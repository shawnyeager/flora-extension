import { MessageType } from '@/utils/messages';

const status = document.getElementById('status')!;
const sub = document.getElementById('sub')!;

async function requestPermissions() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = 'Permissions granted!';
    sub.textContent = 'Starting recording...';
  } catch (err) {
    console.warn('[permissions] denied:', err);
    status.textContent = 'Permissions denied';
    sub.textContent = 'Recording will continue without camera/microphone.';
  }

  // Tell background to proceed with recording
  await browser.runtime.sendMessage({ type: MessageType.START_RECORDING });

  // Close this tab after a short delay
  setTimeout(() => window.close(), 500);
}

requestPermissions();
