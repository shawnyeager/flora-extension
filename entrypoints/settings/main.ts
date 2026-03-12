import { getSettings, saveSettings } from '@/utils/settings';
import { MessageType } from '@/utils/messages';
import { Icons } from '@/utils/icons';

// --- DOM refs ---

const serverInput = document.getElementById('server-input') as HTMLInputElement;
const serverAddBtn = document.getElementById('server-add') as HTMLButtonElement;
const serverList = document.getElementById('server-list') as HTMLUListElement;

const relayInput = document.getElementById('relay-input') as HTMLInputElement;
const relayAddBtn = document.getElementById('relay-add') as HTMLButtonElement;
const relayList = document.getElementById('relay-list') as HTMLUListElement;

const publishToggle = document.getElementById('publish-toggle') as HTMLInputElement;

const identityDot = document.querySelector('.identity-dot') as HTMLElement;
const identityLabel = document.querySelector('.identity-label') as HTMLElement;
const identityNpub = document.querySelector('.identity-npub') as HTMLElement;
const identityCopy = document.querySelector('.identity-copy') as HTMLButtonElement;

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
document.body.append(toast);

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
) {
  list.replaceChildren();
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
  renderList(serverList, servers, removeServer, 'primary');
}

async function addServer() {
  const value = serverInput.value.trim();
  if (!value) return;

  if (!isValidUrl(value, 'https:')) {
    serverInput.classList.add('invalid');
    serverInput.focus();
    return;
  }

  if (servers.includes(value)) {
    serverInput.value = '';
    return;
  }

  serverInput.classList.remove('invalid');
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
});

// --- Relay management ---

function renderRelays() {
  renderList(relayList, relays, removeRelay);
}

async function addRelay() {
  const value = relayInput.value.trim();
  if (!value) return;

  if (!isValidUrl(value, 'wss:')) {
    relayInput.classList.add('invalid');
    relayInput.focus();
    return;
  }

  if (relays.includes(value)) {
    relayInput.value = '';
    return;
  }

  relayInput.classList.remove('invalid');
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
});

// --- Publish toggle (auto-save) ---

publishToggle.addEventListener('change', async () => {
  await saveSettings({ publishToNostr: publishToggle.checked });
  showSaved();
});

// --- Identity ---

async function detectIdentity() {
  identityLabel.textContent = 'Checking\u2026';
  identityDot.className = 'identity-dot';
  identityNpub.textContent = '';
  identityCopy.hidden = true;

  let result: any;
  try {
    result = await Promise.race([
      browser.runtime.sendMessage({ type: MessageType.NIP07_PROBE }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
  } catch {
    showIdentityMissing();
    return;
  }

  if (result && typeof result === 'object' && 'detected' in result) {
    identityDot.classList.add('connected');
    identityLabel.textContent = 'Signer detected \u2014 your pubkey will be confirmed before signing';
  } else {
    showIdentityMissing();
  }
}

function showIdentityMissing() {
  identityDot.classList.add('missing');
  identityLabel.textContent = 'No signer found \u2014 install nos2x or Alby to sign events';
  identityNpub.textContent = '';
  identityCopy.hidden = true;
}

// --- Load ---

async function load() {
  const settings = await getSettings();
  servers = [...settings.blossomServers];
  relays = [...settings.nostrRelays];
  publishToggle.checked = settings.publishToNostr;
  renderServers();
  renderRelays();
}

load();
detectIdentity();
