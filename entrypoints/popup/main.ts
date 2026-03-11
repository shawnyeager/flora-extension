import { MessageType } from '@/utils/messages';
import type { ExtensionState } from '@/utils/state';

const app = document.getElementById('app')!;

const logo = document.createElement('div');
logo.className = 'logo';
logo.textContent = 'Bloom';

const btnRecord = document.createElement('button');
btnRecord.className = 'btn-record';
btnRecord.textContent = 'Start Recording';

const btnStop = document.createElement('button');
btnStop.className = 'btn-stop';
btnStop.textContent = 'Stop Recording';
btnStop.style.display = 'none';

// Preview state elements
const previewVideo = document.createElement('video');
previewVideo.className = 'preview-video';
previewVideo.controls = true;
previewVideo.style.display = 'none';

const btnUpload = document.createElement('button');
btnUpload.className = 'btn-record';
btnUpload.textContent = 'Upload & Share';
btnUpload.style.display = 'none';

const btnDownload = document.createElement('button');
btnDownload.className = 'btn-stop';
btnDownload.textContent = 'Download MP4';
btnDownload.style.display = 'none';

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

const status = document.createElement('div');
status.className = 'status';
status.textContent = 'Ready';

app.append(logo, btnRecord, btnStop, previewVideo, btnUpload, btnDownload, btnCopy, btnRetry, btnReset, resultLink, status);

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
  await browser.runtime.sendMessage({ type: MessageType.START_UPLOAD });
});

btnReset.addEventListener('click', async () => {
  previewVideo.src = '';
  previewVideo.style.display = 'none';
  await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
});

// Listen for state updates and upload progress
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

const STATE_LABELS: Record<ExtensionState, string> = {
  idle: 'Ready',
  initializing: 'Starting...',
  awaiting_media: 'Select a screen to share...',
  countdown: 'Starting...',
  recording: 'Recording',
  finalizing: 'Saving...',
  preview: 'Review your recording',
  uploading: 'Uploading...',
  publishing: 'Publishing to Nostr...',
  complete: 'Done!',
  error: 'Upload failed',
};

async function updateUI(state: ExtensionState) {
  status.textContent = STATE_LABELS[state] || state;

  btnRecord.style.display = state === 'idle' ? 'block' : 'none';
  btnStop.style.display = state === 'recording' ? 'block' : 'none';
  btnUpload.style.display = state === 'preview' ? 'block' : 'none';
  btnDownload.style.display = ['preview', 'complete'].includes(state) ? 'block' : 'none';
  btnCopy.style.display = state === 'complete' ? 'block' : 'none';
  btnRetry.style.display = state === 'error' ? 'block' : 'none';
  btnReset.style.display = ['preview', 'complete', 'error'].includes(state) ? 'block' : 'none';
  resultLink.style.display = 'none';

  if (state === 'preview') {
    btnReset.textContent = 'Discard';
    // Load recording for playback
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
