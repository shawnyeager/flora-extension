import { MessageType, type RecordingMeta } from '@/utils/messages';
import { Icons } from '@/utils/icons';
import type { ExtensionState } from '@/utils/state';

// --- DOM refs ---

const gridEl = document.getElementById('grid')!;
const emptyEl = document.getElementById('empty')!;
const countEl = document.getElementById('count')!;
const noticeEl = document.getElementById('notice')!;
const noticeDot = noticeEl.querySelector('.notice-dot') as HTMLElement;
const noticeText = noticeEl.querySelector('.notice-text') as HTMLElement;
const bulkBar = document.getElementById('bulk-bar')!;
const bulkCount = document.getElementById('bulk-count')!;
const bulkDeleteBtn = document.getElementById('bulk-delete')!;
const bulkCancelBtn = document.getElementById('bulk-cancel')!;
const playerOverlay = document.getElementById('player')!;
const playerVideo = document.getElementById('player-video') as HTMLVideoElement;
const playerClose = document.getElementById('player-close')!;
const playerBackdrop = playerOverlay.querySelector('.player-backdrop')!;

// --- State ---

let currentState: ExtensionState = 'idle';
let recordings: RecordingMeta[] = [];
const selected = new Set<string>();

// --- Helpers ---

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(ts);
  if (d.getFullYear() === new Date().getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// --- Selection ---

function isSelecting(): boolean {
  return selected.size > 0;
}

function updateSelectionUI() {
  const selecting = isSelecting();
  gridEl.classList.toggle('selecting', selecting);
  bulkBar.classList.toggle('visible', selecting);
  bulkCount.textContent = `${selected.size} selected`;

  // Update each card's selected state
  gridEl.querySelectorAll('.rec-card').forEach((card) => {
    const hash = (card as HTMLElement).dataset.hash!;
    const isSelected = selected.has(hash);
    card.classList.toggle('selected', isSelected);
    const check = card.querySelector('.rec-check') as HTMLElement;
    if (check) check.classList.toggle('checked', isSelected);
  });
}

function toggleSelect(hash: string) {
  if (selected.has(hash)) {
    selected.delete(hash);
  } else {
    selected.add(hash);
  }
  updateSelectionUI();
}

function clearSelection() {
  selected.clear();
  updateSelectionUI();
}

// --- Video player ---

async function openPlayer(hash: string) {
  playerOverlay.hidden = false;
  playerVideo.src = '';
  playerVideo.poster = '';

  // Show thumbnail as poster while loading
  const rec = recordings.find((r) => r.hash === hash);
  if (rec?.thumbnail) playerVideo.poster = rec.thumbnail;

  const result = await browser.runtime.sendMessage({
    type: MessageType.GET_RECORDING_BY_HASH,
    hash,
  });
  if (result?.dataUrl) {
    playerVideo.src = result.dataUrl;
    playerVideo.play();
  }
}

function closePlayer() {
  playerOverlay.hidden = true;
  playerVideo.pause();
  playerVideo.removeAttribute('src');
  playerVideo.load();
}

playerClose.addEventListener('click', closePlayer);
playerBackdrop.addEventListener('click', closePlayer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !playerOverlay.hidden) closePlayer();
});

// --- Status notice ---

const STATE_LABELS: Record<ExtensionState, string> = {
  idle: '',
  initializing: 'Starting\u2026',
  awaiting_media: 'Picking a screen\u2026',
  countdown: 'Get ready\u2026',
  recording: 'Recording in progress',
  finalizing: 'Wrapping up\u2026',
  preview: 'Review your clip',
  confirming: 'Almost there\u2026',
  uploading: 'Uploading\u2026',
  publishing: 'Publishing\u2026',
  complete: '',
  error: 'Upload failed',
};

const RECORDING_STATES: ExtensionState[] = ['recording'];
const ACTIVE_STATES: ExtensionState[] = ['initializing', 'awaiting_media', 'countdown', 'finalizing', 'uploading', 'publishing', 'confirming'];

async function updateStatus(state: ExtensionState) {
  currentState = state;
  let label = STATE_LABELS[state];

  if (state === 'error') {
    try {
      const { error } = await browser.runtime.sendMessage({ type: MessageType.GET_ERROR });
      if (error) label = error;
    } catch {}
  }

  if (!label) {
    noticeEl.hidden = true;
  } else {
    noticeEl.hidden = false;
    noticeDot.className = 'notice-dot';
    if (RECORDING_STATES.includes(state)) noticeDot.classList.add('recording');
    else if (ACTIVE_STATES.includes(state)) noticeDot.classList.add('active');
    else if (state === 'error') noticeDot.classList.add('error');
    noticeText.textContent = label;
  }
}

// --- Thumbnail lazy generation ---

async function ensureThumbnail(rec: RecordingMeta, imgEl: HTMLImageElement) {
  if (rec.thumbnail) {
    imgEl.src = rec.thumbnail;
    return;
  }
  // Request background to generate thumbnail
  try {
    const result = await browser.runtime.sendMessage({
      type: MessageType.GENERATE_THUMBNAIL,
      hash: rec.hash,
    });
    if (result?.thumbnail) {
      imgEl.src = result.thumbnail;
      rec.thumbnail = result.thumbnail;
    }
  } catch {
    // Thumbnail generation failed, placeholder stays
  }
}

// --- Card rendering ---

const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

const PLACEHOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';

function createCard(rec: RecordingMeta, index: number): HTMLElement {
  const card = document.createElement('div');
  card.className = 'rec-card';
  card.dataset.hash = rec.hash;
  card.style.setProperty('--i', String(index));

  // --- Thumbnail wrapper ---
  const thumb = document.createElement('div');
  thumb.className = 'rec-thumb';

  // Checkbox (Google Photos style)
  const check = document.createElement('button');
  check.className = 'rec-check';
  check.innerHTML = CHECK_SVG;
  check.setAttribute('aria-label', 'Select');
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSelect(rec.hash);
  });
  thumb.append(check);

  // Image or placeholder
  if (rec.thumbnail) {
    const img = document.createElement('img');
    img.src = rec.thumbnail;
    img.alt = `Recording ${fmtDuration(rec.duration)}`;
    img.loading = 'lazy';
    thumb.append(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'rec-thumb-placeholder';
    placeholder.innerHTML = PLACEHOLDER_SVG;
    thumb.append(placeholder);

    // Lazy generate
    const img = document.createElement('img');
    img.alt = `Recording ${fmtDuration(rec.duration)}`;
    img.style.display = 'none';
    thumb.append(img);
    ensureThumbnail(rec, img).then(() => {
      if (img.src) {
        placeholder.remove();
        img.style.display = '';
      }
    });
  }

  // Play button overlay
  const playIcon = document.createElement('div');
  playIcon.className = 'rec-play';
  playIcon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="8 5 19 12 8 19"/></svg>';
  thumb.append(playIcon);

  // Duration overlay
  const dur = document.createElement('span');
  dur.className = 'rec-duration';
  dur.textContent = fmtDuration(rec.duration);
  thumb.append(dur);

  // Uploaded indicator
  if (rec.uploaded) {
    const badge = document.createElement('span');
    badge.className = 'rec-uploaded-badge';
    badge.textContent = 'Shared';
    thumb.append(badge);
  }

  // Click thumbnail to play or toggle selection
  thumb.addEventListener('click', () => {
    if (isSelecting()) {
      toggleSelect(rec.hash);
    } else {
      openPlayer(rec.hash);
    }
  });

  card.append(thumb);

  // --- Metadata row ---
  const meta = document.createElement('div');
  meta.className = 'rec-meta';

  const info = document.createElement('span');
  info.className = 'rec-meta-info';

  const time = fmtRelative(rec.timestamp);
  const size = fmtBytes(rec.size);
  info.textContent = `${time} \u00b7 ${size}`;
  meta.append(info);

  // Action buttons (visible on hover)
  const actions = document.createElement('div');
  actions.className = 'rec-actions';

  // Primary: Upload or Copy URL
  if (rec.uploaded && rec.blossomUrl) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'rec-btn rec-btn-text';
    copyBtn.textContent = 'Copy URL';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(rec.blossomUrl!);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy URL'; }, 1500);
    });
    actions.append(copyBtn);
  } else {
    const upBtn = document.createElement('button');
    upBtn.className = 'rec-btn rec-btn-text btn-upload';
    upBtn.textContent = 'Upload';
    upBtn.disabled = currentState !== 'idle';
    upBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const resp = await browser.runtime.sendMessage({
        type: MessageType.UPLOAD_FROM_LIBRARY,
        hash: rec.hash,
        publishToNostr: false,
      });
      if (!resp?.ok) {
        upBtn.textContent = 'Not now';
        setTimeout(() => { upBtn.textContent = 'Upload'; }, 1500);
      }
    });
    actions.append(upBtn);
  }

  // Download
  const dlBtn = document.createElement('button');
  dlBtn.className = 'rec-btn rec-btn-icon';
  dlBtn.innerHTML = Icons.download;
  dlBtn.title = 'Download';
  dlBtn.setAttribute('aria-label', 'Download');
  dlBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    dlBtn.style.opacity = '0.3';
    try {
      const result = await browser.runtime.sendMessage({
        type: MessageType.GET_RECORDING_BY_HASH,
        hash: rec.hash,
      });
      if (result?.dataUrl) {
        const a = document.createElement('a');
        a.href = result.dataUrl;
        a.download = `bloom-${rec.timestamp}.mp4`;
        a.click();
      }
    } finally {
      dlBtn.style.opacity = '';
    }
  });
  actions.append(dlBtn);

  // Delete
  const delBtn = document.createElement('button');
  delBtn.className = 'rec-btn rec-btn-icon danger';
  delBtn.innerHTML = Icons.trash;
  delBtn.title = 'Delete';
  delBtn.setAttribute('aria-label', 'Delete');
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this recording? You can\u2019t undo this.')) return;
    await browser.runtime.sendMessage({
      type: MessageType.DELETE_RECORDING,
      hash: rec.hash,
    });
    await loadRecordings();
  });
  actions.append(delBtn);

  meta.append(actions);
  card.append(meta);

  return card;
}

// --- Date grouping ---

function getDateGroup(ts: number): string {
  const now = new Date();
  const date = new Date(ts);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  if (ts >= today.getTime()) return 'Today';
  if (ts >= yesterday.getTime()) return 'Yesterday';
  if (ts >= weekAgo.getTime()) return 'This week';
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'long' });
  }
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// --- Render ---

function renderGrid(recs: RecordingMeta[]) {
  recordings = recs;

  while (gridEl.firstChild) gridEl.firstChild.remove();

  const hasItems = recs.length > 0;
  emptyEl.hidden = hasItems;
  countEl.textContent = hasItems ? String(recs.length) : '';

  // Prune stale selections
  for (const hash of selected) {
    if (!recs.find((r) => r.hash === hash)) selected.delete(hash);
  }

  let lastGroup = '';
  for (let i = 0; i < recs.length; i++) {
    // Date group separator
    const group = getDateGroup(recs[i].timestamp);
    if (group !== lastGroup) {
      const sep = document.createElement('div');
      sep.className = 'date-group';
      sep.textContent = group;
      gridEl.append(sep);
      lastGroup = group;
    }

    const card = createCard(recs[i], i);
    // First recording is hero (spans full width)
    if (i === 0) card.classList.add('hero');
    gridEl.append(card);
  }

  updateSelectionUI();

  // Disable upload buttons if not idle
  gridEl.querySelectorAll('.btn-upload').forEach((btn) => {
    (btn as HTMLButtonElement).disabled = currentState !== 'idle';
  });
}

async function loadRecordings() {
  const result = await browser.runtime.sendMessage({ type: MessageType.LIST_RECORDINGS });
  renderGrid(result || []);
}

// --- Bulk actions ---

bulkDeleteBtn.addEventListener('click', async () => {
  const hashes = [...selected];
  if (hashes.length === 0) return;

  const count = hashes.length;
  const noun = count === 1 ? 'recording' : 'recordings';
  if (!confirm(`Delete ${count} ${noun}? You can\u2019t undo this.`)) return;

  await browser.runtime.sendMessage({
    type: MessageType.DELETE_RECORDINGS,
    hashes,
  });

  clearSelection();
  await loadRecordings();
});

bulkCancelBtn.addEventListener('click', () => {
  clearSelection();
});

// --- Listeners ---

browser.runtime.onMessage.addListener((message) => {
  if (message.type === MessageType.STATE_CHANGED) {
    updateStatus(message.state);
    if (message.state === 'idle' || message.state === 'complete' || message.state === 'preview') {
      loadRecordings();
    }
    // Update upload button states
    gridEl.querySelectorAll('.btn-upload').forEach((btn) => {
      (btn as HTMLButtonElement).disabled = message.state !== 'idle';
    });
  }
});

// --- Init ---

browser.runtime.sendMessage({ type: MessageType.GET_STATE }).then((state) => {
  if (state) updateStatus(state as ExtensionState);
});
loadRecordings();
