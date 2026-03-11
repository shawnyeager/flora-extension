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

console.log('[offscreen] document loaded');

let output: Output | null = null;
let videoSource: MediaStreamVideoTrackSource | null = null;
let audioSource: MediaStreamAudioTrackSource | null = null;
let target: BufferTarget | null = null;
let displayStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let recordingStartTime = 0;

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
    const duration = (Date.now() - recordingStartTime) / 1000;

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

async function storeRecording(buffer: ArrayBuffer, duration: number) {
  const db = await openDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');

  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  await new Promise<void>((resolve, reject) => {
    const req = store.put({
      hash,
      data: buffer,
      size: buffer.byteLength,
      duration,
      timestamp: Date.now(),
      uploaded: false,
    });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  db.close();
  console.log(`[offscreen] stored recording: ${hash}`);
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bloom-recordings', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'hash' });
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

// Message handler
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

      default:
        return false;
    }
  },
);
