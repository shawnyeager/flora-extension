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
import { generateSecretKey, getPublicKey as getKeyPublicKey, finalizeEvent, getEventHash, type VerifiedEvent } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';

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
let isStopping = false;

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
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      console.warn('[offscreen] mic not available, recording without mic:', err);
    }

    // 3. Detect codecs at actual capture resolution
    const trackSettings = videoTrack.getSettings();
    const captureWidth = trackSettings.width ?? 1920;
    const captureHeight = trackSettings.height ?? 1080;

    const BASE_BITRATES: Record<string, number> = {
      av1: 4_000_000,   // 2x previous — screen content needs higher bitrate
      vp9: 5_000_000,
      avc: 8_000_000,
    };

    const videoCodec = await getFirstEncodableVideoCodec(
      ['av1', 'vp9', 'avc'] as VideoCodec[],
      { width: captureWidth, height: captureHeight, bitrate: BASE_BITRATES.avc },
    );
    if (!videoCodec) throw new Error('No supported video codec found');
    console.log('[offscreen] selected video codec:', videoCodec);

    const audioCodec = await getFirstEncodableAudioCodec(
      ['aac', 'opus'] as AudioCodec[],
      { numberOfChannels: 2, sampleRate: 48000, bitrate: 128_000 },
    );
    console.log('[offscreen] selected audio codec:', audioCodec);

    // 4. Create video source with resolution-scaled bitrate
    const BASE_PIXELS = 1920 * 1080;
    const capturePixels = captureWidth * captureHeight;
    const pixelRatio = capturePixels / BASE_PIXELS;
    // Sub-linear scaling: 4K (~4x pixels) gets ~3x bitrate, not 4x
    const bitrate = Math.round(BASE_BITRATES[videoCodec] * Math.pow(pixelRatio, 0.75));

    console.log(`[offscreen] encoding: ${captureWidth}x${captureHeight} ${videoCodec} @ ${(bitrate / 1_000_000).toFixed(1)} Mbps`);

    videoSource = new MediaStreamVideoTrackSource(
      videoTrack as MediaStreamVideoTrack,
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
        { codec: audioCodec, bitrate: 192_000 },
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
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[offscreen] capture error:', errMsg);
    cleanup();
    browser.runtime.sendMessage({
      type: MessageType.CAPTURE_ERROR,
      error: errMsg,
    });
  }
}

async function stopCapture() {
  if (isStopping || !output || !target) return;
  isStopping = true;

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
    isStopping = false;
    cleanup();
  }
}

function mixAudioTracks(tracks: MediaStreamTrack[]): MediaStreamTrack {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const dest = ctx.createMediaStreamDestination();
  // System audio is index 0, mic is index 1 (mic pushed last in audioTracks)
  const micIndex = tracks.length - 1;

  for (let i = 0; i < tracks.length; i++) {
    const source = ctx.createMediaStreamSource(new MediaStream([tracks[i]]));
    const gain = ctx.createGain();
    gain.gain.value = i === micIndex ? 1.4 : 1.0;
    source.connect(gain).connect(dest);
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
  isStopping = false;
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

// --- NIP-44 Encrypt (routes through background -> NIP-07 signer) ---

async function nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
  const response = await browser.runtime.sendMessage({
    type: MessageType.NIP44_ENCRYPT,
    recipientPubkey,
    plaintext,
  });
  if (!response?.ok) {
    throw new Error(response?.error || 'NIP-44 encryption failed');
  }
  return response.data;
}

// --- AES-GCM Encryption ---

async function encryptVideo(buffer: ArrayBuffer): Promise<{
  encrypted: ArrayBuffer;
  key: Uint8Array;
  nonce: Uint8Array;
}> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const rawKey = new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  // Zero the source key material immediately after import
  rawKey.fill(0);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, buffer);
  return { encrypted, key, nonce };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- NIP-59 Gift Wrapping ---

async function giftWrapKind15(
  rumor: { kind: number; content: string; tags: string[][]; created_at: number; pubkey: string },
  recipientPubkey: string,
): Promise<VerifiedEvent> {
  // Compute rumor ID per NIP-01
  const rumorWithId = { ...rumor, id: getEventHash(rumor as any) };

  // NIP-44 payload size guard (< 64000 bytes to stay within NIP-44 limits)
  const rumorJson = JSON.stringify(rumorWithId);
  if (new TextEncoder().encode(rumorJson).length >= 64000) {
    throw new Error('Rumor payload too large for NIP-44 encryption (>= 64KB)');
  }

  // Layer 1: Seal (kind 13) — encrypt rumor with NIP-44 via signer
  const sealContent = await nip44Encrypt(recipientPubkey, rumorJson);

  // Randomize created_at up to 2 days in the past for privacy (using crypto.getRandomValues)
  const randomBytes = new Uint8Array(4);
  crypto.getRandomValues(randomBytes);
  const randomOffset = (randomBytes[0] | (randomBytes[1] << 8) | (randomBytes[2] << 16) | ((randomBytes[3] & 0x7f) << 24)) >>> 0;
  const sealTimestampOffset = randomOffset % 172800;

  const sealDraft = {
    kind: 13,
    content: sealContent,
    tags: [] as string[][],
    created_at: Math.floor(Date.now() / 1000) - sealTimestampOffset,
  };

  // Sign seal with real identity via NIP-07
  const signer = createSigner();
  const signedSeal = await signer(sealDraft);

  // Layer 2: Gift Wrap (kind 1059) — encrypt seal with ephemeral key
  const ephemeralSk = generateSecretKey();
  const ephemeralPk = getKeyPublicKey(ephemeralSk);
  const conversationKey = nip44.utils.getConversationKey(ephemeralSk, recipientPubkey);
  const wrapContent = nip44.encrypt(JSON.stringify(signedSeal), conversationKey);

  // Randomize wrap timestamp too
  const wrapRandomBytes = new Uint8Array(4);
  crypto.getRandomValues(wrapRandomBytes);
  const wrapRandomOffset = (wrapRandomBytes[0] | (wrapRandomBytes[1] << 8) | (wrapRandomBytes[2] << 16) | ((wrapRandomBytes[3] & 0x7f) << 24)) >>> 0;
  const wrapTimestampOffset = wrapRandomOffset % 172800;

  const wrap = finalizeEvent({
    kind: 1059,
    content: wrapContent,
    tags: [['p', recipientPubkey]],
    created_at: Math.floor(Date.now() / 1000) - wrapTimestampOffset,
  }, ephemeralSk);

  // Zero ephemeral secret key
  ephemeralSk.fill(0);

  return wrap;
}

// --- Private Sending ---

async function sendPrivate(
  server: string,
  recipients: Array<{ pubkey: string; name?: string; relays?: string[] }>,
) {
  try {
    // 1. Get the latest recording from IDB using by_timestamp index with reverse cursor
    const db = await openDB();
    const tx = db.transaction('recordings', 'readonly');
    const store = tx.objectStore('recordings');
    const index = store.index('by_timestamp');

    const recording = await new Promise<any>((resolve, reject) => {
      const req = index.openCursor(null, 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          resolve(cursor.value);
        } else {
          reject(new Error('No recording found'));
        }
      };
      req.onerror = () => reject(req.error);
    });
    db.close();

    const originalBuffer: ArrayBuffer = recording.data;
    const originalHash = recording.hash;
    // Null recording.data to reduce memory pressure
    recording.data = null;

    // 2. Encrypt the video
    browser.runtime.sendMessage({
      type: MessageType.UPLOAD_PROGRESS,
      bytesUploaded: 0,
      totalBytes: originalBuffer.byteLength,
      serverName: 'Encrypting\u2026',
    });

    const { encrypted, key, nonce } = await encryptVideo(originalBuffer);

    // 3. Upload encrypted blob to Blossom
    const encryptedBlob = new Blob([encrypted], { type: 'application/octet-stream' });
    const primaryServer = server;
    if (!primaryServer) throw new Error('No Blossom server configured');

    console.log('[offscreen] uploading encrypted blob (' + encryptedBlob.size + ' bytes) to ' + primaryServer);

    const blossomSigner = createSigner();
    const client = new BlossomClient(primaryServer, blossomSigner);

    browser.runtime.sendMessage({
      type: MessageType.UPLOAD_PROGRESS,
      bytesUploaded: 0,
      totalBytes: encryptedBlob.size,
      serverName: primaryServer,
    });

    const descriptor = await client.uploadBlob(encryptedBlob, { auth: true });
    const encryptedBlobHash = descriptor.sha256;
    const blossomUrl = descriptor.url;

    console.log('[offscreen] encrypted blob uploaded: ' + blossomUrl);

    // 4. Get sender pubkey for the rumor
    const senderPubkey = await getPublicKey();

    // 5. Build Kind 15 rumor and gift-wrap for each recipient
    // Include sender as a gift-wrap recipient (NIP-17 convention)
    const allRecipients = [
      ...recipients,
      { pubkey: senderPubkey, name: 'self', relays: [] as string[] },
    ];

    browser.runtime.sendMessage({
      type: MessageType.UPLOAD_PROGRESS,
      bytesUploaded: encryptedBlob.size,
      totalBytes: encryptedBlob.size,
      serverName: 'Sending to recipients\u2026',
    });

    // Build gift wraps sequentially (each requires NIP-44 encryption via signer)
    const wrapsWithRelays: Array<{ wrap: VerifiedEvent; relays: string[] }> = [];
    for (const recipient of allRecipients) {
      const rumor = {
        kind: 15,
        content: blossomUrl,
        pubkey: senderPubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', recipient.pubkey],
          ['file-type', 'video/mp4'],
          ['encryption-algorithm', 'aes-gcm'],
          ['decryption-key', bytesToHex(key)],
          ['decryption-nonce', bytesToHex(nonce)],
          ['x', encryptedBlobHash],
          ['ox', originalHash],
          ['size', String(encrypted.byteLength)],
        ],
      };

      const wrap = await giftWrapKind15(rumor, recipient.pubkey);

      const targetRelays = recipient.relays?.length
        ? recipient.relays
        : ['wss://nos.lol', 'wss://relay.damus.io'];

      wrapsWithRelays.push({ wrap, relays: targetRelays });
    }

    // Zero key material after all gift wraps are built
    key.fill(0);
    nonce.fill(0);

    // 6. Publish all gift wraps in parallel
    const pool = new SimplePool();
    let sent = 0;
    const deliveredPubkeys: string[] = [];

    try {
      const publishResults = await Promise.allSettled(
        wrapsWithRelays.map(async ({ wrap, relays }, i) => {
          const recipient = allRecipients[i];
          const publishPromises = pool.publish(relays, wrap);
          const results = await Promise.allSettled(
            publishPromises.map((p) =>
              Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))]),
            ),
          );
          const accepted = results.filter((r) => r.status === 'fulfilled').length;
          if (accepted > 0) {
            sent++;
            deliveredPubkeys.push(recipient.pubkey);
            console.log('[offscreen] gift wrap sent to ' + recipient.pubkey.slice(0, 8) + '\u2026 (' + sent + '/' + allRecipients.length + ')');
          } else {
            console.error('[offscreen] failed to send to ' + recipient.pubkey.slice(0, 8) + '\u2026: all relays rejected');
          }
        }),
      );
    } finally {
      const allRelays = wrapsWithRelays.flatMap(({ relays }) => relays);
      pool.close([...new Set(allRelays)]);
    }

    // Guard: if no deliveries succeeded, throw
    if (sent === 0) {
      throw new Error('All gift wrap deliveries failed — no relays accepted the events');
    }

    // 7. Mark recording in IDB
    await markPrivate(originalHash, encryptedBlobHash, recipients);

    browser.runtime.sendMessage({
      type: MessageType.PRIVATE_SEND_COMPLETE,
      recipientCount: sent,
      encryptedBlobHash,
      deliveredPubkeys,
    });
  } catch (err) {
    console.error('[offscreen] private send error:', err);
    browser.runtime.sendMessage({
      type: MessageType.PRIVATE_SEND_ERROR,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function markPrivate(
  hash: string,
  encryptedBlobHash: string,
  recipients: Array<{ pubkey: string; name?: string }>,
): Promise<boolean> {
  const db = await openDB();
  const tx = db.transaction('recordings', 'readwrite');
  const store = tx.objectStore('recordings');
  return new Promise((resolve) => {
    const getReq = store.get(hash);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) { db.close(); resolve(false); return; }
      record.uploaded = true;
      record.sharingMode = 'private';
      record.encryptedBlobHash = encryptedBlobHash;
      record.recipients = recipients.map((r) => ({ pubkey: r.pubkey, name: r.name }));
      const putReq = store.put(record);
      putReq.onsuccess = () => { db.close(); resolve(true); };
      putReq.onerror = () => { db.close(); resolve(false); };
    };
    getReq.onerror = () => { db.close(); resolve(false); };
  });
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

      case MessageType.SEND_PRIVATE: {
        const msg = message as any;
        sendPrivate(msg.server, msg.recipients);
        sendResponse({ ok: true });
        return false;
      }

      default:
        return false;
    }
  },
);
