import { MessageType } from '@/utils/messages';
import { Icons } from '@/utils/icons';
import type { RecordingControlsState } from '@/utils/messages';

const recDot = document.querySelector('.rec-dot') as HTMLElement;
const timer = document.querySelector('.timer') as HTMLElement;
const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement;
const micBtn = document.getElementById('mic-btn') as HTMLButtonElement;
const camBtn = document.getElementById('cam-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;

/** Insert trusted SVG icon from our Icons constants */
function setIcon(el: HTMLElement, svg: string) {
  const tpl = document.createElement('template');
  tpl.innerHTML = svg;
  el.replaceChildren(tpl.content.cloneNode(true));
}

// Set initial icons
setIcon(pauseBtn, Icons.pause);
setIcon(micBtn, Icons.mic);
setIcon(camBtn, Icons.camera);
setIcon(stopBtn, Icons.stop);

let paused = false;
let micMuted = false;
let webcamOn = true;
let timerStartedAt = 0;
let pausedAccum = 0;
let timerInterval: ReturnType<typeof setInterval> | null = null;

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (paused || !timerStartedAt) return;
    timer.textContent = formatTime(Date.now() - timerStartedAt - pausedAccum);
  }, 500);
}

// Sync state from background
async function sync() {
  try {
    const state = await browser.runtime.sendMessage({ type: MessageType.GET_RECORDING_STATE }) as RecordingControlsState;
    if (!state?.recordingStartedAt) return;

    timerStartedAt = state.recordingStartedAt;
    pausedAccum = state.pausedAccumulated;
    paused = state.paused;
    micMuted = state.micMuted;
    webcamOn = state.webcamOn;

    setIcon(pauseBtn, paused ? Icons.play : Icons.pause);
    pauseBtn.setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording');
    pauseBtn.classList.toggle('active', paused);
    recDot.classList.toggle('paused', paused);

    setIcon(micBtn, micMuted ? Icons.micOff : Icons.mic);
    micBtn.classList.toggle('active', micMuted);

    setIcon(camBtn, webcamOn ? Icons.camera : Icons.cameraOff);
    camBtn.classList.toggle('active', !webcamOn);

    timer.textContent = formatTime(Date.now() - timerStartedAt - pausedAccum);
    startTimer();
  } catch { /* background not ready */ }
}

pauseBtn.addEventListener('click', () => {
  paused = !paused;
  if (paused) {
    setIcon(pauseBtn, Icons.play);
    pauseBtn.setAttribute('aria-label', 'Resume recording');
    pauseBtn.classList.add('active');
    recDot.classList.add('paused');
    browser.runtime.sendMessage({ type: MessageType.PAUSE_RECORDING });
  } else {
    setIcon(pauseBtn, Icons.pause);
    pauseBtn.setAttribute('aria-label', 'Pause recording');
    pauseBtn.classList.remove('active');
    recDot.classList.remove('paused');
    browser.runtime.sendMessage({ type: MessageType.RESUME_RECORDING });
  }
});

micBtn.addEventListener('click', () => {
  micMuted = !micMuted;
  setIcon(micBtn, micMuted ? Icons.micOff : Icons.mic);
  micBtn.classList.toggle('active', micMuted);
  micBtn.setAttribute('aria-label', micMuted ? 'Unmute microphone' : 'Mute microphone');
  browser.runtime.sendMessage({ type: MessageType.TOGGLE_MIC, muted: micMuted });
});

camBtn.addEventListener('click', () => {
  webcamOn = !webcamOn;
  setIcon(camBtn, webcamOn ? Icons.camera : Icons.cameraOff);
  camBtn.classList.toggle('active', !webcamOn);
  camBtn.setAttribute('aria-label', webcamOn ? 'Turn camera off' : 'Turn camera on');
  browser.runtime.sendMessage({ type: MessageType.TOGGLE_WEBCAM, enabled: webcamOn });
});

stopBtn.addEventListener('click', () => {
  stopBtn.disabled = true;
  browser.runtime.sendMessage({ type: MessageType.STOP_RECORDING });
});

// Close this window when recording stops
browser.runtime.onMessage.addListener((message: any) => {
  if (message.type === MessageType.STATE_CHANGED && message.state !== 'recording') {
    window.close();
  }
});

sync();
