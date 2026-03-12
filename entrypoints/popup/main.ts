import { MessageType } from '@/utils/messages';
import { Icons } from '@/utils/icons';
import { getSettings } from '@/utils/settings';
import type { ExtensionState } from '@/utils/state';

const app = document.getElementById('app')!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// --- Header ---
const header = el('div', 'header');
const headerLeft = el('div', 'header-left');
const headerIcon = el('img', 'header-icon') as HTMLImageElement;
headerIcon.src = '/icon/48.png';
headerIcon.alt = '';
const headerTitle = el('span', 'header-title', 'Bloom');
headerLeft.append(headerIcon, headerTitle);

const headerActions = el('div', 'header-actions');

const recordingsBtn = el('button', 'btn-settings');
recordingsBtn.innerHTML = Icons.list;
recordingsBtn.setAttribute('aria-label', 'Recordings');
recordingsBtn.addEventListener('click', () => {
  browser.tabs.create({ url: browser.runtime.getURL('/recordings.html') });
});

const settingsBtn = el('button', 'btn-settings');
settingsBtn.innerHTML = Icons.settings;
settingsBtn.setAttribute('aria-label', 'Settings');
settingsBtn.addEventListener('click', () => {
  browser.tabs.create({ url: browser.runtime.getURL('/settings.html') });
});

headerActions.append(recordingsBtn, settingsBtn);
header.append(headerLeft, headerActions);

// --- Status ---
const statusBar = el('div', 'status-bar');
const statusDot = el('div', 'status-dot');
const statusText = el('span', 'status-text', 'Ready');
statusBar.append(statusDot, statusText);

// --- Destination info (collapsible) ---
const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

const destToggle = el('button', 'dest-toggle');
destToggle.innerHTML = `<span>Destination</span>${CHEVRON_SVG}`;
destToggle.addEventListener('click', () => {
  const open = destToggle.classList.toggle('open');
  destBody.classList.toggle('open', open);
});

const destBody = el('div', 'dest-body');
const destBodyInner = el('div', 'dest-body-inner');
const destInfo = el('div', 'dest-info');
destBodyInner.append(destInfo);
destBody.append(destBodyInner);

function destRow(label: string, value: string): HTMLDivElement {
  const row = el('div', 'dest-row');
  row.append(el('span', 'dest-label', label), el('span', 'dest-value', value));
  return row;
}

async function loadDestination() {
  const settings = await getSettings();
  const server = settings.blossomServers[0] || 'Not configured';
  const relayCount = settings.nostrRelays.length;
  let serverHost: string;
  try { serverHost = new URL(server).hostname; } catch { serverHost = server; }

  destInfo.replaceChildren(
    destRow('Server', serverHost),
    destRow('Relays', `${relayCount} configured`),
    ...(settings.publishToNostr ? [destRow('Publish', 'Nostr')] : []),
  );
}

// --- Recording controls toolbar (visible during recording) ---
const recToolbar = el('div', 'rec-toolbar');
recToolbar.style.display = 'none';

const recDot = el('div', 'rec-dot');
const recTimer = el('span', 'rec-timer', '00:00');
const recDivider = el('div', 'rec-divider');

const recPauseBtn = el('button', 'rec-btn');
recPauseBtn.innerHTML = Icons.pause;
recPauseBtn.setAttribute('aria-label', 'Pause recording');

const recMicBtn = el('button', 'rec-btn');
recMicBtn.innerHTML = Icons.mic;
recMicBtn.setAttribute('aria-label', 'Mute microphone');

const recCamBtn = el('button', 'rec-btn');
recCamBtn.innerHTML = Icons.camera;
recCamBtn.setAttribute('aria-label', 'Turn camera off');

const recStopBtn = el('button', 'rec-btn rec-btn-stop');
recStopBtn.innerHTML = Icons.stop;
recStopBtn.setAttribute('aria-label', 'Stop recording');

recToolbar.append(recDot, recTimer, recDivider, recPauseBtn, recMicBtn, recCamBtn, recStopBtn);

// Recording controls state
let recPaused = false;
let recMicMuted = false;
let recWebcamOn = true;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let timerStartedAt = 0;
let timerPausedAccum = 0;

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function startTimerTick() {
  stopTimerTick();
  timerInterval = setInterval(() => {
    if (recPaused || !timerStartedAt) return;
    const elapsed = Date.now() - timerStartedAt - timerPausedAccum;
    recTimer.textContent = formatTime(elapsed);
  }, 500);
}

function stopTimerTick() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

recPauseBtn.addEventListener('click', () => {
  recPaused = !recPaused;
  if (recPaused) {
    recPauseBtn.innerHTML = Icons.play;
    recPauseBtn.setAttribute('aria-label', 'Resume recording');
    recPauseBtn.classList.add('active');
    recDot.classList.add('paused');
    browser.runtime.sendMessage({ type: MessageType.PAUSE_RECORDING });
  } else {
    recPauseBtn.innerHTML = Icons.pause;
    recPauseBtn.setAttribute('aria-label', 'Pause recording');
    recPauseBtn.classList.remove('active');
    recDot.classList.remove('paused');
    browser.runtime.sendMessage({ type: MessageType.RESUME_RECORDING });
  }
});

recMicBtn.addEventListener('click', () => {
  recMicMuted = !recMicMuted;
  recMicBtn.innerHTML = recMicMuted ? Icons.micOff : Icons.mic;
  recMicBtn.classList.toggle('active', recMicMuted);
  recMicBtn.setAttribute('aria-label', recMicMuted ? 'Unmute microphone' : 'Mute microphone');
  browser.runtime.sendMessage({ type: MessageType.TOGGLE_MIC, muted: recMicMuted });
});

recCamBtn.addEventListener('click', () => {
  recWebcamOn = !recWebcamOn;
  recCamBtn.innerHTML = recWebcamOn ? Icons.camera : Icons.cameraOff;
  recCamBtn.classList.toggle('active', !recWebcamOn);
  recCamBtn.setAttribute('aria-label', recWebcamOn ? 'Turn camera off' : 'Turn camera on');
  browser.runtime.sendMessage({ type: MessageType.TOGGLE_WEBCAM, enabled: recWebcamOn });
});

recStopBtn.addEventListener('click', async () => {
  recStopBtn.disabled = true;
  await browser.runtime.sendMessage({ type: MessageType.STOP_RECORDING });
});

async function syncRecordingState() {
  try {
    const state = await browser.runtime.sendMessage({ type: MessageType.GET_RECORDING_STATE }) as any;
    if (!state || !state.recordingStartedAt) return;

    timerStartedAt = state.recordingStartedAt;
    timerPausedAccum = state.pausedAccumulated || 0;
    recPaused = state.paused;
    recMicMuted = state.micMuted;
    recWebcamOn = state.webcamOn;

    // Update UI to match
    recPauseBtn.innerHTML = recPaused ? Icons.play : Icons.pause;
    recPauseBtn.setAttribute('aria-label', recPaused ? 'Resume recording' : 'Pause recording');
    recPauseBtn.classList.toggle('active', recPaused);
    recDot.classList.toggle('paused', recPaused);

    recMicBtn.innerHTML = recMicMuted ? Icons.micOff : Icons.mic;
    recMicBtn.classList.toggle('active', recMicMuted);

    recCamBtn.innerHTML = recWebcamOn ? Icons.camera : Icons.cameraOff;
    recCamBtn.classList.toggle('active', !recWebcamOn);

    // Start timer from current position
    const elapsed = Date.now() - timerStartedAt - timerPausedAccum;
    recTimer.textContent = formatTime(elapsed);
    startTimerTick();
  } catch { /* background not ready */ }
}

// --- Buttons ---
const RECORD_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="5"/></svg>';

const btnRecord = el('button', 'btn-record');
btnRecord.innerHTML = `${RECORD_ICON} Start Recording`;
const btnStop = el('button', 'btn-stop', 'Stop Recording');
btnStop.style.display = 'none';
const btnOpen = el('button', 'btn-open', 'Open Review');
btnOpen.style.display = 'none';

app.append(header, statusBar, destToggle, destBody, recToolbar, btnRecord, btnStop, btnOpen);

loadDestination();

// --- Events ---
btnRecord.addEventListener('click', async () => {
  btnRecord.disabled = true;
  btnRecord.innerHTML = `${RECORD_ICON} Starting\u2026`;

  try {
    const camStatus = await navigator.permissions.query({ name: 'camera' as PermissionName });
    const micStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });

    if (camStatus.state === 'granted' && micStatus.state === 'granted') {
      await browser.runtime.sendMessage({ type: MessageType.START_RECORDING });
    } else {
      await browser.tabs.create({ url: browser.runtime.getURL('/permissions.html') });
    }
  } catch {
    btnRecord.disabled = false;
    btnRecord.innerHTML = `${RECORD_ICON} Start Recording`;
  }
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  btnStop.textContent = 'Stopping\u2026';
  await browser.runtime.sendMessage({ type: MessageType.STOP_RECORDING });
});

btnOpen.addEventListener('click', async () => {
  const { recordingTabId } = await browser.storage.local.get('recordingTabId');
  if (recordingTabId) {
    try {
      await browser.tabs.update(recordingTabId as number, { active: true });
      window.close();
      return;
    } catch { /* tab may have been closed */ }
  }
  browser.tabs.create({ url: browser.runtime.getURL('/review.html') });
});

// --- State ---
browser.runtime.onMessage.addListener((message) => {
  if (message.type === MessageType.STATE_CHANGED) {
    updateUI(message.state);
  }
});

browser.runtime.sendMessage({ type: MessageType.GET_STATE }).then((state) => {
  if (state) updateUI(state as ExtensionState);
});

const STATE_LABELS: Record<ExtensionState, string> = {
  idle: 'Ready when you are',
  initializing: 'Starting\u2026',
  awaiting_media: 'Pick a screen\u2026',
  countdown: 'Get ready\u2026',
  recording: 'Recording',
  finalizing: 'Wrapping up\u2026',
  preview: 'Review your clip',
  confirming: 'Almost there\u2026',
  uploading: 'Uploading\u2026',
  publishing: 'Publishing\u2026',
  complete: 'Shared',
  error: 'Something went wrong',
};

const RECORDING_STATES: ExtensionState[] = ['recording'];
const ACTIVE_STATES: ExtensionState[] = ['initializing', 'awaiting_media', 'countdown', 'finalizing', 'uploading', 'publishing', 'confirming'];
const POST_STATES: ExtensionState[] = ['preview', 'confirming', 'uploading', 'publishing', 'complete', 'error'];

function updateUI(state: ExtensionState) {
  statusText.textContent = STATE_LABELS[state] || state;
  statusDot.classList.toggle('recording', RECORDING_STATES.includes(state));
  statusDot.classList.toggle('active', ACTIVE_STATES.includes(state));

  const isIdle = state === 'idle';
  const isRecording = state === 'recording';

  destToggle.style.display = isIdle ? '' : 'none';
  destBody.style.display = isIdle ? '' : 'none';

  btnRecord.style.display = isIdle ? 'flex' : 'none';
  btnRecord.disabled = false;
  btnRecord.innerHTML = `${RECORD_ICON} Start Recording`;

  // Recording toolbar replaces the old stop button
  recToolbar.style.display = isRecording ? 'flex' : 'none';
  btnStop.style.display = 'none'; // replaced by toolbar stop button

  if (isRecording) {
    syncRecordingState();
  } else {
    stopTimerTick();
  }

  btnOpen.style.display = POST_STATES.includes(state) ? 'block' : 'none';
}
