import { getSettings, saveSettings } from '@/utils/settings';

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

function showIdentityNote() {
  identityEl.textContent = 'Detected from your NIP-07 signer when recording';
  identityEl.style.color = '#a0aec0';
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
showIdentityNote();
