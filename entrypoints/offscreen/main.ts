import { MessageType, type Message } from '@/utils/messages';
import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  MediaStreamVideoTrackSource,
  MediaStreamAudioTrackSource,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
  type VideoCodec,
  type AudioCodec,
} from 'mediabunny';
import { BlossomClient } from 'blossom-client-sdk';
import { SimplePool } from 'nostr-tools/pool';

console.log('[offscreen] document loaded');

// --- Recording pipeline state ---
let output: Output | null = null;
let videoSource: MediaStreamVideoTrackSource | null = null;
let audioSource: MediaStreamAudioTrackSource | null = null;
let target: BufferTarget | null = null;
let micStream: MediaStream | null = null;
let recordingStartTime = 0;
let isPaused = false;
let pauseStartTime = 0;
let totalPausedMs = 0;

// --- Tab capture + canvas proxy state ---
let captureStream: MediaStream | null = null;
let proxyVideo: HTMLVideoElement | null = null;
let proxyCanvas: HTMLCanvasElement | null = null;
let proxyCtx: CanvasRenderingContext2D | null = null;
let drawLoopHandle: ReturnType<typeof setInterval> | null = null;

// --- Audio mixer state (hot-swappable tab audio) ---
let audioCtx: AudioContext | null = null;
let audioDestNode: MediaStreamAudioDestinationNode | null = null;
let tabAudioGain: GainNode | null = null;
let tabAudioSourceNode: MediaStreamAudioSourceNode | null = null;
let micGain: GainNode | null = null;

// --- Helpers ---

async function getUserMediaForTab(streamId: string): Promise<MediaStream> {
  // Chrome-specific mandatory constraints for tab capture — not in the DOM lib
  const constraints = {
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  } as unknown as MediaStreamConstraints;

  return navigator.mediaDevices.getUserMedia(constraints);
}

// --- Capture lifecycle ---

async function startCapture(streamId: string) {
  try {
    // 1. Acquire tab capture via stream ID from chrome.tabCapture.getMediaStreamId
    captureStream = await getUserMediaForTab(streamId);

    const videoTrack = captureStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('No video track from tab capture');
    videoTrack.contentHint = 'detail';

    // 2. Acquire microphone (unchanged)
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      console.warn('[offscreen] mic not available, recording without mic:', err);
    }

    // 3. Set up canvas proxy — mediabunny reads from this continuous track
    //    while we swap the underlying capture source on tab switches
    const trackSettings = videoTrack.getSettings();
    const captureWidth = trackSettings.width ?? 1920;
    const captureHeight = trackSettings.height ?? 1080;

    proxyCanvas = document.createElement('canvas');
    proxyCanvas.width = captureWidth;
    proxyCanvas.height = captureHeight;
    proxyCtx = proxyCanvas.getContext('2d', { alpha: false })!;

    proxyVideo = document.createElement('video');
    proxyVideo.muted = true;
    proxyVideo.srcObject = new MediaStream([videoTrack]);
    // Must be in DOM for Chrome to decode frames in offscreen doc
    proxyVideo.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(proxyVideo);
    await proxyVideo.play();

    // Draw loop at ~30fps
    drawLoopHandle = setInterval(() => {
      if (!proxyCtx || !proxyVideo || proxyVideo.readyState < 2) return;
      // Handle resolution changes between tabs
      if (
        proxyVideo.videoWidth > 0 &&
        (proxyCanvas!.width !== proxyVideo.videoWidth || proxyCanvas!.height !== proxyVideo.videoHeight)
      ) {
        proxyCanvas!.width = proxyVideo.videoWidth;
        proxyCanvas!.height = proxyVideo.videoHeight;
      }
      proxyCtx.drawImage(proxyVideo, 0, 0, proxyCanvas!.width, proxyCanvas!.height);
    }, 33);

    // 4. Build audio mixer — AudioContext stays alive for entire recording,
    //    tab audio source node is disconnected/reconnected on tab switch
    audioCtx = new AudioContext({ sampleRate: 48000 });
    audioDestNode = audioCtx.createMediaStreamDestination();

    tabAudioGain = audioCtx.createGain();
    tabAudioGain.gain.value = 1.0;
    tabAudioGain.connect(audioDestNode);

    const tabAudioTrack = captureStream.getAudioTracks()[0];
    if (tabAudioTrack) {
      tabAudioSourceNode = audioCtx.createMediaStreamSource(new MediaStream([tabAudioTrack]));
      tabAudioSourceNode.connect(tabAudioGain);
    }

    micGain = audioCtx.createGain();
    micGain.gain.value = 1.4;
    micGain.connect(audioDestNode);

    if (micStream) {
      const micTrack = micStream.getAudioTracks()[0];
      if (micTrack) {
        const micSourceNode = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
        micSourceNode.connect(micGain);
      }
    }

    // 5. Detect codecs at capture resolution
    const BASE_BITRATES: Record<string, number> = {
      av1: 4_000_000,
      vp9: 5_000_000,
      avc: 8_000_000,
    };

    const videoCodec = await getFirstEncodableVideoCodec(
      ['av1', 'vp9', 'avc'] as VideoCodec[],
      { width: proxyCanvas.width, height: proxyCanvas.height, bitrate: BASE_BITRATES.avc },
    );
    if (!videoCodec) throw new Error('No supported video codec found');
    console.log('[offscreen] selected video codec:', videoCodec);

    const audioCodec = await getFirstEncodableAudioCodec(
      ['aac', 'opus'] as AudioCodec[],
      { numberOfChannels: 2, sampleRate: 48000, bitrate: 128_000 },
    );
    console.log('[offscreen] selected audio codec:', audioCodec);

    // 6. Resolution-scaled bitrate
    const BASE_PIXELS = 1920 * 1080;
    const capturePixels = proxyCanvas.width * proxyCanvas.height;
    const pixelRatio = capturePixels / BASE_PIXELS;
    const bitrate = Math.round(BASE_BITRATES[videoCodec] * Math.pow(pixelRatio, 0.75));

    console.log(`[offscreen] encoding: ${proxyCanvas.width}x${proxyCanvas.height} ${videoCodec} @ ${(bitrate / 1_000_000).toFixed(1)} Mbps`);

    // 7. Create mediabunny sources from proxy tracks (canvas video + mixed audio)
    const canvasStream = proxyCanvas.captureStream(30);
    const canvasVideoTrack = canvasStream.getVideoTracks()[0] as MediaStreamVideoTrack;

    videoSource = new MediaStreamVideoTrackSource(
      canvasVideoTrack,
      {
        codec: videoCodec,
        bitrate,
        bitrateMode: 'variable',
        latencyMode: 'realtime',
        keyFrameInterval: 3,
        contentHint: 'detail',
        sizeChangeBehavior: 'contain',
      },
      { frameRate: 30 },
    );
    videoSource.errorPromise.catch((err) => {
      console.error('[offscreen] video source error:', err);
      stopCapture();
    });

    const mixedAudioTrack = audioDestNode.stream.getAudioTracks()[0];
    if (mixedAudioTrack && audioCodec) {
      audioSource = new MediaStreamAudioTrackSource(
        mixedAudioTrack as MediaStreamAudioTrack,
        { codec: audioCodec, bitrate: 192_000 },
      );
      audioSource.errorPromise.catch((err) => {
        console.error('[offscreen] audio source error:', err);
        stopCapture();
      });
    }

    // 8. Create output
    target = new BufferTarget();
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    });

    output.addVideoTrack(videoSource, { frameRate: 30 });
    if (audioSource) {
      output.addAudioTrack(audioSource);
    }

    await output.start();
    recordingStartTime = Date.now();
    isPaused = false;
    pauseStartTime = 0;
    totalPausedMs = 0;

    // When the tab capture track ends (tab closed, etc.), the canvas proxy
    // continues drawing the last frame. Background will send SWITCH_TAB_CAPTURE
    // for the next tab, or STOP_CAPTURE when the user stops recording.
    videoTrack.addEventListener('ended', () => {
      console.log('[offscreen] tab capture track ended — canvas proxy continues');
    });

    browser.runtime.sendMessage({
      type: MessageType.CAPTURE_READY,
      codec: videoCodec,
    });

    console.log('[offscreen] recording started via tab capture');
  } catch (err) {
    console.error('[offscreen] capture error:', err);
    cleanup();
    browser.runtime.sendMessage({
      type: MessageType.CAPTURE_ERROR,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function switchTabCapture(streamId: string) {
  if (!proxyVideo || !proxyCanvas || !audioCtx || !tabAudioGain) {
    console.warn('[offscreen] switchTabCapture called before recording started');
    return;
  }

  let newStream: MediaStream;
  try {
    newStream = await getUserMediaForTab(streamId);
  } catch (err) {
    console.warn('[offscreen] switchTabCapture: getUserMedia failed, keeping current capture:', err);
    return;
  }

  const oldStream = captureStream;

  // Swap video: update hidden video's source — draw loop picks up new content
  const newVideoTrack = newStream.getVideoTracks()[0];
  if (newVideoTrack) {
    proxyVideo.srcObject = new MediaStream([newVideoTrack]);
  }

  // Swap audio: disconnect old tab source, connect new one
  if (tabAudioSourceNode) {
    tabAudioSourceNode.disconnect();
    tabAudioSourceNode = null;
  }
  const newAudioTrack = newStream.getAudioTracks()[0];
  if (newAudioTrack) {
    tabAudioSourceNode = audioCtx.createMediaStreamSource(new MediaStream([newAudioTrack]));
    tabAudioSourceNode.connect(tabAudioGain);
  }

  captureStream = newStream;

  // Stop old capture stream tracks (frees tab capture indicator on old tab)
  oldStream?.getTracks().forEach((t) => t.stop());

  console.log('[offscreen] switched tab capture');
}

async function stopCapture() {
  if (!output || !target) return;

  // Stop capture and mic tracks immediately
  captureStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  captureStream = null;
  micStream = null;

  // Stop draw loop and proxy elements
  if (drawLoopHandle !== null) {
    clearInterval(drawLoopHandle);
    drawLoopHandle = null;
  }
  if (proxyVideo) {
    proxyVideo.srcObject = null;
    proxyVideo.remove();
    proxyVideo = null;
  }
  proxyCanvas = null;
  proxyCtx = null;

  try {
    if (isPaused) {
      totalPausedMs += Date.now() - pauseStartTime;
      isPaused = false;
    }
    const duration = (Date.now() - recordingStartTime - totalPausedMs) / 1000;

    videoSource?.close();
    audioSource?.close();

    await output.finalize();

    // Close AudioContext after finalization
    await audioCtx?.close();
    audioCtx = null;
    audioDestNode = null;
    tabAudioGain = null;
    tabAudioSourceNode = null;
    micGain = null;

    const buffer = target.buffer;
    if (!buffer) throw new Error('No buffer after finalization');

    console.log(`[offscreen] recording finalized: ${buffer.byteLength} bytes, ${duration.toFixed(1)}s`);

    await storeRecording(buffer, duration);

    browser.runtime.sendMessage({
      type: MessageType.RECORDING_COMPLETE,
      size: buffer.byteLength,
      duration,
    });
  } catch (err) {
    console.error('[offscreen] finalization error:', err);
    browser.runtime.sendMessage({
      type: MessageType.CAPTURE_ERROR,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    cleanup();
  }
}

function cleanup() {
  captureStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  if (drawLoopHandle !== null) {
    clearInterval(drawLoopHandle);
    drawLoopHandle = null;
  }
  if (proxyVideo) {
    proxyVideo.srcObject = null;
    proxyVideo.remove();
    proxyVideo = null;
  }
  captureStream = null;
  micStream = null;
  proxyCanvas = null;
  proxyCtx = null;
  videoSource = null;
  audioSource = null;
  output = null;
  target = null;
  audioCtx?.close().catch(() => {});
  audioCtx = null;
  audioDestNode = null;
  tabAudioGain = null;
  tabAudioSourceNode = null;
  micGain = null;
}

// --- Thumbnail ---

function generateThumbnail(buffer: ArrayBuffer): Promise<string> {
  const blob = new Blob([buffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';

    const cleanup = () => { URL.revokeObjectURL(url); };

    video.onloadeddata = () => {
      video.currentTime = Math.min(1, video.duration * 0.1);
    };

    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      const targetW = 640;
      const scale = targetW / (video.videoWidth || targetW);
      canvas.width = targetW;
      canvas.height = Math.round((video.videoHeight || 360) * scale);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      cleanup();
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };

    video.onerror = () => { cleanup(); reject(new Error('Thumbnail generation failed')); };
    // Timeout after 5s
    setTimeout(() => { cleanup(); reject(new Error('Thumbnail generation timed out')); }, 5000);
    video.src = url;
  });
}

// --- IDB Storage ---

async function storeRecording(buffer: ArrayBuffer, duration: number) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  let thumbnail: string | undefined;
  try {
    thumbnail = await generateThumbnail(buffer);
  } catch (err) {
    console.warn('[offscreen] thumbnail generation failed:', err);
  }

  const db = await openDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');

  await new Promise<void>((resolve, reject) => {
    const req = store.put({
      hash,
      data: buffer,
      size: buffer.byteLength,
      duration,
      timestamp: Date.now(),
      uploaded: false,
      thumbnail,
    });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  db.close();
  console.log(`[offscreen] stored recording: ${hash}`);
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bloom-recordings', 2); // legacy name — do not rename (data loss)
    req.onupgradeneeded = (event) => {
      const db = req.result;
      let store: IDBObjectStore;
      if (!db.objectStoreNames.contains('recordings')) {
        store = db.createObjectStore('recordings', { keyPath: 'hash' });
      } else {
        store = (event.target as IDBOpenDBRequest).transaction!.objectStore('recordings');
      }
      if (!store.indexNames.contains('by_timestamp')) {
        store.createIndex('by_timestamp', 'timestamp');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getLatestRecording(): Promise<{ dataUrl: string; duration: number } | null> {
  const db = await openDB();
  const tx = db.transaction('recordings', 'readonly');
  const store = tx.objectStore('recordings');

  return new Promise((resolve) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const recordings = req.result;
      db.close();
      if (!recordings || recordings.length === 0) {
        resolve(null);
        return;
      }
      recordings.sort((a: any, b: any) => b.timestamp - a.timestamp);
      const latest = recordings[0];
      const bytes = new Uint8Array(latest.data);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const dataUrl = 'data:video/mp4;base64,' + btoa(binary);
      resolve({ dataUrl, duration: latest.duration });
    };
    req.onerror = () => {
      db.close();
      resolve(null);
    };
  });
}

async function listRecordings(): Promise<{ hash: string; size: number; duration: number; timestamp: number; uploaded: boolean; blossomUrl?: string }[]> {
  const db = await openDB();
  const tx = db.transaction('recordings', 'readonly');
  const store = tx.objectStore('recordings');
  const index = store.index('by_timestamp');

  return new Promise((resolve) => {
    const results: any[] = [];
    const req = index.openCursor(null, 'prev'); // newest first
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const { hash, size, duration, timestamp, uploaded, blossomUrl, thumbnail } = cursor.value;
        results.push({ hash, size, duration, timestamp, uploaded: !!uploaded, blossomUrl, thumbnail });
        cursor.continue();
      } else {
        db.close();
        resolve(results);
      }
    };
    req.onerror = () => { db.close(); resolve([]); };
  });
}

async function deleteRecording(hash: string): Promise<boolean> {
  const db = await openDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  return new Promise((resolve) => {
    const req = store.delete(hash);
    req.onsuccess = () => { db.close(); resolve(true); };
    req.onerror = () => { db.close(); resolve(false); };
  });
}

async function markUploaded(hash: string, blossomUrl: string, noteId?: string): Promise<boolean> {
  const db = await openDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  return new Promise((resolve) => {
    const getReq = store.get(hash);
    getReq.onsuccess = () => {
      if (!getReq.result) { db.close(); resolve(false); return; }
      const record = getReq.result;
      record.uploaded = true;
      record.blossomUrl = blossomUrl;
      if (noteId) record.noteId = noteId;
      const putReq = store.put(record);
      putReq.onsuccess = () => { db.close(); resolve(true); };
      putReq.onerror = () => { db.close(); resolve(false); };
    };
    getReq.onerror = () => { db.close(); resolve(false); };
  });
}

async function getRecordingByHash(hash: string): Promise<{ dataUrl: string; duration: number } | null> {
  const db = await openDB();
  const tx = db.transaction('recordings', 'readonly');
  const store = tx.objectStore('recordings');
  return new Promise((resolve) => {
    const req = store.get(hash);
    req.onsuccess = () => {
      db.close();
      if (!req.result) { resolve(null); return; }
      const record = req.result;
      const bytes = new Uint8Array(record.data);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const dataUrl = 'data:video/mp4;base64,' + btoa(binary);
      resolve({ dataUrl, duration: record.duration });
    };
    req.onerror = () => { db.close(); resolve(null); };
  });
}

async function generateThumbnailForHash(hash: string): Promise<string | null> {
  const db = await openDB();

  const record = await new Promise<any>((resolve) => {
    const tx = db.transaction('recordings', 'readonly');
    const req = tx.objectStore('recordings').get(hash);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });

  if (!record?.data) { db.close(); return null; }

  let thumbnail: string;
  try {
    thumbnail = await generateThumbnail(record.data);
  } catch {
    db.close();
    return null;
  }

  // Save it back
  await new Promise<void>((resolve) => {
    const tx = db.transaction('recordings', 'readwrite');
    record.thumbnail = thumbnail;
    const req = tx.objectStore('recordings').put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });

  db.close();
  return thumbnail;
}

async function deleteRecordings(hashes: string[]): Promise<number> {
  const db = await openDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  let deleted = 0;

  for (const hash of hashes) {
    await new Promise<void>((resolve) => {
      const req = store.delete(hash);
      req.onsuccess = () => { deleted++; resolve(); };
      req.onerror = () => resolve();
    });
  }

  db.close();
  return deleted;
}

async function uploadRecordingByHash(hash: string, server: string) {
  try {
    const db = await openDB();
    const tx = db.transaction('recordings', 'readonly');
    const store = tx.objectStore('recordings');

    const recording = await new Promise<any>((resolve, reject) => {
      const req = store.get(hash);
      req.onsuccess = () => {
        if (!req.result) { reject(new Error('Recording not found')); return; }
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
    db.close();

    const blob = new Blob([recording.data], { type: 'video/mp4' });
    const primaryServer = server;
    if (!primaryServer) throw new Error('No Blossom server configured');

    console.log(`[offscreen] uploading ${blob.size} bytes to ${primaryServer}`);

    const signer = createSigner();
    const client = new BlossomClient(primaryServer, signer);

    browser.runtime.sendMessage({
      type: MessageType.UPLOAD_PROGRESS,
      bytesUploaded: 0,
      totalBytes: blob.size,
      serverName: primaryServer,
    });

    const descriptor = await client.uploadBlob(blob, { auth: true });

    console.log(`[offscreen] upload complete:`, descriptor);

    browser.runtime.sendMessage({
      type: MessageType.UPLOAD_COMPLETE,
      url: descriptor.url,
      sha256: descriptor.sha256,
      size: descriptor.size,
    });
  } catch (err) {
    console.error('[offscreen] upload error:', err);
    browser.runtime.sendMessage({
      type: MessageType.UPLOAD_ERROR,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- NIP-07 Signer (routes through background -> scripting.executeScript in recording tab) ---

function createSigner() {
  return async (draft: { kind: number; content: string; tags: string[][]; created_at: number }) => {
    const response = await browser.runtime.sendMessage({
      type: MessageType.NIP07_SIGN,
      event: draft,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Signing failed');
    }
    return response.data;
  };
}

async function getPublicKey(): Promise<string> {
  const response = await browser.runtime.sendMessage({
    type: MessageType.NIP07_GET_PUBKEY,
  });
  if (!response?.ok) {
    throw new Error(response?.error || 'Failed to get public key');
  }
  return response.data;
}

// --- Blossom Upload ---

async function uploadRecording(server: string) {
  try {
    const db = await openDB();
    const tx = db.transaction('recordings', 'readonly');
    const store = tx.objectStore('recordings');

    const recording = await new Promise<any>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const recordings = req.result;
        if (!recordings || recordings.length === 0) {
          reject(new Error('No recording found'));
          return;
        }
        recordings.sort((a: any, b: any) => b.timestamp - a.timestamp);
        resolve(recordings[0]);
      };
      req.onerror = () => reject(req.error);
    });
    db.close();

    const blob = new Blob([recording.data], { type: 'video/mp4' });
    const primaryServer = server;
    if (!primaryServer) throw new Error('No Blossom server configured');

    console.log(`[offscreen] uploading ${blob.size} bytes to ${primaryServer}`);

    const signer = createSigner();
    const client = new BlossomClient(primaryServer, signer);

    browser.runtime.sendMessage({
      type: MessageType.UPLOAD_PROGRESS,
      bytesUploaded: 0,
      totalBytes: blob.size,
      serverName: primaryServer,
    });

    const descriptor = await client.uploadBlob(blob, { auth: true });

    console.log(`[offscreen] upload complete:`, descriptor);

    browser.runtime.sendMessage({
      type: MessageType.UPLOAD_COMPLETE,
      url: descriptor.url,
      sha256: descriptor.sha256,
      size: descriptor.size,
    });
  } catch (err) {
    console.error('[offscreen] upload error:', err);
    browser.runtime.sendMessage({
      type: MessageType.UPLOAD_ERROR,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Nostr Publishing ---

async function publishNote(blossomUrl: string, sha256: string, size: number, relays: string[], noteContent?: string) {
  try {
    const signer = createSigner();

    const text = noteContent?.trim();
    const content = text ? `${text}\n\n${blossomUrl}` : blossomUrl;
    const alt = text ? text.slice(0, 100) : 'Screen recording';

    const draft = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      content,
      tags: [
        ['r', blossomUrl],
        ['imeta',
          `url ${blossomUrl}`,
          `x ${sha256}`,
          `m video/mp4`,
          `size ${size}`,
          `alt ${alt}`,
        ],
      ],
    };

    const signedEvent = await signer(draft);
    console.log('[offscreen] signed note event:', signedEvent.id);

    const pool = new SimplePool();

    const publishPromises = pool.publish(relays, signedEvent);
    // Wait for all relays to respond (with a timeout so we don't hang)
    const results = await Promise.allSettled(
      publishPromises.map((p) =>
        Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))]),
      ),
    );
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    console.log(`[offscreen] published to ${accepted}/${relays.length} relays (${failed} failed)`);

    pool.close(relays);

    browser.runtime.sendMessage({
      type: MessageType.PUBLISH_COMPLETE,
      noteId: signedEvent.id,
      blossomUrl,
    });
  } catch (err) {
    console.error('[offscreen] publish error:', err);
    browser.runtime.sendMessage({
      type: MessageType.PUBLISH_ERROR,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Message handler ---

browser.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    if (message.target !== 'offscreen') return false;

    switch (message.type) {
      case MessageType.START_CAPTURE:
        startCapture((message as any).streamId);
        sendResponse({ ok: true });
        return false;

      case MessageType.STOP_CAPTURE:
        // Stop capture tracks synchronously (kills screen share indicator immediately)
        captureStream?.getTracks().forEach((t) => t.stop());
        micStream?.getTracks().forEach((t) => t.stop());
        stopCapture();
        sendResponse({ ok: true });
        return false;

      case MessageType.SWITCH_TAB_CAPTURE:
        switchTabCapture((message as any).streamId).catch((err) =>
          console.error('[offscreen] switchTabCapture error:', err),
        );
        sendResponse({ ok: true });
        return false;

      case MessageType.PAUSE_CAPTURE: {
        if (videoSource && !isPaused) {
          videoSource.pause();
          audioSource?.pause();
          isPaused = true;
          pauseStartTime = Date.now();
          console.log('[offscreen] capture paused');
        }
        sendResponse({ ok: true });
        return false;
      }

      case MessageType.RESUME_CAPTURE: {
        if (videoSource && isPaused) {
          videoSource.resume();
          audioSource?.resume();
          totalPausedMs += Date.now() - pauseStartTime;
          isPaused = false;
          console.log('[offscreen] capture resumed');
        }
        sendResponse({ ok: true });
        return false;
      }

      case MessageType.TOGGLE_MIC: {
        const muted = (message as any).muted;
        if (micStream) {
          micStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
          console.log(`[offscreen] mic ${muted ? 'muted' : 'unmuted'}`);
        }
        sendResponse({ ok: true });
        return false;
      }

      case MessageType.GET_RECORDING:
        getLatestRecording().then(sendResponse);
        return true;

      case MessageType.START_UPLOAD: {
        const msg = message as any;
        uploadRecording(msg.server);
        sendResponse({ ok: true });
        return false;
      }

      case MessageType.PUBLISH_NOTE: {
        const msg = message as any;
        publishNote(msg.blossomUrl, msg.sha256, msg.size, msg.relays, msg.noteContent);
        sendResponse({ ok: true });
        return false;
      }

      case MessageType.LIST_RECORDINGS:
        listRecordings().then(sendResponse);
        return true;

      case MessageType.DELETE_RECORDING:
        deleteRecording((message as any).hash).then((ok) => sendResponse({ ok }));
        return true;

      case MessageType.MARK_UPLOADED:
        markUploaded((message as any).hash, (message as any).blossomUrl, (message as any).noteId).then((ok) => sendResponse({ ok }));
        return true;

      case MessageType.GET_RECORDING_BY_HASH:
        getRecordingByHash((message as any).hash).then(sendResponse);
        return true;

      case MessageType.UPLOAD_FROM_LIBRARY: {
        const msg = message as any;
        uploadRecordingByHash(msg.hash, msg.server);
        sendResponse({ ok: true });
        return false;
      }

      case MessageType.GENERATE_THUMBNAIL:
        generateThumbnailForHash((message as any).hash).then((thumbnail) => sendResponse({ thumbnail }));
        return true;

      case MessageType.DELETE_RECORDINGS:
        deleteRecordings((message as any).hashes).then((count) => sendResponse({ ok: true, count }));
        return true;

      default:
        return false;
    }
  },
);
