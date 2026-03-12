import { MessageType } from '@/utils/messages';
import type { ExtensionState } from '@/utils/state';

const app = document.getElementById('app')!;

// Header
const header = document.createElement('div');
header.className = 'header';
const headerIcon = document.createElement('img');
headerIcon.className = 'header-icon';
headerIcon.src = '/icon/48.png';
headerIcon.alt = 'Bloom';
const headerTitle = document.createElement('span');
headerTitle.className = 'header-title';
headerTitle.textContent = 'Bloom';
header.append(headerIcon, headerTitle);

// Status
const statusBar = document.createElement('div');
statusBar.className = 'status-bar';
const statusDot = document.createElement('div');
statusDot.className = 'status-dot';
const statusText = document.createElement('span');
statusText.className = 'status-text';
statusText.textContent = 'Ready';
statusBar.append(statusDot, statusText);

// Buttons
const btnRecord = document.createElement('button');
btnRecord.className = 'btn-record';
btnRecord.textContent = 'Start Recording';

const btnStop = document.createElement('button');
btnStop.className = 'btn-stop';
btnStop.textContent = 'Stop Recording';
btnStop.style.display = 'none';

const btnOpen = document.createElement('button');
btnOpen.className = 'btn-open';
btnOpen.textContent = 'Open Review';
btnOpen.style.display = 'none';

// Footer
const footer = document.createElement('div');
footer.className = 'footer';
const settingsLink = document.createElement('a');
settingsLink.className = 'settings-link';
settingsLink.textContent = 'Settings';
settingsLink.href = '#';
footer.append(settingsLink);

app.append(header, statusBar, btnRecord, btnStop, btnOpen, footer);

btnRecord.addEventListener('click', async () => {
  const camStatus = await navigator.permissions.query({ name: 'camera' as PermissionName });
  const micStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });

  if (camStatus.state === 'granted' && micStatus.state === 'granted') {
    await browser.runtime.sendMessage({ type: MessageType.START_RECORDING });
  } else {
    await browser.tabs.create({ url: browser.runtime.getURL('/permissions.html') });
  }
});

btnStop.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.STOP_RECORDING });
});

btnOpen.addEventListener('click', async () => {
  const { recordingTabId } = await browser.storage.local.get('recordingTabId');
  if (recordingTabId) {
    try {
      await browser.tabs.update(recordingTabId as number, { active: true });
      return;
    } catch { /* tab may have been closed */ }
  }
  browser.tabs.create({ url: browser.runtime.getURL('/review.html') });
});

settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  browser.tabs.create({ url: browser.runtime.getURL('/settings.html') });
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type === MessageType.STATE_CHANGED) {
    updateUI(message.state);
  }
});

browser.runtime.sendMessage({ type: MessageType.GET_STATE }).then((state) => {
  if (state) updateUI(state as ExtensionState);
});

const STATE_LABELS: Record<ExtensionState, string> = {
  idle: 'Ready to record',
  initializing: 'Starting\u2026',
  awaiting_media: 'Select a screen to share\u2026',
  countdown: 'Starting\u2026',
  recording: 'Recording',
  finalizing: 'Saving\u2026',
  preview: 'Review your recording',
  confirming: 'Confirming upload\u2026',
  uploading: 'Uploading\u2026',
  publishing: 'Publishing to Nostr\u2026',
  complete: 'Shared successfully',
  error: 'Upload failed',
};

const RECORDING_STATES: ExtensionState[] = ['recording'];
const ACTIVE_STATES: ExtensionState[] = ['initializing', 'awaiting_media', 'countdown', 'finalizing', 'uploading', 'publishing', 'confirming'];
const POST_STATES: ExtensionState[] = ['preview', 'confirming', 'uploading', 'publishing', 'complete', 'error'];

function updateUI(state: ExtensionState) {
  statusText.textContent = STATE_LABELS[state] || state;
  statusDot.classList.toggle('recording', RECORDING_STATES.includes(state));
  statusDot.classList.toggle('active', ACTIVE_STATES.includes(state));

  btnRecord.style.display = state === 'idle' ? 'block' : 'none';
  btnStop.style.display = state === 'recording' ? 'block' : 'none';
  btnOpen.style.display = POST_STATES.includes(state) ? 'block' : 'none';
}
