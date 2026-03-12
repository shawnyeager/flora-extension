import { getSettings, saveSettings } from '@/utils/settings';
import { MessageType } from '@/utils/messages';

const serversEl = document.getElementById('servers') as HTMLTextAreaElement;
const relaysEl = document.getElementById('relays') as HTMLTextAreaElement;
const publishToggle = document.getElementById('publish-toggle') as HTMLInputElement;
const identityEl = document.getElementById('identity') as HTMLDivElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const saveStatus = document.getElementById('save-status') as HTMLSpanElement;

async function loadSettings() {
  const settings = await getSettings();
  serversEl.value = settings.blossomServers.join('\n');
  relaysEl.value = settings.nostrRelays.join('\n');
  publishToggle.checked = settings.publishToNostr;
}

async function detectIdentity() {
  identityEl.textContent = 'Checking\u2026';
  identityEl.classList.add('checking');
  identityEl.classList.remove('error');

  try {
    const result = await Promise.race([
      browser.runtime.sendMessage({ type: MessageType.NIP07_PROBE }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    identityEl.classList.remove('checking');

    if (result && typeof result === 'object' && 'pubkey' in result && result.pubkey) {
      const hex = result.pubkey as string;
      identityEl.textContent = hex.length > 16
        ? `${hex.slice(0, 8)}\u2026${hex.slice(-8)}`
        : hex;
      identityEl.title = hex;
    } else {
      showIdentityFallback();
    }
  } catch {
    showIdentityFallback();
  }
}

function showIdentityFallback() {
  identityEl.classList.remove('checking');
  identityEl.classList.add('error');
  identityEl.textContent = 'Detected from your NIP-07 signer when recording.';
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

btnSave.addEventListener('click', async () => {
  const servers = serversEl.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const relays = relaysEl.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  btnSave.disabled = true;
  btnSave.textContent = 'Saving\u2026';

  await saveSettings({
    blossomServers: servers,
    nostrRelays: relays,
    publishToNostr: publishToggle.checked,
  });

  btnSave.disabled = false;
  btnSave.textContent = 'Save';

  if (saveTimeout) clearTimeout(saveTimeout);
  saveStatus.textContent = 'Saved';
  saveStatus.classList.add('visible');
  saveTimeout = setTimeout(() => {
    saveStatus.classList.remove('visible');
  }, 2000);
});

loadSettings();
detectIdentity();
