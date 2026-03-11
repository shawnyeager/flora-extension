import { MessageType } from '@/utils/messages';
import type { ExtensionState } from '@/utils/state';

const app = document.getElementById('app')!;

const logo = document.createElement('div');
logo.className = 'logo';
logo.textContent = 'Bloom';

const btnRecord = document.createElement('button');
btnRecord.className = 'btn-record';
btnRecord.id = 'btn-record';
btnRecord.textContent = 'Start Recording';

const status = document.createElement('div');
status.className = 'status';
status.id = 'status';
status.textContent = 'Ready';

app.append(logo, btnRecord, status);

btnRecord.addEventListener('click', async () => {
  const response = await browser.runtime.sendMessage({
    type: MessageType.START_RECORDING,
  });
  console.log('[popup] start recording response:', response);
});

// Listen for state updates from service worker
browser.runtime.onMessage.addListener((message) => {
  if (message.type === MessageType.STATE_CHANGED) {
    updateUI(message.state);
  }
});

// Get current state on popup open
browser.runtime.sendMessage({ type: MessageType.GET_STATE }).then((state) => {
  if (state) updateUI(state as ExtensionState);
});

function updateUI(state: ExtensionState) {
  status.textContent = state;
  btnRecord.disabled = state !== 'idle';
  btnRecord.textContent = state === 'idle' ? 'Start Recording' : state;
}
