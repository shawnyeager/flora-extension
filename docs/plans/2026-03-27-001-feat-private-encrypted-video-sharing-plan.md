---
title: "feat: Add private encrypted video sharing via NIP-17 Kind 15"
type: feat
status: active
date: 2026-03-27
deepened: 2026-03-27
origin: docs/plans/2026-03-27-feat-private-sharing-design.md
---

## Enhancement Summary

**Deepened on:** 2026-03-27
**Research agents used:** security-sentinel, architecture-strategist, performance-oracle, kieran-typescript-reviewer, julik-frontend-races-reviewer, Web Crypto AES-GCM research, Context7 (nostr-tools, NIP specs)

### Key Improvements from Deepening
1. **Security:** Zero-fill all key material (`key`, `nonce`, `ephemeralSk`) after use; import raw key into non-extractable `CryptoKey` before zeroing source bytes
2. **Performance:** Fix IDB `getAll()` → cursor (existing bug), null buffers after encryption to halve peak memory, parallelize Kind 0 batch fetches, separate gift-wrap construction from relay publishing
3. **Architecture:** Update TRANSITIONS table, add tab-focus to NIP44_ENCRYPT handler, use `try/finally` on all SimplePool usage
4. **Race conditions:** Replace blur `setTimeout` with `mousedown preventDefault` on dropdown, optimistic chip insertion with async DM relay fetch, guard async operations against mode switches
5. **TypeScript:** Fix `nip44` import path, verify `getEventHash` export, use discriminated union narrowing instead of `as any`, type `giftWrapKind15` return as `NostrEvent`
6. **Crypto:** Hex encoding confirmed for key/nonce (0xchat/Amethyst interop), 12-byte random nonce safe for single-use keys, NIP-44 payload size guard

# Private Encrypted Video Sharing

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add private encrypted video sharing to Flora using NIP-17 Kind 15 file messages with AES-GCM encryption and NIP-59 gift wrapping.

**Architecture:** Recordings are encrypted client-side with AES-GCM before upload to Blossom. A Kind 15 file message containing the Blossom URL and decryption key is gift-wrapped per NIP-59 for each recipient and published to their NIP-17 inbox relays. The confirm screen gains a three-way sharing mode picker (Public/Unlisted/Private) replacing the current "Publish to Nostr" toggle, with an inline recipient picker for Private mode.

**Tech Stack:** `nostr-tools` (nip19, nip44, nip59, nip05), Web Crypto API (AES-256-GCM), `blossom-client-sdk`, Chrome extension APIs (scripting, storage)

## Overview

Flora currently only supports public sharing: upload to Blossom + publish Kind 1 note. This feature adds three sharing modes:

- **Public** — Upload to Blossom + Kind 1 note (current behavior)
- **Unlisted** — Upload to Blossom, no Nostr event, just copy the link
- **Private** — AES-GCM encrypt video, upload opaque blob to Blossom, send Kind 15 file message via NIP-17 gift wrapping to selected recipients

Recipients view private videos in any Nostr client supporting Kind 15 DMs (0xchat, Amethyst).

## Problem Statement / Motivation

Every Flora recording is currently public. The Blossom URL is open to anyone with the hash, and the Kind 1 note broadcasts it to relays. This blocks the primary use case for a Loom replacement: sharing recordings privately with teammates, clients, or specific people.

## Proposed Solution

Follow the established Nostr ecosystem pattern (implemented by 0xchat and Amethyst):

1. Encrypt video with AES-256-GCM (random key + nonce) in the offscreen document
2. Upload encrypted blob to Blossom (opaque bytes, anyone can download but nobody can decrypt)
3. Build Kind 15 file message with Blossom URL, decryption key, nonce, MIME type
4. Gift-wrap per NIP-59: unsigned rumor -> Kind 13 seal (NIP-44 via NIP-07 signer) -> Kind 1059 wrap (local ephemeral key)
5. Publish gift wrap to each recipient's Kind 10050 inbox relays
6. Send a copy to the sender themselves (NIP-17 convention for conversation history)

## Technical Considerations

### NIP-07 Compatibility

Flora never touches private keys. The seal layer uses `window.nostr.nip44.encrypt()` and `window.nostr.signEvent()` via the existing content script bridge. The wrap layer uses a locally-generated ephemeral keypair. `nostr-tools`' `wrapEvent()` helper requires raw private keys, so we build layers manually.

Feature-detect `window.nostr.nip44` and disable Private mode if unsupported.

### Import Conventions

Always use nostr-tools submodule imports per existing codebase patterns:
```typescript
import { generateSecretKey, getPublicKey, finalizeEvent, getEventHash } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { decode } from 'nostr-tools/nip19';
import { queryProfile } from 'nostr-tools/nip05'; // static import, not dynamic
import type { UnsignedEvent, NostrEvent } from 'nostr-tools/pure';
```

**Verify at build time:** `getEventHash` may not be exported from `nostr-tools/pure`. If not, compute manually with `import { sha256 } from '@noble/hashes/sha256'` and serialize per NIP-01.

**Never use barrel import** (`import { nip44 } from 'nostr-tools'`) — pulls entire package, wrong for extensions.

### IDB Considerations

No schema version bump needed — we're adding optional fields to existing records (`sharingMode`, `encryptedBlobHash`, `recipients`), not new object stores or indexes. The `openDB()` function is duplicated in `offscreen/main.ts` and `review/main.ts`.

**Existing bug:** Both `uploadRecording()` and the new `sendPrivate()` use `store.getAll()` to find the latest recording — this loads ALL recording blobs into memory. Fix: use `by_timestamp` index with a reverse cursor (`index.openCursor(null, 'prev')`) to load only the latest. Fix in both existing and new code.

### Memory

AES-GCM encryption holds original + encrypted buffers in memory simultaneously. Peak memory is ~3x video size (IDB record + original ref + encrypted output). Crashes expected at ~250-300MB recordings (a few minutes of 1080p).

**Mitigation (must implement):** Null `recording.data` immediately after extracting the buffer. Release `originalBuffer` reference after encryption completes (let it go out of scope before upload begins). This reduces peak to ~2x.

### Key Material Handling

**Best-effort zeroing pattern:**
```typescript
const rawKey = crypto.getRandomValues(new Uint8Array(32));
const cryptoKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
rawKey.fill(0); // zero source immediately after import

// ... use cryptoKey for encryption ...
// After encryption: let cryptoKey go out of scope

// After gift-wrap loop: zero the hex-encoded copies too
key.fill(0);
nonce.fill(0);
```

Also zero `ephemeralSk.fill(0)` after each `finalizeEvent` call in `giftWrapKind15`.

JS cannot guarantee memory wiping (GC copies, JIT optimizations), but `.fill(0)` is standard practice and signals intent.

### Crypto Format (Confirmed via 0xchat/Amethyst interop)

- **Key format:** Hex-encoded (64 chars for 32 bytes) in `decryption-key` tag
- **Nonce format:** Hex-encoded (24 chars for 12 bytes) in `decryption-nonce` tag
- **Nonce size:** 12 bytes (96 bits) — NIST-recommended for AES-GCM
- **Collision risk:** Zero — each key is used exactly once (one encrypt per key)
- **Algorithm tag value:** `aes-gcm` (only supported value per NIP-17)

## System-Wide Impact

### Message Flow (Private Path)

```
Review Page                    Background                     Offscreen
    |                              |                              |
    |-- CONFIRM_UPLOAD ----------->|                              |
    |   (sharingMode:'private',    |                              |
    |    recipients:[...])         |-- SEND_PRIVATE ------------->|
    |                              |                              |-- encryptVideo()
    |                              |                              |-- uploadBlob()
    |                              |<-- UPLOAD_PROGRESS ----------|
    |<-- UPLOAD_PROGRESS ----------|                              |
    |                              |                              |-- giftWrapKind15() x N
    |                              |                              |   (NIP44_ENCRYPT via bg)
    |                              |<-- PRIVATE_SEND_COMPLETE ----|
    |                              |-- setState('complete')       |
    |<-- STATE_CHANGED('complete') |                              |
```

### State Transitions

No new states needed. Private shares reuse `uploading -> complete` (skipping `publishing`). Progress text updated dynamically via `UPLOAD_PROGRESS` `serverName` field.

**Must update `utils/state.ts` TRANSITIONS table:** Add `'complete'` to the `uploading` transitions:
```typescript
uploading: ['publishing', 'complete', 'error'],  // 'complete' for unlisted/private paths
```
Update the JSDoc comment to document the unlisted/private path. `canTransition()` is exported and could be used by future code.

### NIP44_ENCRYPT Tab Focus

The `NIP44_ENCRYPT` handler must mirror the tab-switching dance from `NIP07_SIGN` — focus the signing tab before calling `nip44EncryptDirect`, then switch back. Without this, signer prompts are invisible and will timeout (10s per recipient = flow appears hung).

### Error Propagation

- Blossom upload failure -> `PRIVATE_SEND_ERROR` -> `error` state -> retry re-encrypts from scratch
- Individual gift-wrap relay failure -> logged, continue to next recipient
- All gift-wraps fail (sent === 0) -> `PRIVATE_SEND_ERROR` -> `error` state
- NIP-44 encrypt failure -> `PRIVATE_SEND_ERROR` (signer issue)
- NIP-05 resolution failure -> inline error text in recipient input

## Acceptance Criteria

### Functional Requirements

- [ ] Three-way sharing mode picker (Public/Unlisted/Private) replaces "Publish to Nostr" toggle
- [ ] Public mode works exactly as before (Kind 1 note + Blossom URL)
- [ ] Unlisted mode uploads to Blossom without any Nostr event
- [ ] Private mode encrypts with AES-GCM, uploads encrypted blob, sends Kind 15 via NIP-17
- [ ] Recipient input accepts npub, NIP-05, and hex pubkey
- [ ] Autocomplete from Kind 3 follow list with Kind 0 profile enrichment
- [ ] Selected recipients shown as removable chips with avatar + name
- [ ] Warning badge on recipients without Kind 10050 DM relays
- [ ] Recent recipients remembered in chrome.storage.local
- [ ] Contact list cached with 1-hour TTL
- [ ] Complete screen shows "Sent privately" with recipient names (no Copy Link)
- [ ] Complete screen distinguishes delivered vs failed recipients
- [ ] Sender receives their own gift-wrapped copy (NIP-17 convention)
- [ ] Recordings library shows "Private" badge with recipient tooltip
- [ ] Private mode disabled when signer unavailable or lacks NIP-44
- [ ] Error feedback for failed NIP-05 resolution and invalid npub

### Non-Functional Requirements

- [ ] ARIA attributes on sharing mode picker (`role="radiogroup"`), dropdown (`role="listbox"`), chip remove buttons (`aria-label`)
- [ ] Escape key dismisses autocomplete dropdown
- [ ] `prefers-reduced-motion` respected on new animations
- [ ] Existing public sharing flow unchanged (regression test)

## Implementation Tasks

The detailed task-by-task implementation with exact file paths, line numbers, and complete code is in:
**`docs/plans/2026-03-27-feat-private-sharing-plan.md`**

Summary of 10 tasks:

1. **Message types & settings** — `SharingMode` type, new MessageType constants, updated interfaces
2. **NIP-44 encrypt proxy** — `nip44EncryptDirect()` + `probeNip44Support()` in background
3. **Contact fetching** — Kind 3/Kind 0 fetch, NIP-05 resolution, Kind 10050 DM relay lookup
4. **AES-GCM encryption & gift wrapping** — Core crypto in offscreen document
5. **Background state flow** — Route private mode through `SEND_PRIVATE`, handle completion/error
6. **Review page HTML** — Sharing mode picker, recipient input, updated complete view
7. **Recipient picker styles** — Mode buttons, chips, dropdown, private badge
8. **Review page JS** — Wire everything: mode switching, contact loading, autocomplete, confirm flow
9. **Recordings library** — Private badge with correct class names (`rec-badge rec-badge-private`)
10. **Build & smoke test** — TypeScript check, build, manual test checklist

### Critical Fixes (Consolidated from All Reviews)

These MUST be incorporated during implementation. The detailed implementation plan code does NOT include these — they must be applied as corrections.

**Security (from security-sentinel):**
- Zero-fill `key.fill(0)` and `nonce.fill(0)` after the gift-wrap loop in `sendPrivate`
- Zero-fill `ephemeralSk.fill(0)` before returning from `giftWrapKind15`
- Import raw AES key into non-extractable `CryptoKey` via `importKey(..., false, ['encrypt'])`, then zero source `Uint8Array` immediately
- Validate avatar URLs: only allow `https?://` scheme before setting `img.src`
- Add NIP-44 payload size guard: `if (rumorJson.length > 64000) throw`
- Use `crypto.getRandomValues` for timestamp randomization instead of `Math.random()`

**Architecture (from architecture-strategist):**
- Update `utils/state.ts` TRANSITIONS: `uploading: ['publishing', 'complete', 'error']`
- Add tab-focus logic to `NIP44_ENCRYPT` handler (mirror `NIP07_SIGN` pattern)
- Reset `pendingSharingMode` and `pendingRecipients` in `RESET_STATE` handler
- Include sender as gift-wrap recipient (NIP-17 convention for conversation history)
- Wrap ALL `SimplePool` usage in `try/finally` to prevent connection leaks

**Performance (from performance-oracle):**
- Fix IDB `getAll()` → use `by_timestamp` index cursor in both existing `uploadRecording` and new `sendPrivate`
- Null `recording.data` after extracting buffer; release `originalBuffer` after encryption
- Parallelize Kind 0 profile batch fetches with `Promise.allSettled`
- Separate gift-wrap construction (sequential, signer constraint) from relay publishing (parallel)
- Share a single `SimplePool` instance in background with idle timeout cleanup
- Use `Set` for O(n) contact dedup instead of O(n^2) `Array.some`

**Race Conditions (from julik-frontend-races-reviewer):**
- Replace blur `setTimeout(200)` with `mousedown` + `preventDefault` on dropdown container
- Optimistic chip insertion: add chip immediately, fetch DM relays in background, re-render on resolve
- Add `contactsLoading` guard to prevent concurrent fetches; show "Loading contacts..." placeholder
- Guard `handleDirectInput` and `selectRecipient` against mode switches during async resolution
- Add `img.onerror` fallback on avatar images to show placeholder

**TypeScript (from kieran-typescript-reviewer):**
- Fix nip44 import: `import { v2 as nip44 } from 'nostr-tools/nip44'` (not barrel import)
- Verify `getEventHash` exists in `nostr-tools/pure` — if not, compute manually
- Type `giftWrapKind15` return as `Promise<NostrEvent>` (not `Promise<any>`)
- Use discriminated union narrowing on message handlers instead of `as any`
- Use static imports for `nostr-tools/nip05` and `nostr-tools/nip19` (not dynamic `import()`)
- Remove dead `confirmPublish` element ref and all usages
- Extract "get latest recording from IDB" into shared helper (used 3+ times)

**Code-level bugs (from spec-flow-analyzer):**
- Badge classes must be `rec-badge rec-badge-private` (not `badge badge-private`)
- Variable is `thumb` (not `thumbnailWrap`) in recordings/main.ts
- Update `ConfirmData` interface to include `defaultSharingMode`, `nip44Supported`
- Add `defaultSharingMode` migration in `getSettings()`: if undefined, derive from `publishToNostr`
- Derive `publishToNostr` from `sharingMode` only — remove dual source of truth
- Check `sent === 0` after gift-wrap loop — throw error if all deliveries failed
- Track which recipients were successfully delivered, show accurate names on complete screen
- Show inline error for failed NIP-05 resolution and invalid npub
- Handle Escape key to dismiss dropdown
- Filter already-selected recipients from recent suggestions
- Implement contact caching in chrome.storage.local with 1-hour TTL

## Dependencies & Risks

- **NIP-44 signer support** — Private mode requires `window.nostr.nip44.encrypt`. nos2x confirmed. Alby likely but unconfirmed. Graceful degradation: disable Private button.
- **Blossom content-type** — Encrypted blob uploaded as `application/octet-stream`. Some servers may reject non-media types. Mitigation: let it fail with clear error.
- **Large recordings** — Crashes expected at ~250-300MB (3x memory spike). With buffer nulling mitigation, safe to ~400-500MB. Streaming encryption not available for AES-GCM in browsers (Web Crypto streams proposal explicitly excludes authenticated ciphers).
- **NIP-07 signer prompts** — Each recipient requires a sequential `nip44.encrypt` call through the signer. Some signers (nos2x) batch-approve after first prompt; others may prompt for each. With 10+ recipients, flow takes 2-5s best case. Consider adding recipient cap (15-20) and pre-warning in UI.
- **MAIN world plaintext exposure** — The AES decryption key (inside the serialized rumor) briefly exists in the web page's MAIN world during `scripting.executeScript` for NIP-44 encryption. This is inherent to NIP-07 architecture (same exposure as existing `signEvent`). Accepted risk — prefer recording tab for signing (already the case via `findScriptableTab`).
- **Single key per encrypted blob** — All recipients share the same AES key. If any recipient is compromised, all copies are compromised. This is inherent to the architecture and matches 0xchat/Amethyst behavior. Document as accepted design decision.

## Sources & References

### Origin

- **Design doc:** [docs/plans/2026-03-27-feat-private-sharing-design.md](docs/plans/2026-03-27-feat-private-sharing-design.md)
- **Implementation plan:** [docs/plans/2026-03-27-feat-private-sharing-plan.md](docs/plans/2026-03-27-feat-private-sharing-plan.md)
- **Original brainstorm:** [docs/brainstorms/2026-02-22-bloom-brainstorm.md](docs/brainstorms/2026-02-22-bloom-brainstorm.md) — "Encryption/private videos" was out of scope for v1

### External References

- [NIP-17: Private Direct Messages](https://github.com/nostr-protocol/nips/blob/master/17.md) — Kind 15 file messages
- [NIP-44: Versioned Encryption](https://github.com/nostr-protocol/nips/blob/master/44.md) — 64KB limit, ChaCha20 + HMAC
- [NIP-59: Gift Wrap](https://github.com/nostr-protocol/nips/blob/master/59.md) — Rumor -> Seal -> Wrap layers
- [NIP-07: Browser Extension](https://github.com/nostr-protocol/nips/blob/master/07.md) — `nip44.encrypt`/`decrypt` methods
- [Amethyst v0.94.0](https://github.com/vitorpamplona/amethyst/releases/tag/v0.94.0) — Encrypted media on DMs reference
- [Blossom Protocol](https://github.com/hzrd149/blossom) — No access control by design, privacy via client-side encryption

### Internal References

- Message types: `utils/messages.ts`
- State machine: `utils/state.ts`
- Settings: `utils/settings.ts`
- Background orchestrator: `entrypoints/background.ts`
- Offscreen media pipeline: `entrypoints/offscreen/main.ts`
- Review UI: `entrypoints/review/main.ts` + `index.html` + `style.css`
- Recordings library: `entrypoints/recordings/main.ts` + `style.css`
