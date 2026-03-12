---
title: "feat: Complete upload flow — note text and upload-only result"
type: feat
status: completed
date: 2026-03-12
---

# Complete Upload Flow

Two gaps in the post-recording flow:

1. Publishing to Nostr creates a bare URL note with no user text — you can't say anything about your recording
2. Upload-only (no publish) works technically but the UI says "Shared successfully" which implies Nostr, and offers no context that this is just a Blossom upload

## Problem

### No note content

`publishNote()` in `entrypoints/offscreen/main.ts:374` hardcodes `content: blossomUrl`. The confirm view has no textarea. The `CONFIRM_UPLOAD` and `PUBLISH_NOTE` message interfaces carry no text field. There is zero path for user-supplied text to reach the Nostr event.

### Upload-only UX is misleading

When `pendingPublishToNostr` is false, `UPLOAD_COMPLETE` goes straight to `setState('complete')`. The complete view shows the Blossom URL correctly (falls back to `uploadResult.url`), but:
- Title says "Shared successfully" — implies Nostr sharing happened
- No distinction between "uploaded to Blossom" vs "published to Nostr"

## Changes

### 1. Add note textarea to confirm view

**`entrypoints/overlay.content/index.ts`** — In the `.br-confirm` innerHTML (line ~388):

- [x] Add a `<textarea class="br-confirm-note">` between the publish checkbox and the relay row
- [x] Placeholder: `"Say something about this recording..."`
- [x] Only visible when publish checkbox is checked
- [x] Wire the publish checkbox change handler to show/hide the textarea (alongside the relay row toggle that already exists in `showConfirm()`)

### 2. Pass note content through the message chain

**`utils/messages.ts`**:

- [x] Add `noteContent?: string` to `ConfirmUploadMessage` interface
- [x] Add `noteContent?: string` to `PublishNoteMessage` interface

**`entrypoints/overlay.content/index.ts`** — `.br-btn-confirm` click handler (line ~501):

- [x] Read `.br-confirm-note` textarea value and include as `noteContent` in the `CONFIRM_UPLOAD` message

**`entrypoints/background.ts`** — `CONFIRM_UPLOAD` handler (line ~393):

- [x] Store `noteContent` from message (module-scope var like `pendingPublishToNostr`)
- [x] Pass `noteContent` in the `PUBLISH_NOTE` message forwarded to offscreen

**`entrypoints/background.ts`** — `UPLOAD_COMPLETE` handler (line ~297):

- [x] Include stored `noteContent` in the `PUBLISH_NOTE` message

### 3. Use note content in the Nostr event

**`entrypoints/offscreen/main.ts`** — `publishNote()` function (line ~369):

- [x] Accept `noteContent?: string` parameter
- [x] If noteContent is non-empty: `content = noteContent + '\n\n' + blossomUrl`
- [x] If noteContent is empty: `content = blossomUrl` (current behavior)
- [x] Update the `alt` in imeta to use a trimmed version of noteContent (first 100 chars) instead of hardcoded `"Screen recording"`

**`entrypoints/offscreen/main.ts`** — `PUBLISH_NOTE` message handler (line ~487):

- [x] Pass `msg.noteContent` to `publishNote()`

### 4. Differentiate complete view for upload-only vs published

**`entrypoints/overlay.content/index.ts`** — `updateUI('complete')` handler (line ~743):

- [x] Call `GET_RESULT` (already done)
- [x] If `publishResult?.noteId` is non-empty: title = "Shared successfully", show note link (njump)
- [x] If only `uploadResult` exists (no publish): title = "Uploaded", just show the Blossom URL
- [x] Copy button copies the Blossom URL in both cases (current behavior is fine)

### 5. Style the note textarea

**`entrypoints/overlay.content/style.css`**:

- [x] Add `.br-confirm-note` styles: full width, 3 rows, matches existing `.br-dest-input` aesthetic (monospace, dark bg, subtle border), resize: none
- [x] Scrollbar styling matching the settings page textarea
- [x] Focus ring matching other inputs

## Files

| File | Action |
|------|--------|
| `utils/messages.ts` | Add `noteContent` to 2 interfaces |
| `entrypoints/overlay.content/index.ts` | Textarea in confirm view, pass noteContent, differentiate complete title |
| `entrypoints/overlay.content/style.css` | Textarea styles |
| `entrypoints/background.ts` | Store and forward noteContent |
| `entrypoints/offscreen/main.ts` | Use noteContent in event draft |

## Acceptance Criteria

- [x] Confirm view shows a textarea when "Publish to Nostr" is checked
- [x] Textarea is hidden when publish is unchecked
- [x] Note text appears in the published Nostr event's `content` field (before the URL)
- [x] Empty note text = URL-only content (backward compatible, current behavior)
- [x] Upload without publish shows "Uploaded" (not "Shared successfully") and displays the Blossom URL
- [x] Upload with publish shows "Shared successfully" and displays the Blossom URL
- [x] Copy Link works in both flows
