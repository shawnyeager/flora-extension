import { MessageType, type Message } from '@/utils/messages';
import { getSettings } from '@/utils/settings';
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

let output: Output | null = null;
let videoSource: MediaStreamVideoTrackSource | null = null;
let audioSource: MediaStreamAudioTrackSource | null = null;
let target: BufferTarget | null = null;
let displayStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let recordingStartTime = 0;
let isPaused = false;
let pauseStartTime = 0;
let totalPausedMs = 0;

async function startCapture() {
  try {
    // 1. Acquire screen capture (webcam overlay comes from content script on the page)
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: true,
    });

    const videoTrack = displayStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('No video track from getDisplayMedia');
    videoTrack.contentHint = 'detail';

    // 2. Acquire microphone
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      console.warn('[offscreen] mic not available, recording without mic:', err);
    }

    // 3. Detect codecs
    const videoCodec = await getFirstEncodableVideoCodec(
      ['av1', 'vp9', 'avc'] as VideoCodec[],
      { width: 1920, height: 1080, bitrate: 3_000_000 },
    );
    if (!videoCodec) throw new Error('No supported video codec found');
    console.log('[offscreen] selected video codec:', videoCodec);

    const audioCodec = await getFirstEncodableAudioCodec(
      ['aac', 'opus'] as AudioCodec[],
      { numberOfChannels: 2, sampleRate: 48000, bitrate: 128_000 },
    );
    console.log('[offscreen] selected audio codec:', audioCodec);

    // 4. Create video source (direct track, no compositing)
    const bitrate = videoCodec === 'av1' ? 2_000_000 : videoCodec === 'vp9' ? 2_500_000 : 4_000_000;

    videoSource = new MediaStreamVideoTrackSource(
      videoTrack as MediaStreamVideoTrack,
      {
        codec: videoCodec,
        bitrate,
        latencyMode: 'realtime',
        contentHint: 'detail',
        sizeChangeBehavior: 'contain',
      },
    );
    videoSource.errorPromise.catch((err) => {
      console.error('[offscreen] video source error:', err);
      stopCapture();
    });

    // 5. Create audio source(s)
    const audioTracks: MediaStreamTrack[] = [];
    const systemAudioTrack = displayStream.getAudioTracks()[0];
    if (systemAudioTrack) audioTracks.push(systemAudioTrack);
    if (micStream) audioTracks.push(...micStream.getAudioTracks());

    if (audioTracks.length > 0 && audioCodec) {
      const mixedTrack = audioTracks.length > 1
        ? mixAudioTracks(audioTracks)
        : audioTracks[0];

      audioSource = new MediaStreamAudioTrackSource(
        mixedTrack as MediaStreamAudioTrack,
        { codec: audioCodec, bitrate: 128_000 },
      );
      audioSource.errorPromise.catch((err) => {
        console.error('[offscreen] audio source error:', err);
        stopCapture();
      });
    }

    // 6. Create output
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

    // Handle stream ending
    videoTrack.addEventListener('ended', () => {
      console.log('[offscreen] video track ended by user');
      stopCapture();
    });

    browser.runtime.sendMessage({
      type: MessageType.CAPTURE_READY,
      codec: videoCodec,
    });

    console.log('[offscreen] recording started');
  } catch (err) {
    console.error('[offscreen] capture error:', err);
    cleanup();
    browser.runtime.sendMessage({
      type: MessageType.CAPTURE_ERROR,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function stopCapture() {
  if (!output || !target) return;

  // Stop media tracks FIRST (immediately kills screen share indicator + mic)
  displayStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  displayStream = null;
  micStream = null;

  try {
    // Account for paused time in duration
    if (isPaused) {
      totalPausedMs += Date.now() - pauseStartTime;
      isPaused = false;
    }
    const duration = (Date.now() - recordingStartTime - totalPausedMs) / 1000;

    videoSource?.close();
    audioSource?.close();

    await output.finalize();

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

function mixAudioTracks(tracks: MediaStreamTrack[]): MediaStreamTrack {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const dest = ctx.createMediaStreamDestination();

  for (const track of tracks) {
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(dest);
  }

  return dest.stream.getAudioTracks()[0];
}

function cleanup() {
  displayStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  displayStream = null;
  micStream = null;
  videoSource = null;
  audioSource = null;
  output = null;
  target = null;
}

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
    const req = indexedDB.open('bloom-recordings', 2);
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

async function migrateThumbnails() {
  const key = 'bloom-thumb-v2';
  if (localStorage.getItem(key)) return;

  const db = await openDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  const req = store.openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor) {
      const rec = cursor.value;
      if (rec.thumbnail) {
        rec.thumbnail = undefined;
        cursor.update(rec);
      }
      cursor.continue();
    }
  };
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); resolve(); };
  });
  localStorage.setItem(key, '1');
  console.log('[offscreen] cleared old thumbnails for regeneration');
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

async function markUploaded(hash: string, blossomUrl: string): Promise<boolean> {
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

async function uploadRecordingByHash(hash: string, serverOverride?: string) {
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
    const settings = await getSettings();
    const primaryServer = serverOverride || settings.blossomServers[0];
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

async function uploadRecording(serverOverride?: string) {
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
    const settings = await getSettings();
    const primaryServer = serverOverride || settings.blossomServers[0];
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

async function publishNote(blossomUrl: string, sha256: string, size: number, noteContent?: string) {
  try {
    const settings = await getSettings();
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
    const relays = settings.nostrRelays;

    const publishPromises = pool.publish(relays, signedEvent);
    // Wait for at least one relay to accept
    const firstRelay = await Promise.any(publishPromises);
    console.log(`[offscreen] published to relay: ${firstRelay}`);

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

// Message handler
migrateThumbnails();

browser.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    if (message.target !== 'offscreen') return false;

    switch (message.type) {
      case MessageType.START_CAPTURE:
        startCapture();
        sendResponse({ ok: true });
        return false;

      case MessageType.STOP_CAPTURE:
        // Stop media tracks synchronously in handler (kills screen share indicator immediately)
        displayStream?.getTracks().forEach((t) => t.stop());
        micStream?.getTracks().forEach((t) => t.stop());
        stopCapture();
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
        uploadRecording(msg.serverOverride);
        sendResponse({ ok: true });
        return false;
      }

      case MessageType.PUBLISH_NOTE: {
        const msg = message as any;
        publishNote(msg.blossomUrl, msg.sha256, msg.size, msg.noteContent);
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
        markUploaded((message as any).hash, (message as any).blossomUrl).then((ok) => sendResponse({ ok }));
        return true;

      case MessageType.GET_RECORDING_BY_HASH:
        getRecordingByHash((message as any).hash).then(sendResponse);
        return true;

      case MessageType.UPLOAD_FROM_LIBRARY: {
        const msg = message as any;
        uploadRecordingByHash(msg.hash, msg.serverOverride);
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
