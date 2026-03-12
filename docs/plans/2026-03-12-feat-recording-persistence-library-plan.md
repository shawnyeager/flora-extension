---
title: "feat: Recording persistence and local library"
type: feat
status: completed
date: 2026-03-12
---

# Recording Persistence & Local Library

## Problem

Two issues:

1. **Accidental dismissal loses recordings.** During the confirm/upload flow, clicking the backdrop or pressing Escape can dismiss the dialog and reset to idle, destroying the user's recording with no recovery path. The current protection relies on CSS `display` checks — fragile and will break if views are refactored.

2. **No way to access past recordings.** Recordings accumulate in IndexedDB (keyed by SHA-256) but there's no UI to browse, re-upload, download, or delete them. The `uploaded` flag is written as `false` but never updated. Once the user closes the review, the recording is unreachable.

## Changes

### Part 1: Block Accidental Dismissal

#### 1.1 Track state in the content script

**`entrypoints/overlay.content/index.ts`:**

- [x] Add module-level `let currentOverlayState: ExtensionState = 'idle'` alongside existing state variables
- [x] Set it at the top of `updateUI(state)` before the if/else chain
- [x] Define protected states: `const PROTECTED = ['finalizing', 'confirming', 'uploading', 'publishing']`

#### 1.2 Guard all dismiss paths with state check

**`entrypoints/overlay.content/index.ts`:**

- [x] **Escape handler** (line ~455): Early return if `PROTECTED.includes(currentOverlayState)`
- [x] **Backdrop click** (line ~475): Early return if `PROTECTED.includes(currentOverlayState)`
- [x] **Close button** already hidden via `showReviewView()` — keep that, but also add the state guard as defense in depth

#### 1.3 Guard RESET_STATE in background

**`entrypoints/background.ts`:**

- [x] In the `RESET_STATE` handler (line ~148): if `currentState` is in `['finalizing', 'uploading', 'publishing']`, respond `{ ok: false, reason: 'protected_state' }` and do NOT reset
- [x] Allow reset from `confirming` at the background level (user can still use the explicit Back button)

#### 1.4 Guard review page

**`entrypoints/review/main.ts`:**

- [x] Add `beforeunload` listener during protected states to warn user before closing tab
- [x] Remove the listener when state leaves protected set

### Part 2: Recording Library

#### 2.1 IDB schema upgrade (v1 → v2)

**`entrypoints/offscreen/main.ts`:**

- [x] Bump `indexedDB.open('bloom-recordings', 2)`
- [x] In `onupgradeneeded`: if upgrading from v1, no store changes needed (new fields are optional on existing records)
- [x] Add index on `timestamp`: `store.createIndex('by_timestamp', 'timestamp')` (only on initial create or upgrade)
- [x] New optional fields on records: `blossomUrl?: string`, `title?: string`

#### 2.2 New IDB operations

**`entrypoints/offscreen/main.ts`:**

- [x] `listRecordings()`: Open cursor on `by_timestamp` index (descending), collect metadata objects `{ hash, size, duration, timestamp, uploaded, blossomUrl }` — skip the `data` field. Return array.
- [x] `deleteRecording(hash)`: `store.delete(hash)` in a readwrite transaction
- [x] `markUploaded(hash, blossomUrl)`: `store.get(hash)` then `store.put({ ...record, uploaded: true, blossomUrl })` in a readwrite transaction
- [x] `getRecordingByHash(hash)`: Like `getLatestRecording()` but by specific hash. Returns data URL.

#### 2.3 New message types

**`utils/messages.ts`:**

- [x] `LIST_RECORDINGS` — no payload, returns `RecordingMeta[]`
- [x] `DELETE_RECORDING` — payload: `{ hash: string }`, returns `{ ok: boolean }`
- [x] `MARK_UPLOADED` — payload: `{ hash: string; blossomUrl: string }`, returns `{ ok: boolean }`
- [x] `GET_RECORDING_BY_HASH` — payload: `{ hash: string }`, returns data URL or null

Add to the `MessageType` enum and create corresponding interfaces.

#### 2.4 Message handlers in offscreen

**`entrypoints/offscreen/main.ts`:**

- [x] `LIST_RECORDINGS` → call `listRecordings()`, sendResponse
- [x] `DELETE_RECORDING` → call `deleteRecording(msg.hash)`, sendResponse
- [x] `MARK_UPLOADED` → call `markUploaded(msg.hash, msg.blossomUrl)`, sendResponse
- [x] `GET_RECORDING_BY_HASH` → call `getRecordingByHash(msg.hash)`, sendResponse (async, return true)

All handlers check `message.target === 'offscreen'`.

#### 2.5 Message routing in background

**`entrypoints/background.ts`:**

- [x] Route `LIST_RECORDINGS`, `DELETE_RECORDING`, `MARK_UPLOADED`, `GET_RECORDING_BY_HASH` through to offscreen (same pattern as `GET_RECORDING`: `ensureOffscreenDocument()` then forward with `target: 'offscreen'`)
- [x] `UPLOAD_COMPLETE` handler (line ~298): after storing `uploadResult`, send `MARK_UPLOADED` to offscreen with `hash = sha256` and `blossomUrl = msg.url`
- [x] `DELETE_RECORDING` handler: if deleting the current preview recording, also reset state to idle (prevent stale preview)

#### 2.6 Offscreen document lifecycle

**`entrypoints/background.ts`:**

- [x] `ensureOffscreenDocument()` already exists — reuse it for library operations
- [x] When creating offscreen doc for non-recording operations, the existing reasons (`DISPLAY_MEDIA`, `USER_MEDIA`) still work since the doc may also be used for recording. Chrome allows multiple reasons.

#### 2.7 Recordings page

**New files: `entrypoints/recordings/index.html`, `entrypoints/recordings/main.ts`, `entrypoints/recordings/style.css`**

Follow the `entrypoints/settings/` pattern (WXT auto-registers as `/recordings.html`).

**`index.html`:**
- [x] Minimal shell: `<div id="app"></div>`, links to style.css and main.ts

**`main.ts`:**
- [x] On load: send `LIST_RECORDINGS` via background, render list
- [x] Listen for `STATE_CHANGED` to update status indicator and disable/enable upload buttons
- [x] Per-recording card shows: timestamp (formatted), duration, size, upload status badge
- [x] Actions per recording:
  - Download — sends `GET_RECORDING_BY_HASH`, triggers `<a download>` with data URL
  - Upload to Blossom — sends `CONFIRM_UPLOAD` (only enabled when extension state is `idle`), transitions into upload flow
  - Delete — confirmation prompt, then sends `DELETE_RECORDING`, re-fetches list
  - Copy URL — visible only when `uploaded && blossomUrl`, copies to clipboard
- [x] Empty state: "No recordings yet" with prompt text
- [x] Status bar at top showing current extension state (recording in progress, uploading, etc.)
- [x] Re-fetch list on `STATE_CHANGED` to `complete` or `idle` (catches new recordings and upload completions)

**`style.css`:**
- [x] Follow settings page design tokens (import from `:host` or use same vars)
- [x] Recording cards: dark surface, border-subtle, metadata row, action buttons
- [x] Upload status badge: green dot for uploaded, neutral for not uploaded
- [x] Responsive: single column, max-width container

#### 2.8 Upload from library

When uploading from the recordings page:
- [x] The page sends a new message `UPLOAD_FROM_LIBRARY` with `{ hash, serverOverride?, publishToNostr, noteContent? }`
- [x] Background handler: check state is `idle`, then store hash, set `pendingPublishToNostr`, transition to `uploading`, send `START_UPLOAD` to offscreen with the specific hash
- [x] Offscreen `START_UPLOAD` handler: if `msg.hash` is provided, load that specific recording instead of `getAll + sort latest`
- [x] Progress and completion flow works the same as the normal upload
- [x] The recordings page listens for `STATE_CHANGED` and `UPLOAD_PROGRESS` to show progress inline
- [x] On completion, recordings page re-fetches list to reflect updated `uploaded` status

#### 2.9 Popup button

**`entrypoints/popup/main.ts`:**

- [x] Add "Recordings" button below the action buttons area (or next to the settings gear in the header)
- [x] Click handler: `browser.tabs.create({ url: browser.runtime.getURL('/recordings.html') })`

**`entrypoints/popup/index.html` + `style.css`:**

- [x] Add the button markup and styling, matching existing popup aesthetic

## Files

| File | Action |
|------|--------|
| `utils/messages.ts` | Add 4+ message types and interfaces |
| `utils/state.ts` | Add `PROTECTED_STATES` constant |
| `entrypoints/overlay.content/index.ts` | Track state, guard dismiss paths |
| `entrypoints/background.ts` | Guard RESET_STATE, route new messages, wire MARK_UPLOADED into UPLOAD_COMPLETE |
| `entrypoints/offscreen/main.ts` | IDB v2, new operations, new message handlers |
| `entrypoints/review/main.ts` | beforeunload guard during protected states |
| `entrypoints/recordings/index.html` | New — page shell |
| `entrypoints/recordings/main.ts` | New — library logic |
| `entrypoints/recordings/style.css` | New — library styles |
| `entrypoints/popup/main.ts` | Add Recordings button |
| `entrypoints/popup/index.html` | Add button markup |
| `entrypoints/popup/style.css` | Button styles |

## Implementation Order

1. **Part 1: Dismiss protection** — small, self-contained, immediately valuable
2. **IDB schema + operations** — foundation for the library
3. **Message types + routing** — plumbing between offscreen/background
4. **Recordings page** — the UI
5. **Upload from library** — depends on recordings page + message routing
6. **Popup button** — trivial, do last

## Acceptance Criteria

- [ ] Backdrop click does nothing during confirming/uploading/publishing/finalizing states
- [ ] Escape key does nothing during those states
- [ ] Background rejects RESET_STATE during uploading/publishing/finalizing
- [ ] Review page warns before tab close during protected states
- [ ] Recordings page lists all stored recordings with metadata
- [ ] Download works for any recording in the library
- [ ] Delete removes a recording from IDB (with confirmation prompt)
- [ ] Upload from library works when extension state is idle
- [ ] Upload from library is disabled when extension is busy
- [ ] `uploaded` flag and `blossomUrl` are updated in IDB after every successful upload (both normal flow and library)
- [ ] Copy URL button appears for uploaded recordings
- [ ] Popup has a Recordings button that opens the library page
- [ ] Empty state shown when no recordings exist
