import { getSettings, saveSettings } from '@/utils/settings';
import { MessageType } from '@/utils/messages';
import { Icons } from '@/utils/icons';
import { npubEncode, decode } from 'nostr-tools/nip19';

// --- DOM refs ---

const serverInput = document.getElementById('server-input') as HTMLInputElement;
const serverAddBtn = document.getElementById('server-add') as HTMLButtonElement;
const serverList = document.getElementById('server-list') as HTMLUListElement;

const relayInput = document.getElementById('relay-input') as HTMLInputElement;
const relayAddBtn = document.getElementById('relay-add') as HTMLButtonElement;
const relayList = document.getElementById('relay-list') as HTMLUListElement;

const publishToggle = document.getElementById('publish-toggle') as HTMLInputElement;

const npubInput = document.getElementById('npub-input') as HTMLInputElement;
const npubError = document.getElementById('npub-error') as HTMLDivElement;
const identityDot = document.querySelector('.identity-dot') as HTMLElement;
const identityLabel = document.querySelector('.identity-label') as HTMLElement;

// --- Helpers ---

/** Insert trusted SVG icon from our Icons constants into an element */
function setIcon(el: HTMLElement, svg: string) {
  const tpl = document.createElement('template');
  tpl.innerHTML = svg;  // trusted internal SVG constant from icons.ts
  el.replaceChildren(tpl.content.cloneNode(true));
}

// --- State ---

let servers: string[] = [];
let relays: string[] = [];

// --- Saved toast ---

const toast = document.createElement('div');
toast.className = 'saved-toast';
toast.textContent = 'Saved';
toast.setAttribute('role', 'status');
toast.setAttribute('aria-live', 'polite');
document.body.append(toast);

const serverError = document.getElementById('server-error') as HTMLDivElement;
const relayError = document.getElementById('relay-error') as HTMLDivElement;

let toastTimeout: ReturnType<typeof setTimeout> | null = null;

function showSaved() {
  toast.classList.add('visible');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('visible'), 1200);
}

// --- URL list rendering ---

function renderList(
  list: HTMLUListElement,
  urls: string[],
  onRemove: (index: number) => void,
  badgeLabel?: string,
  emptyText?: string,
) {
  list.replaceChildren();
  if (urls.length === 0 && emptyText) {
    const empty = document.createElement('li');
    empty.className = 'url-empty';
    empty.textContent = emptyText;
    list.append(empty);
    return;
  }
  urls.forEach((url, i) => {
    const li = document.createElement('li');
    li.className = 'url-item';

    const urlSpan = document.createElement('span');
    urlSpan.className = 'url-item-url';
    urlSpan.textContent = url;
    urlSpan.title = url;
    li.append(urlSpan);

    if (i === 0 && badgeLabel && urls.length > 1) {
      const badge = document.createElement('span');
      badge.className = 'url-item-badge';
      badge.textContent = badgeLabel;
      li.append(badge);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'url-item-remove';
    setIcon(removeBtn, Icons.x);
    removeBtn.setAttribute('aria-label', `Remove ${url}`);
    removeBtn.addEventListener('click', () => onRemove(i));
    li.append(removeBtn);

    list.append(li);
  });
}

// --- URL validation ---

function isValidUrl(value: string, protocol: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === protocol;
  } catch {
    return false;
  }
}

// --- Server management ---

function renderServers() {
  renderList(serverList, servers, removeServer, 'primary', 'No servers added yet');
}

async function addServer() {
  const value = serverInput.value.trim();
  if (!value) return;

  if (!isValidUrl(value, 'https:')) {
    serverInput.classList.add('invalid');
    serverError.classList.add('visible');
    serverError.textContent = 'Enter a valid https:// URL';
    serverInput.focus();
    return;
  }

  if (servers.includes(value)) {
    serverInput.value = '';
    serverError.classList.add('visible');
    serverError.textContent = 'Already added';
    setTimeout(() => serverError.classList.remove('visible'), 2000);
    return;
  }

  serverInput.classList.remove('invalid');
  serverError.classList.remove('visible');
  servers.push(value);
  serverInput.value = '';
  renderServers();
  await saveSettings({ blossomServers: servers });
  showSaved();
}

async function removeServer(index: number) {
  servers.splice(index, 1);
  renderServers();
  await saveSettings({ blossomServers: servers });
  showSaved();
}

serverAddBtn.addEventListener('click', addServer);
serverInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addServer();
});
serverInput.addEventListener('input', () => {
  serverInput.classList.remove('invalid');
  serverError.classList.remove('visible');
});

// --- Relay management ---

function renderRelays() {
  renderList(relayList, relays, removeRelay, undefined, 'No relays added yet');
}

async function addRelay() {
  const value = relayInput.value.trim();
  if (!value) return;

  if (!isValidUrl(value, 'wss:')) {
    relayInput.classList.add('invalid');
    relayError.classList.add('visible');
    relayError.textContent = 'Enter a valid wss:// URL';
    relayInput.focus();
    return;
  }

  if (relays.includes(value)) {
    relayInput.value = '';
    relayError.classList.add('visible');
    relayError.textContent = 'Already added';
    setTimeout(() => relayError.classList.remove('visible'), 2000);
    return;
  }

  relayInput.classList.remove('invalid');
  relayError.classList.remove('visible');
  relays.push(value);
  relayInput.value = '';
  renderRelays();
  await saveSettings({ nostrRelays: relays });
  showSaved();
}

async function removeRelay(index: number) {
  relays.splice(index, 1);
  renderRelays();
  await saveSettings({ nostrRelays: relays });
  showSaved();
}

relayAddBtn.addEventListener('click', addRelay);
relayInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addRelay();
});
relayInput.addEventListener('input', () => {
  relayInput.classList.remove('invalid');
  relayError.classList.remove('visible');
});

// --- Publish toggle (auto-save) ---

publishToggle.addEventListener('change', async () => {
  await saveSettings({ publishToNostr: publishToggle.checked });
  showSaved();
});

// --- Identity (npub input + signer detection) ---

/** Parse npub1... or 64-char hex into hex pubkey. Returns null if invalid. */
function parseNpub(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return ''; // empty = clear

  // 64-char hex pubkey
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();

  // npub1... bech32
  if (trimmed.startsWith('npub1')) {
    try {
      const { type, data } = decode(trimmed);
      if (type === 'npub') return data as string;
    } catch { /* invalid bech32 */ }
  }

  return null; // not a valid pubkey
}

let npubSaveTimeout: ReturnType<typeof setTimeout> | null = null;

npubInput.addEventListener('input', () => {
  npubInput.classList.remove('invalid');
  npubError.classList.remove('visible');

  // Debounce save
  if (npubSaveTimeout) clearTimeout(npubSaveTimeout);
  npubSaveTimeout = setTimeout(async () => {
    const hex = parseNpub(npubInput.value);
    if (hex === null) {
      npubInput.classList.add('invalid');
      npubError.textContent = 'Enter a valid npub1... or 64-char hex pubkey';
      npubError.classList.add('visible');
      return;
    }
    await saveSettings({ nostrPubkey: hex });
    if (hex) showSaved();
  }, 400);
});

npubInput.addEventListener('paste', () => {
  // Re-trigger validation immediately on paste
  setTimeout(() => npubInput.dispatchEvent(new Event('input')), 0);
});

async function detectSigner() {
  identityLabel.textContent = 'Checking signer\u2026';
  identityDot.className = 'identity-dot';

  let result: any;
  try {
    result = await Promise.race([
      browser.runtime.sendMessage({ type: MessageType.NIP07_PROBE }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {
    showSignerMissing();
    return;
  }

  if (result && typeof result === 'object' && 'detected' in result) {
    identityDot.classList.add('connected');
    identityLabel.textContent = 'NIP-07 signer detected';
  } else {
    showSignerMissing();
  }
}

function showSignerMissing() {
  identityDot.classList.add('missing');
  identityLabel.textContent = 'No signer found \u2014 install nos2x or Alby to sign events';
}

// --- Load ---

async function load() {
  const settings = await getSettings();
  servers = [...settings.blossomServers];
  relays = [...settings.nostrRelays];
  publishToggle.checked = settings.publishToNostr;
  renderServers();
  renderRelays();

  // Show stored pubkey as npub1... in the input
  if (settings.nostrPubkey) {
    try {
      npubInput.value = npubEncode(settings.nostrPubkey);
    } catch {
      npubInput.value = settings.nostrPubkey;
    }
  }
}

load();
detectSigner();

// Dynamic version from manifest
document.getElementById('about-version')!.textContent = `Flora v${browser.runtime.getManifest().version}`;
