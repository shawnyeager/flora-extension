---
title: "feat: Pre-upload confirmation screen and settings UI"
type: feat
status: active
date: 2026-03-11
---

# Pre-Upload Confirmation Screen and Settings UI

## Overview

The current upload flow is a black box — after recording, "Upload & Share" immediately fires the video to hardcoded defaults (blossom.band, relay.damus.io, nos.lol) with zero visibility into where the video is going, which identity is signing it, or what relays will broadcast it. Users need to see and control all of this before anything leaves their machine.

## Problem Statement

1. **No visibility:** User has no idea which Blossom server, which relays, or which Nostr identity is being used
2. **No control:** Servers and relays are hardcoded defaults with no UI to change them
3. **No confirmation:** One click and the video is in the wild — no "are you sure?" step
4. **No NIP-07 feedback:** If the signer isn't installed or available, the user finds out only after a cryptic "Upload failed" error
5. **No settings page:** The `BloomSettings` type and `getSettings()`/`saveSettings()` exist but have zero UI

## Proposed Solution

Two interconnected pieces:

1. **Confirmation screen** — shown in the popup when user clicks "Upload & Share" from preview. Displays target server, relays, connected npub, publish toggle, and file size. User explicitly clicks "Confirm" to proceed.
2. **Settings page** — a dedicated extension page (`/settings.html`) for configuring Blossom servers, Nostr relays, and defaults. Accessible from the popup and the confirmation screen.

## Technical Approach

### State Machine Change

Add `confirming` state between `preview` and `uploading`:

```
preview -> confirming    (user clicks "Upload & Share")
confirming -> uploading  (user clicks "Confirm")
confirming -> preview    (user clicks "Back")
```

Update `utils/state.ts`:

```typescript
export type ExtensionState =
  | 'idle'
  | 'initializing'
  | 'awaiting_media'
  | 'countdown'
  | 'recording'
  | 'finalizing'
  | 'preview'
  | 'confirming'    // NEW
  | 'uploading'
  | 'publishing'
  | 'complete'
  | 'error';

export const TRANSITIONS: Record<ExtensionState, ExtensionState[]> = {
  // ...existing...
  preview: ['confirming', 'idle'],       // changed: was ['uploading', 'idle']
  confirming: ['uploading', 'preview'],  // NEW
  uploading: ['publishing', 'error'],
  // ...rest unchanged...
};
```

### NIP-07 Probing Strategy

Probe NIP-07 when entering `preview` state (background caches result). This decouples the check from popup lifecycle:

```typescript
// background.ts
let cachedNip07: { pubkey: string } | { error: string } | null = null;

// When state transitions to 'preview', probe NIP-07
function probeNip07() {
  relayToContentScript({ type: MessageType.NIP07_GET_PUBKEY })
    .then((result) => {
      cachedNip07 = result.ok
        ? { pubkey: result.data }
        : { error: result.error };
    })
    .catch((err) => {
      cachedNip07 = { error: err.message };
    });
}
```

### New Message Types

```typescript
// utils/messages.ts additions

// Popup -> Background: request confirmation data
GET_CONFIRM_DATA: 'get_confirm_data',

// Background -> Popup: response
// Returns: { npub, signerAvailable, server, relays, publishToNostr, fileSize, duration }

// Popup -> Background: user confirmed upload with options
CONFIRM_UPLOAD: 'confirm_upload',
// Carries: { serverOverride?: string, publishToNostr: boolean }

// Popup -> Background: go back to preview
BACK_TO_PREVIEW: 'back_to_preview',
```

### Confirmation Screen Data Contract

When popup enters `confirming` state, it requests `GET_CONFIRM_DATA`:

```typescript
interface ConfirmData {
  npub: string | null;           // hex pubkey from NIP-07 probe, null if unavailable
  signerAvailable: boolean;      // true if NIP-07 probe succeeded
  bridgeError: string | null;    // error message if NIP-07 probe failed
  server: string;                // primary Blossom server from settings
  relays: string[];              // Nostr relays from settings
  publishToNostr: boolean;       // current setting
  fileSize: number;              // bytes, from recording metadata
  duration: number;              // seconds
}
```

### Confirmation Screen UI (in popup)

```
┌─────────────────────────────┐
│          Bloom              │
├─────────────────────────────┤
│  Review before sharing      │
│                             │
│  📦 3.2 MB · 0:42          │
│                             │
│  Upload to:                 │
│  ┌─────────────────────┐   │
│  │ blossom.band      ▾ │   │
│  └─────────────────────┘   │
│                             │
│  ☑ Publish note to Nostr    │
│  → relay.damus.io, nos.lol  │
│                             │
│  Signing as:                │
│  npub1abc...xyz             │
│                             │
│  ┌───────────────────────┐  │
│  │      Confirm          │  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │       Back            │  │
│  └───────────────────────┘  │
│                             │
│          ⚙ Settings         │
└─────────────────────────────┘
```

**When NIP-07 is unavailable:**

```
│  ⚠ No Nostr signer detected │
│  Install nos2x or Alby to   │
│  upload and share recordings │
│                              │
│  [Confirm] ← disabled/gray  │
│  [Back]                      │
│  [Download MP4]              │
```

**When no content script bridge available (all tabs restricted):**

```
│  ⚠ Open any web page to     │
│  enable Nostr signing        │
│                              │
│  [Confirm] ← disabled       │
```

### Confirm Action

When user clicks "Confirm":
1. Popup sends `CONFIRM_UPLOAD` with `{ publishToNostr, serverOverride? }`
2. Background transitions `confirming -> uploading`
3. Background sends `START_UPLOAD` to offscreen with the override data
4. Offscreen uses override server if provided, otherwise settings default
5. Offscreen respects the per-upload `publishToNostr` flag

```typescript
// Updated START_UPLOAD message
interface StartUploadMessage extends BaseMessage {
  type: typeof MessageType.START_UPLOAD;
  target: 'offscreen';
  serverOverride?: string;       // one-time override, does NOT persist
  publishToNostr?: boolean;      // per-upload override
}
```

### Settings Page

New entry point: `entrypoints/settings/index.html` + `entrypoints/settings/main.ts`

Sections:
1. **Blossom Servers** — editable list, first is primary. Add/remove URLs.
2. **Nostr Relays** — editable list. Add/remove relay URLs.
3. **Publishing** — toggle "Publish note to Nostr" default
4. **Identity** — shows connected npub (read-only, from NIP-07 probe)

Settings stored in `chrome.storage.local` via existing `utils/settings.ts`.

Opened via:
- `⚙ Settings` link in popup (any state)
- `⚙ Settings` link in confirmation screen
- Opens as a new tab: `browser.tabs.create({ url: browser.runtime.getURL('/settings.html') })`

### Server Override Semantics

- Confirmation screen pre-populates from `settings.blossomServers[0]`
- User can type a different server URL (inline edit, not a dropdown — they might use any server)
- Override is **one-time** for this upload only — does NOT write back to settings
- To permanently change the server, user goes to Settings page
- Override is passed via `CONFIRM_UPLOAD` message through to offscreen

## Implementation Phases

### Phase A: State machine + confirmation screen

**Tasks:**
- [x] Add `confirming` state to `utils/state.ts`
- [x] Add `GET_CONFIRM_DATA`, `CONFIRM_UPLOAD`, `BACK_TO_PREVIEW` message types to `utils/messages.ts`
- [x] Add NIP-07 probing in background (probe on `preview` state entry, cache result)
- [x] Add `GET_CONFIRM_DATA` handler in background (returns cached probe + settings + recording metadata)
- [x] Add `CONFIRM_UPLOAD` handler in background (transitions to uploading, relays to offscreen with overrides)
- [x] Add `BACK_TO_PREVIEW` handler in background (transitions back to preview)
- [x] Update `START_UPLOAD` message to accept `serverOverride` and `publishToNostr` fields
- [x] Update offscreen `uploadRecording()` to use overrides from message
- [x] Update offscreen `publishNote()` to respect per-upload publishToNostr
- [x] Build confirmation screen UI in popup (file size, server input, relay list, publish toggle, npub display, signer warnings)
- [x] Add "Back" button to return to preview
- [x] Disable "Confirm" when signer unavailable, show appropriate warning
- [x] Add double-click guard on Confirm button

`entrypoints/popup/main.ts`, `entrypoints/background.ts`, `entrypoints/offscreen/main.ts`, `utils/state.ts`, `utils/messages.ts`

### Phase B: Settings page

**Tasks:**
- [x] Create `entrypoints/settings/index.html` with basic page structure
- [x] Create `entrypoints/settings/main.ts` with editable lists for servers and relays
- [x] Create `entrypoints/settings/style.css`
- [x] Wire `getSettings()` / `saveSettings()` to populate and persist form state
- [x] Add NIP-07 identity display (calls GET_PUBLIC_KEY, shows npub)
- [x] Add publish toggle with current default
- [x] Add `⚙ Settings` link to popup (visible in idle, preview, confirming, complete states)

`entrypoints/settings/index.html`, `entrypoints/settings/main.ts`, `entrypoints/settings/style.css`, `entrypoints/popup/main.ts`

### Phase C: Recording metadata passthrough

**Tasks:**
- [x] Store recording file size and duration in background when RECORDING_COMPLETE fires (currently just logs them)
- [x] Include file size in GET_CONFIRM_DATA response
- [x] Display file size in human-readable format on confirmation screen (e.g., "3.2 MB · 0:42")

`entrypoints/background.ts`

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No NIP-07 signer installed | Confirmation shows warning, Confirm disabled, Download still works |
| Signer installed but user on chrome:// page | Show "Open any web page to enable signing", Confirm disabled |
| User closes popup during confirming state | Popup reopens to confirming state (persisted in state machine) |
| User changes server in confirmation to invalid URL | Upload fails with error, user can retry from error state |
| User toggles publish OFF | Upload proceeds, kind 1 note is NOT created, goes straight to complete |
| Double-click on Confirm | Guard prevents duplicate START_UPLOAD |
| Recording > server size limit | Upload returns 413, error state shows "File too large for this server" |
| Publish succeeds to some relays but not all | `Promise.any()` — first acceptance = success |
| Upload succeeds, publish fails | Complete state with blossom URL shown, note about publish failure |

## Acceptance Criteria

- [ ] After recording + preview, "Upload & Share" shows confirmation screen (NOT immediate upload)
- [ ] Confirmation shows: target server, relay list, npub, publish toggle, file size
- [ ] User can change the target server before confirming (one-time override)
- [ ] User can toggle "Publish note to Nostr" on/off per upload
- [ ] "Confirm" is disabled when NIP-07 signer is unavailable, with clear error message
- [ ] "Back" returns to preview without losing the recording
- [ ] Settings page allows editing Blossom servers and Nostr relays
- [ ] Settings persist across sessions via `chrome.storage.local`
- [ ] Settings page shows connected Nostr identity (npub)
- [ ] `⚙ Settings` link accessible from popup

## References

- Existing settings utility: `utils/settings.ts`
- State machine: `utils/state.ts`
- Message types: `utils/messages.ts`
- NIP-07 bridge: `entrypoints/nostr-bridge.ts`
- Content script proxy: `entrypoints/overlay.content/index.ts` (NIP-07 proxy section)
- Background NIP-07 relay: `entrypoints/background.ts` (`relayToContentScript()`)
- Original Phase 8 plan: `docs/plans/2026-02-22-feat-bloom-screen-recorder-extension-plan.md` (lines 467-517)
- Blossom SDK: `BlossomClient.uploadBlob()` with `auth: true`
- Nostr SDK: `SimplePool.publish()` with relay list
