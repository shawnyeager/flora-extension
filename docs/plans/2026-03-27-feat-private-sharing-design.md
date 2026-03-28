---
status: approved
date: 2026-03-27
scope: private encrypted video sharing via NIP-17 Kind 15
---

# Private Sharing — Design

## Overview

Add private encrypted video sharing to Flora. Recordings are encrypted client-side with AES-GCM, uploaded as opaque blobs to Blossom, and delivered to recipients via NIP-17 Kind 15 file messages (gift-wrapped). Recipients view the video in any Nostr client that supports Kind 15 DMs (0xchat, Amethyst).

## Sharing Modes

The confirm screen gets a three-way mode picker replacing the current "Publish to Nostr" toggle:

- **Public** — Upload to Blossom + publish Kind 1 note to relays. Complete screen shows Blossom URL + Copy Link. (Current behavior.)
- **Unlisted** — Upload to Blossom, no Nostr event. Complete screen shows Blossom URL + Copy Link.
- **Private** — Encrypt with AES-GCM, upload encrypted blob to Blossom, send Kind 15 via NIP-17 to recipients. Complete screen shows "Sent to [names]" confirmation. No link to copy.

Private mode shows an inline recipient picker below the mode selector. Confirm button disabled until at least one valid recipient is added.

## Encryption & Upload Flow

When the user confirms a Private share:

1. Generate a random AES-256-GCM key and 12-byte nonce via `crypto.getRandomValues()` in the offscreen document.
2. Encrypt the MP4 buffer with `crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, buffer)`.
3. Upload the encrypted blob to Blossom via `BlossomClient.uploadBlob()`. The SHA-256 hash of the encrypted blob becomes the content address.
4. Build a Kind 15 event (unsigned rumor):

```jsonc
{
  "kind": 15,
  "content": "<blossom-url-of-encrypted-blob>",
  "tags": [
    ["p", "<recipient-pubkey>", "<relay-hint>"],  // one per recipient
    ["file-type", "video/mp4"],
    ["encryption-algorithm", "aes-gcm"],
    ["decryption-key", "<hex-encoded-aes-key>"],
    ["decryption-nonce", "<hex-encoded-nonce>"],
    ["x", "<sha256-of-encrypted-blob>"],
    ["ox", "<sha256-of-original-mp4>"],
    ["size", "<encrypted-blob-bytes>"]
  ]
}
```

5. Gift-wrap for each recipient per NIP-59/NIP-17:
   - Create unsigned rumor (the Kind 15, no `sig`)
   - Seal: NIP-44 encrypt rumor with sender→recipient key via `window.nostr.nip44.encrypt()`, wrap in Kind 13 event, sign with `window.nostr.signEvent()`. Randomize `created_at` up to 2 days in the past. Tags MUST be empty.
   - Gift wrap: NIP-44 encrypt seal with a locally-generated ephemeral keypair→recipient key, wrap in Kind 1059 event, sign with the ephemeral key. Include `["p", "<recipient-pubkey>"]` tag.
6. Publish each gift wrap to the recipient's Kind 10050 inbox relays. Fallback to sender's general relays if no Kind 10050 found.

## NIP-07 Integration

Flora never touches the user's private key. The seal layer uses `window.nostr.nip44.encrypt()` and `window.nostr.signEvent()` via the existing NIP-07 content script bridge. The gift wrap layer uses a locally-generated ephemeral keypair (no signer needed).

Feature-detect `window.nostr.nip44` before offering Private mode. Show an error if the signer doesn't support NIP-44: "Your signer extension doesn't support NIP-44 encryption. Update it or switch to nos2x/Alby."

The `nostr-tools` `wrapEvent()` helper requires raw private keys, so we build the layers manually using NIP-07 primitives. The ephemeral key for the wrap layer is generated locally with `generateSecretKey()` from `nostr-tools`.

## Recipient Selection

When Private mode is selected, a recipient input appears inline on the confirm screen.

### Contact loading

1. Fetch user's Kind 3 (follow list) from relays — extract `p` tags for pubkey list.
2. Batch-fetch Kind 0 (profile metadata) for those pubkeys — display name, avatar, NIP-05.
3. Cache in `chrome.storage.local` with 1-hour TTL.

### Input behavior

- Text field accepting npub, NIP-05 (`user@domain.com`), or 64-char hex pubkey.
- Typing filters cached follow list by display name, name, or NIP-05.
- Autocomplete dropdown: avatar + display name + NIP-05 (or truncated npub).
- `npub1...` input → decode with `nostr-tools/nip19`.
- `@` in input → resolve via NIP-05 HTTPS lookup from background script (no CORS issues).
- 64 hex chars → use as pubkey directly.
- On selection, fetch recipient's Kind 10050 (DM relay list). Warning badge if missing.

### Selected recipients

Shown as removable chips with avatar + name.

### Recent recipients

Stored in `chrome.storage.local` as ordered list of `{ pubkey, name, avatar, nip05 }`. Shown as suggestions when input is focused and empty. Updated after each successful private share.

## Recording Library

Private recordings appear in the library with:
- A "Private" badge (distinct from "Uploaded" and "Posted")
- List of recipients (names/npubs)
- Re-share and download actions available from the library

The full unencrypted MP4 remains in IndexedDB, so re-sharing to additional recipients or downloading locally works without re-encryption of a stored blob.

## IDB Schema Changes

Add fields to the recording record:

```typescript
{
  // ... existing fields (hash, data, size, duration, timestamp, uploaded, thumbnail, blossomUrl, noteId)
  sharingMode?: 'public' | 'unlisted' | 'private';
  encryptedBlobHash?: string;     // SHA-256 of encrypted blob (different from hash of original)
  recipients?: Array<{
    pubkey: string;
    name?: string;
    deliveredToRelays?: string[];
  }>;
}
```

## Settings Changes

Add to `FloraSettings`:

```typescript
{
  // ... existing fields
  defaultSharingMode: 'public' | 'unlisted' | 'private';  // defaults to 'public'
}
```

## Out of Scope

- NIP-51 follow sets (named recipient groups)
- Standalone encrypted video viewer page
- Re-sharing from the library (future enhancement)
- Password-protected links
- Thumbnail encryption (send encrypted thumbnail in `thumb` tag)
