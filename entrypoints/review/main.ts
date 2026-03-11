import { MessageType } from '@/utils/messages';
import type { ExtensionState } from '@/utils/state';

// --- Element refs ---
const settingsLink = document.getElementById('settings-link') as HTMLAnchorElement;

// Preview view
const viewPreview = document.getElementById('view-preview') as HTMLDivElement;
const previewVideo = document.getElementById('preview-video') as HTMLVideoElement;
const previewMeta = document.getElementById('preview-meta') as HTMLDivElement;
const destServer = document.getElementById('dest-server') as HTMLDivElement;
const destRelays = document.getElementById('dest-relays') as HTMLDivElement;
const relaySection = document.getElementById('relay-section') as HTMLDivElement;
const destIdentity = document.getElementById('dest-identity') as HTMLDivElement;
const signerWarning = document.getElementById('signer-warning') as HTMLDivElement;
const btnUpload = document.getElementById('btn-upload') as HTMLButtonElement;
const btnDownload = document.getElementById('btn-download') as HTMLButtonElement;
const btnDiscard = document.getElementById('btn-discard') as HTMLButtonElement;

// Confirm view
const viewConfirm = document.getElementById('view-confirm') as HTMLDivElement;
const confirmVideo = document.getElementById('confirm-video') as HTMLVideoElement;
const confirmMeta = document.getElementById('confirm-meta') as HTMLDivElement;
const confirmServer = document.getElementById('confirm-server') as HTMLInputElement;
const confirmPublish = document.getElementById('confirm-publish') as HTMLInputElement;
const confirmRelays = document.getElementById('confirm-relays') as HTMLDivElement;
const confirmIdentity = document.getElementById('confirm-identity') as HTMLDivElement;
const confirmWarning = document.getElementById('confirm-warning') as HTMLDivElement;
const btnConfirm = document.getElementById('btn-confirm') as HTMLButtonElement;
const btnBack = document.getElementById('btn-back') as HTMLButtonElement;

// Progress view
const viewProgress = document.getElementById('view-progress') as HTMLDivElement;
const progressStatus = document.getElementById('progress-status') as HTMLDivElement;
const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
const progressDetail = document.getElementById('progress-detail') as HTMLDivElement;

// Complete view
const viewComplete = document.getElementById('view-complete') as HTMLDivElement;
const resultLink = document.getElementById('result-link') as HTMLAnchorElement;
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement;
const btnNew = document.getElementById('btn-new') as HTMLButtonElement;

// Error view
const viewError = document.getElementById('view-error') as HTMLDivElement;
const errorMessage = document.getElementById('error-message') as HTMLDivElement;
const btnRetry = document.getElementById('btn-retry') as HTMLButtonElement;
const btnErrorDiscard = document.getElementById('btn-error-discard') as HTMLButtonElement;

let confirmLocked = false;
let videoLoaded = false;

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

function truncateKey(hex: string): string {
  if (hex.length <= 16) return hex;
  return `${hex.slice(0, 8)}\u2026${hex.slice(-8)}`;
}

// --- Views ---

const views = [viewPreview, viewConfirm, viewProgress, viewComplete, viewError];

function showView(view: HTMLDivElement) {
  for (const v of views) v.style.display = v === view ? 'flex' : 'none';
}

async function loadVideo() {
  if (videoLoaded) return;
  try {
    const result = await browser.runtime.sendMessage({ type: MessageType.GET_RECORDING });
    if (result?.dataUrl) {
      previewVideo.src = result.dataUrl;
      confirmVideo.src = result.dataUrl;
      videoLoaded = true;
    }
  } catch {
    // offscreen may not be ready
  }
}

interface ConfirmData {
  npub: string | null;
  signerAvailable: boolean;
  bridgeError: string | null;
  server: string;
  relays: string[];
  publishToNostr: boolean;
  fileSize: number;
  duration: number;
}

async function getConfirmData(): Promise<ConfirmData | null> {
  return browser.runtime.sendMessage({ type: MessageType.GET_CONFIRM_DATA });
}

async function showPreview() {
  showView(viewPreview);
  await loadVideo();

  const data = await getConfirmData();
  if (!data) return;

  const parts: string[] = [];
  if (data.fileSize) parts.push(formatBytes(data.fileSize));
  if (data.duration) parts.push(formatDuration(data.duration));
  previewMeta.textContent = parts.join(' \u00b7 ');

  destServer.textContent = data.server || 'Not configured';

  if (data.publishToNostr && data.relays?.length) {
    relaySection.style.display = 'flex';
    destRelays.textContent = data.relays.join(', ');
  } else {
    relaySection.style.display = 'none';
  }

  signerWarning.style.display = 'none';
  if (data.signerAvailable && data.npub) {
    destIdentity.textContent = truncateKey(data.npub);
    btnUpload.disabled = false;
  } else {
    destIdentity.textContent = '';
    const err = data.bridgeError || 'No Nostr signer detected';
    if (err.includes('No content script')) {
      signerWarning.textContent = 'Open any web page to enable Nostr signing.';
    } else {
      signerWarning.textContent = 'No Nostr signer detected. Install nos2x or Alby to upload and share.';
    }
    signerWarning.style.display = 'block';
    btnUpload.disabled = true;
  }
}

async function showConfirm() {
  showView(viewConfirm);

  const data = await getConfirmData();
  if (!data) return;

  const parts: string[] = [];
  if (data.fileSize) parts.push(formatBytes(data.fileSize));
  if (data.duration) parts.push(formatDuration(data.duration));
  confirmMeta.textContent = parts.join(' \u00b7 ');

  confirmServer.value = data.server;
  confirmPublish.checked = data.publishToNostr;

  const updateRelays = () => {
    confirmRelays.style.display = confirmPublish.checked && data.relays?.length ? 'block' : 'none';
    confirmRelays.textContent = data.relays?.join(', ') || '';
  };
  updateRelays();
  confirmPublish.onchange = updateRelays;

  confirmWarning.style.display = 'none';
  if (data.signerAvailable && data.npub) {
    confirmIdentity.textContent = truncateKey(data.npub);
    btnConfirm.disabled = false;
  } else {
    confirmIdentity.textContent = 'Not available';
    const err = data.bridgeError || 'No Nostr signer detected';
    confirmWarning.textContent = err.includes('No content script')
      ? 'Open any web page to enable Nostr signing.'
      : 'No Nostr signer detected. Install nos2x or Alby to upload.';
    confirmWarning.style.display = 'block';
    btnConfirm.disabled = true;
  }

  confirmLocked = false;
  btnConfirm.textContent = 'Confirm Upload';
}

// --- Event handlers ---

settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  browser.tabs.create({ url: browser.runtime.getURL('/settings.html') });
});

btnUpload.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.START_UPLOAD });
});

btnDownload.addEventListener('click', async () => {
  btnDownload.textContent = 'Preparing\u2026';
  btnDownload.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({ type: MessageType.GET_RECORDING });
    if (result?.dataUrl) {
      const a = document.createElement('a');
      a.href = result.dataUrl;
      a.download = `bloom-${Date.now()}.mp4`;
      a.click();
    }
  } catch (err) {
    console.error('Download failed:', err);
  } finally {
    btnDownload.textContent = 'Download MP4';
    btnDownload.disabled = false;
  }
});

btnDiscard.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
  window.close();
});

btnConfirm.addEventListener('click', async () => {
  if (confirmLocked) return;
  confirmLocked = true;
  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Uploading\u2026';

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

btnNew.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
  window.close();
});

btnRetry.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.CONFIRM_UPLOAD, publishToNostr: true });
});

btnErrorDiscard.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
  window.close();
});

// --- State listener ---

browser.runtime.onMessage.addListener((message) => {
  if (message.type === MessageType.STATE_CHANGED) {
    updateUI(message.state);
  }
  if (message.type === MessageType.UPLOAD_PROGRESS) {
    const pct = Math.round((message.bytesUploaded / message.totalBytes) * 100);
    progressBar.style.width = `${pct}%`;
    progressDetail.textContent = `${formatBytes(message.bytesUploaded)} / ${formatBytes(message.totalBytes)} to ${message.serverName}`;
  }
});

async function updateUI(state: ExtensionState) {
  switch (state) {
    case 'preview':
      await showPreview();
      break;
    case 'confirming':
      await showConfirm();
      break;
    case 'uploading':
      showView(viewProgress);
      progressStatus.textContent = 'Uploading\u2026';
      progressBar.style.width = '0%';
      progressDetail.textContent = '';
      break;
    case 'publishing':
      showView(viewProgress);
      progressStatus.textContent = 'Publishing to Nostr\u2026';
      progressBar.style.width = '100%';
      progressDetail.textContent = '';
      break;
    case 'complete': {
      showView(viewComplete);
      const result = await browser.runtime.sendMessage({ type: MessageType.GET_RESULT });
      const url = result?.publishResult?.blossomUrl || result?.uploadResult?.url;
      if (url) {
        resultLink.href = url;
        resultLink.textContent = url;
        resultLink.style.display = 'block';
      }
      break;
    }
    case 'error':
      showView(viewError);
      errorMessage.textContent = 'The upload failed. You can retry or discard the recording.';
      break;
    case 'idle':
      window.close();
      break;
  }
}

// Init: get current state and render
browser.runtime.sendMessage({ type: MessageType.GET_STATE }).then((state) => {
  if (state) updateUI(state as ExtensionState);
});
