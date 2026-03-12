---
title: "fix: Surface actual error messages when upload fails"
type: fix
status: completed
date: 2026-03-12
---

# fix: Surface actual error messages when upload fails

## Problem

When an upload fails, every UI surface shows a useless generic message:
- **Review page**: "The upload failed. You can retry or discard the recording."
- **Popup**: "Something went wrong"
- **Recordings page**: "Something went wrong"

The actual error (e.g. "403 Forbidden", "network error", server response) is captured by the offscreen document and sent to background — but background **logs it and throws it away**. No UI can ever display it.

## Root Cause

Two loss points in the error propagation chain:

### Loss Point 1: `background.ts` discards the error string

```typescript
// background.ts:404-407
case MessageType.UPLOAD_ERROR: {
  console.error('[background] upload error:', (message as any).error);
  setState('error');  // ← error detail is never stored
  return false;
}
```

Compare to the success path which stores `uploadResult = { url, sha256, size }`. There's no equivalent `lastError` variable.

### Loss Point 2: UI pages use hardcoded strings

- `review/main.ts:375` → hardcoded "The upload failed..."
- `popup/main.ts:286` → hardcoded "Something went wrong"
- `recordings/main.ts:143` → hardcoded "Something went wrong"

No UI ever asks background for the error detail because there's no way to retrieve it.

## Fix

### 1. Add `lastError` variable in `background.ts`

Store the error string alongside the state transition:

```typescript
let lastError: string | null = null;

case MessageType.UPLOAD_ERROR: {
  const errMsg = (message as any).error || 'Upload failed';
  console.error('[background] upload error:', errMsg);
  lastError = errMsg;
  setState('error');
  return false;
}

case MessageType.PUBLISH_ERROR: {
  const errMsg = (message as any).error || 'Publishing failed';
  console.error('[background] publish error:', errMsg);
  // ... existing logic (fallback to complete if uploadResult exists)
  // If transitioning to error:
  lastError = errMsg;
  setState('error');
  return false;
}
```

Clear `lastError` on state transitions away from error (RESET_STATE, retry).

### 2. Add `GET_ERROR` message type

In `utils/messages.ts`:

```typescript
GET_ERROR: 'get_error',
```

In `background.ts`, handle it:

```typescript
case MessageType.GET_ERROR:
  sendResponse({ error: lastError });
  return false;
```

### 3. Update review page (`review/main.ts`)

```typescript
case 'error': {
  showView(viewError);
  const { error } = await browser.runtime.sendMessage({ type: MessageType.GET_ERROR });
  errorMessage.textContent = error || 'The upload failed.';
  break;
}
```

### 4. Update popup (`popup/main.ts`)

Change the hardcoded label map:

```typescript
error: 'Upload failed',  // shorter, more accurate
```

Optionally fetch and display the actual error in a tooltip or subtitle.

### 5. Update recordings page (`recordings/main.ts`)

Same pattern — change generic string to something less useless. The recordings page shows upload status per-recording, so this is lower priority.

## Files

| File | Change |
|------|--------|
| `utils/messages.ts` | Add `GET_ERROR` message type + interface |
| `entrypoints/background.ts` | Add `lastError` variable, store on UPLOAD_ERROR/PUBLISH_ERROR, handle GET_ERROR, clear on reset/retry |
| `entrypoints/review/main.ts` | Fetch and display actual error in error view |
| `entrypoints/popup/main.ts` | Update generic label |
| `entrypoints/recordings/main.ts` | Update generic label |

## Acceptance Criteria

- [x] When upload fails, review page shows the actual error message (e.g. "403 Forbidden", "Failed to fetch")
- [x] Error message clears when user retries or resets
- [x] Popup shows "Upload failed" instead of "Something went wrong"
- [x] Recordings page shows "Upload failed" instead of "Something went wrong"
- [x] `lastError` is cleared on RESET_STATE and on successful upload start (retry)
