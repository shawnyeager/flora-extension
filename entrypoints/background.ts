import { MessageType, type Message } from '@/utils/messages';
import { type ExtensionState } from '@/utils/state';
import { getSettings } from '@/utils/settings';

const OFFSCREEN_PATH = '/offscreen.html';

let currentState: ExtensionState = 'idle';
let uploadResult: { url: string; sha256: string; size: number } | null = null;
let publishResult: { noteId: string; blossomUrl: string } | null = null;
let cachedNip07: { pubkey: string } | { error: string } | null = null;
let lastRecordingMeta: { size: number; duration: number } | null = null;
let pendingPublishToNostr = true;

async function relayToContentScript(message: Message): Promise<any> {
  // Try active tab first, fall back to any tab
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  const tabId = activeTab?.id;

  if (tabId) {
    try {
      return await browser.tabs.sendMessage(tabId, message);
    } catch {
      // Active tab doesn't have content script, try others
    }
  }

  // Try all tabs
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || tab.id === tabId) continue;
    try {
      return await browser.tabs.sendMessage(tab.id, message);
    } catch {
      continue;
    }
  }

  throw new Error('No content script available for NIP-07 signing');
}

function probeNip07() {
  cachedNip07 = null;
  relayToContentScript({ type: MessageType.NIP07_GET_PUBKEY } as Message)
    .then((result) => {
      if (result?.ok !== false && result?.data) {
        cachedNip07 = { pubkey: result.data };
      } else {
        cachedNip07 = { error: result?.error || 'Unknown NIP-07 error' };
      }
    })
    .catch((err) => {
      cachedNip07 = { error: err.message };
    });
}

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
          uploadResult = null;
          publishResult = null;
          closeOffscreenDocument().catch(console.error);
          sendResponse({ ok: true });
          return false;

        case MessageType.GET_RESULT:
          sendResponse({ uploadResult, publishResult });
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
          lastRecordingMeta = { size: msg.size, duration: msg.duration };
          setState('preview');
          // Proactively probe NIP-07 so confirmation screen has data ready
          probeNip07();
          return false;
        }

        case MessageType.UPLOAD_PROGRESS: {
          // Relay to popup and content scripts
          browser.runtime.sendMessage(message).catch(() => {});
          browser.tabs.query({}).then((tabs) => {
            for (const tab of tabs) {
              if (tab.id) browser.tabs.sendMessage(tab.id, message).catch(() => {});
            }
          });
          return false;
        }

        case MessageType.UPLOAD_COMPLETE: {
          const msg = message as any;
          console.log(`[background] upload complete: ${msg.url}`);
          uploadResult = { url: msg.url, sha256: msg.sha256, size: msg.size };

          if (pendingPublishToNostr) {
            setState('publishing');
            browser.runtime.sendMessage({
              type: MessageType.PUBLISH_NOTE,
              target: 'offscreen',
              blossomUrl: msg.url,
              sha256: msg.sha256,
              size: msg.size,
            }).catch(console.error);
          } else {
            // Skip Nostr publish — go straight to complete
            setState('complete');
          }
          return false;
        }

        case MessageType.UPLOAD_ERROR: {
          console.error('[background] upload error:', (message as any).error);
          setState('error');
          return false;
        }

        case MessageType.PUBLISH_COMPLETE: {
          const msg = message as any;
          console.log(`[background] published note: ${msg.noteId}`);
          publishResult = { noteId: msg.noteId, blossomUrl: msg.blossomUrl };
          setState('complete');
          return false;
        }

        case MessageType.PUBLISH_ERROR: {
          console.error('[background] publish error:', (message as any).error);
          // Publishing failed but upload succeeded — still go to complete
          if (uploadResult) {
            publishResult = { noteId: '', blossomUrl: uploadResult.url };
            setState('complete');
          } else {
            setState('error');
          }
          return false;
        }

        case MessageType.START_UPLOAD: {
          // Manual retry from popup (or auto-trigger won't hit here since background is sender)
          setState('uploading');
          ensureOffscreenDocument()
            .then(() =>
              browser.runtime.sendMessage({
                type: MessageType.START_UPLOAD,
                target: 'offscreen',
              }),
            )
            .catch(console.error);
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.NIP07_SIGN:
        case MessageType.NIP07_GET_PUBKEY: {
          // Route to content script in the active tab
          relayToContentScript(message)
            .then((result) => sendResponse(result))
            .catch((err) => sendResponse({ ok: false, error: err.message }));
          return true; // async sendResponse
        }

        case MessageType.GET_CONFIRM_DATA: {
          if (currentState === 'preview') setState('confirming');
          getSettings()
            .then((settings) => {
              const nip07Available = cachedNip07 !== null && 'pubkey' in cachedNip07;
              sendResponse({
                npub: nip07Available ? (cachedNip07 as { pubkey: string }).pubkey : null,
                signerAvailable: nip07Available,
                bridgeError: cachedNip07 !== null && 'error' in cachedNip07
                  ? (cachedNip07 as { error: string }).error
                  : cachedNip07 === null ? 'NIP-07 probe still in progress' : null,
                server: settings.blossomServers[0] || 'https://blossom.band',
                relays: settings.nostrRelays,
                publishToNostr: settings.publishToNostr,
                fileSize: lastRecordingMeta?.size ?? 0,
                duration: lastRecordingMeta?.duration ?? 0,
              });
            })
            .catch((err) => {
              console.error('[background] GET_CONFIRM_DATA error:', err);
              sendResponse(null);
            });
          return true; // async sendResponse
        }

        case MessageType.CONFIRM_UPLOAD: {
          const msg = message as any;
          pendingPublishToNostr = msg.publishToNostr !== false;
          setState('uploading');
          ensureOffscreenDocument()
            .then(() =>
              browser.runtime.sendMessage({
                type: MessageType.START_UPLOAD,
                target: 'offscreen',
                serverOverride: msg.serverOverride,
                publishToNostr: msg.publishToNostr,
              }),
            )
            .catch(console.error);
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.BACK_TO_PREVIEW: {
          setState('preview');
          sendResponse({ ok: true });
          return false;
        }

        default:
          return false;
      }
    },
  );
});
