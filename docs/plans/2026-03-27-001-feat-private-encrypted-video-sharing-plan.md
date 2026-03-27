---
title: "feat: Add private encrypted video sharing via NIP-17 Kind 15"
type: feat
status: active
date: 2026-03-27
origin: docs/plans/2026-03-27-feat-private-sharing-design.md
---

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
```

### IDB Considerations

No schema version bump needed — we're adding optional fields to existing records (`sharingMode`, `encryptedBlobHash`, `recipients`), not new object stores or indexes. The `openDB()` function is duplicated in `offscreen/main.ts` and `review/main.ts`.

### Memory

AES-GCM encryption holds original + encrypted buffers in memory simultaneously. For very large recordings this could be an issue, but acceptable for v1.

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

### Critical Fixes from Spec-Flow Analysis

These must be incorporated during implementation (not in the original plan):

**Code-level bugs:**
- Badge classes must be `rec-badge rec-badge-private` (not `badge badge-private`) — matches existing `rec-badge-posted`/`rec-badge-uploaded`
- Variable is `thumb` (not `thumbnailWrap`) in recordings/main.ts
- Remove `confirmPublish` element ref and all usages (element removed from HTML)
- Update `ConfirmData` interface to include `defaultSharingMode`, `nip44Supported`

**Error handling:**
- Check `sent === 0` after gift-wrap loop — send `PRIVATE_SEND_ERROR` if all deliveries failed
- Track which recipients were successfully delivered, show accurate names on complete screen
- Show inline error for failed NIP-05 resolution ("Could not resolve") and invalid npub ("Invalid npub")

**State management:**
- Reset `pendingSharingMode` and `pendingRecipients` in `RESET_STATE` handler
- Add `defaultSharingMode` migration in `getSettings()`: if undefined, derive from `publishToNostr`
- Derive `publishToNostr` from `sharingMode` only — remove dual source of truth

**NIP-17 compliance:**
- Include sender as a gift-wrap recipient (send copy to self for conversation history)

**UX polish:**
- Handle Escape key to dismiss dropdown
- Filter already-selected recipients from recent suggestions
- Contact caching in chrome.storage.local with 1-hour TTL (design doc requirement)

## Dependencies & Risks

- **NIP-44 signer support** — Private mode requires `window.nostr.nip44.encrypt`. nos2x confirmed. Alby likely but unconfirmed. Graceful degradation: disable Private button.
- **Blossom content-type** — Encrypted blob uploaded as `application/octet-stream`. Some servers may reject non-media types. Mitigation: let it fail with clear error.
- **Large recordings** — 500MB+ videos require ~1GB RAM during encryption (original + encrypted copy). Acceptable for v1.
- **NIP-07 signer prompts** — Each recipient requires a `nip44.encrypt` call which may prompt the user. 10 recipients = potentially 10 signer prompts.

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
