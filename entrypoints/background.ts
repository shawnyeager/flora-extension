import { MessageType, type Message } from '@/utils/messages';
import { type ExtensionState } from '@/utils/state';

let currentState: ExtensionState = 'idle';

function setState(state: ExtensionState) {
  currentState = state;
  browser.storage.session.set({ state });
  // Broadcast state change to all contexts
  browser.runtime.sendMessage({
    type: MessageType.STATE_CHANGED,
    state,
  }).catch(() => {
    // Popup may not be open — ignore
  });
}

export default defineBackground(() => {
  console.log('[background] service worker started');

  // Restore state from session storage
  browser.storage.session.get('state').then((result) => {
    if (result.state) {
      currentState = result.state as ExtensionState;
    }
  });

  browser.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse) => {
      switch (message.type) {
        case MessageType.GET_STATE:
          sendResponse(currentState);
          return false;

        case MessageType.START_RECORDING:
          console.log('[background] start recording requested');
          setState('initializing');
          // TODO: Phase 2 — create offscreen doc, start capture pipeline
          sendResponse({ ok: true });
          return false;

        case MessageType.STOP_RECORDING:
          console.log('[background] stop recording requested');
          setState('finalizing');
          // TODO: Phase 2 — stop capture, finalize MP4
          sendResponse({ ok: true });
          return false;

        default:
          return false;
      }
    },
  );
});
