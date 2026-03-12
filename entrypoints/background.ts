import { MessageType, type Message, type RecordingControlsState } from '@/utils/messages';
import { PROTECTED_STATES, type ExtensionState } from '@/utils/state';
import { getSettings } from '@/utils/settings';

const OFFSCREEN_PATH = '/offscreen.html';

let currentState: ExtensionState = 'idle';
let uploadResult: { url: string; sha256: string; size: number } | null = null;
let publishResult: { noteId: string; blossomUrl: string } | null = null;
let lastError: string | null = null;
let lastRecordingMeta: { size: number; duration: number } | null = null;
let pendingPublishToNostr = true;
let pendingNoteContent: string | undefined;
let recordingTabId: number | null = null;

// Recording controls state (shared between popup and content script)
let controlsState: RecordingControlsState = {
  paused: false,
  micMuted: false,
  webcamOn: true,
  recordingStartedAt: 0,
  pausedAccumulated: 0,
};
let pauseTimestamp = 0;

/** Find a web tab suitable for scripting.executeScript (not chrome://, chrome-extension://, etc.) */
async function findScriptableTab(): Promise<number | null> {
  // 1. Tab where user was recording (most likely to have NIP-07 signer)
  if (recordingTabId) {
    try {
      const tab = await browser.tabs.get(recordingTabId);
      if (tab?.url && /^https?:/.test(tab.url)) return recordingTabId;
    } catch {
      // Tab was closed
      recordingTabId = null;
    }
  }

  // 2. Restore from storage (survives service worker restart)
  if (!recordingTabId) {
    try {
      const stored = await browser.storage.local.get('recordingTabId');
      if (stored.recordingTabId) {
        const tab = await browser.tabs.get(stored.recordingTabId);
        if (tab?.url && /^https?:/.test(tab.url)) {
          recordingTabId = stored.recordingTabId;
          return recordingTabId;
        }
      }
    } catch {}
  }

  // 3. Active tab in the last focused window
  const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id && active.url && /^https?:/.test(active.url)) return active.id;

  // 4. Any active tab in any window
  const activeTabs = await browser.tabs.query({ active: true });
  for (const tab of activeTabs) {
    if (tab.id && tab.url && /^https?:/.test(tab.url)) return tab.id;
  }

  // 5. Last resort: any web tab
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  return tabs[0]?.id ?? null;
}

function setState(state: ExtensionState) {
  currentState = state;
  browser.storage.local.set({ state });

  // Open review.html tab for preview (or focus it if already open)
  if (state === 'preview') {
    const reviewUrl = browser.runtime.getURL('/review.html');
    browser.tabs.query({ url: reviewUrl }).then((tabs) => {
      if (tabs.length > 0 && tabs[0].id) {
        browser.tabs.update(tabs[0].id, { active: true });
      } else {
        browser.tabs.create({ url: reviewUrl });
      }
    });
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
        // Race against timeout — some signers hang forever on reject
        return Promise.race([
          nostr.signEvent(evt).then(
            (signed: any) => signed ? { ok: true, data: signed } : { ok: false, error: 'signEvent returned empty' },
            (err: any) => ({ ok: false, error: String(err) }),
          ),
          new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'Signing timed out — did you reject or close the signer prompt?' }), 15000)),
        ]);
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

        case MessageType.RESET_STATE: {
          // Reject reset during active upload/publish/finalization to prevent data loss
          const hardProtected: ExtensionState[] = ['finalizing', 'uploading', 'publishing'];
          if (hardProtected.includes(currentState)) {
            sendResponse({ ok: false, reason: 'protected_state' });
            return false;
          }
          setState('idle');
          uploadResult = null;
          publishResult = null;
          lastError = null;
          closeOffscreenDocument().catch(console.error);
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.GET_RESULT:
          sendResponse({ uploadResult, publishResult });
          return false;

        case MessageType.GET_ERROR:
          sendResponse({ error: lastError });
          return false;

        case MessageType.GET_RECORDING_STATE:
          sendResponse({
            ...controlsState,
            // If currently paused, include the live pause duration
            pausedAccumulated: controlsState.pausedAccumulated + (pauseTimestamp ? Date.now() - pauseTimestamp : 0),
          });
          return false;

        case MessageType.NIP07_PROBE: {
          // Content scripts on web tabs can do the full probe (user is focused there).
          // Extension pages (settings) can only do a light check (getPublicKey hangs on background tabs).
          const senderIsWebTab = _sender.tab?.url && /^https?:/.test(_sender.tab.url);

          findScriptableTab()
            .then(async (tabId) => {
              if (!tabId) return sendResponse({ error: 'No web tab available for NIP-07 probe' });
              if (senderIsWebTab) {
                return probeNip07Direct(tabId).then((r) => sendResponse(r));
              }
              // Light probe — just check window.nostr exists
              try {
                const results = await (browser as any).scripting.executeScript({
                  target: { tabId },
                  world: 'MAIN',
                  func: () => {
                    const nostr = (window as any).nostr;
                    if (!nostr) return { error: 'missing' };
                    if (typeof nostr.getPublicKey !== 'function') return { error: 'no getPublicKey' };
                    return { detected: true };
                  },
                });
                sendResponse(results?.[0]?.result || { error: 'no result' });
              } catch (err: any) {
                sendResponse({ error: err.message });
              }
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
          controlsState = { paused: false, micMuted: false, webcamOn: true, recordingStartedAt: Date.now(), pausedAccumulated: 0 };
          pauseTimestamp = 0;
          setState('recording');
          return false;

        case MessageType.CAPTURE_ERROR: {
          const errMsg = (message as any).error || '';
          console.error('[background] capture error:', errMsg);
          // User canceled the screen picker — not a real error, just go back to idle
          if (currentState === 'awaiting_media' || currentState === 'initializing') {
            setState('idle');
            closeOffscreenDocument().catch(console.error);
          } else {
            setState('error');
          }
          return false;
        }

        case MessageType.PAUSE_RECORDING: {
          controlsState.paused = true;
          pauseTimestamp = Date.now();
          browser.runtime.sendMessage({
            type: MessageType.PAUSE_CAPTURE,
            target: 'offscreen',
          }).catch(console.error);
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.RESUME_RECORDING: {
          if (pauseTimestamp) controlsState.pausedAccumulated += Date.now() - pauseTimestamp;
          controlsState.paused = false;
          pauseTimestamp = 0;
          browser.runtime.sendMessage({
            type: MessageType.RESUME_CAPTURE,
            target: 'offscreen',
          }).catch(console.error);
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.TOGGLE_MIC: {
          controlsState.micMuted = !!(message as any).muted;
          browser.runtime.sendMessage({
            type: MessageType.TOGGLE_MIC,
            target: 'offscreen',
            muted: (message as any).muted,
          }).catch(console.error);
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.TOGGLE_WEBCAM: {
          controlsState.webcamOn = !!(message as any).enabled;
          const webcamMsg = { type: MessageType.TOGGLE_WEBCAM, enabled: (message as any).enabled };
          if (recordingTabId) {
            browser.tabs.sendMessage(recordingTabId, webcamMsg).catch(() => {
              // Tab may have navigated — broadcast to all tabs
              browser.tabs.query({}).then((tabs) => {
                for (const tab of tabs) {
                  if (tab.id) browser.tabs.sendMessage(tab.id, webcamMsg).catch(() => {});
                }
              });
            });
          } else {
            // No recording tab — broadcast to all tabs
            browser.tabs.query({}).then((tabs) => {
              for (const tab of tabs) {
                if (tab.id) browser.tabs.sendMessage(tab.id, webcamMsg).catch(() => {});
              }
            });
          }
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

          // Mark recording as uploaded in IDB
          browser.runtime.sendMessage({
            type: MessageType.MARK_UPLOADED,
            target: 'offscreen',
            hash: msg.sha256,
            blossomUrl: msg.url,
          }).catch(() => {});

          if (pendingPublishToNostr) {
            setState('publishing');
            getSettings().then((settings) =>
              browser.runtime.sendMessage({
                type: MessageType.PUBLISH_NOTE,
                target: 'offscreen',
                blossomUrl: msg.url,
                sha256: msg.sha256,
                size: msg.size,
                relays: settings.nostrRelays,
                noteContent: pendingNoteContent,
              }),
            ).catch((err) => {
              console.error('[background] publish setup failed:', err);
              // Upload succeeded but publish setup failed — still go to complete
              if (uploadResult) {
                publishResult = { noteId: '', blossomUrl: uploadResult.url };
                setState('complete');
              }
            });
          } else {
            // Skip Nostr publish — go straight to complete
            setState('complete');
          }
          return false;
        }

        case MessageType.UPLOAD_ERROR: {
          const errMsg = (message as any).error || 'Upload failed';
          console.error('[background] upload error:', errMsg);
          lastError = errMsg;
          setState('error');
          return false;
        }

        case MessageType.PUBLISH_COMPLETE: {
          const msg = message as any;
          console.log(`[background] published note: ${msg.noteId}`);
          publishResult = { noteId: msg.noteId, blossomUrl: msg.blossomUrl };
          // Update IDB record with noteId
          if (uploadResult) {
            browser.runtime.sendMessage({
              type: MessageType.MARK_UPLOADED,
              target: 'offscreen',
              hash: uploadResult.sha256,
              blossomUrl: uploadResult.url,
              noteId: msg.noteId,
            }).catch(() => {});
          }
          setState('complete');
          return false;
        }

        case MessageType.PUBLISH_ERROR: {
          const errMsg = (message as any).error || 'Publishing failed';
          console.error('[background] publish error:', errMsg);
          // Publishing failed but upload succeeded — still go to complete
          if (uploadResult) {
            publishResult = { noteId: '', blossomUrl: uploadResult.url };
            setState('complete');
          } else {
            lastError = errMsg;
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
          // Return settings + recording metadata + signer status
          Promise.all([
            getSettings(),
            findScriptableTab().then((tabId) =>
              tabId ? probeNip07Direct(tabId) : { error: 'No web tab available' },
            ).catch((err) => ({ error: err.message })),
          ])
            .then(([settings, signerResult]) => {
              const npub = 'pubkey' in signerResult ? signerResult.pubkey : null;
              const bridgeError = 'error' in signerResult ? signerResult.error : null;
              sendResponse({
                server: settings.blossomServers[0] || 'https://blossom.band',
                relays: settings.nostrRelays,
                publishToNostr: settings.publishToNostr,
                fileSize: lastRecordingMeta?.size ?? 0,
                duration: lastRecordingMeta?.duration ?? 0,
                npub,
                signerAvailable: !!npub,
                bridgeError,
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
          pendingNoteContent = msg.noteContent;
          setState('uploading');
          getSettings().then((settings) => {
            const server = msg.serverOverride || settings.blossomServers[0];
            return ensureOffscreenDocument().then(() =>
              browser.runtime.sendMessage({
                type: MessageType.START_UPLOAD,
                target: 'offscreen',
                server,
              }),
            );
          }).catch((err) => {
            console.error('[background] confirm upload failed:', err);
            lastError = err instanceof Error ? err.message : String(err);
            setState('error');
          });
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.BACK_TO_PREVIEW: {
          setState('preview');
          sendResponse({ ok: true });
          return false;
        }

        case MessageType.LIST_RECORDINGS:
        case MessageType.GET_RECORDING_BY_HASH: {
          ensureOffscreenDocument()
            .then(() =>
              browser.runtime.sendMessage({
                ...message,
                target: 'offscreen',
              }),
            )
            .then((data) => sendResponse(data))
            .catch((err) => {
              console.error(`[background] ${message.type} error:`, err);
              sendResponse(null);
            });
          return true;
        }

        case MessageType.DELETE_RECORDING: {
          ensureOffscreenDocument()
            .then(() =>
              browser.runtime.sendMessage({
                ...message,
                target: 'offscreen',
              }),
            )
            .then((data) => sendResponse(data))
            .catch((err) => {
              console.error('[background] DELETE_RECORDING error:', err);
              sendResponse({ ok: false });
            });
          return true;
        }

        case MessageType.MARK_UPLOADED: {
          if (message.target === 'offscreen') return false; // not for us
          ensureOffscreenDocument()
            .then(() =>
              browser.runtime.sendMessage({
                ...message,
                target: 'offscreen',
              }),
            )
            .then((data) => sendResponse(data))
            .catch(() => sendResponse({ ok: false }));
          return true;
        }

        case MessageType.GENERATE_THUMBNAIL: {
          ensureOffscreenDocument()
            .then(() =>
              browser.runtime.sendMessage({
                ...message,
                target: 'offscreen',
              }),
            )
            .then((data) => sendResponse(data))
            .catch(() => sendResponse({ thumbnail: null }));
          return true;
        }

        case MessageType.DELETE_RECORDINGS: {
          ensureOffscreenDocument()
            .then(() =>
              browser.runtime.sendMessage({
                ...message,
                target: 'offscreen',
              }),
            )
            .then((data) => sendResponse(data))
            .catch(() => sendResponse({ ok: false }));
          return true;
        }

        case MessageType.UPLOAD_FROM_LIBRARY: {
          const msg = message as any;
          if (currentState !== 'idle') {
            sendResponse({ ok: false, reason: 'busy' });
            return false;
          }
          pendingPublishToNostr = msg.publishToNostr !== false;
          pendingNoteContent = msg.noteContent;
          setState('uploading');
          getSettings().then((settings) => {
            const server = msg.serverOverride || settings.blossomServers[0];
            return ensureOffscreenDocument().then(() =>
              browser.runtime.sendMessage({
                type: MessageType.UPLOAD_FROM_LIBRARY,
                target: 'offscreen',
                hash: msg.hash,
                server,
              }),
            );
          }).catch((err) => {
            console.error('[background] library upload failed:', err);
            lastError = err instanceof Error ? err.message : String(err);
            setState('error');
          });
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
