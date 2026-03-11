import './style.css';
import { MessageType } from '@/utils/messages';
import type { ExtensionState } from '@/utils/state';

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    let timerInterval: ReturnType<typeof setInterval> | null = null;
    let recordingStartTime = 0;
    let webcamStream: MediaStream | null = null;
    let micMuted = false;
    let webcamAborted = false;
    let webcamAcquiring = false;

    // --- NIP-07 bridge injection and proxy ---
    let bridgeChannel: string | null = null;
    const pendingRequests = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

    // Listen for bridge messages (ready signal + responses)
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'bloom:bridge:ready' && data.channel) {
        bridgeChannel = data.channel;
        console.log('[overlay] nostr bridge ready, channel:', bridgeChannel);
        return;
      }

      // Match responses to pending requests
      if (data.id && pendingRequests.has(data.id)) {
        const pending = pendingRequests.get(data.id)!;
        pendingRequests.delete(data.id);
        if (data.type === 'bloom:error') {
          pending.reject(new Error(data.error));
        } else {
          pending.resolve(data.data);
        }
      }
    });

    function bridgeRequest(type: string, payload?: Record<string, any>): Promise<any> {
      return new Promise((resolve, reject) => {
        if (!bridgeChannel) {
          reject(new Error('NIP-07 bridge not ready'));
          return;
        }
        const id = crypto.randomUUID();
        pendingRequests.set(id, { resolve, reject });
        window.postMessage({ channel: bridgeChannel, type, id, ...payload }, '*');
        // Timeout after 60s (user may need to approve in signer)
        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            reject(new Error('NIP-07 signing request timed out'));
          }
        }, 60_000);
      });
    }

    // Clean up webcam if content script context is invalidated (extension reload, etc.)
    ctx.onInvalidated(() => {
      console.log('[overlay] context invalidated, cleaning up webcam');
      webcamAborted = true;
      webcamStream?.getTracks().forEach((t) => t.stop());
      webcamStream = null;
    });

    // Inject the nostr-bridge script into page main world
    try {
      await injectScript('/nostr-bridge.js', { keepInDom: true });
      console.log('[overlay] nostr-bridge injected');
    } catch (err) {
      console.warn('[overlay] failed to inject nostr-bridge:', err);
    }

    const ui = await createShadowRootUi(ctx, {
      name: 'bloom-overlay',
      position: 'overlay',
      anchor: 'body',
      isolateEvents: true,
      onMount(container) {
        const wrapper = document.createElement('div');
        wrapper.id = 'bloom-root';

        // --- Webcam preview bubble ---
        const webcamBubble = document.createElement('div');
        webcamBubble.className = 'bloom-webcam';

        const webcamVideoEl = document.createElement('video');
        webcamVideoEl.autoplay = true;
        webcamVideoEl.muted = true;
        webcamVideoEl.playsInline = true;

        const webcamOff = document.createElement('div');
        webcamOff.className = 'bloom-webcam-off';
        webcamOff.textContent = '\u{1F4F7}';

        webcamBubble.append(webcamVideoEl, webcamOff);

        webcamBubble.addEventListener('click', () => {
          const isOn = webcamVideoEl.style.display !== 'none';
          if (isOn) {
            webcamVideoEl.style.display = 'none';
            webcamOff.style.display = 'flex';
            browser.runtime.sendMessage({ type: MessageType.TOGGLE_WEBCAM, enabled: false });
          } else {
            webcamVideoEl.style.display = 'block';
            webcamOff.style.display = 'none';
            browser.runtime.sendMessage({ type: MessageType.TOGGLE_WEBCAM, enabled: true });
          }
        });

        // --- Controls bar ---
        const controls = document.createElement('div');
        controls.className = 'bloom-controls';

        const recDot = document.createElement('div');
        recDot.className = 'bloom-rec-dot';

        const timer = document.createElement('span');
        timer.className = 'bloom-timer';
        timer.textContent = '00:00';

        const micBtn = document.createElement('button');
        micBtn.className = 'bloom-btn-icon';
        micBtn.textContent = '\u{1F3A4}';
        micBtn.title = 'Toggle microphone';
        micBtn.addEventListener('click', () => {
          micMuted = !micMuted;
          micBtn.classList.toggle('active', micMuted);
          micBtn.title = micMuted ? 'Microphone muted' : 'Toggle microphone';
          browser.runtime.sendMessage({
            type: MessageType.TOGGLE_MIC,
            muted: micMuted,
          });
        });

        const stopBtn = document.createElement('button');
        stopBtn.className = 'bloom-btn bloom-btn-stop';
        stopBtn.textContent = 'Stop';
        stopBtn.addEventListener('click', () => {
          stopEverything();
          browser.runtime.sendMessage({ type: MessageType.STOP_RECORDING });
        });

        controls.append(recDot, timer, micBtn, stopBtn);
        wrapper.append(webcamBubble, controls);
        container.append(wrapper);
        return wrapper;
      },
      onRemove(wrapper) {
        wrapper?.remove();
      },
    });

    ui.mount();

    function formatTime(seconds: number): string {
      const m = Math.floor(seconds / 60).toString().padStart(2, '0');
      const s = Math.floor(seconds % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    }

    function startTimer() {
      recordingStartTime = Date.now();
      timerInterval = setInterval(() => {
        const elapsed = (Date.now() - recordingStartTime) / 1000;
        const timerEl = ui.shadow.querySelector('.bloom-timer') as HTMLElement;
        if (timerEl) timerEl.textContent = formatTime(elapsed);
      }, 500);
    }

    function stopTimer() {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }

    async function startWebcamPreview() {
      if (webcamStream || webcamAcquiring) return; // already acquired or in progress

      const webcamBubble = ui.shadow.querySelector('.bloom-webcam') as HTMLElement;
      const videoEl = ui.shadow.querySelector('.bloom-webcam video') as HTMLVideoElement;
      const offEl = ui.shadow.querySelector('.bloom-webcam-off') as HTMLElement;
      if (!videoEl || !offEl || !webcamBubble) return;

      webcamAborted = false;
      webcamAcquiring = true;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240, facingMode: 'user' },
        });
        webcamAcquiring = false;

        if (webcamAborted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        webcamStream = stream;
        videoEl.srcObject = stream;
        videoEl.style.display = 'block';
        offEl.style.display = 'none';
        webcamBubble.style.display = 'block';
      } catch {
        webcamAcquiring = false;
        if (webcamAborted) return;
        videoEl.style.display = 'none';
        offEl.style.display = 'flex';
        webcamBubble.style.display = 'block';
      }
    }

    function stopEverything() {
      webcamAborted = true;
      webcamAcquiring = false;
      webcamStream?.getTracks().forEach((t) => t.stop());
      webcamStream = null;

      const videoEl = ui.shadow.querySelector('.bloom-webcam video') as HTMLVideoElement;
      if (videoEl) videoEl.srcObject = null;

      const controls = ui.shadow.querySelector('.bloom-controls') as HTMLElement;
      const webcamBubble = ui.shadow.querySelector('.bloom-webcam') as HTMLElement;
      if (controls) controls.style.display = 'none';
      if (webcamBubble) webcamBubble.style.display = 'none';

      stopTimer();
    }

    function updateUI(state: ExtensionState) {
      if (state === 'awaiting_media') {
        // Pre-acquire webcam while user picks screen (hides the 1-2s camera spinup)
        startWebcamPreview();
      } else if (state === 'recording') {
        const controls = ui.shadow.querySelector('.bloom-controls') as HTMLElement;
        if (controls) controls.style.display = 'flex';
        startTimer();
        // If webcam wasn't pre-acquired, start it now
        if (!webcamStream) startWebcamPreview();
      } else {
        stopEverything();
      }
    }

    // Listen for messages from background
    browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
      if (message.type === 'state_changed' && message.state) {
        updateUI(message.state as ExtensionState);
        return false;
      }

      if (message.type === MessageType.NIP07_GET_PUBKEY) {
        bridgeRequest('bloom:getPublicKey')
          .then((pubkey) => {
            if (pubkey) {
              sendResponse({ ok: true, data: pubkey });
            } else {
              sendResponse({ ok: false, error: 'Signer returned empty pubkey' });
            }
          })
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true; // async sendResponse
      }

      if (message.type === MessageType.NIP07_SIGN) {
        bridgeRequest('bloom:signEvent', { event: message.event })
          .then((signed) => sendResponse({ ok: true, data: signed }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true; // async sendResponse
      }

      return false;
    });

    // Also listen via storage.local as backup
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.state) {
        updateUI(changes.state.newValue as ExtensionState);
      }
    });

    // Restore state on page load/navigation
    try {
      const result = await browser.storage.local.get('state');
      if (result.state) updateUI(result.state as ExtensionState);
    } catch {
      // Extension context may not be available
    }
  },
});
