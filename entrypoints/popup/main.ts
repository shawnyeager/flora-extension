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

// --- Destination info (visible when idle) ---
const destInfo = el('div', 'dest-info');

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

// --- Buttons ---
const btnRecord = el('button', 'btn-record', 'Start Recording');
const btnStop = el('button', 'btn-stop', 'Stop Recording');
btnStop.style.display = 'none';
const btnOpen = el('button', 'btn-open', 'Open Review');
btnOpen.style.display = 'none';

app.append(header, statusBar, destInfo, btnRecord, btnStop, btnOpen);

loadDestination();

// --- Events ---
btnRecord.addEventListener('click', async () => {
  btnRecord.disabled = true;
  btnRecord.textContent = 'Starting\u2026';

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
    btnRecord.textContent = 'Start Recording';
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
  idle: 'Ready to record',
  initializing: 'Starting\u2026',
  awaiting_media: 'Select a screen\u2026',
  countdown: 'Starting\u2026',
  recording: 'Recording',
  finalizing: 'Saving\u2026',
  preview: 'Review your recording',
  confirming: 'Confirming\u2026',
  uploading: 'Uploading\u2026',
  publishing: 'Publishing to Nostr\u2026',
  complete: 'Shared',
  error: 'Upload failed',
};

const RECORDING_STATES: ExtensionState[] = ['recording'];
const ACTIVE_STATES: ExtensionState[] = ['initializing', 'awaiting_media', 'countdown', 'finalizing', 'uploading', 'publishing', 'confirming'];
const POST_STATES: ExtensionState[] = ['preview', 'confirming', 'uploading', 'publishing', 'complete', 'error'];

function updateUI(state: ExtensionState) {
  statusText.textContent = STATE_LABELS[state] || state;
  statusDot.classList.toggle('recording', RECORDING_STATES.includes(state));
  statusDot.classList.toggle('active', ACTIVE_STATES.includes(state));

  destInfo.style.display = state === 'idle' ? 'flex' : 'none';

  btnRecord.style.display = state === 'idle' ? 'block' : 'none';
  btnRecord.disabled = false;
  btnRecord.textContent = 'Start Recording';

  btnStop.style.display = state === 'recording' ? 'block' : 'none';
  btnStop.disabled = false;
  btnStop.textContent = 'Stop Recording';

  btnOpen.style.display = POST_STATES.includes(state) ? 'block' : 'none';
}
