---
title: "feat: Add upload confirmation to recordings page"
type: feat
status: completed
date: 2026-03-12
---

# feat: Add upload confirmation to recordings page

## Problem

Clicking "Upload" on the recordings page fires the upload immediately with no confirmation. If the user has "Publish to Nostr" enabled in settings, their video auto-posts to Nostr without any review. Nobody wants to yolo-post a video.

The review page has a proper confirmation flow: show server, Nostr toggle (pre-filled from settings), identity status, then "Confirm Upload". The recordings page needs the same gate.

## Approach: Inline confirmation panel

When the user clicks "Upload" on a recording card, show a confirmation panel below the grid (or as a bottom sheet/overlay) with:

1. **Which recording** — thumbnail + duration so they know what they're uploading
2. **Upload to** — server URL (read-only, from settings)
3. **Publish to Nostr** — checkbox, pre-filled from `settings.publishToNostr`
4. **Relay list** — shown when Nostr checkbox is on (from settings)
5. **Identity** — signer status (npub or warning)
6. **Confirm Upload** / **Cancel** buttons

This reuses the existing `GET_CONFIRM_DATA` message that background already handles — it returns server, relays, publishToNostr default, npub, and signer status.

The only difference from the review page: the recordings page must also pass the recording `hash` when confirming, since it's uploading from the library (not the most recent recording).

## Implementation

### 1. Add confirmation overlay HTML to `recordings/index.html`

Add a hidden overlay panel (similar to the player overlay that already exists):

```html
<div id="upload-confirm" class="confirm-overlay" hidden>
  <div class="confirm-backdrop"></div>
  <div class="confirm-panel">
    <h2>Review before uploading</h2>
    <div class="confirm-preview">
      <img id="confirm-thumb" class="confirm-thumb" alt="" />
      <span id="confirm-info" class="confirm-info"></span>
    </div>
    <div class="confirm-field">
      <label>Upload to</label>
      <div id="confirm-server" class="confirm-value mono"></div>
    </div>
    <div class="confirm-field">
      <label class="confirm-check-label">
        <input type="checkbox" id="confirm-nostr" />
        Publish note to Nostr
      </label>
      <div id="confirm-relays" class="confirm-sub"></div>
    </div>
    <div class="confirm-field">
      <label>Signing as</label>
      <div id="confirm-identity" class="confirm-value mono"></div>
    </div>
    <div id="confirm-warning" class="warning" style="display:none"></div>
    <div class="confirm-actions">
      <button id="confirm-upload-btn" class="confirm-btn-primary">Confirm Upload</button>
      <button id="confirm-cancel-btn" class="confirm-btn-secondary">Cancel</button>
    </div>
  </div>
</div>
```

### 2. Add confirmation panel styles to `recordings/style.css`

Style the overlay to match the existing player overlay pattern:
- `.confirm-overlay` — fixed overlay with backdrop
- `.confirm-panel` — centered card, same radius/bg as the existing player content
- `.confirm-field` — same layout as review page fields
- `.confirm-check-label` — same as review page
- Reuse existing token variables

### 3. Update `recordings/main.ts` — Upload button opens confirmation

Change the Upload button click handler:

```typescript
// Instead of immediately sending UPLOAD_FROM_LIBRARY:
upBtn.addEventListener('click', async (e) => {
  e.stopPropagation();
  showUploadConfirm(rec);
});
```

New `showUploadConfirm(rec)` function:
- Shows the confirm overlay
- Sets thumbnail and recording info (duration, size)
- Calls `GET_CONFIRM_DATA` to get server, relays, signer status, publishToNostr default
- Pre-fills the Nostr checkbox from settings
- Shows/hides relay list based on checkbox
- Shows signer identity or warning
- Stores the `hash` for when user clicks Confirm

### 4. Confirm button sends `UPLOAD_FROM_LIBRARY`

```typescript
confirmUploadBtn.addEventListener('click', async () => {
  confirmUploadBtn.disabled = true;
  confirmUploadBtn.textContent = 'Uploading…';
  await browser.runtime.sendMessage({
    type: MessageType.UPLOAD_FROM_LIBRARY,
    hash: pendingHash,
    publishToNostr: confirmNostr.checked,
  });
  hideUploadConfirm();
});
```

### 5. Cancel button and backdrop click close the panel

```typescript
confirmCancelBtn.addEventListener('click', hideUploadConfirm);
confirmBackdrop.addEventListener('click', hideUploadConfirm);
```

## Files

| File | Change |
|------|--------|
| `entrypoints/recordings/index.html` | Add confirm overlay HTML |
| `entrypoints/recordings/style.css` | Add confirm panel styles |
| `entrypoints/recordings/main.ts` | Upload button opens confirm, confirm button sends UPLOAD_FROM_LIBRARY |

## Acceptance Criteria

- [x] Clicking "Upload" on a recording card opens the confirmation panel (not immediately uploading)
- [x] Panel shows: recording thumbnail + duration, server URL, Nostr checkbox (pre-filled from settings), relay list (when Nostr is on), signer identity
- [x] "Confirm Upload" sends `UPLOAD_FROM_LIBRARY` with the checkbox value for `publishToNostr`
- [x] "Cancel" and backdrop click close the panel without uploading
- [x] Panel disappears when upload starts (state changes to uploading)
- [x] Signer warning shown if no NIP-07 signer detected
- [x] Keyboard accessible: Escape closes, focus trapped in panel
