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
 *   finalizing -> uploading       (MP4 ready)
 *   uploading -> publishing       (upload complete)
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
  finalizing: ['uploading'],
  uploading: ['publishing', 'error'],
  publishing: ['complete'],
  complete: ['idle'],
  error: ['uploading', 'idle'],
};

export function canTransition(from: ExtensionState, to: ExtensionState): boolean {
  return TRANSITIONS[from].includes(to);
}
