import { MessageType, type Message } from '@/utils/messages';
import { type ExtensionState } from '@/utils/state';

const OFFSCREEN_PATH = '/offscreen.html';

let currentState: ExtensionState = 'idle';

function setState(state: ExtensionState) {
  currentState = state;
  browser.storage.local.set({ state });

  // Send to extension pages (popup, offscreen)
  browser.runtime.sendMessage({
    type: MessageType.STATE_CHANGED,
    state,
  }).catch(() => {});

  // Send to content scripts in all tabs
  browser.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        browser.tabs.sendMessage(tab.id, {
          type: MessageType.STATE_CHANGED,
          state,
        }).catch(() => {});
      }
    }
  });

  // REC badge on extension icon
  if (state === 'recording') {
    browser.action.setBadgeText({ text: 'REC' });
    browser.action.setBadgeBackgroundColor({ color: '#e53e3e' });
  } else {
    browser.action.setBadgeText({ text: '' });
  }
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await (browser.runtime as any).getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  await (browser as any).offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['DISPLAY_MEDIA', 'USER_MEDIA'],
    justification: 'Screen recording with WebCodecs encoding',
  });
}

async function closeOffscreenDocument() {
  if (!(await hasOffscreenDocument())) return;
  await (browser as any).offscreen.closeDocument();
}

export default defineBackground(() => {
  console.log('[background] service worker started');

  // Reset state on startup (storage.local persists, so clear stale state)
  browser.storage.local.set({ state: 'idle' });

  browser.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse) => {
      switch (message.type) {
        case MessageType.GET_STATE:
          sendResponse(currentState);
          return false;

        case MessageType.RESET_STATE:
          setState('idle');
          closeOffscreenDocument().catch(console.error);
          sendResponse({ ok: true });
          return false;

        case MessageType.START_RECORDING: {
          setState('initializing');

          ensureOffscreenDocument()
            .then(() => {
              setState('awaiting_media');
              return browser.runtime.sendMessage({
                type: MessageType.START_CAPTURE,
                target: 'offscreen',
              });
            })
            .catch((err) => {
              console.error('[background] failed to start recording:', err);
              setState('idle');
            });

          sendResponse({ ok: true });
          return false;
        }

        case MessageType.STOP_RECORDING: {
          browser.runtime.sendMessage({
            type: MessageType.STOP_CAPTURE,
            target: 'offscreen',
          }).catch(console.error);

          setState('finalizing');
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.CAPTURE_READY:
          console.log('[background] capture ready, codec:', (message as any).codec);
          setState('recording');
          return false;

        case MessageType.CAPTURE_ERROR:
          console.error('[background] capture error:', (message as any).error);
          setState('error');
          return false;

        case MessageType.TOGGLE_MIC: {
          browser.runtime.sendMessage({
            type: MessageType.TOGGLE_MIC,
            target: 'offscreen',
            muted: (message as any).muted,
          }).catch(console.error);
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.TOGGLE_WEBCAM: {
          browser.runtime.sendMessage({
            type: MessageType.TOGGLE_WEBCAM,
            target: 'offscreen',
            enabled: (message as any).enabled,
          }).catch(console.error);
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.GET_RECORDING: {
          ensureOffscreenDocument()
            .then(() =>
              browser.runtime.sendMessage({
                type: MessageType.GET_RECORDING,
                target: 'offscreen',
              }),
            )
            .then((data) => sendResponse(data))
            .catch((err) => {
              console.error('[background] get recording error:', err);
              sendResponse(null);
            });
          return true; // async sendResponse
        }

        case MessageType.RECORDING_COMPLETE: {
          const msg = message as any;
          console.log(`[background] recording complete: ${msg.size} bytes, ${msg.duration}s`);
          setState('complete');
          return false;
        }

        default:
          return false;
      }
    },
  );
});
