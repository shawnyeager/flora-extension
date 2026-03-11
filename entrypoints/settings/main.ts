import { getSettings, saveSettings } from '@/utils/settings';
import { MessageType } from '@/utils/messages';

const serversEl = document.getElementById('servers') as HTMLTextAreaElement;
const relaysEl = document.getElementById('relays') as HTMLTextAreaElement;
const publishToggle = document.getElementById('publish-toggle') as HTMLInputElement;
const identityEl = document.getElementById('identity') as HTMLDivElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const saveStatus = document.getElementById('save-status') as HTMLDivElement;

async function loadSettings() {
  const settings = await getSettings();
  serversEl.value = settings.blossomServers.join('\n');
  relaysEl.value = settings.nostrRelays.join('\n');
  publishToggle.checked = settings.publishToNostr;
}

async function probeIdentity() {
  try {
    const response = await browser.runtime.sendMessage({
      type: MessageType.NIP07_GET_PUBKEY,
    });
    if (response?.ok !== false && response?.data) {
      identityEl.textContent = response.data;
    } else {
      identityEl.textContent = response?.error || 'No signer detected';
      identityEl.style.color = '#f6ad55';
    }
  } catch {
    identityEl.textContent = 'Could not reach signer';
    identityEl.style.color = '#f6ad55';
  }
}

btnSave.addEventListener('click', async () => {
  const servers = serversEl.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const relays = relaysEl.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  await saveSettings({
    blossomServers: servers,
    nostrRelays: relays,
    publishToNostr: publishToggle.checked,
  });

  saveStatus.textContent = 'Saved';
  setTimeout(() => { saveStatus.textContent = ''; }, 2000);
});

loadSettings();
probeIdentity();
