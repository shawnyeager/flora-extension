import { MessageType } from '@/utils/messages';
import { PROTECTED_STATES, type ExtensionState } from '@/utils/state';
import type { SharingMode } from '@/utils/settings';
import { decode } from 'nostr-tools/nip19';

// --- Element refs ---
const settingsLink = document.getElementById('settings-link') as HTMLAnchorElement;

// Preview view
const viewPreview = document.getElementById('view-preview') as HTMLDivElement;
const previewVideo = document.getElementById('preview-video') as HTMLVideoElement;
const previewMeta = document.getElementById('preview-meta') as HTMLDivElement;
const destServer = document.getElementById('dest-server') as HTMLDivElement;
const destServerUnlisted = document.getElementById('dest-server-unlisted') as HTMLDivElement;
const destRelays = document.getElementById('dest-relays') as HTMLDivElement;
const relaySection = document.getElementById('relay-section') as HTMLDivElement;
const destIdentity = document.getElementById('dest-identity') as HTMLDivElement;
const signerWarning = document.getElementById('signer-warning') as HTMLDivElement;
const btnUpload = document.getElementById('btn-upload') as HTMLButtonElement;
const btnDownload = document.getElementById('btn-download') as HTMLButtonElement;
const btnDiscard = document.getElementById('btn-discard') as HTMLButtonElement;

// Sharing mode
const sharingModePicker = document.getElementById('sharing-mode-picker') as HTMLDivElement;
const publicOptions = document.getElementById('public-options') as HTMLDivElement;
const unlistedOptions = document.getElementById('unlisted-options') as HTMLDivElement;
const privateOptions = document.getElementById('private-options') as HTMLDivElement;
const recipientInput = document.getElementById('recipient-input') as HTMLInputElement;
const recipientChips = document.getElementById('recipient-chips') as HTMLDivElement;
const recipientDropdown = document.getElementById('recipient-dropdown') as HTMLDivElement;

// Progress view
const viewProgress = document.getElementById('view-progress') as HTMLDivElement;
const progressStatus = document.getElementById('progress-status') as HTMLDivElement;
const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
const progressDetail = document.getElementById('progress-detail') as HTMLDivElement;

// Complete view
const viewComplete = document.getElementById('view-complete') as HTMLDivElement;
const completeTitle = document.getElementById('complete-title') as HTMLDivElement;
const completeRecipients = document.getElementById('complete-recipients') as HTMLDivElement;
const resultLink = document.getElementById('result-link') as HTMLAnchorElement;
const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement;
const btnNew = document.getElementById('btn-new') as HTMLButtonElement;

// Error view
const viewError = document.getElementById('view-error') as HTMLDivElement;
const errorMessage = document.getElementById('error-message') as HTMLDivElement;
const btnRetry = document.getElementById('btn-retry') as HTMLButtonElement;
const btnErrorDiscard = document.getElementById('btn-error-discard') as HTMLButtonElement;

let uploadLocked = false;
let videoLoaded = false;

// Sharing mode state
let currentSharingMode: SharingMode = 'public';
let selectedRecipients: Array<{
  pubkey: string;
  name?: string;
  avatar?: string;
  nip05?: string;
  relays?: string[];
  hasDmRelays?: boolean;
}> = [];
let contacts: Array<{ pubkey: string; name?: string; avatar?: string; nip05?: string }> = [];
let contactsLoaded = false;
let contactsLoading = false;
let recentRecipients: Array<{ pubkey: string; name?: string; avatar?: string; nip05?: string }> = [];
let highlightedIndex = -1;
let lastConfirmData: ConfirmData | null = null;

// Warn user before closing tab during protected states
const beforeUnloadHandler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
function updateBeforeUnload(state: ExtensionState) {
  if (PROTECTED_STATES.includes(state)) {
    window.addEventListener('beforeunload', beforeUnloadHandler);
  } else {
    window.removeEventListener('beforeunload', beforeUnloadHandler);
  }
}

// --- Helpers ---

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function truncateKey(hex: string): string {
  if (hex.length <= 16) return hex;
  return `${hex.slice(0, 8)}\u2026${hex.slice(-8)}`;
}

// --- Views ---

const views = [viewPreview, viewProgress, viewComplete, viewError];

function showView(view: HTMLDivElement) {
  for (const v of views) v.style.display = v === view ? 'flex' : 'none';
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bloom-recordings', 2); // legacy name — do not rename (data loss)
    req.onupgradeneeded = (event) => {
      const db = req.result;
      let store: IDBObjectStore;
      if (!db.objectStoreNames.contains('recordings')) {
        store = db.createObjectStore('recordings', { keyPath: 'hash' });
      } else {
        store = (event.target as IDBOpenDBRequest).transaction!.objectStore('recordings');
      }
      if (!store.indexNames.contains('by_timestamp')) {
        store.createIndex('by_timestamp', 'timestamp');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let videoBlobUrl: string | null = null;

async function loadVideo() {
  if (videoLoaded) return;
  try {
    const db = await openDB();
    const tx = db.transaction('recordings', 'readonly');
    const store = tx.objectStore('recordings');
    const index = store.index('by_timestamp');

    const record = await new Promise<any>((resolve) => {
      const req = index.openCursor(null, 'prev');
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => resolve(null);
    });
    db.close();

    if (record?.data) {
      videoBlobUrl = URL.createObjectURL(new Blob([record.data], { type: 'video/mp4' }));
      previewVideo.style.visibility = 'hidden';
      await new Promise<void>((resolve) => {
        previewVideo.onloadeddata = () => {
          previewVideo.style.visibility = 'visible';
          resolve();
        };
        previewVideo.onerror = () => {
          previewVideo.style.visibility = 'visible';
          resolve();
        };
        previewVideo.src = videoBlobUrl!;
      });
      videoLoaded = true;
    }
  } catch (err) {
    console.error('[review] failed to load video from IndexedDB:', err);
  }
}

interface ConfirmData {
  npub: string | null;
  signerAvailable: boolean;
  bridgeError: string | null;
  server: string;
  relays: string[];
  publishToNostr: boolean;
  fileSize: number;
  duration: number;
  defaultSharingMode: string;
  nip44Supported: boolean;
}

async function getConfirmData(): Promise<ConfirmData | null> {
  return browser.runtime.sendMessage({ type: MessageType.GET_CONFIRM_DATA });
}

// --- Sharing mode ---

function setSharingMode(mode: SharingMode) {
  currentSharingMode = mode;
  sharingModePicker.querySelectorAll('.sharing-mode-btn').forEach((btn) => {
    const isActive = (btn as HTMLElement).dataset.mode === mode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-checked', String(isActive));
  });
  publicOptions.style.display = mode === 'public' ? '' : 'none';
  unlistedOptions.style.display = mode === 'unlisted' ? '' : 'none';
  privateOptions.style.display = mode === 'private' ? '' : 'none';
  updateUploadButton();
}

function updateUploadButton() {
  if (currentSharingMode === 'private') {
    btnUpload.disabled = selectedRecipients.length === 0;
    btnUpload.textContent = selectedRecipients.length === 0
      ? 'Add recipients'
      : `Send privately to ${selectedRecipients.length}`;
  } else {
    btnUpload.disabled = false;
    btnUpload.textContent = currentSharingMode === 'unlisted' ? 'Upload' : 'Upload & Publish';
  }
}

sharingModePicker.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.sharing-mode-btn') as HTMLElement;
  if (!btn?.dataset.mode) return;
  const mode = btn.dataset.mode as SharingMode;
  if (mode === 'private') {
    if (lastConfirmData && !lastConfirmData.nip44Supported) {
      signerWarning.textContent = 'Your signer extension does not support NIP-44 encryption. Update it or switch to nos2x/Alby.';
      signerWarning.style.display = 'block';
      return;
    }
    if (!contactsLoaded && !contactsLoading) loadContacts();
  }
  signerWarning.style.display = 'none';
  setSharingMode(mode);
});

// --- Contact loading ---

async function loadContacts() {
  if (contactsLoading) return;
  contactsLoading = true;
  try {
    const response = await browser.runtime.sendMessage({ type: MessageType.FETCH_CONTACTS });
    contacts = response?.contacts || [];
    contactsLoaded = true;
    if (document.activeElement === recipientInput) {
      renderDropdown(recipientInput.value);
    }
  } catch (err) {
    console.error('[review] failed to load contacts:', err);
  } finally {
    contactsLoading = false;
  }

  try {
    const stored = await browser.storage.local.get('recentRecipients');
    recentRecipients = (stored as any).recentRecipients || [];
  } catch { /* ignore */ }
}

// --- Recipient rendering ---

function renderChips() {
  while (recipientChips.firstChild) recipientChips.removeChild(recipientChips.firstChild);
  for (const r of selectedRecipients) {
    const chip = document.createElement('div');
    chip.className = 'recipient-chip';

    if (r.avatar) {
      const img = document.createElement('img');
      img.src = r.avatar;
      img.alt = '';
      img.onerror = () => {
        const ph = document.createElement('div');
        ph.className = 'chip-avatar-placeholder';
        ph.textContent = (r.name || r.pubkey)?.[0]?.toUpperCase() || '?';
        img.replaceWith(ph);
      };
      chip.append(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'chip-avatar-placeholder';
      ph.textContent = (r.name || r.pubkey)?.[0]?.toUpperCase() || '?';
      chip.append(ph);
    }

    const name = document.createElement('span');
    name.textContent = r.name || truncateKey(r.pubkey);
    chip.append(name);

    if (r.hasDmRelays === false) {
      const warn = document.createElement('span');
      warn.className = 'chip-warning';
      warn.textContent = '\u26a0';
      warn.title = 'No DM relays found \u2014 may not receive';
      warn.setAttribute('aria-label', `Warning: ${r.name || truncateKey(r.pubkey)} has no DM relays`);
      chip.append(warn);
    }

    const remove = document.createElement('button');
    remove.className = 'chip-remove';
    remove.textContent = '\u00d7';
    remove.setAttribute('aria-label', `Remove ${r.name || truncateKey(r.pubkey)}`);
    remove.addEventListener('click', () => {
      selectedRecipients = selectedRecipients.filter((s) => s.pubkey !== r.pubkey);
      renderChips();
      updateUploadButton();
    });
    chip.append(remove);

    recipientChips.append(chip);
  }
}

function renderDropdown(query: string) {
  while (recipientDropdown.firstChild) recipientDropdown.removeChild(recipientDropdown.firstChild);
  highlightedIndex = -1;

  const q = query.toLowerCase().trim();
  let matches: typeof contacts;

  if (!q) {
    matches = recentRecipients
      .filter((r) => !selectedRecipients.some((s) => s.pubkey === r.pubkey))
      .slice(0, 5);
  } else {
    if (!contactsLoaded && contactsLoading) {
      const placeholder = document.createElement('div');
      placeholder.className = 'recipient-option';
      placeholder.textContent = 'Loading contacts\u2026';
      recipientDropdown.append(placeholder);
      recipientDropdown.style.display = 'block';
      return;
    }
    matches = contacts.filter((c) => {
      if (selectedRecipients.some((s) => s.pubkey === c.pubkey)) return false;
      return (
        c.name?.toLowerCase().includes(q) ||
        c.nip05?.toLowerCase().includes(q) ||
        c.pubkey.startsWith(q)
      );
    }).slice(0, 8);
  }

  if (matches.length === 0) {
    recipientDropdown.style.display = 'none';
    return;
  }

  for (const contact of matches) {
    const opt = document.createElement('div');
    opt.className = 'recipient-option';
    opt.setAttribute('role', 'option');

    if (contact.avatar) {
      const img = document.createElement('img');
      img.src = contact.avatar;
      img.alt = '';
      img.onerror = () => {
        const ph = document.createElement('div');
        ph.className = 'chip-avatar-placeholder';
        ph.textContent = (contact.name || contact.pubkey)?.[0]?.toUpperCase() || '?';
        img.replaceWith(ph);
      };
      opt.append(img);
    }

    const info = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'option-name';
    nameEl.textContent = contact.name || truncateKey(contact.pubkey);
    info.append(nameEl);
    if (contact.nip05) {
      const nip05El = document.createElement('div');
      nip05El.className = 'option-nip05';
      nip05El.textContent = contact.nip05;
      info.append(nip05El);
    }
    opt.append(info);

    opt.addEventListener('click', () => selectRecipient(contact));
    recipientDropdown.append(opt);
  }

  recipientDropdown.style.display = 'block';
}

// --- Recipient selection ---

async function selectRecipient(contact: { pubkey: string; name?: string; avatar?: string; nip05?: string }) {
  if (selectedRecipients.some((r) => r.pubkey === contact.pubkey)) return;

  const recipient = {
    ...contact,
    relays: undefined as string[] | undefined,
    hasDmRelays: undefined as boolean | undefined,
  };
  selectedRecipients.push(recipient);
  recipientInput.value = '';
  recipientDropdown.style.display = 'none';
  renderChips();
  updateUploadButton();
  recipientInput.focus();

  const modeAtStart = currentSharingMode;
  try {
    const relayResult = await browser.runtime.sendMessage({
      type: MessageType.FETCH_DM_RELAYS,
      pubkey: contact.pubkey,
    });
    const still = selectedRecipients.find((r) => r.pubkey === contact.pubkey);
    if (!still || currentSharingMode !== modeAtStart) return;
    const relays = relayResult?.relays || [];
    still.relays = relays;
    still.hasDmRelays = relays.length > 0;
    renderChips();
  } catch { /* leave relay status unknown */ }
}

async function handleDirectInput(value: string) {
  const trimmed = value.trim();
  const modeAtStart = currentSharingMode;

  if (trimmed.startsWith('npub1')) {
    try {
      const decoded = decode(trimmed);
      if (decoded.type === 'npub') {
        const pubkey = decoded.data as string;
        const existing = contacts.find((c) => c.pubkey === pubkey);
        if (currentSharingMode === modeAtStart) {
          await selectRecipient(existing || { pubkey });
        }
        return true;
      }
    } catch {
      showInputError('Invalid npub');
      return false;
    }
  }

  if (trimmed.includes('@')) {
    try {
      const result = await browser.runtime.sendMessage({
        type: MessageType.RESOLVE_NIP05,
        identifier: trimmed,
      });
      if (currentSharingMode !== modeAtStart) return false;
      if (result?.pubkey) {
        const existing = contacts.find((c) => c.pubkey === result.pubkey);
        await selectRecipient(existing || { pubkey: result.pubkey, nip05: trimmed });
        return true;
      }
    } catch { /* ignore */ }
    showInputError('Could not resolve NIP-05');
    return false;
  }

  if (/^[0-9a-f]{64}$/.test(trimmed)) {
    const existing = contacts.find((c) => c.pubkey === trimmed);
    if (currentSharingMode === modeAtStart) {
      await selectRecipient(existing || { pubkey: trimmed });
    }
    return true;
  }

  return false;
}

function showInputError(msg: string) {
  recipientInput.style.borderColor = '#ef4444';
  let errorEl = document.getElementById('recipient-error');
  if (!errorEl) {
    errorEl = document.createElement('div');
    errorEl.id = 'recipient-error';
    errorEl.setAttribute('aria-live', 'assertive');
    errorEl.style.color = '#ef4444';
    errorEl.style.fontSize = '12px';
    errorEl.style.marginTop = '4px';
    recipientInput.parentElement?.append(errorEl);
  }
  errorEl.textContent = msg;
  setTimeout(() => {
    recipientInput.style.borderColor = '';
    if (errorEl) errorEl.textContent = '';
  }, 2000);
}

// --- Recipient input event handlers ---

recipientInput.addEventListener('input', () => {
  renderDropdown(recipientInput.value);
});

recipientInput.addEventListener('focus', () => {
  renderDropdown(recipientInput.value);
});

recipientInput.addEventListener('blur', () => {
  recipientDropdown.style.display = 'none';
});

recipientDropdown.addEventListener('mousedown', (e) => {
  e.preventDefault();
});

recipientInput.addEventListener('keydown', async (e) => {
  const options = recipientDropdown.querySelectorAll('.recipient-option');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlightedIndex = Math.min(highlightedIndex + 1, options.length - 1);
    options.forEach((o, i) => o.classList.toggle('highlighted', i === highlightedIndex));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlightedIndex = Math.max(highlightedIndex - 1, 0);
    options.forEach((o, i) => o.classList.toggle('highlighted', i === highlightedIndex));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (highlightedIndex >= 0 && options[highlightedIndex]) {
      (options[highlightedIndex] as HTMLElement).click();
    } else if (recipientInput.value.trim()) {
      await handleDirectInput(recipientInput.value);
    }
  } else if (e.key === 'Escape') {
    recipientDropdown.style.display = 'none';
  }
});

// --- Preview ---

async function showPreview() {
  await loadVideo();
  showView(viewPreview);

  const data = await getConfirmData();
  if (!data) return;
  lastConfirmData = data;

  const parts: string[] = [];
  if (data.fileSize) parts.push(formatBytes(data.fileSize));
  if (data.duration) parts.push(formatDuration(data.duration));
  previewMeta.textContent = parts.join(' \u00b7 ');

  // Populate server and relay info
  destServer.textContent = data.server || 'Not configured';
  destServerUnlisted.textContent = data.server || 'Not configured';

  if (data.relays?.length) {
    relaySection.style.display = 'flex';
    destRelays.textContent = data.relays.join(', ');
  } else {
    relaySection.style.display = 'none';
  }

  // Initialize sharing mode
  const defaultMode = (data.defaultSharingMode || (data.publishToNostr ? 'public' : 'unlisted')) as SharingMode;
  setSharingMode(defaultMode);

  renderSignerStatus(data, destIdentity, signerWarning, btnUpload);

  // Reset recipient state
  selectedRecipients = [];
  renderChips();

  uploadLocked = false;
  updateUploadButton();
}

function renderSignerStatus(
  data: ConfirmData,
  identityEl: HTMLElement,
  warningEl: HTMLElement,
  actionBtn: HTMLButtonElement,
) {
  warningEl.style.display = 'none';

  const identityField = identityEl.closest('.field') as HTMLElement | null;
  if (data.npub) {
    identityEl.textContent = truncateKey(data.npub);
    if (identityField) identityField.style.display = '';
  } else {
    identityEl.textContent = '';
    if (identityField) identityField.style.display = 'none';
  }

  if (data.signerAvailable) {
    actionBtn.disabled = false;
  } else {
    while (warningEl.firstChild) warningEl.firstChild.remove();

    const msg = document.createElement('div');
    msg.textContent = `Signer: ${data.bridgeError || 'Not detected'}`;
    warningEl.append(msg);

    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn-ghost';
    retryBtn.textContent = 'Retry signer detection';
    retryBtn.style.marginTop = '8px';
    retryBtn.addEventListener('click', async () => {
      retryBtn.textContent = 'Checking\u2026';
      retryBtn.disabled = true;
      const freshData = await getConfirmData();
      if (freshData) {
        lastConfirmData = freshData;
        renderSignerStatus(freshData, identityEl, warningEl, actionBtn);
      } else {
        retryBtn.textContent = 'Retry signer detection';
        retryBtn.disabled = false;
      }
    });
    warningEl.append(retryBtn);

    warningEl.style.display = 'block';
    actionBtn.disabled = currentSharingMode !== 'unlisted';
  }
}

// --- Event handlers ---

settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  browser.tabs.create({ url: browser.runtime.getURL('/settings.html') });
});

// Upload & Share — directly triggers upload with selected sharing mode (no confirm screen)
btnUpload.addEventListener('click', async () => {
  if (uploadLocked) return;
  uploadLocked = true;
  btnUpload.disabled = true;
  btnUpload.textContent = currentSharingMode === 'private' ? 'Encrypting\u2026' : 'Uploading\u2026';

  // Save recent recipients for private mode
  if (currentSharingMode === 'private' && selectedRecipients.length) {
    const recent = selectedRecipients.map((r) => ({
      pubkey: r.pubkey, name: r.name, avatar: r.avatar, nip05: r.nip05,
    }));
    try {
      const stored = await browser.storage.local.get('recentRecipients');
      const existing: any[] = (stored as any).recentRecipients || [];
      const merged = [...recent, ...existing.filter((e: any) => !recent.some((r) => r.pubkey === e.pubkey))].slice(0, 20);
      await browser.storage.local.set({ recentRecipients: merged });
    } catch { /* ignore storage errors */ }
  }

  await browser.runtime.sendMessage({
    type: MessageType.CONFIRM_UPLOAD,
    publishToNostr: currentSharingMode === 'public',
    sharingMode: currentSharingMode,
    recipients: currentSharingMode === 'private'
      ? selectedRecipients.map((r) => ({ pubkey: r.pubkey, name: r.name, relays: r.relays }))
      : undefined,
  });
});

btnDownload.addEventListener('click', async () => {
  btnDownload.textContent = 'Preparing\u2026';
  btnDownload.disabled = true;
  try {
    if (!videoBlobUrl) await loadVideo();
    if (videoBlobUrl) {
      const a = document.createElement('a');
      a.href = videoBlobUrl;
      a.download = `flora-${Date.now()}.mp4`;
      a.click();
    }
  } catch (err) {
    console.error('Download failed:', err);
  } finally {
    btnDownload.textContent = 'Save to device';
    btnDownload.disabled = false;
  }
});

btnDiscard.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
  window.close();
});

btnCopy.addEventListener('click', async () => {
  const result = await browser.runtime.sendMessage({ type: MessageType.GET_RESULT });
  const url = result?.publishResult?.blossomUrl || result?.uploadResult?.url;
  if (url) {
    await navigator.clipboard.writeText(url);
    btnCopy.textContent = 'Copied!';
    setTimeout(() => { btnCopy.textContent = 'Copy Link'; }, 2000);
  }
});

btnNew.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
  window.close();
});

btnRetry.addEventListener('click', async () => {
  await browser.runtime.sendMessage({
    type: MessageType.CONFIRM_UPLOAD,
    publishToNostr: currentSharingMode === 'public',
    sharingMode: currentSharingMode,
    recipients: currentSharingMode === 'private'
      ? selectedRecipients.map((r) => ({ pubkey: r.pubkey, name: r.name, relays: r.relays }))
      : undefined,
  });
});

btnErrorDiscard.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: MessageType.RESET_STATE });
  window.close();
});

// --- State listener ---

browser.runtime.onMessage.addListener((message) => {
  if (message.type === MessageType.STATE_CHANGED) {
    updateUI(message.state);
  }
  if (message.type === MessageType.UPLOAD_PROGRESS) {
    const pct = Math.round((message.bytesUploaded / message.totalBytes) * 100);
    progressBar.style.width = `${pct}%`;
    progressDetail.textContent = `${formatBytes(message.bytesUploaded)} / ${formatBytes(message.totalBytes)} to ${message.serverName}`;
  }
});

async function updateUI(state: ExtensionState) {
  updateBeforeUnload(state);
  switch (state) {
    case 'preview':
      await showPreview();
      break;
    case 'confirming':
      // No separate confirm screen — preview handles everything now.
      // If we get here (e.g., from old state), just show preview.
      await showPreview();
      break;
    case 'uploading':
      showView(viewProgress);
      progressStatus.textContent = 'Uploading\u2026';
      progressBar.style.width = '0%';
      progressDetail.textContent = '';
      break;
    case 'publishing':
      showView(viewProgress);
      progressStatus.textContent = 'Publishing to Nostr\u2026';
      progressBar.style.width = '100%';
      progressDetail.textContent = '';
      break;
    case 'complete': {
      showView(viewComplete);
      const result = await browser.runtime.sendMessage({ type: MessageType.GET_RESULT });

      if (result?.sharingMode === 'private') {
        completeTitle.textContent = 'Sent privately';
        resultLink.style.display = 'none';
        btnCopy.style.display = 'none';
        const names = result.recipients?.map((r: any) => r.name || truncateKey(r.pubkey)).join(', ') || '';
        completeRecipients.textContent = 'Delivered to ' + names;
        completeRecipients.style.display = 'block';
      } else {
        completeTitle.textContent = result?.sharingMode === 'unlisted' ? 'Uploaded' : "You're live";
        const url = result?.publishResult?.blossomUrl || result?.uploadResult?.url;
        if (url) {
          resultLink.href = url;
          resultLink.textContent = url;
          resultLink.style.display = 'block';
        }
        btnCopy.style.display = '';
        completeRecipients.style.display = 'none';
      }
      break;
    }
    case 'error': {
      showView(viewError);
      const { error } = await browser.runtime.sendMessage({ type: MessageType.GET_ERROR });
      errorMessage.textContent = error || 'The upload failed.';
      break;
    }
    case 'idle':
      window.close();
      break;
  }
}

// Init: get current state and render
browser.runtime.sendMessage({ type: MessageType.GET_STATE }).then((state) => {
  if (state) updateUI(state as ExtensionState);
});
