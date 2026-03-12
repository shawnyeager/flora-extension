---
title: "fix: Recording controls visible in captured video"
type: fix
status: completed
date: 2026-03-12
---

# fix: Recording controls visible in captured video

## Problem

The recording controls bar (timer, pause, mic, camera, stop buttons) is a content script overlay injected into the tab's DOM. When Chrome captures the tab via `getDisplayMedia`, it captures everything rendered in the tab — including the controls. The webcam bubble being captured is **intentional** (by design), but the controls bar appearing in the output is a bug.

## Root Cause

`entrypoints/overlay.content/index.ts` creates both the webcam bubble and the controls bar inside the same Shadow DOM container, injected into the recorded tab. Chrome's tab capture makes no distinction between "app content" and "extension overlay" — it captures the full rendered output.

## Fix

Hide the controls bar on the **recording tab** during active recording. Move recording controls to the **popup**, which is not part of any tab's DOM and never captured.

The webcam bubble stays in the content script — it's supposed to appear in the recording.

### Phase 1: Hide controls on recording tab

**`entrypoints/overlay.content/index.ts`**

In `updateUI()`, when state is `recording`, set `controls.style.display = 'none'`. Show it again for non-recording states (`idle`, `preview`, etc.). The controls are already hidden for `idle` — extend this to cover `recording`.

The controls should remain visible during `countdown` (if we add one later) and `awaiting_media` but must be hidden once `recording` begins.

### Phase 2: Add recording controls to popup

**`entrypoints/popup/main.ts`** and **`entrypoints/popup/index.html`** / **`style.css`**

During `recording` state, the popup currently shows only a Stop button. Add:

- Recording timer (sync'd via a `TIMER_TICK` message or local timer started on state change)
- Pause/Resume toggle
- Mic mute toggle
- Camera toggle

These send the same messages as the content script controls (`PAUSE_RECORDING`, `RESUME_RECORDING`, `TOGGLE_MIC`, `TOGGLE_WEBCAM`).

Layout: horizontal toolbar matching the content script controls aesthetic, but inside the popup's dark panel. Reuse `Icons.*` for consistency.

### Phase 3: Sync state between popup and content script

The popup opens/closes frequently. On open during `recording` state:

1. Query current mic/camera/pause state from background (add a `GET_RECORDING_STATE` message that returns `{ paused, micMuted, webcamOn }`)
2. Render controls with correct toggle states
3. Listen for `STATE_CHANGED` to update

Background needs to track `paused`, `micMuted`, `webcamOn` booleans (currently only tracked in the content script's local variables). Move this state to the background service worker so both popup and content script can query it.

## Files to Change

| File | Change |
|------|--------|
| `entrypoints/overlay.content/index.ts` | Hide `.bloom-controls` during `recording` state |
| `entrypoints/popup/main.ts` | Add recording controls (timer, pause, mic, cam) during `recording` state |
| `entrypoints/popup/style.css` | Style the recording controls toolbar |
| `entrypoints/background.ts` | Track `paused`/`micMuted`/`webcamOn` state; add `GET_RECORDING_STATE` handler |
| `utils/messages.ts` | Add `GET_RECORDING_STATE` message type |

## Acceptance Criteria

- [x] Controls bar does not appear in recorded video output
- [x] Webcam bubble still appears in recorded video (unchanged)
- [x] Popup shows full recording controls (timer, pause, mic, cam, stop) during `recording` state
- [x] Popup controls are synced — opening popup mid-recording shows correct toggle states
- [x] Pause/resume, mic mute, camera toggle all work from the popup
- [x] Timer in popup matches elapsed recording time
- [ ] Keyboard shortcut discoverability: popup could hint at shortcuts (future)

## Out of Scope

- Keyboard shortcuts for controls (separate feature)
- Moving controls to Chrome Side Panel (overkill for now)
- Canvas compositing for webcam (current content script approach works)
