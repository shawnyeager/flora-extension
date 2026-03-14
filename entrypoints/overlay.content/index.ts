import './style.css';
import { MessageType } from '@/utils/messages';
import { Icons } from '@/utils/icons';
import { type ExtensionState } from '@/utils/state';

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',

  async main(ctx) {
    // ==========================================
    // State
    // ==========================================
    let timerInterval: ReturnType<typeof setInterval> | null = null;
    let recordingStartTime = 0;
    let webcamStream: MediaStream | null = null;
    let micMuted = false;
    let webcamAborted = false;
    let webcamAcquiring = false;
    let currentOverlayState: ExtensionState = 'idle';

    // Pause
    let paused = false;
    let pausedAccumulator = 0;
    let pauseTimestamp = 0;

    // Webcam
    let webcamOn = true;

    // Flag set when we receive a direct STATE_CHANGED message (not via storage),
    // indicating this content script is on the recording tab
    let isRecordingTabFlag = false;

    // Bubble size & position
    type BubbleSize = 'sm' | 'md' | 'lg';
    let bubbleSize: BubbleSize = 'md';
    // Position as viewport percentages (0–1) for window-size independence
    let bubblePosXPct = 0.02; // default: near left edge
    let bubblePosYPct = 0.82; // default: near bottom

    const BUBBLE_SIZES: Record<BubbleSize, number> = { sm: 128, md: 200, lg: 300 };

    // Drag
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let bubbleStartRect: DOMRect | null = null;

    // Restore saved prefs before building UI
    try {
      const saved = await browser.storage.local.get(['bubbleSize', 'bubblePosition']);
      if (saved.bubbleSize && (saved.bubbleSize as string) in BUBBLE_SIZES) {
        bubbleSize = saved.bubbleSize as BubbleSize;
      }
      if (saved.bubblePosition) {
        const pos = saved.bubblePosition as { xPct?: number; yPct?: number };
        bubblePosXPct = pos.xPct ?? bubblePosXPct;
        bubblePosYPct = pos.yPct ?? bubblePosYPct;
      }
    } catch { /* storage may not be available */ }

    ctx.onInvalidated(() => {
      webcamAborted = true;
      webcamStream?.getTracks().forEach((t) => t.stop());
      webcamStream = null;
    });

    // ==========================================
    // Bubble position helpers
    // ==========================================
    function applyBubblePosition(el: HTMLElement) {
      const size = BUBBLE_SIZES[bubbleSize];
      const x = Math.max(0, Math.min(bubblePosXPct * window.innerWidth, window.innerWidth - size));
      const y = Math.max(0, Math.min(bubblePosYPct * window.innerHeight, window.innerHeight - size));
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    }

    function clampAndSavePosition(el: HTMLElement) {
      const size = BUBBLE_SIZES[bubbleSize];
      const x = Math.max(0, Math.min(parseFloat(el.style.left) || 0, window.innerWidth - size));
      const y = Math.max(0, Math.min(parseFloat(el.style.top) || 0, window.innerHeight - size));
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      bubblePosXPct = x / window.innerWidth;
      bubblePosYPct = y / window.innerHeight;
    }

    function saveBubblePrefs() {
      browser.storage.local.set({
        bubbleSize,
        bubblePosition: { xPct: bubblePosXPct, yPct: bubblePosYPct },
      }).catch(() => {});
    }

    // ==========================================
    // Shadow Root UI
    // ==========================================
    let rootWrapper: HTMLElement | null = null;

    const ui = await createShadowRootUi(ctx, {
      name: 'flora-overlay',
      position: 'overlay',
      anchor: 'body',
      isolateEvents: true,
      onMount(container) {
        const wrapper = document.createElement('div');
        wrapper.id = 'flora-root';
        rootWrapper = wrapper;

        // --- Webcam bubble ---
        const webcamBubble = document.createElement('div');
        webcamBubble.className = `flora-webcam size-${bubbleSize}`;
        webcamBubble.setAttribute('role', 'region');
        webcamBubble.setAttribute('aria-label', 'Webcam preview');
        applyBubblePosition(webcamBubble);

        // Inner mask — clips video to circle, allows size selector to overflow
        const mask = document.createElement('div');
        mask.className = 'flora-webcam-mask';

        const webcamVideoEl = document.createElement('video');
        webcamVideoEl.autoplay = true;
        webcamVideoEl.muted = true;
        webcamVideoEl.playsInline = true;
        webcamVideoEl.setAttribute('aria-hidden', 'true');

        const webcamOff = document.createElement('div');
        webcamOff.className = 'flora-webcam-off';
        webcamOff.innerHTML = Icons.cameraOff;

        mask.append(webcamVideoEl, webcamOff);

        // --- Size selector (visual dots on hover) ---
        const sizeSelector = document.createElement('div');
        sizeSelector.className = 'flora-size-selector';
        const sizeLabels: Record<BubbleSize, string> = { sm: 'Small', md: 'Medium', lg: 'Large' };
        for (const s of ['sm', 'md', 'lg'] as BubbleSize[]) {
          const btn = document.createElement('button');
          btn.className = `flora-size-btn${s === bubbleSize ? ' active' : ''}`;
          btn.setAttribute('data-size', s);
          btn.setAttribute('aria-label', `${sizeLabels[s]} bubble`);
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (s === bubbleSize) return;
            webcamBubble.classList.remove(`size-${bubbleSize}`);
            bubbleSize = s;
            webcamBubble.classList.add(`size-${bubbleSize}`);
            sizeSelector.querySelectorAll('.flora-size-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            clampAndSavePosition(webcamBubble);
            saveBubblePrefs();
          });
          sizeSelector.append(btn);
        }

        // Flip size selector above if near bottom edge
        webcamBubble.addEventListener('mouseenter', () => {
          const rect = webcamBubble.getBoundingClientRect();
          if (rect.bottom + 40 > window.innerHeight) {
            sizeSelector.classList.add('flip-above');
          } else {
            sizeSelector.classList.remove('flip-above');
          }
        });

        // Camera toggle badge
        const camToggle = document.createElement('button');
        camToggle.className = 'flora-webcam-toggle';
        camToggle.innerHTML = Icons.cameraOff;
        camToggle.setAttribute('aria-label', 'Toggle camera');

        camToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          webcamOn = !webcamOn;
          if (!webcamOn) {
            webcamBubble.style.display = 'none';
            const camBtn = ui.shadow.querySelector('.flora-btn-cam') as HTMLElement;
            if (camBtn) { camBtn.innerHTML = Icons.cameraOff; camBtn.classList.add('active'); camBtn.setAttribute('aria-label', 'Turn camera on'); }
            browser.runtime.sendMessage({ type: MessageType.TOGGLE_WEBCAM, enabled: false });
          } else {
            webcamVideoEl.style.display = 'block';
            webcamOff.style.display = 'none';
            webcamBubble.style.display = 'block';
            const camBtn = ui.shadow.querySelector('.flora-btn-cam') as HTMLElement;
            if (camBtn) { camBtn.innerHTML = Icons.camera; camBtn.classList.remove('active'); camBtn.setAttribute('aria-label', 'Turn camera off'); }
            browser.runtime.sendMessage({ type: MessageType.TOGGLE_WEBCAM, enabled: true });
          }
        });

        // --- Drag handlers (free positioning, no corner snapping) ---
        webcamBubble.addEventListener('pointerdown', (e: PointerEvent) => {
          if ((e.target as HTMLElement).closest('.flora-webcam-toggle') ||
              (e.target as HTMLElement).closest('.flora-size-selector')) return;
          isDragging = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          bubbleStartRect = webcamBubble.getBoundingClientRect();
          webcamBubble.classList.add('dragging');
          webcamBubble.style.top = `${bubbleStartRect.top}px`;
          webcamBubble.style.left = `${bubbleStartRect.left}px`;
          webcamBubble.style.right = 'auto';
          webcamBubble.style.bottom = 'auto';
          webcamBubble.setPointerCapture(e.pointerId);
          e.preventDefault();
        });

        webcamBubble.addEventListener('pointermove', (e: PointerEvent) => {
          if (!isDragging || !bubbleStartRect) return;
          const dx = e.clientX - dragStartX;
          const dy = e.clientY - dragStartY;
          const maxX = window.innerWidth - bubbleStartRect.width;
          const maxY = window.innerHeight - bubbleStartRect.height;
          webcamBubble.style.left = `${Math.max(0, Math.min(bubbleStartRect.left + dx, maxX))}px`;
          webcamBubble.style.top = `${Math.max(0, Math.min(bubbleStartRect.top + dy, maxY))}px`;
        });

        webcamBubble.addEventListener('pointerup', (e: PointerEvent) => {
          if (!isDragging) return;
          isDragging = false;
          webcamBubble.classList.remove('dragging');
          webcamBubble.releasePointerCapture(e.pointerId);
          // Stay where dropped — save position as viewport percentages
          const left = parseFloat(webcamBubble.style.left) || 0;
          const top = parseFloat(webcamBubble.style.top) || 0;
          bubblePosXPct = left / window.innerWidth;
          bubblePosYPct = top / window.innerHeight;
          saveBubblePrefs();
        });

        // Re-clamp on window resize
        window.addEventListener('resize', () => {
          if (webcamBubble.style.display !== 'none') {
            applyBubblePosition(webcamBubble);
          }
        });

        webcamBubble.append(mask, sizeSelector, camToggle);

        // --- Controls bar ---
        const controls = document.createElement('div');
        controls.className = 'flora-controls';
        controls.setAttribute('role', 'toolbar');
        controls.setAttribute('aria-label', 'Recording controls');

        const recDot = document.createElement('div');
        recDot.className = 'flora-rec-dot';
        recDot.setAttribute('aria-hidden', 'true');

        const timer = document.createElement('span');
        timer.className = 'flora-timer';
        timer.textContent = '00:00';
        timer.setAttribute('aria-live', 'off');
        timer.setAttribute('aria-label', 'Recording duration');

        const divider = document.createElement('div');
        divider.className = 'flora-divider';
        divider.setAttribute('aria-hidden', 'true');

        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'flora-btn-icon flora-btn-pause';
        pauseBtn.innerHTML = Icons.pause;
        pauseBtn.setAttribute('aria-label', 'Pause recording');
        pauseBtn.addEventListener('click', () => {
          paused = !paused;
          if (paused) {
            pauseTimestamp = Date.now();
            pauseBtn.innerHTML = Icons.play;
            pauseBtn.setAttribute('aria-label', 'Resume recording');
            pauseBtn.classList.add('active');
            recDot.classList.add('paused');
            browser.runtime.sendMessage({ type: MessageType.PAUSE_RECORDING });
          } else {
            pausedAccumulator += Date.now() - pauseTimestamp;
            pauseBtn.innerHTML = Icons.pause;
            pauseBtn.setAttribute('aria-label', 'Pause recording');
            pauseBtn.classList.remove('active');
            recDot.classList.remove('paused');
            browser.runtime.sendMessage({ type: MessageType.RESUME_RECORDING });
          }
        });

        const micBtn = document.createElement('button');
        micBtn.className = 'flora-btn-icon';
        micBtn.innerHTML = Icons.mic;
        micBtn.setAttribute('aria-label', 'Mute microphone');
        micBtn.addEventListener('click', () => {
          micMuted = !micMuted;
          micBtn.innerHTML = micMuted ? Icons.micOff : Icons.mic;
          micBtn.classList.toggle('active', micMuted);
          micBtn.setAttribute('aria-label', micMuted ? 'Unmute microphone' : 'Mute microphone');
          browser.runtime.sendMessage({ type: MessageType.TOGGLE_MIC, muted: micMuted });
        });

        const camBtn = document.createElement('button');
        camBtn.className = 'flora-btn-icon flora-btn-cam';
        camBtn.innerHTML = Icons.camera;
        camBtn.setAttribute('aria-label', 'Turn camera off');
        camBtn.addEventListener('click', () => {
          webcamOn = !webcamOn;
          if (!webcamOn) {
            webcamBubble.style.display = 'none';
            camBtn.innerHTML = Icons.cameraOff;
            camBtn.classList.add('active');
            camBtn.setAttribute('aria-label', 'Turn camera on');
            browser.runtime.sendMessage({ type: MessageType.TOGGLE_WEBCAM, enabled: false });
          } else {
            webcamVideoEl.style.display = 'block';
            webcamOff.style.display = 'none';
            webcamBubble.style.display = 'block';
            camBtn.innerHTML = Icons.camera;
            camBtn.classList.remove('active');
            camBtn.setAttribute('aria-label', 'Turn camera off');
            browser.runtime.sendMessage({ type: MessageType.TOGGLE_WEBCAM, enabled: true });
          }
        });

        const stopBtn = document.createElement('button');
        stopBtn.className = 'flora-btn-stop';
        stopBtn.innerHTML = Icons.stop;
        stopBtn.setAttribute('aria-label', 'Stop recording');
        stopBtn.addEventListener('click', () => {
          stopEverything();
          browser.runtime.sendMessage({ type: MessageType.STOP_RECORDING });
        });

        controls.append(recDot, timer, divider, pauseBtn, micBtn, camBtn, stopBtn);
        wrapper.append(webcamBubble, controls);
        container.append(wrapper);
        return wrapper;
      },
      onRemove(wrapper) {
        wrapper?.remove();
      },
    });

    ui.mount();

    // Override WXT's default overlay host positioning (position:relative in page flow)
    // to position:fixed so it never scrolls. Prevents compositor lag that causes the
    // webcam bubble to jitter during scroll in screen capture output.
    const host = ui.shadow.host as HTMLElement;
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.width = '100vw';
    host.style.height = '100vh';
    host.style.pointerEvents = 'none';

    // ==========================================
    // Recording Functions
    // ==========================================
    function startTimer() {
      recordingStartTime = Date.now();
      pausedAccumulator = 0;
      paused = false;
      pauseTimestamp = 0;
      timerInterval = setInterval(() => {
        if (paused) return;
        const elapsed = (Date.now() - recordingStartTime - pausedAccumulator) / 1000;
        const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const s = Math.floor(elapsed % 60).toString().padStart(2, '0');
        const timerEl = ui.shadow.querySelector('.flora-timer') as HTMLElement;
        if (timerEl) timerEl.textContent = `${m}:${s}`;
      }, 1000);
    }

    function stopTimer() {
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    }

    async function startWebcamPreview() {
      if (webcamStream || webcamAcquiring) return;
      const bubble = ui.shadow.querySelector('.flora-webcam') as HTMLElement;
      const videoEl = ui.shadow.querySelector('.flora-webcam video') as HTMLVideoElement;
      const offEl = ui.shadow.querySelector('.flora-webcam-off') as HTMLElement;
      if (!videoEl || !offEl || !bubble) return;

      webcamAborted = false;
      webcamAcquiring = true;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        });
        webcamAcquiring = false;
        if (webcamAborted) { stream.getTracks().forEach((t) => t.stop()); return; }
        webcamStream = stream;
        videoEl.srcObject = stream;
        videoEl.style.display = 'block';
        offEl.style.display = 'none';
        webcamOn = true;

        bubble.style.display = 'block';
      } catch {
        webcamAcquiring = false;
        if (webcamAborted) return;
        videoEl.style.display = 'none';
        offEl.style.display = 'flex';
        webcamOn = false;
        bubble.style.display = 'none';
        // Sync failure state back to background so popup reflects reality
        browser.runtime.sendMessage({ type: MessageType.TOGGLE_WEBCAM, enabled: false }).catch(() => {});
      }
    }

    function stopEverything() {
      webcamAborted = true;
      webcamAcquiring = false;
      webcamStream?.getTracks().forEach((t) => t.stop());
      webcamStream = null;
      const videoEl = ui.shadow.querySelector('.flora-webcam video') as HTMLVideoElement;
      if (videoEl) videoEl.srcObject = null;
      const controls = ui.shadow.querySelector('.flora-controls') as HTMLElement;
      const bubble = ui.shadow.querySelector('.flora-webcam') as HTMLElement;
      if (controls) controls.style.display = 'none';
      if (bubble) bubble.style.display = 'none';
      stopTimer();
      paused = false;
      pausedAccumulator = 0;
      pauseTimestamp = 0;
    }

    // ==========================================
    // State Handler
    // ==========================================
    // Post-recording UI (preview, confirm, upload, complete, error) now lives in review.html.
    // The content script only manages the recording overlay (webcam bubble, controls).
    function updateUI(state: ExtensionState) {
      currentOverlayState = state;
      if (state === 'awaiting_media') {
        startWebcamPreview();
      } else if (state === 'recording') {
        // Hide controls — they appear in the captured video. Popup has controls instead.
        const controls = ui.shadow.querySelector('.flora-controls') as HTMLElement;
        if (controls) controls.style.display = 'none';
        startTimer();
        if (!webcamStream) startWebcamPreview();
      } else {
        // All other states: clean up the recording overlay
        stopEverything();
      }
    }

    /** Like updateUI but skips webcam acquisition — used when we can't confirm
     *  this is the recording tab (e.g., restoring from storage on init). */
    function updateUIWithoutWebcam(state: ExtensionState) {
      currentOverlayState = state;
      if (state === 'recording') {
        const controls = ui.shadow.querySelector('.flora-controls') as HTMLElement;
        if (controls) controls.style.display = 'none';
        startTimer();
      } else if (state !== 'awaiting_media') {
        stopEverything();
      }
    }

    // ==========================================
    // Message Listeners
    // ==========================================
    browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
      if (message.type === MessageType.STATE_CHANGED && message.state) {
        // If we receive a direct STATE_CHANGED message for a webcam state,
        // it means the background specifically targeted us — we're the recording tab
        const webcamStates: ExtensionState[] = ['awaiting_media', 'recording'];
        if (webcamStates.includes(message.state)) {
          isRecordingTabFlag = true;
        }
        updateUI(message.state as ExtensionState);
        return false;
      }

      if (message.type === MessageType.TOGGLE_WEBCAM) {
        const enabled = !!message.enabled;
        if (enabled !== webcamOn) {
          webcamOn = enabled;
          const bubble = ui.shadow.querySelector('.flora-webcam') as HTMLElement;
          const camBtn = ui.shadow.querySelector('.flora-btn-cam') as HTMLElement;
          if (!webcamOn) {
            if (bubble) bubble.style.display = 'none';
            if (camBtn) { camBtn.innerHTML = Icons.cameraOff; camBtn.classList.add('active'); camBtn.setAttribute('aria-label', 'Turn camera on'); }
          } else {
            const videoEl = ui.shadow.querySelector('.flora-webcam video') as HTMLElement;
            const offEl = ui.shadow.querySelector('.flora-webcam-off') as HTMLElement;
            if (videoEl) videoEl.style.display = 'block';
            if (offEl) offEl.style.display = 'none';
            if (bubble) bubble.style.display = 'block';
            if (camBtn) { camBtn.innerHTML = Icons.camera; camBtn.classList.remove('active'); camBtn.setAttribute('aria-label', 'Turn camera off'); }
          }
        }
        return false;
      }

      return false;
    });

    // Backup: storage listener for state changes (cleanup states only — webcam states
    // are sent directly to the recording tab via message, not storage)
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.state) {
        const newState = changes.state.newValue as ExtensionState;
        // Only act on non-webcam states from storage (webcam states come via direct message)
        const webcamStates: ExtensionState[] = ['awaiting_media', 'recording'];
        if (!webcamStates.includes(newState)) {
          updateUI(newState);
        }
      }
    });

    // Init: restore state (only start webcam if we're the recording tab)
    try {
      const result = await browser.storage.local.get(['state', 'recordingTabId']);
      if (result.state) {
        const state = result.state as ExtensionState;
        const webcamStates: ExtensionState[] = ['awaiting_media', 'recording'];
        if (webcamStates.includes(state)) {
          // We can't know our tab ID from the content script, so skip webcam
          // on init — the background will send us a direct message if we're the recording tab
          updateUIWithoutWebcam(state);
        } else {
          updateUI(state);
        }
      }
    } catch { /* extension context may not be available */ }
  },
});
