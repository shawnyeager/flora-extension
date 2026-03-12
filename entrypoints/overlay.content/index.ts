import './style.css';
import { MessageType } from '@/utils/messages';
import { Icons } from '@/utils/icons';
import type { ExtensionState } from '@/utils/state';

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
    let videoLoaded = false;
    let confirmLocked = false;

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
    // Helpers
    // ==========================================
    function fmtBytes(b: number) {
      if (b < 1024) return `${b} B`;
      if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
      return `${(b / 1048576).toFixed(1)} MB`;
    }
    function fmtDuration(s: number) {
      return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
    }
    function fmtKey(hex: string) {
      return hex.length <= 16 ? hex : `${hex.slice(0, 8)}\u2026${hex.slice(-8)}`;
    }

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
          video: { width: 320, height: 240, facingMode: 'user' },
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
    // Review Panel (lazy creation)
    // ==========================================
    let reviewPanel: HTMLElement | null = null;

    function ensureReviewPanel(): HTMLElement {
      if (reviewPanel) return reviewPanel;

      const panel = document.createElement('div');
      panel.className = 'bloom-review';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', 'Recording review');
      panel.innerHTML = `
<div class="br-backdrop"></div>
<div class="br-panel">
  <button class="br-close" aria-label="Close">${Icons.x}</button>
  <div class="br-header">
    <span class="br-logo">${Icons.camera}</span>
    <span class="br-title">Bloom</span>
  </div>

  <div class="br-video-wrap">
    <video class="br-video" controls playsinline></video>
    <div class="br-meta"></div>
  </div>

  <div class="br-view br-preview">
    <div class="br-dest">
      <div class="br-dest-row">
        <span class="br-dest-label">Server</span>
        <span class="br-server br-dest-value"></span>
      </div>
      <div class="br-dest-row br-relay-row">
        <span class="br-dest-label">Relays</span>
        <span class="br-relays br-dest-value"></span>
      </div>
      <div class="br-dest-row">
        <span class="br-dest-label">Identity</span>
        <span class="br-identity br-dest-value"></span>
      </div>
      <div class="br-warning" role="alert"></div>
    </div>
    <div class="br-actions">
      <button class="br-btn-primary br-btn-icon br-btn-upload">${Icons.upload} Upload &amp; Share</button>
      <div class="br-actions-row">
        <button class="br-btn-secondary br-btn-icon br-btn-download">${Icons.download} Download</button>
        <button class="br-btn-ghost br-btn-icon br-btn-discard">${Icons.trash} Discard</button>
      </div>
    </div>
  </div>

  <div class="br-view br-confirm" style="display:none">
    <div class="br-dest br-dest-edit">
      <div class="br-dest-row">
        <span class="br-dest-label">Server</span>
        <input class="br-confirm-server br-dest-input" type="text" spellcheck="false" aria-label="Blossom server URL">
      </div>
      <label class="br-check"><input type="checkbox" class="br-confirm-publish" checked> Publish to Nostr</label>
      <div class="br-dest-row br-confirm-relay-row">
        <span class="br-dest-label">Relays</span>
        <span class="br-confirm-relays br-dest-value"></span>
      </div>
      <div class="br-dest-row">
        <span class="br-dest-label">Identity</span>
        <span class="br-confirm-identity br-dest-value"></span>
      </div>
      <div class="br-confirm-warning" role="alert"></div>
    </div>
    <div class="br-actions">
      <button class="br-btn-primary br-btn-icon br-btn-confirm">${Icons.upload} Confirm Upload</button>
      <button class="br-btn-ghost br-btn-back">Back</button>
    </div>
  </div>

  <div class="br-view br-progress" style="display:none">
    <div class="br-center-section">
      <div class="br-progress-status" aria-live="polite"></div>
      <div class="br-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="br-progress-fill"></div></div>
      <div class="br-progress-detail" aria-live="polite"></div>
    </div>
  </div>

  <div class="br-view br-complete" style="display:none">
    <div class="br-center-section">
      <div class="br-complete-icon">${Icons.check}</div>
      <div class="br-complete-title">Shared successfully</div>
      <a class="br-result-link" target="_blank"></a>
      <div class="br-actions">
        <button class="br-btn-primary br-btn-icon br-btn-copy">${Icons.copy} Copy Link</button>
        <button class="br-btn-ghost br-btn-new">New Recording</button>
      </div>
    </div>
  </div>

  <div class="br-view br-error" style="display:none">
    <div class="br-center-section">
      <div class="br-error-icon">${Icons.alertCircle}</div>
      <div class="br-error-title">Upload Failed</div>
      <div class="br-error-message" role="alert"></div>
      <div class="br-actions">
        <button class="br-btn-primary br-btn-retry">Retry</button>
        <button class="br-btn-ghost br-btn-error-discard">Discard</button>
      </div>
    </div>
  </div>
</div>`;

      // --- Wire events ---
      const q = (sel: string) => panel.querySelector(sel) as HTMLElement;

      // Escape key to close/go back
      panel.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        const confirmView = q('.br-confirm');
        if (confirmView && confirmView.style.display !== 'none') {
          browser.runtime.sendMessage({ type: MessageType.BACK_TO_PREVIEW });
        } else {
          const previewView = q('.br-preview');
          if (previewView && previewView.style.display !== 'none') {
            browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
          }
        }
      });

      // Close button
      q('.br-close').addEventListener('click', () => {
        browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
      });

      // Backdrop click to close (only on preview)
      q('.br-backdrop').addEventListener('click', () => {
        const previewView = q('.br-preview');
        if (previewView && previewView.style.display !== 'none') {
          browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
        }
      });

      q('.br-btn-upload').addEventListener('click', () => {
        browser.runtime.sendMessage({ type: MessageType.START_UPLOAD });
      });

      q('.br-btn-download').addEventListener('click', async () => {
        const btn = q('.br-btn-download') as HTMLButtonElement;
        btn.innerHTML = 'Preparing\u2026';
        btn.setAttribute('disabled', '');
        try {
          const result = await browser.runtime.sendMessage({ type: MessageType.GET_RECORDING });
          if (result?.dataUrl) {
            const a = document.createElement('a');
            a.href = result.dataUrl;
            a.download = `bloom-${Date.now()}.mp4`;
            a.click();
          }
        } finally {
          btn.innerHTML = `${Icons.download} Download`;
          btn.removeAttribute('disabled');
        }
      });

      q('.br-btn-discard').addEventListener('click', async () => {
        await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
      });

      q('.br-btn-confirm').addEventListener('click', async () => {
        if (confirmLocked) return;
        confirmLocked = true;
        const btn = q('.br-btn-confirm') as HTMLButtonElement;
        btn.setAttribute('disabled', '');
        btn.textContent = 'Uploading\u2026';
        await browser.runtime.sendMessage({
          type: MessageType.CONFIRM_UPLOAD,
          serverOverride: (q('.br-confirm-server') as HTMLInputElement).value.trim() || undefined,
          publishToNostr: (q('.br-confirm-publish') as HTMLInputElement).checked,
        });
      });

      q('.br-btn-back').addEventListener('click', () => {
        browser.runtime.sendMessage({ type: MessageType.BACK_TO_PREVIEW });
      });

      q('.br-btn-copy').addEventListener('click', async () => {
        const result = await browser.runtime.sendMessage({ type: MessageType.GET_RESULT });
        const url = result?.publishResult?.blossomUrl || result?.uploadResult?.url;
        if (url) {
          await navigator.clipboard.writeText(url);
          const btn = q('.br-btn-copy');
          const original = btn.innerHTML;
          btn.innerHTML = `${Icons.check} Copied!`;
          setTimeout(() => { btn.innerHTML = original; }, 2000);
        }
      });

      q('.br-btn-new').addEventListener('click', async () => {
        await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
      });

      q('.br-btn-retry').addEventListener('click', () => {
        browser.runtime.sendMessage({ type: MessageType.CONFIRM_UPLOAD, publishToNostr: true });
      });

      q('.br-btn-error-discard').addEventListener('click', async () => {
        await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
      });

      rootWrapper?.append(panel);
      reviewPanel = panel;
      return panel;
    }

    // ==========================================
    // Review Logic
    // ==========================================
    async function probeNip07(): Promise<{ pubkey: string } | { error: string }> {
      try {
        return await browser.runtime.sendMessage({ type: MessageType.NIP07_PROBE });
      } catch (err: any) {
        return { error: err.message };
      }
    }

    async function loadVideo() {
      if (videoLoaded) return;
      try {
        const result = await browser.runtime.sendMessage({ type: MessageType.GET_RECORDING });
        if (result?.dataUrl) {
          const video = ensureReviewPanel().querySelector('.br-video') as HTMLVideoElement;
          if (video) video.src = result.dataUrl;
          videoLoaded = true;
        }
      } catch { /* offscreen may not be ready */ }
    }

    function showReviewView(cls: string) {
      const panel = ensureReviewPanel();
      panel.style.display = 'block';
      // Trigger entrance animation
      requestAnimationFrame(() => {
        panel.classList.add('visible');
      });
      panel.querySelectorAll('.br-view').forEach((v) => ((v as HTMLElement).style.display = 'none'));
      const target = panel.querySelector(`.${cls}`) as HTMLElement;
      if (target) target.style.display = 'flex';

      const showMedia = cls === 'br-preview' || cls === 'br-confirm';
      const videoWrap = panel.querySelector('.br-video-wrap') as HTMLElement;
      if (videoWrap) videoWrap.style.display = showMedia ? 'block' : 'none';

      // Show/hide close button based on view
      const closeBtn = panel.querySelector('.br-close') as HTMLElement;
      const canClose = cls === 'br-preview' || cls === 'br-complete';
      if (closeBtn) closeBtn.style.display = canClose ? 'flex' : 'none';
    }

    function hideReview() {
      if (!reviewPanel) return;
      reviewPanel.classList.remove('visible');
      // Wait for fade out animation
      setTimeout(() => {
        if (reviewPanel && !reviewPanel.classList.contains('visible')) {
          reviewPanel.style.display = 'none';
        }
      }, 250);
    }

    function renderSigner(
      nip07: { pubkey: string } | { error: string },
      identityEl: HTMLElement,
      warningEl: HTMLElement,
      actionBtn: HTMLButtonElement,
    ) {
      warningEl.style.display = 'none';
      if ('pubkey' in nip07 && nip07.pubkey) {
        identityEl.textContent = fmtKey(nip07.pubkey);
        actionBtn.removeAttribute('disabled');
      } else {
        identityEl.textContent = '\u2014';
        const errMsg = 'error' in nip07 ? nip07.error : 'Unknown error';
        warningEl.innerHTML = '';

        const msg = document.createElement('div');
        msg.textContent = errMsg;
        warningEl.append(msg);

        const retryBtn = document.createElement('button');
        retryBtn.className = 'br-btn-ghost';
        retryBtn.textContent = 'Retry signer detection';
        retryBtn.style.cssText = 'margin-top:8px;width:auto;padding:6px 12px';
        retryBtn.addEventListener('click', async () => {
          retryBtn.textContent = 'Checking\u2026';
          retryBtn.setAttribute('disabled', '');
          const fresh = await probeNip07();
          renderSigner(fresh, identityEl, warningEl, actionBtn);
        });
        warningEl.append(retryBtn);

        warningEl.style.display = 'block';
        actionBtn.setAttribute('disabled', '');
      }
    }

    async function showPreview() {
      showReviewView('br-preview');
      await loadVideo();

      const panel = ensureReviewPanel();
      const [settings, nip07] = await Promise.all([
        browser.runtime.sendMessage({ type: MessageType.GET_CONFIRM_DATA }),
        probeNip07(),
      ]);
      if (!settings) return;

      const parts: string[] = [];
      if (settings.fileSize) parts.push(fmtBytes(settings.fileSize));
      if (settings.duration) parts.push(fmtDuration(settings.duration));
      const meta = panel.querySelector('.br-meta') as HTMLElement;
      if (meta) meta.textContent = parts.join(' \u00b7 ');

      (panel.querySelector('.br-server') as HTMLElement).textContent = settings.server || 'Not configured';

      const relayRow = panel.querySelector('.br-relay-row') as HTMLElement;
      if (settings.publishToNostr && settings.relays?.length) {
        relayRow.style.display = 'flex';
        (panel.querySelector('.br-relays') as HTMLElement).textContent = settings.relays.join(', ');
      } else {
        relayRow.style.display = 'none';
      }

      renderSigner(
        nip07,
        panel.querySelector('.br-identity') as HTMLElement,
        panel.querySelector('.br-warning') as HTMLElement,
        panel.querySelector('.br-btn-upload') as HTMLButtonElement,
      );
    }

    async function showConfirm() {
      showReviewView('br-confirm');

      const panel = ensureReviewPanel();
      const [settings, nip07] = await Promise.all([
        browser.runtime.sendMessage({ type: MessageType.GET_CONFIRM_DATA }),
        probeNip07(),
      ]);
      if (!settings) return;

      (panel.querySelector('.br-confirm-server') as HTMLInputElement).value = settings.server;
      const publishCheck = panel.querySelector('.br-confirm-publish') as HTMLInputElement;
      publishCheck.checked = settings.publishToNostr;

      const relayRow = panel.querySelector('.br-confirm-relay-row') as HTMLElement;
      const relaysEl = panel.querySelector('.br-confirm-relays') as HTMLElement;
      const updateRelays = () => {
        relayRow.style.display = publishCheck.checked && settings.relays?.length ? 'flex' : 'none';
        relaysEl.textContent = settings.relays?.join(', ') || '';
      };
      updateRelays();
      publishCheck.onchange = updateRelays;

      renderSigner(
        nip07,
        panel.querySelector('.br-confirm-identity') as HTMLElement,
        panel.querySelector('.br-confirm-warning') as HTMLElement,
        panel.querySelector('.br-btn-confirm') as HTMLButtonElement,
      );

      confirmLocked = false;
      const confirmBtn = panel.querySelector('.br-btn-confirm') as HTMLButtonElement;
      confirmBtn.innerHTML = `${Icons.upload} Confirm Upload`;
      confirmBtn.removeAttribute('disabled');
    }

    // ==========================================
    // State Handler
    // ==========================================
    function updateUI(state: ExtensionState) {
      if (state === 'awaiting_media') {
        hideReview();
        startWebcamPreview();
      } else if (state === 'recording') {
        hideReview();
        const controls = ui.shadow.querySelector('.bloom-controls') as HTMLElement;
        if (controls) controls.style.display = 'flex';
        startTimer();
        if (!webcamStream) startWebcamPreview();
      } else if (state === 'preview') {
        stopEverything();
        showPreview();
      } else if (state === 'confirming') {
        showConfirm();
      } else if (state === 'uploading') {
        showReviewView('br-progress');
        const panel = ensureReviewPanel();
        (panel.querySelector('.br-progress-status') as HTMLElement).textContent = 'Uploading\u2026';
        const fill = panel.querySelector('.br-progress-fill') as HTMLElement;
        fill.style.width = '0%';
        const track = panel.querySelector('.br-progress-track') as HTMLElement;
        track.setAttribute('aria-valuenow', '0');
        (panel.querySelector('.br-progress-detail') as HTMLElement).textContent = '';
      } else if (state === 'publishing') {
        showReviewView('br-progress');
        const panel = ensureReviewPanel();
        (panel.querySelector('.br-progress-status') as HTMLElement).textContent = 'Publishing to Nostr\u2026';
        (panel.querySelector('.br-progress-fill') as HTMLElement).style.width = '100%';
        const track = panel.querySelector('.br-progress-track') as HTMLElement;
        track.setAttribute('aria-valuenow', '100');
      } else if (state === 'complete') {
        showReviewView('br-complete');
        browser.runtime.sendMessage({ type: MessageType.GET_RESULT }).then((result) => {
          const url = result?.publishResult?.blossomUrl || result?.uploadResult?.url;
          if (url) {
            const link = ensureReviewPanel().querySelector('.br-result-link') as HTMLAnchorElement;
            link.href = url;
            link.textContent = url;
            link.style.display = 'block';
          }
        });
      } else if (state === 'error') {
        showReviewView('br-error');
        (ensureReviewPanel().querySelector('.br-error-message') as HTMLElement).textContent =
          'The upload failed. You can retry or discard the recording.';
      } else {
        // idle, initializing, finalizing, countdown
        stopEverything();
        hideReview();
        if (state === 'idle') videoLoaded = false;
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

      if (message.type === MessageType.UPLOAD_PROGRESS && reviewPanel) {
        const pct = Math.round((message.bytesUploaded / message.totalBytes) * 100);
        const panel = ensureReviewPanel();
        (panel.querySelector('.br-progress-fill') as HTMLElement).style.width = `${pct}%`;
        const track = panel.querySelector('.br-progress-track') as HTMLElement;
        track.setAttribute('aria-valuenow', String(pct));
        (panel.querySelector('.br-progress-detail') as HTMLElement).textContent =
          `${fmtBytes(message.bytesUploaded)} / ${fmtBytes(message.totalBytes)} to ${message.serverName}`;
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
