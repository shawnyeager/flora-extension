/**
 * Extension state machine.
 *
 * Transitions:
 *   idle -> initializing        (user clicks Start)
 *   initializing -> awaiting_media (offscreen doc + content script ready)
 *   initializing -> idle          (error)
 *   awaiting_media -> countdown   (streams acquired)
 *   awaiting_media -> idle        (user denied / error)
 *   countdown -> recording        (countdown finished)
 *   countdown -> idle             (user cancelled)
 *   recording -> finalizing       (user clicks Stop / stream ends)
 *   finalizing -> preview         (MP4 ready, user reviews)
 *   preview -> confirming         (user clicks Upload & Share)
 *   preview -> idle               (user discards)
 *   confirming -> uploading       (user confirms upload)
 *   confirming -> preview         (user clicks Back)
 *   uploading -> publishing       (upload complete, public mode)
 *   uploading -> complete         (upload complete, unlisted/private mode)
 *   uploading -> error            (upload failed)
 *   publishing -> complete        (note published)
 *   complete -> idle              (user dismisses)
 *   error -> uploading            (retry)
 *   error -> idle                 (save local / dismiss)
 */
export type ExtensionState =
  | 'idle'
  | 'initializing'
  | 'awaiting_media'
  | 'countdown'
  | 'recording'
  | 'finalizing'
  | 'preview'
  | 'confirming'
  | 'uploading'
  | 'publishing'
  | 'complete'
  | 'error';

/** Valid state transitions */
export const TRANSITIONS: Record<ExtensionState, ExtensionState[]> = {
  idle: ['initializing'],
  initializing: ['awaiting_media', 'idle'],
  awaiting_media: ['countdown', 'idle'],
  countdown: ['recording', 'idle'],
  recording: ['finalizing'],
  finalizing: ['preview'],
  preview: ['confirming', 'idle'],
  confirming: ['uploading', 'preview'],
  uploading: ['publishing', 'complete', 'error'],
  publishing: ['complete'],
  complete: ['idle'],
  error: ['uploading', 'idle'],
};

export function canTransition(from: ExtensionState, to: ExtensionState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States where the user should not be able to dismiss/reset the UI */
export const PROTECTED_STATES: ExtensionState[] = ['finalizing', 'confirming', 'uploading', 'publishing'];
