---
title: "fix: Recording preview, controls, and quality bugs"
type: fix
status: active
date: 2026-03-12
---

# fix: Recording Preview, Controls, and Quality Bugs

## Overview

Five bugs affecting recording quality and the post-recording experience. Each has a clear root cause identified from code analysis.

## Bugs

### 🐛 1. Post-recording preview shows black window

**Root cause:** `getLatestRecording()` in `entrypoints/offscreen/main.ts:300-329` converts the full video `ArrayBuffer` to a base64 data URL using a byte-by-byte `String.fromCharCode` loop + `btoa()`, then sends it over `browser.runtime.sendMessage()`. This is:

1. **Extremely slow** — O(n) string concatenation for every byte
2. **Exceeds message size limits** — A 30s recording at 3 Mbps is ~11 MB raw, ~15 MB as base64. Chrome's `sendMessage` can silently fail or truncate at these sizes.
3. **Blocks the offscreen document** — The synchronous loop freezes the event loop

The content script sets `video.src = result.dataUrl` but with corrupt/truncated data, the `<video>` shows its `background: #000` fallback.

**Fix:** Open the standalone `review.html` extension page for preview. It can read IndexedDB directly (same extension origin), completely bypassing the message size problem.

- When state transitions to `'preview'`, background opens `review.html` in a new tab (or focuses it if already open)
- Remove the overlay content script's review panel entirely — it was the source of the PiP/controls-in-recording problems too
- `review.html` already exists with full preview UI; just needs to load video from IndexedDB using `URL.createObjectURL(new Blob([buffer]))` instead of data URLs
- The review page already handles all states (preview, confirming, uploading, publishing, complete, error)

**Files:**

| File | Change |
|------|--------|
| `entrypoints/background.ts:339` | Open `review.html` tab instead of just `setState('preview')` |
| `entrypoints/review/main.ts:90-102` | Use blob URL from IndexedDB instead of `GET_RECORDING` message |
| `entrypoints/offscreen/main.ts:300-329` | Keep `getLatestRecording()` for download but fix with `FileReader.readAsDataURL()` for smaller payloads |
| `entrypoints/overlay.content/index.ts` | Remove review panel code (lines 344-780+) — no longer needed |
| `entrypoints/overlay.content/style.css` | Remove all `.bloom-review` / `.br-*` styles |

### 🐛 2. Popup camera toggle has no effect

**Root cause:** Background's `TOGGLE_WEBCAM` handler (`background.ts:308-316`) forwards the message to the **offscreen document** via `browser.runtime.sendMessage({ target: 'offscreen' })`. Two problems:

1. The offscreen document has **no `TOGGLE_WEBCAM` handler** — message is silently dropped
2. The webcam lives in the **content script**, not the offscreen document — the offscreen never touches the webcam

`browser.runtime.sendMessage()` only reaches extension pages (popup, background, offscreen), **not content scripts**. To reach a content script, background must use `browser.tabs.sendMessage(recordingTabId, ...)`.

The content script's own cam button (overlay.content/index.ts:222-238) works fine because it directly manipulates the local DOM — no message passing needed.

**Fix:** Background forwards `TOGGLE_WEBCAM` to the recording tab's content script, and add an incoming message handler in the content script.

**Files:**

| File | Change |
|------|--------|
| `entrypoints/background.ts:308-316` | Use `browser.tabs.sendMessage(recordingTabId, ...)` instead of `browser.runtime.sendMessage({ target: 'offscreen' })` |
| `entrypoints/overlay.content/index.ts:785` | Add `TOGGLE_WEBCAM` handler in the `onMessage` listener |

### 🐛 3. Video jumps vertically on playback start

**Root cause:** The review panel `.br-panel` has an entrance animation: `transform: translateY(8px)` → `translateY(0)` over 0.25s with a 0.05s delay (`overlay.content/style.css:326-331`). The `<video>` element has `max-height: 300px` but no explicit `aspect-ratio`. When video metadata loads and the browser determines the intrinsic dimensions, the element's height changes — causing a visible reflow **after** the entrance animation.

**Fix:** If we go with Bug 1's fix (moving preview to `review.html`), the overlay panel animation is removed entirely. For the `review.html` page:

- Set `aspect-ratio: 16/9` on the video element to pre-reserve space
- Load video src **before** making the view visible

**Files:**

| File | Change |
|------|--------|
| `entrypoints/review/style.css` | Add `aspect-ratio: 16/9` to video element |
| `entrypoints/review/main.ts` | Ensure video `loadedmetadata` fires before showing the view |

### 🐛 4. Audio levels are low

**Root cause:** `mixAudioTracks()` in `offscreen/main.ts:189-199` connects each audio source directly to the `AudioContext.destination` with **no `GainNode`** in the signal chain. Additionally:

- `noiseSuppression: true` (line 45) aggressively reduces perceived mic volume
- `echoCancellation: true` (line 45) subtracts system audio from mic, further reducing level
- No `autoGainControl` specified — browser may not boost quiet mic input

```typescript
// Current — no gain control
function mixAudioTracks(tracks: MediaStreamTrack[]): MediaStreamTrack {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const dest = ctx.createMediaStreamDestination();
  for (const track of tracks) {
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    source.connect(dest); // ← direct connection, no gain
  }
  return dest.stream.getAudioTracks()[0];
}
```

**Fix:**

```typescript
// Fixed — GainNode per source, mic boosted
function mixAudioTracks(tracks: MediaStreamTrack[], micIndex: number): MediaStreamTrack {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const dest = ctx.createMediaStreamDestination();
  for (let i = 0; i < tracks.length; i++) {
    const source = ctx.createMediaStreamSource(new MediaStream([tracks[i]]));
    const gain = ctx.createGain();
    gain.gain.value = i === micIndex ? 1.4 : 1.0; // boost mic slightly
    source.connect(gain).connect(dest);
  }
  return dest.stream.getAudioTracks()[0];
}
```

Also update mic constraints:

```typescript
micStream = await navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true, // ← let browser normalize mic level
  },
});
```

**Files:**

| File | Change |
|------|--------|
| `entrypoints/offscreen/main.ts:189-199` | Add `GainNode` per source, boost mic |
| `entrypoints/offscreen/main.ts:44-46` | Add `autoGainControl: true` to mic constraints |

### 🐛 5. Webcam quality is low

**Root cause:** `getUserMedia` at `overlay.content/index.ts:304-305` requests only **320x240** (QVGA):

```typescript
const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: 320, height: 240, facingMode: 'user' },
});
```

The webcam bubble is 120x120 CSS pixels, but on HiDPI displays (2x), that's 240 device pixels. The 320x240 source is being stretched. More importantly, `getDisplayMedia` captures what's rendered on screen, so the webcam in the final video is at whatever rendered resolution — blurry at 320x240.

**Fix:** Request 640x480 with `ideal` constraints (graceful fallback):

```typescript
const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
});
```

This gives the browser room to negotiate (won't fail if 640x480 isn't available) and provides 4x the pixels for the screen capture.

**Files:**

| File | Change |
|------|--------|
| `entrypoints/overlay.content/index.ts:304-305` | Change to `{ ideal: 640 }` / `{ ideal: 480 }` |

## Acceptance Criteria

- [x] After recording, `review.html` opens with the video playing correctly (not black)
- [x] Popup camera toggle button actually hides/shows the webcam bubble on the page
- [x] No vertical jump/shift when video starts playing in the review page
- [x] Audio levels are noticeably louder (mic is audible at normal speaking volume)
- [x] Webcam bubble appears sharp on HiDPI displays, and in the recorded output
- [x] Download button still works (produces valid MP4 file)
- [ ] All existing flows still work: record → preview → confirm → upload → publish

## Implementation Order

1. **Bug 5** (webcam quality) — one-line change, zero risk
2. **Bug 4** (audio levels) — small change to `mixAudioTracks` + mic constraints
3. **Bug 2** (popup camera toggle) — routing fix in background.ts + handler in content script
4. **Bug 1** (black preview) — largest change, moves preview to review.html, removes overlay panel
5. **Bug 3** (vertical jump) — addressed by Bug 1 fix + aspect-ratio on review.html video

## Edge Cases (from SpecFlow analysis)

- **Download button**: Also uses the broken base64 data URL path. Fix in review.html by creating blob URL from IDB ArrayBuffer directly.
- **`recordingTabId` staleness**: If user navigates/closes the recording tab, `tabs.sendMessage` for TOGGLE_WEBCAM fails. Wrap in try/catch, still update `controlsState` in background.
- **No mic available**: `mixAudioTracks` is only called when both system audio and mic are present (`audioTracks.length > 1`). Single-track path is fine as-is.
- **Webcam doesn't support 640x480**: Using `ideal` constraints means the browser negotiates gracefully — won't reject the getUserMedia call.
- **IDB race on preview**: `storeRecording()` awaits the IDB put before sending `RECORDING_COMPLETE`, so data is committed before state changes. Safe.
- **review.html handles ALL post-recording states**: preview, confirming, uploading, publishing, complete, error. The overlay review panel becomes dead code — remove it entirely.

## References

- `entrypoints/offscreen/main.ts` — capture, encoding, IndexedDB storage, base64 conversion
- `entrypoints/background.ts` — message routing, state machine, `TOGGLE_WEBCAM` handler
- `entrypoints/overlay.content/index.ts` — webcam preview, review panel, message listeners
- `entrypoints/review/main.ts` — standalone review page (already exists)
- `utils/messages.ts` — `TOGGLE_WEBCAM`, `GET_RECORDING` message types
