import { getSettings, saveSettings } from '@/utils/settings';
import { MessageType } from '@/utils/messages';

const serversEl = document.getElementById('servers') as HTMLTextAreaElement;
const relaysEl = document.getElementById('relays') as HTMLTextAreaElement;
const publishToggle = document.getElementById('publish-toggle') as HTMLInputElement;
const identityEl = document.getElementById('identity') as HTMLDivElement;
const identityValue = identityEl.querySelector('.identity-value') as HTMLSpanElement;
const identityHint = identityEl.querySelector('.identity-hint') as HTMLSpanElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;

// --- Load ---

async function loadSettings() {
  const settings = await getSettings();
  serversEl.value = settings.blossomServers.join('\n');
  relaysEl.value = settings.nostrRelays.join('\n');
  publishToggle.checked = settings.publishToNostr;
}

// --- Identity ---

async function detectIdentity() {
  identityHint.textContent = 'Checking\u2026';
  identityEl.classList.add('checking');

  try {
    const result = await Promise.race([
      browser.runtime.sendMessage({ type: MessageType.NIP07_PROBE }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    identityEl.classList.remove('checking');

    if (result && typeof result === 'object' && 'pubkey' in result && result.pubkey) {
      const hex = result.pubkey as string;
      identityValue.textContent = hex;
      identityValue.title = hex;
      identityHint.textContent = 'Via NIP-07 signer';
    } else {
      showIdentityFallback();
    }
  } catch {
    showIdentityFallback();
  }
}

function showIdentityFallback() {
  identityEl.classList.remove('checking');
  identityValue.textContent = '';
  identityHint.textContent = 'No NIP-07 signer detected. Install nos2x or Alby to sign events.';
}

// --- Save ---

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
  btnSave.textContent = 'Saved';
  btnSave.classList.add('saved');

  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    btnSave.textContent = 'Save settings';
    btnSave.classList.remove('saved');
  }, 1500);
});

loadSettings();
detectIdentity();
