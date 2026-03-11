import { MessageType, type Message } from '@/utils/messages';

console.log('[offscreen] document loaded');

browser.runtime.onMessage.addListener(
  (message: Message, _sender, sendResponse) => {
    // Filter messages intended for the offscreen document
    if (message.target !== 'offscreen') return false;

    switch (message.type) {
      case MessageType.START_CAPTURE:
        console.log('[offscreen] start capture requested');
        // TODO: Phase 2 — getDisplayMedia, WebCodecs encoding, muxing
        sendResponse({ ok: true });
        return false;

      case MessageType.STOP_CAPTURE:
        console.log('[offscreen] stop capture requested');
        // TODO: Phase 2 — stop encoding, finalize MP4
        sendResponse({ ok: true });
        return false;

      default:
        return false;
    }
  },
);
