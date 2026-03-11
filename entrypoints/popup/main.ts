import { MessageType } from '@/utils/messages';
import type { ExtensionState } from '@/utils/state';

const app = document.getElementById('app')!;

const logo = document.createElement('div');
logo.className = 'logo';
logo.textContent = 'Bloom';

const status = document.createElement('div');
status.className = 'status';
status.textContent = 'Ready';

const btnRecord = document.createElement('button');
btnRecord.className = 'btn-record';
btnRecord.textContent = 'Start Recording';

const btnStop = document.createElement('button');
btnStop.className = 'btn-stop';
btnStop.textContent = 'Stop Recording';
btnStop.style.display = 'none';

const btnOpen = document.createElement('button');
btnOpen.className = 'btn-stop';
btnOpen.textContent = 'Open Review';
btnOpen.style.display = 'none';

const settingsLink = document.createElement('a');
settingsLink.className = 'settings-link';
settingsLink.textContent = 'Settings';
settingsLink.href = '#';

app.append(logo, btnRecord, btnStop, btnOpen, status, settingsLink);

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

btnOpen.addEventListener('click', () => {
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
  idle: 'Ready',
  initializing: 'Starting...',
  awaiting_media: 'Select a screen to share...',
  countdown: 'Starting...',
  recording: 'Recording',
  finalizing: 'Saving...',
  preview: 'Recording ready — review tab opened',
  confirming: 'Review in progress',
  uploading: 'Uploading...',
  publishing: 'Publishing to Nostr...',
  complete: 'Done!',
  error: 'Upload failed',
};

function updateUI(state: ExtensionState) {
  status.textContent = STATE_LABELS[state] || state;

  btnRecord.style.display = state === 'idle' ? 'block' : 'none';
  btnStop.style.display = state === 'recording' ? 'block' : 'none';
  // Show "Open Review" for any post-recording state
  btnOpen.style.display = ['preview', 'confirming', 'uploading', 'publishing', 'complete', 'error'].includes(state) ? 'block' : 'none';
}
