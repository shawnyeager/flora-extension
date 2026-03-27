# Private Sharing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add private encrypted video sharing to Flora using NIP-17 Kind 15 file messages with AES-GCM encryption and NIP-59 gift wrapping.

**Architecture:** Recordings are encrypted client-side with AES-GCM before upload to Blossom. A Kind 15 file message containing the Blossom URL and decryption key is gift-wrapped per NIP-59 for each recipient and published to their NIP-17 inbox relays. The confirm screen gains a three-way sharing mode picker (Public/Unlisted/Private) replacing the current "Publish to Nostr" toggle, with an inline recipient picker for Private mode.

**Tech Stack:** `nostr-tools` (nip19, nip44, nip59, nip05), Web Crypto API (AES-256-GCM), `blossom-client-sdk`, Chrome extension APIs (scripting, storage)

**Design doc:** `docs/plans/2026-03-27-feat-private-sharing-design.md`

---

### Task 1: Add sharing mode to settings and message types

**Files:**
- Modify: `utils/settings.ts:1-7` (FloraSettings interface)
- Modify: `utils/messages.ts:3-76` (MessageType constants)
- Modify: `utils/messages.ts:237-242` (ConfirmUploadMessage interface)
- Modify: `utils/messages.ts:254-263` (RecordingMeta interface)

**Step 1: Add `defaultSharingMode` to FloraSettings**

In `utils/settings.ts`, add the type and field:

```typescript
export type SharingMode = 'public' | 'unlisted' | 'private';

export interface FloraSettings {
  blossomServers: string[];
  nostrRelays: string[];
  publishToNostr: boolean;
  nostrPubkey: string;
  selectedCameraDeviceId: string | null;
  defaultSharingMode: SharingMode;
}
```

Add to DEFAULTS:
```typescript
defaultSharingMode: 'public',
```

**Step 2: Add new message types**

In `utils/messages.ts`, add to the MessageType object:

```typescript
// NIP-44 encryption proxy (via background -> scripting.executeScript)
NIP44_ENCRYPT: 'nip44_encrypt',

// Private sharing
SEND_PRIVATE: 'send_private',
PRIVATE_SEND_COMPLETE: 'private_send_complete',
PRIVATE_SEND_ERROR: 'private_send_error',

// Contact loading
FETCH_CONTACTS: 'fetch_contacts',
RESOLVE_NIP05: 'resolve_nip05',
FETCH_DM_RELAYS: 'fetch_dm_relays',
```

**Step 3: Update ConfirmUploadMessage to include sharing mode and recipients**

```typescript
export interface ConfirmUploadMessage extends BaseMessage {
  type: typeof MessageType.CONFIRM_UPLOAD;
  serverOverride?: string;
  publishToNostr: boolean;
  noteContent?: string;
  sharingMode: SharingMode;
  recipients?: Array<{ pubkey: string; name?: string; relays?: string[] }>;
}
```

**Step 4: Update RecordingMeta to include sharing info**

```typescript
export interface RecordingMeta {
  hash: string;
  size: number;
  duration: number;
  timestamp: number;
  uploaded: boolean;
  blossomUrl?: string;
  noteId?: string;
  thumbnail?: string;
  sharingMode?: SharingMode;
  encryptedBlobHash?: string;
  recipients?: Array<{ pubkey: string; name?: string }>;
}
```

**Step 5: Add the new message interfaces**

```typescript
export interface Nip44EncryptMessage extends BaseMessage {
  type: typeof MessageType.NIP44_ENCRYPT;
  recipientPubkey: string;
  plaintext: string;
}

export interface SendPrivateMessage extends BaseMessage {
  type: typeof MessageType.SEND_PRIVATE;
  target: 'offscreen';
  server: string;
  recipients: Array<{ pubkey: string; name?: string; relays?: string[] }>;
}

export interface PrivateSendCompleteMessage extends BaseMessage {
  type: typeof MessageType.PRIVATE_SEND_COMPLETE;
  recipientCount: number;
  encryptedBlobHash: string;
}

export interface PrivateSendErrorMessage extends BaseMessage {
  type: typeof MessageType.PRIVATE_SEND_ERROR;
  error: string;
}

export interface FetchContactsMessage extends BaseMessage {
  type: typeof MessageType.FETCH_CONTACTS;
}

export interface ResolveNip05Message extends BaseMessage {
  type: typeof MessageType.RESOLVE_NIP05;
  identifier: string;
}

export interface FetchDmRelaysMessage extends BaseMessage {
  type: typeof MessageType.FETCH_DM_RELAYS;
  pubkey: string;
}
```

Add all new interfaces to the `Message` union type.

**Step 6: Commit**

```bash
git add utils/settings.ts utils/messages.ts
git commit -m "feat(messages): add sharing mode, NIP-44, and private sharing message types"
```

---

### Task 2: Add NIP-44 encrypt proxy to background service worker

The seal layer of gift wrapping needs NIP-44 encryption, which requires the signer extension (`window.nostr.nip44.encrypt`). Like `signEventDirect`, this must route through `scripting.executeScript` on a web tab.

**Files:**
- Modify: `entrypoints/background.ts:150-167` (add nip44EncryptDirect after probeNip07Exists)
- Modify: `entrypoints/background.ts:236-776` (add message handler case)

**Step 1: Add `nip44EncryptDirect` function**

Add after `signEventDirect` (around line 228):

```typescript
async function nip44EncryptDirect(
  tabId: number,
  recipientPubkey: string,
  plaintext: string,
): Promise<{ ok: true; data: string } | { ok: false; error: string }> {
  try {
    const results = await (browser as any).scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [recipientPubkey, plaintext],
      func: (pubkey: string, text: string) => {
        const nostr = (window as any).nostr;
        if (!nostr) return { ok: false, error: 'No NIP-07 signer found' };
        if (!nostr.nip44?.encrypt) return { ok: false, error: 'Signer does not support NIP-44 encryption' };
        return Promise.race([
          nostr.nip44.encrypt(pubkey, text).then(
            (ct: string) => ct ? { ok: true, data: ct } : { ok: false, error: 'nip44.encrypt returned empty' },
            (err: any) => ({ ok: false, error: String(err) }),
          ),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'NIP-44 encrypt timed out (10s)' }), 10000)),
        ]);
      },
    });
    return results?.[0]?.result || { ok: false, error: 'no result' };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
```

**Step 2: Add `probeNip44Support` function**

Add after `nip44EncryptDirect`:

```typescript
async function probeNip44Support(tabId: number): Promise<boolean> {
  try {
    const results = await (browser as any).scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const nostr = (window as any).nostr;
        return !!(nostr?.nip44?.encrypt && nostr?.nip44?.decrypt);
      },
    });
    return results?.[0]?.result === true;
  } catch {
    return false;
  }
}
```

**Step 3: Add NIP44_ENCRYPT message handler**

In the message handler switch, add:

```typescript
case MessageType.NIP44_ENCRYPT: {
  const msg = message as any;
  findScriptableTab()
    .then(async (tabId) => {
      if (!tabId) return sendResponse({ ok: false, error: 'No web tab available for NIP-44' });
      const result = await nip44EncryptDirect(tabId, msg.recipientPubkey, msg.plaintext);
      sendResponse(result);
    })
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
}
```

**Step 4: Update GET_CONFIRM_DATA to include NIP-44 support status**

In the `GET_CONFIRM_DATA` handler (line 603), add NIP-44 probing:

```typescript
case MessageType.GET_CONFIRM_DATA: {
  Promise.all([
    getSettings(),
    findScriptableTab().then(async (tabId) => {
      if (!tabId) return { error: 'No web tab available', nip44: false };
      const probe = await probeNip07Exists(tabId);
      const nip44 = 'available' in probe ? await probeNip44Support(tabId) : false;
      return { ...probe, nip44 };
    }).catch((err: any) => ({ error: err.message, nip44: false })),
  ])
    .then(([settings, signerResult]) => {
      const signerAvailable = 'available' in signerResult;
      const npub = settings.nostrPubkey || null;
      const bridgeError = 'error' in signerResult ? signerResult.error : null;
      sendResponse({
        server: settings.blossomServers[0] || 'https://blossom.band',
        relays: settings.nostrRelays,
        publishToNostr: settings.publishToNostr,
        defaultSharingMode: settings.defaultSharingMode,
        fileSize: lastRecordingMeta?.size ?? 0,
        duration: lastRecordingMeta?.duration ?? 0,
        npub,
        signerAvailable,
        bridgeError: signerAvailable ? null : bridgeError,
        nip44Supported: (signerResult as any).nip44 === true,
      });
    })
    .catch((err) => {
      console.error('[background] GET_CONFIRM_DATA error:', err);
      sendResponse(null);
    });
  return true;
}
```

**Step 5: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat(background): add NIP-44 encrypt proxy and NIP-44 support probing"
```

---

### Task 3: Add contact fetching to background service worker

Fetch the user's Kind 3 follow list and Kind 0 profiles from relays, and resolve NIP-05 identifiers. These run in the background service worker because they're plain relay/HTTP requests that don't need DOM access.

**Files:**
- Modify: `entrypoints/background.ts` (add contact fetch handlers)

**Step 1: Add relay helper imports**

At the top of `background.ts`, add:

```typescript
import { SimplePool } from 'nostr-tools/pool';
import { decode as decodeNip19 } from 'nostr-tools/nip19';
```

**Step 2: Add `fetchContacts` function**

Add before `export default defineBackground`:

```typescript
async function fetchContacts(pubkey: string, relays: string[]): Promise<Array<{ pubkey: string; name?: string; avatar?: string; nip05?: string }>> {
  const pool = new SimplePool();
  try {
    // Fetch Kind 3 (follow list)
    const kind3 = await pool.get(relays, { kinds: [3], authors: [pubkey], limit: 1 });
    if (!kind3) return [];

    const followPubkeys = kind3.tags
      .filter((t) => t[0] === 'p' && t[1])
      .map((t) => t[1]);

    if (followPubkeys.length === 0) return [];

    // Fetch Kind 0 (profiles) for all follows — batch in groups of 50
    const profiles: Array<{ pubkey: string; name?: string; avatar?: string; nip05?: string }> = [];
    const batchSize = 50;
    for (let i = 0; i < followPubkeys.length; i += batchSize) {
      const batch = followPubkeys.slice(i, i + batchSize);
      const events = await pool.querySync(relays, { kinds: [0], authors: batch, limit: batch.length });
      for (const evt of events) {
        try {
          const meta = JSON.parse(evt.content);
          profiles.push({
            pubkey: evt.pubkey,
            name: meta.display_name || meta.name || undefined,
            avatar: meta.picture || undefined,
            nip05: meta.nip05 || undefined,
          });
        } catch {
          profiles.push({ pubkey: evt.pubkey });
        }
      }
    }

    // Include follows without profiles
    for (const pk of followPubkeys) {
      if (!profiles.some((p) => p.pubkey === pk)) {
        profiles.push({ pubkey: pk });
      }
    }

    return profiles;
  } finally {
    pool.close(relays);
  }
}

async function fetchDmRelays(pubkey: string, relays: string[]): Promise<string[]> {
  const pool = new SimplePool();
  try {
    const kind10050 = await pool.get(relays, { kinds: [10050], authors: [pubkey], limit: 1 });
    if (!kind10050) return [];
    return kind10050.tags
      .filter((t) => t[0] === 'relay' && t[1])
      .map((t) => t[1]);
  } finally {
    pool.close(relays);
  }
}
```

**Step 3: Add message handlers for contact fetching**

In the switch statement, add:

```typescript
case MessageType.FETCH_CONTACTS: {
  getSettings()
    .then((settings) => {
      if (!settings.nostrPubkey) return sendResponse({ contacts: [] });
      return fetchContacts(settings.nostrPubkey, settings.nostrRelays)
        .then((contacts) => sendResponse({ contacts }));
    })
    .catch((err) => {
      console.error('[background] FETCH_CONTACTS error:', err);
      sendResponse({ contacts: [] });
    });
  return true;
}

case MessageType.RESOLVE_NIP05: {
  const identifier = (message as any).identifier;
  // NIP-05 resolution is an HTTPS fetch — no CORS issues from service worker
  import('nostr-tools/nip05').then(async ({ queryProfile }) => {
    try {
      const profile = await queryProfile(identifier);
      sendResponse(profile ? { pubkey: profile.pubkey, relays: profile.relays } : { error: 'Not found' });
    } catch (err: any) {
      sendResponse({ error: err.message });
    }
  });
  return true;
}

case MessageType.FETCH_DM_RELAYS: {
  const pubkey = (message as any).pubkey;
  getSettings()
    .then((settings) => fetchDmRelays(pubkey, settings.nostrRelays))
    .then((relays) => sendResponse({ relays }))
    .catch((err) => {
      console.error('[background] FETCH_DM_RELAYS error:', err);
      sendResponse({ relays: [] });
    });
  return true;
}
```

**Step 4: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat(background): add contact fetching, NIP-05 resolution, and DM relay lookup"
```

---

### Task 4: Add AES-GCM encryption and NIP-17 gift wrapping to offscreen document

This is the core encryption logic. The offscreen document encrypts the video with AES-GCM, uploads the encrypted blob, builds Kind 15 events, and gift-wraps them for each recipient.

**Files:**
- Modify: `entrypoints/offscreen/main.ts:537-560` (add nip44Encrypt helper alongside existing signer helpers)
- Modify: `entrypoints/offscreen/main.ts:620-676` (add private send function after publishNote)
- Modify: `entrypoints/offscreen/main.ts:679-781` (add message handler case)

**Step 1: Add imports**

At the top of `offscreen/main.ts`, add:

```typescript
import { generateSecretKey, getPublicKey as getKeyPublicKey, finalizeEvent, getEventHash } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';
```

**Step 2: Add NIP-44 encrypt helper (routes through background -> NIP-07 signer)**

Add after `getPublicKey()` function (around line 560):

```typescript
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
```

**Step 3: Add AES-GCM encryption helper**

```typescript
async function encryptVideo(buffer: ArrayBuffer): Promise<{
  encrypted: ArrayBuffer;
  key: Uint8Array;
  nonce: Uint8Array;
}> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cryptoKey, buffer);
  return { encrypted, key, nonce };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

**Step 4: Add gift-wrap function**

This builds the NIP-59 layers manually using NIP-07 for the seal and a local ephemeral key for the wrap:

```typescript
async function giftWrapKind15(
  rumor: { kind: number; content: string; tags: string[][]; created_at: number; pubkey: string },
  recipientPubkey: string,
): Promise<any> {
  const rumorWithId = { ...rumor, id: getEventHash(rumor) };

  // Layer 1: Seal (kind 13) — encrypt rumor with NIP-44 via signer
  const sealContent = await nip44Encrypt(recipientPubkey, JSON.stringify(rumorWithId));
  const sealDraft = {
    kind: 13,
    content: sealContent,
    tags: [] as string[][],
    // Randomize created_at up to 2 days in the past for privacy
    created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800),
  };

  // Sign seal with real identity via NIP-07
  const signer = createSigner();
  const signedSeal = await signer(sealDraft);

  // Layer 2: Gift Wrap (kind 1059) — encrypt seal with ephemeral key
  const ephemeralSk = generateSecretKey();
  const ephemeralPk = getKeyPublicKey(ephemeralSk);
  const conversationKey = nip44.v2.utils.getConversationKey(ephemeralSk, recipientPubkey);
  const wrapContent = nip44.v2.encrypt(JSON.stringify(signedSeal), conversationKey);

  const wrap = finalizeEvent({
    kind: 1059,
    content: wrapContent,
    tags: [['p', recipientPubkey]],
    created_at: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 172800),
  }, ephemeralSk);

  return wrap;
}
```

**Step 5: Add `sendPrivate` function**

```typescript
async function sendPrivate(
  server: string,
  recipients: Array<{ pubkey: string; name?: string; relays?: string[] }>,
) {
  try {
    // 1. Get the latest recording from IDB
    const db = await openDB();
    const tx = db.transaction('recordings', 'readonly');
    const store = tx.objectStore('recordings');
    const recording = await new Promise<any>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const recordings = req.result;
        if (!recordings?.length) { reject(new Error('No recording found')); return; }
        recordings.sort((a: any, b: any) => b.timestamp - a.timestamp);
        resolve(recordings[0]);
      };
      req.onerror = () => reject(req.error);
    });
    db.close();

    const originalBuffer: ArrayBuffer = recording.data;
    const originalHash = recording.hash;

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
    browser.runtime.sendMessage({
      type: MessageType.UPLOAD_PROGRESS,
      bytesUploaded: encryptedBlob.size,
      totalBytes: encryptedBlob.size,
      serverName: 'Sending to recipients\u2026',
    });

    const pool = new SimplePool();
    let sent = 0;

    for (const recipient of recipients) {
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

      // Publish to recipient's DM relays
      const targetRelays = recipient.relays?.length
        ? recipient.relays
        : ['wss://nos.lol', 'wss://relay.damus.io']; // fallback

      try {
        const publishPromises = pool.publish(targetRelays, wrap);
        await Promise.allSettled(
          publishPromises.map((p) =>
            Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))]),
          ),
        );
        sent++;
        console.log('[offscreen] gift wrap sent to ' + recipient.pubkey.slice(0, 8) + '\u2026 (' + sent + '/' + recipients.length + ')');
      } catch (err) {
        console.error('[offscreen] failed to send to ' + recipient.pubkey.slice(0, 8) + '\u2026:', err);
      }
    }

    pool.close(recipients.flatMap((r) => r.relays || ['wss://nos.lol', 'wss://relay.damus.io']));

    // 6. Mark recording in IDB
    await markPrivate(originalHash, encryptedBlobHash, recipients);

    browser.runtime.sendMessage({
      type: MessageType.PRIVATE_SEND_COMPLETE,
      recipientCount: sent,
      encryptedBlobHash,
    });
  } catch (err) {
    console.error('[offscreen] private send error:', err);
    browser.runtime.sendMessage({
      type: MessageType.PRIVATE_SEND_ERROR,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

**Step 6: Add `markPrivate` IDB helper**

Add alongside `markUploaded`:

```typescript
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
```

**Step 7: Add message handler for SEND_PRIVATE**

In the offscreen message handler switch:

```typescript
case MessageType.SEND_PRIVATE: {
  const msg = message as any;
  sendPrivate(msg.server, msg.recipients);
  sendResponse({ ok: true });
  return false;
}
```

**Step 8: Commit**

```bash
git add entrypoints/offscreen/main.ts
git commit -m "feat(offscreen): add AES-GCM encryption, Kind 15 construction, NIP-59 gift wrapping"
```

---

### Task 5: Add private sharing state flow to background service worker

Wire the CONFIRM_UPLOAD handler to route Private mode through the new `SEND_PRIVATE` path, and handle completion/error messages.

**Files:**
- Modify: `entrypoints/background.ts:636-657` (CONFIRM_UPLOAD handler)
- Modify: `entrypoints/background.ts:7-13` (state variables)

**Step 1: Add state variables for private sharing**

After `pendingNoteContent` (line 13), add:

```typescript
let pendingSharingMode: SharingMode = 'public';
let pendingRecipients: Array<{ pubkey: string; name?: string; relays?: string[] }> = [];
```

Import `SharingMode` from settings:

```typescript
import { getSettings, saveSettings, type SharingMode } from '@/utils/settings';
```

(Note: `saveSettings` is already used at line 594.)

**Step 2: Update CONFIRM_UPLOAD handler**

Replace the existing CONFIRM_UPLOAD case (lines 636-657):

```typescript
case MessageType.CONFIRM_UPLOAD: {
  const msg = message as any;
  const sharingMode: SharingMode = msg.sharingMode || 'public';
  pendingSharingMode = sharingMode;
  pendingPublishToNostr = sharingMode === 'public';
  pendingNoteContent = msg.noteContent;
  pendingRecipients = msg.recipients || [];

  setState('uploading');

  getSettings().then((settings) => {
    const server = msg.serverOverride || settings.blossomServers[0];
    return ensureOffscreenDocument().then(() => {
      if (sharingMode === 'private') {
        return browser.runtime.sendMessage({
          type: MessageType.SEND_PRIVATE,
          target: 'offscreen',
          server,
          recipients: pendingRecipients,
        });
      } else {
        return browser.runtime.sendMessage({
          type: MessageType.START_UPLOAD,
          target: 'offscreen',
          server,
        });
      }
    });
  }).catch((err) => {
    console.error('[background] confirm upload failed:', err);
    lastError = err instanceof Error ? err.message : String(err);
    setState('error');
  });
  sendResponse({ ok: true });
  return false;
}
```

**Step 3: Add PRIVATE_SEND_COMPLETE handler**

```typescript
case MessageType.PRIVATE_SEND_COMPLETE: {
  const msg = message as any;
  console.log('[background] private send complete: ' + msg.recipientCount + ' recipients');
  uploadResult = { url: '', sha256: msg.encryptedBlobHash, size: 0 };
  publishResult = null;
  setState('complete');
  return false;
}

case MessageType.PRIVATE_SEND_ERROR: {
  const errMsg = (message as any).error || 'Private send failed';
  console.error('[background] private send error:', errMsg);
  lastError = errMsg;
  setState('error');
  return false;
}
```

**Step 4: Update GET_RESULT handler for private mode**

Update the GET_RESULT case (line 259) to include sharing context:

```typescript
case MessageType.GET_RESULT:
  sendResponse({
    uploadResult,
    publishResult,
    sharingMode: pendingSharingMode,
    recipients: pendingRecipients,
  });
  return false;
```

**Step 5: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat(background): wire private sharing flow through CONFIRM_UPLOAD and completion handlers"
```

---

### Task 6: Update review page HTML for sharing mode picker and recipient input

**Files:**
- Modify: `entrypoints/review/index.html:46-75` (view-confirm section)
- Modify: `entrypoints/review/index.html:87-97` (view-complete section)

**Step 1: Replace the publish toggle with sharing mode picker**

Replace the confirm view's destination card (lines 50-67) with:

```html
<div class="destination-card editable">
  <h2>Review before sharing</h2>
  <div class="field">
    <label for="confirm-server">Upload to</label>
    <input type="text" id="confirm-server" class="field-input" placeholder="https://blossom.band" />
  </div>
  <div class="field">
    <label>Sharing</label>
    <div id="sharing-mode-picker" class="sharing-mode-picker">
      <button class="sharing-mode-btn active" data-mode="public">Public</button>
      <button class="sharing-mode-btn" data-mode="unlisted">Unlisted</button>
      <button class="sharing-mode-btn" data-mode="private">Private</button>
    </div>
  </div>
  <div id="public-options" class="field">
    <div id="confirm-relays" class="field-sub"></div>
  </div>
  <div id="private-options" style="display:none">
    <div class="field">
      <label for="recipient-input">Send to</label>
      <div class="recipient-chips" id="recipient-chips"></div>
      <div class="recipient-input-wrap">
        <input type="text" id="recipient-input" class="field-input" placeholder="npub, name, or user@domain" autocomplete="off" />
        <div id="recipient-dropdown" class="recipient-dropdown" style="display:none"></div>
      </div>
    </div>
  </div>
  <div class="field">
    <label>Signing as</label>
    <div id="confirm-identity" class="field-value mono"></div>
  </div>
</div>
```

**Step 2: Update complete view for private mode**

Replace the complete section (lines 87-97) with:

```html
<div id="view-complete" class="view" style="display:none">
  <div class="complete-section">
    <div class="complete-icon">&#10003;</div>
    <div id="complete-title" class="complete-title">You're live</div>
    <a id="result-link" class="result-link" target="_blank"></a>
    <div id="complete-recipients" class="complete-recipients" style="display:none"></div>
    <div class="actions">
      <button id="btn-copy" class="btn-primary">Copy link</button>
      <button id="btn-new" class="btn-secondary">Record another</button>
    </div>
  </div>
</div>
```

**Step 3: Commit**

```bash
git add entrypoints/review/index.html
git commit -m "feat(review): add sharing mode picker and recipient input HTML"
```

---

### Task 7: Add recipient picker styles

**Files:**
- Modify: `entrypoints/review/style.css` (add styles for sharing mode picker, recipient chips, dropdown)

**Step 1: Add sharing mode picker styles**

```css
.sharing-mode-picker {
  display: flex;
  gap: var(--fl-space-xs);
  background: rgba(255, 255, 255, 0.04);
  border-radius: var(--fl-radius-md);
  padding: 3px;
}

.sharing-mode-btn {
  flex: 1;
  padding: 6px 12px;
  border: none;
  border-radius: var(--fl-radius-sm);
  background: transparent;
  color: var(--fl-text-secondary, #9ca3af);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.sharing-mode-btn:hover {
  color: var(--fl-text-primary, #f0f0f2);
}

.sharing-mode-btn.active {
  background: rgba(255, 255, 255, 0.1);
  color: var(--fl-text-primary, #f0f0f2);
}

.sharing-mode-btn[data-mode="private"].active {
  background: rgba(155, 110, 199, 0.2);
  color: var(--fl-accent-violet, #9b6ec7);
}
```

**Step 2: Add recipient chip styles**

```css
.recipient-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fl-space-xs);
  margin-bottom: var(--fl-space-xs);
}

.recipient-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 4px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: var(--fl-radius-pill);
  font-size: 12px;
  color: var(--fl-text-primary, #f0f0f2);
}

.recipient-chip img {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.recipient-chip .chip-avatar-placeholder {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--fl-text-secondary, #9ca3af);
}

.recipient-chip .chip-remove {
  background: none;
  border: none;
  color: var(--fl-text-muted, #6b7280);
  cursor: pointer;
  padding: 0 2px;
  font-size: 14px;
  line-height: 1;
}

.recipient-chip .chip-remove:hover {
  color: var(--fl-text-primary, #f0f0f2);
}

.recipient-chip .chip-warning {
  color: var(--fl-warning, #fbbf24);
  font-size: 11px;
  cursor: help;
}
```

**Step 3: Add dropdown styles**

```css
.recipient-input-wrap {
  position: relative;
}

.recipient-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 10;
  background: var(--fl-bg-elevated, #1a1a1f);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--fl-radius-sm);
  margin-top: 4px;
  max-height: 200px;
  overflow-y: auto;
}

.recipient-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--fl-text-primary, #f0f0f2);
}

.recipient-option:hover,
.recipient-option.highlighted {
  background: rgba(255, 255, 255, 0.06);
}

.recipient-option img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

.recipient-option .option-name {
  font-weight: 500;
}

.recipient-option .option-nip05 {
  color: var(--fl-text-muted, #6b7280);
  font-size: 12px;
}

.complete-recipients {
  font-size: 13px;
  color: var(--fl-text-secondary, #9ca3af);
  margin-top: var(--fl-space-sm);
}
```

**Step 4: Commit**

```bash
git add entrypoints/review/style.css
git commit -m "feat(review): add sharing mode picker, recipient chip, and dropdown styles"
```

---

### Task 8: Wire up sharing mode picker and recipient input in review page JS

This is the largest task. It wires the sharing mode buttons, loads contacts, handles the recipient input with autocomplete, and updates the confirm flow.

**Files:**
- Modify: `entrypoints/review/main.ts` (major changes to confirm flow)

**Step 1: Add new element refs**

After the existing confirm view refs (line 30), add:

```typescript
// Sharing mode
const sharingModePicker = document.getElementById('sharing-mode-picker') as HTMLDivElement;
const publicOptions = document.getElementById('public-options') as HTMLDivElement;
const privateOptions = document.getElementById('private-options') as HTMLDivElement;
const recipientInput = document.getElementById('recipient-input') as HTMLInputElement;
const recipientChips = document.getElementById('recipient-chips') as HTMLDivElement;
const recipientDropdown = document.getElementById('recipient-dropdown') as HTMLDivElement;

// Complete view (updated)
const completeTitle = document.getElementById('complete-title') as HTMLDivElement;
const completeRecipients = document.getElementById('complete-recipients') as HTMLDivElement;
```

**Step 2: Add state for sharing mode and contacts**

```typescript
import type { SharingMode } from '@/utils/settings';

let currentSharingMode: SharingMode = 'public';
let selectedRecipients: Array<{
  pubkey: string;
  name?: string;
  avatar?: string;
  nip05?: string;
  relays?: string[];
  hasDmRelays?: boolean;
}> = [];
let contacts: Array<{ pubkey: string; name?: string; avatar?: string; nip05?: string }> = [];
let contactsLoaded = false;
let recentRecipients: Array<{ pubkey: string; name?: string; avatar?: string; nip05?: string }> = [];
let highlightedIndex = -1;
```

**Step 3: Add sharing mode picker logic**

```typescript
function setSharingMode(mode: SharingMode) {
  currentSharingMode = mode;
  sharingModePicker.querySelectorAll('.sharing-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.mode === mode);
  });
  publicOptions.style.display = mode === 'public' ? 'block' : 'none';
  privateOptions.style.display = mode === 'private' ? '' : 'none';
  updateConfirmButton();
}

sharingModePicker.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.sharing-mode-btn') as HTMLElement;
  if (!btn?.dataset.mode) return;
  const mode = btn.dataset.mode as SharingMode;
  if (mode === 'private') {
    // Check NIP-44 support before allowing private mode
    const data = (window as any).__confirmData;
    if (data && !data.nip44Supported) {
      confirmWarning.textContent = 'Your signer extension does not support NIP-44 encryption. Update it or switch to nos2x/Alby.';
      confirmWarning.style.display = 'block';
      return;
    }
    if (!contactsLoaded) loadContacts();
  }
  confirmWarning.style.display = 'none';
  setSharingMode(mode);
});
```

**Step 4: Add contact loading**

```typescript
async function loadContacts() {
  const response = await browser.runtime.sendMessage({ type: MessageType.FETCH_CONTACTS });
  contacts = response?.contacts || [];
  contactsLoaded = true;

  // Load recent recipients from storage
  const stored = await browser.storage.local.get('recentRecipients');
  recentRecipients = stored.recentRecipients || [];
}
```

**Step 5: Add recipient input handling**

```typescript
function renderChips() {
  while (recipientChips.firstChild) recipientChips.removeChild(recipientChips.firstChild);
  for (const r of selectedRecipients) {
    const chip = document.createElement('div');
    chip.className = 'recipient-chip';

    if (r.avatar) {
      const img = document.createElement('img');
      img.src = r.avatar;
      img.alt = '';
      chip.append(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'chip-avatar-placeholder';
      ph.textContent = (r.name || r.pubkey)?.[0]?.toUpperCase() || '?';
      chip.append(ph);
    }

    const name = document.createElement('span');
    name.textContent = r.name || truncateKey(r.pubkey);
    chip.append(name);

    if (r.hasDmRelays === false) {
      const warn = document.createElement('span');
      warn.className = 'chip-warning';
      warn.textContent = '\u26a0';
      warn.title = 'No DM relays found \u2014 may not receive';
      chip.append(warn);
    }

    const remove = document.createElement('button');
    remove.className = 'chip-remove';
    remove.textContent = '\u00d7';
    remove.addEventListener('click', () => {
      selectedRecipients = selectedRecipients.filter((s) => s.pubkey !== r.pubkey);
      renderChips();
      updateConfirmButton();
    });
    chip.append(remove);

    recipientChips.append(chip);
  }
}

function renderDropdown(query: string) {
  while (recipientDropdown.firstChild) recipientDropdown.removeChild(recipientDropdown.firstChild);
  highlightedIndex = -1;

  const q = query.toLowerCase().trim();
  let matches: typeof contacts;

  if (!q) {
    // Show recent recipients when empty
    matches = recentRecipients.slice(0, 5);
  } else {
    matches = contacts.filter((c) => {
      if (selectedRecipients.some((s) => s.pubkey === c.pubkey)) return false;
      return (
        c.name?.toLowerCase().includes(q) ||
        c.nip05?.toLowerCase().includes(q) ||
        c.pubkey.startsWith(q)
      );
    }).slice(0, 8);
  }

  if (matches.length === 0) {
    recipientDropdown.style.display = 'none';
    return;
  }

  for (const contact of matches) {
    const opt = document.createElement('div');
    opt.className = 'recipient-option';

    if (contact.avatar) {
      const img = document.createElement('img');
      img.src = contact.avatar;
      img.alt = '';
      opt.append(img);
    }

    const info = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'option-name';
    nameEl.textContent = contact.name || truncateKey(contact.pubkey);
    info.append(nameEl);
    if (contact.nip05) {
      const nip05El = document.createElement('div');
      nip05El.className = 'option-nip05';
      nip05El.textContent = contact.nip05;
      info.append(nip05El);
    }
    opt.append(info);

    opt.addEventListener('click', () => selectRecipient(contact));
    recipientDropdown.append(opt);
  }

  recipientDropdown.style.display = 'block';
}

async function selectRecipient(contact: { pubkey: string; name?: string; avatar?: string; nip05?: string }) {
  if (selectedRecipients.some((r) => r.pubkey === contact.pubkey)) return;

  // Fetch DM relays for this recipient
  const relayResult = await browser.runtime.sendMessage({
    type: MessageType.FETCH_DM_RELAYS,
    pubkey: contact.pubkey,
  });
  const relays = relayResult?.relays || [];

  selectedRecipients.push({
    ...contact,
    relays,
    hasDmRelays: relays.length > 0,
  });

  recipientInput.value = '';
  recipientDropdown.style.display = 'none';
  renderChips();
  updateConfirmButton();
  recipientInput.focus();
}

// Handle npub paste and NIP-05 resolution
async function handleDirectInput(value: string) {
  const trimmed = value.trim();

  // npub
  if (trimmed.startsWith('npub1')) {
    try {
      const { decode } = await import('nostr-tools/nip19');
      const decoded = decode(trimmed);
      if (decoded.type === 'npub') {
        const pubkey = decoded.data as string;
        const existing = contacts.find((c) => c.pubkey === pubkey);
        await selectRecipient(existing || { pubkey });
        return true;
      }
    } catch { /* invalid npub */ }
  }

  // NIP-05
  if (trimmed.includes('@')) {
    const result = await browser.runtime.sendMessage({
      type: MessageType.RESOLVE_NIP05,
      identifier: trimmed,
    });
    if (result?.pubkey) {
      const existing = contacts.find((c) => c.pubkey === result.pubkey);
      await selectRecipient(existing || { pubkey: result.pubkey, nip05: trimmed });
      return true;
    }
  }

  // 64-char hex
  if (/^[0-9a-f]{64}$/.test(trimmed)) {
    const existing = contacts.find((c) => c.pubkey === trimmed);
    await selectRecipient(existing || { pubkey: trimmed });
    return true;
  }

  return false;
}

recipientInput.addEventListener('input', () => {
  renderDropdown(recipientInput.value);
});

recipientInput.addEventListener('focus', () => {
  renderDropdown(recipientInput.value);
});

recipientInput.addEventListener('blur', () => {
  // Delay to allow click events on dropdown options
  setTimeout(() => { recipientDropdown.style.display = 'none'; }, 200);
});

recipientInput.addEventListener('keydown', async (e) => {
  const options = recipientDropdown.querySelectorAll('.recipient-option');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlightedIndex = Math.min(highlightedIndex + 1, options.length - 1);
    options.forEach((o, i) => o.classList.toggle('highlighted', i === highlightedIndex));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlightedIndex = Math.max(highlightedIndex - 1, 0);
    options.forEach((o, i) => o.classList.toggle('highlighted', i === highlightedIndex));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (highlightedIndex >= 0 && options[highlightedIndex]) {
      (options[highlightedIndex] as HTMLElement).click();
    } else if (recipientInput.value.trim()) {
      await handleDirectInput(recipientInput.value);
    }
  }
});
```

**Step 6: Update `updateConfirmButton` and `showConfirm`**

```typescript
function updateConfirmButton() {
  if (currentSharingMode === 'private') {
    btnConfirm.disabled = selectedRecipients.length === 0;
    btnConfirm.textContent = selectedRecipients.length === 0
      ? 'Add recipients'
      : 'Send privately to ' + selectedRecipients.length;
  } else {
    btnConfirm.disabled = false;
    btnConfirm.textContent = currentSharingMode === 'unlisted' ? 'Upload' : 'Upload & Publish';
  }
}
```

Update `showConfirm()` -- replace the `confirmPublish` toggle logic with sharing mode initialization:

```typescript
async function showConfirm() {
  showView(viewConfirm);

  const data = await getConfirmData();
  if (!data) return;
  (window as any).__confirmData = data; // Stash for NIP-44 check

  const parts: string[] = [];
  if (data.fileSize) parts.push(formatBytes(data.fileSize));
  if (data.duration) parts.push(formatDuration(data.duration));
  confirmMeta.textContent = parts.join(' \u00b7 ');

  confirmServer.value = data.server;

  // Initialize sharing mode from settings default
  const defaultMode = data.defaultSharingMode || (data.publishToNostr ? 'public' : 'unlisted');
  setSharingMode(defaultMode);

  // Show relays for public mode
  confirmRelays.textContent = data.relays?.join(', ') || '';

  renderSignerStatus(data, confirmIdentity, confirmWarning, btnConfirm);

  // Reset recipient state
  selectedRecipients = [];
  renderChips();

  confirmLocked = false;
  updateConfirmButton();
}
```

**Step 7: Update the confirm button click handler**

Replace the existing `btnConfirm` click handler (lines 303-314):

```typescript
btnConfirm.addEventListener('click', async () => {
  if (confirmLocked) return;
  confirmLocked = true;
  btnConfirm.disabled = true;
  btnConfirm.textContent = currentSharingMode === 'private' ? 'Encrypting\u2026' : 'Uploading\u2026';

  // Save recent recipients for private mode
  if (currentSharingMode === 'private' && selectedRecipients.length) {
    const recent = selectedRecipients.map((r) => ({
      pubkey: r.pubkey, name: r.name, avatar: r.avatar, nip05: r.nip05,
    }));
    const stored = await browser.storage.local.get('recentRecipients');
    const existing: any[] = stored.recentRecipients || [];
    const merged = [...recent, ...existing.filter((e: any) => !recent.some((r) => r.pubkey === e.pubkey))].slice(0, 20);
    await browser.storage.local.set({ recentRecipients: merged });
  }

  await browser.runtime.sendMessage({
    type: MessageType.CONFIRM_UPLOAD,
    serverOverride: confirmServer.value.trim() || undefined,
    publishToNostr: currentSharingMode === 'public',
    sharingMode: currentSharingMode,
    recipients: currentSharingMode === 'private'
      ? selectedRecipients.map((r) => ({ pubkey: r.pubkey, name: r.name, relays: r.relays }))
      : undefined,
  });
});
```

**Step 8: Update the complete view handler**

In `updateUI`, update the `complete` case:

```typescript
case 'complete': {
  showView(viewComplete);
  const result = await browser.runtime.sendMessage({ type: MessageType.GET_RESULT });

  if (result?.sharingMode === 'private') {
    completeTitle.textContent = 'Sent privately';
    resultLink.style.display = 'none';
    btnCopy.style.display = 'none';
    const names = result.recipients?.map((r: any) => r.name || truncateKey(r.pubkey)).join(', ') || '';
    completeRecipients.textContent = 'Delivered to ' + names;
    completeRecipients.style.display = 'block';
  } else {
    completeTitle.textContent = result?.sharingMode === 'unlisted' ? 'Uploaded' : "You're live";
    const url = result?.publishResult?.blossomUrl || result?.uploadResult?.url;
    if (url) {
      resultLink.href = url;
      resultLink.textContent = url;
      resultLink.style.display = 'block';
    }
    btnCopy.style.display = '';
    completeRecipients.style.display = 'none';
  }
  break;
}
```

**Step 9: Commit**

```bash
git add entrypoints/review/main.ts
git commit -m "feat(review): wire sharing mode picker, recipient input with autocomplete, and private complete view"
```

---

### Task 9: Update recordings library for private sharing badges

**Files:**
- Modify: `entrypoints/recordings/main.ts:434-444` (badge rendering in createCard)
- Modify: `entrypoints/recordings/style.css`

**Step 1: Update badge rendering**

Find the badge rendering section in `createCard()` and update it to handle the new sharing modes:

```typescript
// Badge rendering -- replace existing uploaded/posted badges
if (recording.sharingMode === 'private') {
  const badge = document.createElement('div');
  badge.className = 'badge badge-private';
  badge.textContent = 'Private';
  badge.title = recording.recipients?.map((r: any) => r.name || r.pubkey.slice(0, 8)).join(', ') || '';
  thumbnailWrap.append(badge);
} else if (recording.noteId) {
  const badge = document.createElement('div');
  badge.className = 'badge badge-posted';
  badge.textContent = 'Posted';
  thumbnailWrap.append(badge);
} else if (recording.uploaded) {
  const badge = document.createElement('div');
  badge.className = 'badge badge-uploaded';
  badge.textContent = 'Uploaded';
  thumbnailWrap.append(badge);
}
```

**Step 2: Add private badge style**

In `entrypoints/recordings/style.css`, add:

```css
.badge-private {
  background: rgba(155, 110, 199, 0.2);
  color: var(--fl-accent-violet, #9b6ec7);
}
```

**Step 3: Commit**

```bash
git add entrypoints/recordings/main.ts entrypoints/recordings/style.css
git commit -m "feat(recordings): add Private badge for encrypted recordings"
```

---

### Task 10: Build and smoke test

**Step 1: TypeScript check**

```bash
npm run compile
```

Fix any type errors.

**Step 2: Build**

```bash
npm run build
```

Fix any build errors.

**Step 3: Manual smoke test checklist**

Load the extension in Chrome and test:

1. **Public mode** -- Record, confirm with Public selected, upload. Verify Kind 1 note published, Blossom URL shown, Copy Link works. (Regression test -- should work exactly as before.)
2. **Unlisted mode** -- Record, confirm with Unlisted selected, upload. Verify no Nostr event published, Blossom URL shown, Copy Link works.
3. **Private mode -- recipient picker:**
   - Select Private mode, verify recipient input appears
   - Type a name, verify autocomplete dropdown shows contacts from follow list
   - Paste an npub, verify it resolves and appears as a chip
   - Type a NIP-05 identifier, verify it resolves
   - Add multiple recipients, verify chips render with avatars and names
   - Remove a recipient chip
   - Verify warning badge on recipients without Kind 10050
4. **Private mode -- send:**
   - Add recipients, click confirm
   - Verify progress shows "Encrypting..." then "Sending to recipients..."
   - Verify complete screen shows "Sent privately" with recipient names
   - Verify no Copy Link button on private complete screen
5. **Private mode -- library:**
   - Check recordings page shows "Private" badge on encrypted recording
   - Hover badge to see recipient names in tooltip
6. **NIP-44 unsupported signer:**
   - If possible, test with a signer that doesn't support NIP-44
   - Verify Private mode shows warning and doesn't activate

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address smoke test issues"
```
