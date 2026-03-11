import { MessageType, type Message } from '@/utils/messages';
import { type ExtensionState } from '@/utils/state';
import { getSettings } from '@/utils/settings';

const OFFSCREEN_PATH = '/offscreen.html';

let currentState: ExtensionState = 'idle';
let uploadResult: { url: string; sha256: string; size: number } | null = null;
let publishResult: { noteId: string; blossomUrl: string } | null = null;
let lastRecordingMeta: { size: number; duration: number } | null = null;
let pendingPublishToNostr = true;
let recordingTabId: number | null = null;

/** Find a web tab suitable for scripting.executeScript (not chrome://, chrome-extension://, etc.) */
async function findScriptableTab(): Promise<number | null> {
  if (recordingTabId) return recordingTabId;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id && active.url && /^https?:/.test(active.url)) return active.id;
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  return tabs[0]?.id ?? null;
}

function setState(state: ExtensionState) {
  currentState = state;
  browser.storage.local.set({ state });

  // Focus the recording tab when entering preview (review overlay shows there)
  if (state === 'preview' && recordingTabId) {
    browser.tabs.update(recordingTabId, { active: true }).catch(() => {});
  }

  // Send to extension pages (popup, offscreen, review)
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

async function probeNip07Direct(tabId: number): Promise<{ pubkey: string } | { error: string }> {
  try {
    const results = await (browser as any).scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const nostr = (window as any).nostr;
        if (!nostr) return { error: 'No NIP-07 signer found (window.nostr missing)' };
        if (typeof nostr.getPublicKey !== 'function') return { error: 'window.nostr.getPublicKey is not a function' };
        return nostr.getPublicKey().then(
          (pk: any) => pk ? { pubkey: String(pk) } : { error: 'getPublicKey() returned empty' },
          (err: any) => ({ error: String(err) }),
        );
      },
    });
    return results?.[0]?.result || { error: 'scripting.executeScript returned no result' };
  } catch (err: any) {
    return { error: err.message };
  }
}

async function getPubkeyDirect(tabId: number): Promise<{ ok: true; data: string } | { ok: false; error: string }> {
  const result = await probeNip07Direct(tabId);
  if ('pubkey' in result) return { ok: true, data: result.pubkey };
  return { ok: false, error: result.error };
}

async function signEventDirect(
  tabId: number,
  event: { kind: number; content: string; tags: string[][]; created_at: number },
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  try {
    const results = await (browser as any).scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [event],
      func: (evt: any) => {
        const nostr = (window as any).nostr;
        if (!nostr) return { ok: false, error: 'No NIP-07 signer found' };
        if (typeof nostr.signEvent !== 'function') return { ok: false, error: 'window.nostr.signEvent is not a function' };
        return nostr.signEvent(evt).then(
          (signed: any) => signed ? { ok: true, data: signed } : { ok: false, error: 'signEvent returned empty' },
          (err: any) => ({ ok: false, error: String(err) }),
        );
      },
    });
    return results?.[0]?.result || { ok: false, error: 'scripting.executeScript returned no result' };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
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

        case MessageType.NIP07_PROBE: {
          findScriptableTab()
            .then((tabId) => {
              if (!tabId) return sendResponse({ error: 'No web tab available for NIP-07 probe' });
              return probeNip07Direct(tabId).then((r) => sendResponse(r));
            })
            .catch((err) => sendResponse({ error: err.message }));
          return true;
        }

        case MessageType.START_RECORDING: {
          // Track which tab the user is on — review overlay and NIP-07 happen there
          browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
            recordingTabId = tab?.id ?? null;
            browser.storage.local.set({ recordingTabId });
          });

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

        case MessageType.PAUSE_RECORDING: {
          browser.runtime.sendMessage({
            type: MessageType.PAUSE_CAPTURE,
            target: 'offscreen',
          }).catch(console.error);
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.RESUME_RECORDING: {
          browser.runtime.sendMessage({
            type: MessageType.RESUME_CAPTURE,
            target: 'offscreen',
          }).catch(console.error);
          sendResponse({ ok: true });
          return false;
        }

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
          if (message.target === 'offscreen') return false; // not for us
          // From popup "Upload & Share" — go to confirming, not directly uploading
          if (currentState === 'preview') {
            setState('confirming');
          }
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.NIP07_GET_PUBKEY: {
          findScriptableTab()
            .then((tabId) => {
              if (!tabId) return sendResponse({ ok: false, error: 'No web tab available for NIP-07' });
              return getPubkeyDirect(tabId).then((r) => sendResponse(r));
            })
            .catch((err) => sendResponse({ ok: false, error: err.message }));
          return true;
        }

        case MessageType.NIP07_SIGN: {
          findScriptableTab()
            .then((tabId) => {
              if (!tabId) return sendResponse({ ok: false, error: 'No web tab available for NIP-07' });
              return signEventDirect(tabId, (message as any).event).then((r) => sendResponse(r));
            })
            .catch((err) => sendResponse({ ok: false, error: err.message }));
          return true;
        }

        case MessageType.GET_CONFIRM_DATA: {
          // Return settings + recording metadata (NIP-07 probing done by content script directly)
          getSettings()
            .then((settings) => {
              sendResponse({
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

        case 'open_settings': {
          browser.tabs.create({ url: browser.runtime.getURL('/settings.html') });
          return false;
        }

        default:
          return false;
      }
    },
  );
});
