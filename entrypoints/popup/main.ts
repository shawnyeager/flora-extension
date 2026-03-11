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

const btnDownload = document.createElement('button');
btnDownload.className = 'btn-stop';
btnDownload.textContent = 'Download MP4';
btnDownload.style.display = 'none';

const btnReset = document.createElement('button');
btnReset.className = 'btn-reset';
btnReset.textContent = 'New Recording';
btnReset.style.display = 'none';

const status = document.createElement('div');
status.className = 'status';
status.textContent = 'Ready';

app.append(logo, btnRecord, btnStop, btnDownload, btnReset, status);

btnRecord.addEventListener('click', async () => {
  // Check if camera/mic permissions are already granted
  const camStatus = await navigator.permissions.query({ name: 'camera' as PermissionName });
  const micStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });

  if (camStatus.state === 'granted' && micStatus.state === 'granted') {
    // Permissions already granted, start directly
    await browser.runtime.sendMessage({ type: MessageType.START_RECORDING });
  } else {
    // Open permissions page in a new tab (popup can't show permission dialogs)
    await browser.tabs.create({ url: browser.runtime.getURL('/permissions.html') });
  }
});

btnStop.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.STOP_RECORDING });
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

btnReset.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
});

// Listen for state updates
browser.runtime.onMessage.addListener((message) => {
  if (message.type === MessageType.STATE_CHANGED) {
    updateUI(message.state);
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
  uploading: 'Uploading...',
  publishing: 'Publishing...',
  complete: 'Recording saved',
  error: 'Error',
};

function updateUI(state: ExtensionState) {
  status.textContent = STATE_LABELS[state] || state;

  btnRecord.style.display = state === 'idle' ? 'block' : 'none';
  btnStop.style.display = state === 'recording' ? 'block' : 'none';
  btnDownload.style.display = state === 'complete' ? 'block' : 'none';
  btnReset.style.display = ['complete', 'error'].includes(state) ? 'block' : 'none';
}
