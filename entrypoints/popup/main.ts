import { MessageType } from '@/utils/messages';
import type { ExtensionState } from '@/utils/state';

const app = document.getElementById('app')!;

// --- Shared elements ---
const logo = document.createElement('div');
logo.className = 'logo';
logo.textContent = 'Bloom';

const status = document.createElement('div');
status.className = 'status';
status.textContent = 'Ready';

// --- Idle / Recording ---
const btnRecord = document.createElement('button');
btnRecord.className = 'btn-record';
btnRecord.textContent = 'Start Recording';

const btnStop = document.createElement('button');
btnStop.className = 'btn-stop';
btnStop.textContent = 'Stop Recording';
btnStop.style.display = 'none';

// --- Preview ---
const previewVideo = document.createElement('video');
previewVideo.className = 'preview-video';
previewVideo.controls = true;
previewVideo.style.display = 'none';

const previewInfo = document.createElement('div');
previewInfo.className = 'preview-info';
previewInfo.style.display = 'none';

const btnUpload = document.createElement('button');
btnUpload.className = 'btn-record';
btnUpload.textContent = 'Upload & Share\u2026';
btnUpload.style.display = 'none';

const btnDownload = document.createElement('button');
btnDownload.className = 'btn-stop';
btnDownload.textContent = 'Download MP4';
btnDownload.style.display = 'none';

// --- Confirmation screen ---
const confirmSection = document.createElement('div');
confirmSection.className = 'confirm-section';
confirmSection.style.display = 'none';
confirmSection.innerHTML = `
  <div class="confirm-meta"></div>
  <label class="confirm-label">Upload to:</label>
  <input type="text" class="confirm-input" id="confirm-server" placeholder="https://blossom.band" />
  <label class="confirm-check-label">
    <input type="checkbox" id="confirm-publish" checked />
    Publish note to Nostr
  </label>
  <div class="confirm-relays"></div>
  <div class="confirm-identity"></div>
  <div class="confirm-warning"></div>
  <button class="btn-record" id="btn-confirm">Confirm</button>
  <button class="btn-reset" id="btn-back">Back</button>
`;

// --- Complete / Error ---
const btnCopy = document.createElement('button');
btnCopy.className = 'btn-copy';
btnCopy.textContent = 'Copy Link';
btnCopy.style.display = 'none';

const btnRetry = document.createElement('button');
btnRetry.className = 'btn-retry';
btnRetry.textContent = 'Retry Upload';
btnRetry.style.display = 'none';

const btnReset = document.createElement('button');
btnReset.className = 'btn-reset';
btnReset.textContent = 'Discard';
btnReset.style.display = 'none';

const resultLink = document.createElement('a');
resultLink.className = 'result-link';
resultLink.target = '_blank';
resultLink.style.display = 'none';

// --- Settings link ---
const settingsLink = document.createElement('a');
settingsLink.className = 'settings-link';
settingsLink.textContent = 'Settings';
settingsLink.href = '#';
settingsLink.style.display = 'none';

app.append(
  logo, btnRecord, btnStop, previewVideo, previewInfo, btnUpload, btnDownload,
  confirmSection, btnCopy, btnRetry, btnReset, resultLink, status, settingsLink,
);

// --- Confirmation screen element refs ---
const confirmMeta = confirmSection.querySelector('.confirm-meta') as HTMLDivElement;
const confirmServer = confirmSection.querySelector('#confirm-server') as HTMLInputElement;
const confirmPublish = confirmSection.querySelector('#confirm-publish') as HTMLInputElement;
const confirmRelays = confirmSection.querySelector('.confirm-relays') as HTMLDivElement;
const confirmIdentity = confirmSection.querySelector('.confirm-identity') as HTMLDivElement;
const confirmWarning = confirmSection.querySelector('.confirm-warning') as HTMLDivElement;
const btnConfirm = confirmSection.querySelector('#btn-confirm') as HTMLButtonElement;
const btnBack = confirmSection.querySelector('#btn-back') as HTMLButtonElement;

let confirmLocked = false;

// --- Event handlers ---

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

btnUpload.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.START_UPLOAD });
});

btnDownload.addEventListener('click', async () => {
  btnDownload.textContent = 'Preparing...';
  btnDownload.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({ type: MessageType.GET_RECORDING });
    if (result && result.dataUrl) {
      const a = document.createElement('a');
      a.href = result.dataUrl;
      a.download = `bloom-${Date.now()}.mp4`;
      a.click();
    } else {
      status.textContent = 'No recording found';
    }
  } catch (err) {
    console.error('Download failed:', err);
    status.textContent = 'Download failed';
  } finally {
    btnDownload.textContent = 'Download MP4';
    btnDownload.disabled = false;
  }
});

btnConfirm.addEventListener('click', async () => {
  if (confirmLocked) return;
  confirmLocked = true;
  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Uploading...';

  await browser.runtime.sendMessage({
    type: MessageType.CONFIRM_UPLOAD,
    serverOverride: confirmServer.value.trim() || undefined,
    publishToNostr: confirmPublish.checked,
  });
});

btnBack.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.BACK_TO_PREVIEW });
});

btnCopy.addEventListener('click', async () => {
  const result = await browser.runtime.sendMessage({ type: MessageType.GET_RESULT });
  const url = result?.publishResult?.blossomUrl || result?.uploadResult?.url;
  if (url) {
    await navigator.clipboard.writeText(url);
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = 'Copy Link'; }, 2000);
  }
});

btnRetry.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.CONFIRM_UPLOAD, publishToNostr: true });
});

btnReset.addEventListener('click', async () => {
  previewVideo.src = '';
  previewVideo.style.display = 'none';
  await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
});

settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  browser.tabs.create({ url: browser.runtime.getURL('/settings.html') });
});

// --- State listener ---

browser.runtime.onMessage.addListener((message) => {
  if (message.type === MessageType.STATE_CHANGED) {
    updateUI(message.state);
  }
  if (message.type === MessageType.UPLOAD_PROGRESS) {
    const pct = Math.round((message.bytesUploaded / message.totalBytes) * 100);
    status.textContent = `Uploading to ${message.serverName}... ${pct}%`;
  }
});

// Get current state on popup open
browser.runtime.sendMessage({ type: MessageType.GET_STATE }).then((state) => {
  if (state) updateUI(state as ExtensionState);
});

// --- Helpers ---

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function truncateNpub(hex: string): string {
  if (hex.length <= 16) return hex;
  return `${hex.slice(0, 8)}...${hex.slice(-8)}`;
}

const STATE_LABELS: Record<ExtensionState, string> = {
  idle: 'Ready',
  initializing: 'Starting...',
  awaiting_media: 'Select a screen to share...',
  countdown: 'Starting...',
  recording: 'Recording',
  finalizing: 'Saving...',
  preview: 'Review your recording',
  confirming: 'Review before sharing',
  uploading: 'Uploading...',
  publishing: 'Publishing to Nostr...',
  complete: 'Done!',
  error: 'Upload failed',
};

async function updateUI(state: ExtensionState) {
  status.textContent = STATE_LABELS[state] || state;

  // Reset confirm lock when leaving confirming state
  if (state !== 'confirming') {
    confirmLocked = false;
    btnConfirm.disabled = false;
    btnConfirm.textContent = 'Confirm';
  }

  // Visibility
  btnRecord.style.display = state === 'idle' ? 'block' : 'none';
  btnStop.style.display = state === 'recording' ? 'block' : 'none';
  previewInfo.style.display = state === 'preview' ? 'block' : 'none';
  btnUpload.style.display = state === 'preview' ? 'block' : 'none';
  btnDownload.style.display = ['preview', 'confirming', 'complete'].includes(state) ? 'block' : 'none';
  confirmSection.style.display = state === 'confirming' ? 'block' : 'none';
  btnCopy.style.display = state === 'complete' ? 'block' : 'none';
  btnRetry.style.display = state === 'error' ? 'block' : 'none';
  btnReset.style.display = ['preview', 'confirming', 'complete', 'error'].includes(state) ? 'block' : 'none';
  resultLink.style.display = 'none';
  settingsLink.style.display = ['idle', 'preview', 'confirming', 'complete'].includes(state) ? 'block' : 'none';

  // Preview video
  if (state === 'preview' || state === 'confirming') {
    btnReset.textContent = 'Discard';
    if (!previewVideo.src) {
      try {
        const result = await browser.runtime.sendMessage({ type: MessageType.GET_RECORDING });
        if (result?.dataUrl) {
          previewVideo.src = result.dataUrl;
          previewVideo.style.display = 'block';
        }
      } catch {
        // Offscreen may not be ready yet
      }
    } else {
      previewVideo.style.display = 'block';
    }
  } else {
    if (state !== 'uploading' && state !== 'publishing') {
      previewVideo.style.display = 'none';
    }
    btnReset.textContent = 'New Recording';
  }

  // Show destination summary on preview screen
  if (state === 'preview') {
    await populatePreviewInfo();
  }

  // Populate confirmation screen
  if (state === 'confirming') {
    await populateConfirmScreen();
  }

  // Complete state
  if (state === 'complete') {
    const result = await browser.runtime.sendMessage({ type: MessageType.GET_RESULT });
    const url = result?.publishResult?.blossomUrl || result?.uploadResult?.url;
    if (url) {
      resultLink.href = url;
      resultLink.textContent = url;
      resultLink.style.display = 'block';
    }
  }
}

async function populatePreviewInfo() {
  const data = await browser.runtime.sendMessage({ type: MessageType.GET_CONFIRM_DATA });
  if (!data) {
    previewInfo.textContent = '';
    return;
  }

  const parts: string[] = [];
  if (data.fileSize) parts.push(formatBytes(data.fileSize));
  if (data.duration) parts.push(formatDuration(data.duration));

  const meta = parts.length ? parts.join(' \u00b7 ') : '';
  const server = data.server || 'No server configured';
  const relays = data.relays?.length ? data.relays.join(', ') : 'No relays configured';
  const identity = data.signerAvailable && data.npub
    ? `Signing as ${truncateNpub(data.npub)}`
    : 'No signer detected';

  previewInfo.innerHTML = '';

  if (meta) {
    const metaLine = document.createElement('div');
    metaLine.className = 'preview-info-meta';
    metaLine.textContent = meta;
    previewInfo.append(metaLine);
  }

  const serverLine = document.createElement('div');
  serverLine.className = 'preview-info-line';
  serverLine.textContent = `Server: ${server}`;
  previewInfo.append(serverLine);

  if (data.publishToNostr) {
    const relayLine = document.createElement('div');
    relayLine.className = 'preview-info-line';
    relayLine.textContent = `Relays: ${relays}`;
    previewInfo.append(relayLine);
  }

  const idLine = document.createElement('div');
  idLine.className = 'preview-info-line';
  if (!data.signerAvailable) {
    idLine.className = 'preview-info-line preview-info-warn';
  }
  idLine.textContent = identity;
  previewInfo.append(idLine);
}

async function populateConfirmScreen() {
  const data = await browser.runtime.sendMessage({ type: MessageType.GET_CONFIRM_DATA });
  if (!data) return;

  // File size + duration
  confirmMeta.textContent = `${formatBytes(data.fileSize)} \u00b7 ${formatDuration(data.duration)}`;

  // Server
  confirmServer.value = data.server;

  // Publish toggle
  confirmPublish.checked = data.publishToNostr;

  // Relays
  if (data.relays?.length) {
    confirmRelays.textContent = data.relays.join(', ');
    confirmRelays.style.display = 'block';
  } else {
    confirmRelays.style.display = 'none';
  }

  // Toggle relay visibility based on publish checkbox
  const updateRelayVisibility = () => {
    confirmRelays.style.display = confirmPublish.checked && data.relays?.length ? 'block' : 'none';
  };
  confirmPublish.onchange = updateRelayVisibility;

  // Identity + signer warnings
  confirmWarning.textContent = '';
  confirmWarning.style.display = 'none';

  if (data.signerAvailable && data.npub) {
    confirmIdentity.textContent = `Signing as: ${truncateNpub(data.npub)}`;
    confirmIdentity.style.display = 'block';
    btnConfirm.disabled = false;
  } else {
    confirmIdentity.style.display = 'none';
    const errorMsg = data.bridgeError || 'No Nostr signer detected';
    if (errorMsg.includes('No content script')) {
      confirmWarning.textContent = 'Open any web page to enable Nostr signing';
    } else {
      confirmWarning.textContent = 'No Nostr signer detected. Install nos2x or Alby to upload and share.';
    }
    confirmWarning.style.display = 'block';
    btnConfirm.disabled = true;
  }
}
