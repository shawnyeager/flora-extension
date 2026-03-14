import { MessageType } from '@/utils/messages';

const status = document.getElementById('status')!;
const sub = document.getElementById('sub')!;

async function requestPermissions() {
  try {
    // Request audio only — the mic is used by the offscreen document which shares
    // the extension origin. Camera permission is requested by the content script
    // in the web page's origin, so granting it here wouldn't help.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = 'Microphone access granted!';
    sub.textContent = 'Starting recording...';
  } catch (err) {
    console.warn('[permissions] denied:', err);
    status.textContent = 'Microphone access denied';
    sub.textContent = 'Recording will continue without microphone.';
  }

  // Tell background to proceed with recording
  await browser.runtime.sendMessage({ type: MessageType.START_RECORDING });

  // Close this tab after a short delay
  setTimeout(() => window.close(), 500);
}

requestPermissions();
