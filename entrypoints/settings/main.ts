import { getSettings, saveSettings } from '@/utils/settings';
import { MessageType } from '@/utils/messages';

const serversEl = document.getElementById('servers') as HTMLTextAreaElement;
const relaysEl = document.getElementById('relays') as HTMLTextAreaElement;
const publishToggle = document.getElementById('publish-toggle') as HTMLInputElement;
const identityEl = document.getElementById('identity') as HTMLSpanElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const backBtn = document.getElementById('back') as HTMLAnchorElement;

// --- Navigation ---

backBtn.addEventListener('click', (e) => {
  e.preventDefault();
  // Go to recordings page (settings always opens in a tab)
  window.location.href = browser.runtime.getURL('/recordings.html');
});

// --- Load ---

async function loadSettings() {
  const settings = await getSettings();
  serversEl.value = settings.blossomServers.join('\n');
  relaysEl.value = settings.nostrRelays.join('\n');
  publishToggle.checked = settings.publishToNostr;
}

// --- Identity (inline in header) ---

async function detectIdentity() {
  identityEl.textContent = '';

  try {
    const result = await Promise.race([
      browser.runtime.sendMessage({ type: MessageType.NIP07_PROBE }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);

    if (result && typeof result === 'object' && 'pubkey' in result && result.pubkey) {
      const hex = result.pubkey as string;
      identityEl.textContent = `${hex.slice(0, 8)}…${hex.slice(-8)}`;
      identityEl.title = hex;
    }
  } catch {
    // No signer — just leave identity empty, it hides via :empty
  }
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
    btnSave.textContent = 'Save';
    btnSave.classList.remove('saved');
  }, 1500);
});

loadSettings();
detectIdentity();
