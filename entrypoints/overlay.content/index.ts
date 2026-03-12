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

    // Drag
    type Corner = 'bl' | 'br' | 'tl' | 'tr';
    let bubbleCorner: Corner = 'bl';
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let bubbleStartRect: DOMRect | null = null;

    ctx.onInvalidated(() => {
      webcamAborted = true;
      webcamStream?.getTracks().forEach((t) => t.stop());
      webcamStream = null;
    });

    // ==========================================
    // Shadow Root UI
    // ==========================================
    let rootWrapper: HTMLElement | null = null;

    const ui = await createShadowRootUi(ctx, {
      name: 'bloom-overlay',
      position: 'overlay',
      anchor: 'body',
      isolateEvents: true,
      onMount(container) {
        const wrapper = document.createElement('div');
        wrapper.id = 'bloom-root';
        rootWrapper = wrapper;

        // --- Webcam bubble ---
        const webcamBubble = document.createElement('div');
        webcamBubble.className = 'bloom-webcam pos-bl';
        webcamBubble.setAttribute('role', 'region');
        webcamBubble.setAttribute('aria-label', 'Webcam preview');

        const webcamVideoEl = document.createElement('video');
        webcamVideoEl.autoplay = true;
        webcamVideoEl.muted = true;
        webcamVideoEl.playsInline = true;
        webcamVideoEl.setAttribute('aria-hidden', 'true');

        const webcamOff = document.createElement('div');
        webcamOff.className = 'bloom-webcam-off';
        webcamOff.innerHTML = Icons.cameraOff;

        // Camera toggle badge
        const camToggle = document.createElement('button');
        camToggle.className = 'bloom-webcam-toggle';
        camToggle.innerHTML = Icons.cameraOff;
        camToggle.setAttribute('aria-label', 'Toggle camera');

        camToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          webcamOn = !webcamOn;
          if (!webcamOn) {
            webcamBubble.style.display = 'none';
            const camBtn = ui.shadow.querySelector('.bloom-btn-cam') as HTMLElement;
            if (camBtn) { camBtn.innerHTML = Icons.cameraOff; camBtn.classList.add('active'); camBtn.setAttribute('aria-label', 'Turn camera on'); }
            browser.runtime.sendMessage({ type: MessageType.TOGGLE_WEBCAM, enabled: false });
          } else {
            webcamVideoEl.style.display = 'block';
            webcamOff.style.display = 'none';
            webcamBubble.style.display = 'block';
            const camBtn = ui.shadow.querySelector('.bloom-btn-cam') as HTMLElement;
            if (camBtn) { camBtn.innerHTML = Icons.camera; camBtn.classList.remove('active'); camBtn.setAttribute('aria-label', 'Turn camera off'); }
            browser.runtime.sendMessage({ type: MessageType.TOGGLE_WEBCAM, enabled: true });
          }
        });

        // --- Drag handlers ---
        webcamBubble.addEventListener('pointerdown', (e: PointerEvent) => {
          if ((e.target as HTMLElement).closest('.bloom-webcam-toggle')) return;
          isDragging = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          bubbleStartRect = webcamBubble.getBoundingClientRect();
          webcamBubble.classList.add('dragging');
          webcamBubble.classList.remove('pos-bl', 'pos-br', 'pos-tl', 'pos-tr');
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
          const rect = webcamBubble.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const isLeft = cx < window.innerWidth / 2;
          const isTop = cy < window.innerHeight / 2;
          bubbleCorner = ((isTop ? 't' : 'b') + (isLeft ? 'l' : 'r')) as Corner;
          webcamBubble.style.top = '';
          webcamBubble.style.left = '';
          webcamBubble.style.right = '';
          webcamBubble.style.bottom = '';
          webcamBubble.classList.add(`pos-${bubbleCorner}`);
        });

        webcamBubble.append(webcamVideoEl, webcamOff, camToggle);

        // --- Controls bar ---
        const controls = document.createElement('div');
        controls.className = 'bloom-controls';
        controls.setAttribute('role', 'toolbar');
        controls.setAttribute('aria-label', 'Recording controls');

        const recDot = document.createElement('div');
        recDot.className = 'bloom-rec-dot';
        recDot.setAttribute('aria-hidden', 'true');

        const timer = document.createElement('span');
        timer.className = 'bloom-timer';
        timer.textContent = '00:00';
        timer.setAttribute('aria-live', 'off');
        timer.setAttribute('aria-label', 'Recording duration');

        const divider = document.createElement('div');
        divider.className = 'bloom-divider';
        divider.setAttribute('aria-hidden', 'true');

        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'bloom-btn-icon bloom-btn-pause';
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
        micBtn.className = 'bloom-btn-icon';
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
        camBtn.className = 'bloom-btn-icon bloom-btn-cam';
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
        stopBtn.className = 'bloom-btn-stop';
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
        const timerEl = ui.shadow.querySelector('.bloom-timer') as HTMLElement;
        if (timerEl) timerEl.textContent = `${m}:${s}`;
      }, 1000);
    }

    function stopTimer() {
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    }

    async function startWebcamPreview() {
      if (webcamStream || webcamAcquiring) return;
      const bubble = ui.shadow.querySelector('.bloom-webcam') as HTMLElement;
      const videoEl = ui.shadow.querySelector('.bloom-webcam video') as HTMLVideoElement;
      const offEl = ui.shadow.querySelector('.bloom-webcam-off') as HTMLElement;
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
      const bubble = ui.shadow.querySelector('.bloom-webcam') as HTMLElement;
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
        const controls = ui.shadow.querySelector('.bloom-controls') as HTMLElement;
        if (controls) controls.style.display = 'none';
        startTimer();
        if (!webcamStream) startWebcamPreview();
      } else {
        // All other states: clean up the recording overlay
        stopEverything();
        // videoLoaded cleanup now handled by review.html
      }
    }

    // ==========================================
    // Message Listeners
    // ==========================================
    browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
      if (message.type === MessageType.STATE_CHANGED && message.state) {
        updateUI(message.state as ExtensionState);
        return false;
      }

      if (message.type === MessageType.TOGGLE_WEBCAM) {
        const enabled = !!message.enabled;
        if (enabled !== webcamOn) {
          webcamOn = enabled;
          if (!webcamOn) {
            webcamBubble.style.display = 'none';
            const camBtn = ui.shadow.querySelector('.bloom-btn-cam') as HTMLElement;
            if (camBtn) { camBtn.innerHTML = Icons.cameraOff; camBtn.classList.add('active'); camBtn.setAttribute('aria-label', 'Turn camera on'); }
          } else {
            webcamBubble.style.display = 'block';
            const camBtn = ui.shadow.querySelector('.bloom-btn-cam') as HTMLElement;
            if (camBtn) { camBtn.innerHTML = Icons.camera; camBtn.classList.remove('active'); camBtn.setAttribute('aria-label', 'Turn camera off'); }
          }
        }
        return false;
      }

      return false;
    });

    // Backup: storage listener for state changes
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes.state) {
        updateUI(changes.state.newValue as ExtensionState);
      }
    });

    // Init: restore state
    try {
      const result = await browser.storage.local.get('state');
      if (result.state) updateUI(result.state as ExtensionState);
    } catch { /* extension context may not be available */ }
  },
});
