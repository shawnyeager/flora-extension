import { MessageType, type RecordingMeta } from '@/utils/messages';
import type { ExtensionState } from '@/utils/state';

const listEl = document.getElementById('list')!;
const emptyEl = document.getElementById('empty')!;
const statusDot = document.querySelector('.status-dot') as HTMLElement;
const statusText = document.querySelector('.status-text') as HTMLElement;

let currentState: ExtensionState = 'idle';

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

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// --- State ---

const STATE_LABELS: Record<ExtensionState, string> = {
  idle: 'Ready',
  initializing: 'Starting\u2026',
  awaiting_media: 'Select a screen\u2026',
  countdown: 'Starting\u2026',
  recording: 'Recording',
  finalizing: 'Saving\u2026',
  preview: 'Review',
  confirming: 'Confirming\u2026',
  uploading: 'Uploading\u2026',
  publishing: 'Publishing\u2026',
  complete: 'Done',
  error: 'Error',
};

const RECORDING_STATES: ExtensionState[] = ['recording'];
const ACTIVE_STATES: ExtensionState[] = ['initializing', 'awaiting_media', 'countdown', 'finalizing', 'uploading', 'publishing', 'confirming'];

function updateStatus(state: ExtensionState) {
  currentState = state;
  statusText.textContent = STATE_LABELS[state] || state;
  statusDot.classList.toggle('recording', RECORDING_STATES.includes(state));
  statusDot.classList.toggle('active', ACTIVE_STATES.includes(state));

  // Disable/enable upload buttons based on state
  listEl.querySelectorAll('.btn-upload').forEach((btn) => {
    (btn as HTMLButtonElement).disabled = state !== 'idle';
  });
}

// --- Render ---

function createButton(text: string, cls: string, handler: (btn: HTMLButtonElement) => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = cls;
  btn.textContent = text;
  btn.addEventListener('click', () => handler(btn));
  return btn;
}

function renderList(recordings: RecordingMeta[]) {
  // Clear list using safe DOM methods
  while (listEl.firstChild) listEl.firstChild.remove();
  emptyEl.style.display = recordings.length === 0 ? 'flex' : 'none';

  for (const rec of recordings) {
    const card = document.createElement('div');
    card.className = 'rec-card';

    // Meta row
    const meta = document.createElement('div');
    meta.className = 'rec-meta';

    const date = document.createElement('span');
    date.className = 'rec-date';
    date.textContent = fmtDate(rec.timestamp);

    const details = document.createElement('span');
    details.className = 'rec-details';
    details.textContent = `${fmtDuration(rec.duration)} \u00b7 ${fmtBytes(rec.size)}`;

    meta.append(date, details);

    // Status badge
    const badge = document.createElement('span');
    badge.className = rec.uploaded ? 'rec-badge uploaded' : 'rec-badge';
    badge.textContent = rec.uploaded ? 'Uploaded' : 'Local';

    // Actions
    const actions = document.createElement('div');
    actions.className = 'rec-actions';

    actions.append(createButton('Download', 'btn-action', async (btn) => {
      btn.textContent = 'Preparing\u2026';
      btn.disabled = true;
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
        btn.textContent = 'Download';
        btn.disabled = false;
      }
    }));

    if (rec.uploaded && rec.blossomUrl) {
      actions.append(createButton('Copy URL', 'btn-action btn-accent', async (btn) => {
        await navigator.clipboard.writeText(rec.blossomUrl!);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy URL'; }, 2000);
      }));
    }

    if (!rec.uploaded) {
      const upBtn = createButton('Upload', 'btn-action btn-accent btn-upload', async (btn) => {
        const resp = await browser.runtime.sendMessage({
          type: MessageType.UPLOAD_FROM_LIBRARY,
          hash: rec.hash,
          publishToNostr: false,
        });
        if (!resp?.ok) {
          btn.textContent = 'Busy';
          setTimeout(() => { btn.textContent = 'Upload'; }, 2000);
        }
      });
      upBtn.disabled = currentState !== 'idle';
      actions.append(upBtn);
    }

    actions.append(createButton('Delete', 'btn-action btn-danger', async () => {
      if (!confirm('Delete this recording? This cannot be undone.')) return;
      await browser.runtime.sendMessage({
        type: MessageType.DELETE_RECORDING,
        hash: rec.hash,
      });
      await loadRecordings();
    }));

    card.append(meta, badge, actions);
    listEl.append(card);
  }
}

async function loadRecordings() {
  const recordings = await browser.runtime.sendMessage({ type: MessageType.LIST_RECORDINGS });
  renderList(recordings || []);
}

// --- Listeners ---

browser.runtime.onMessage.addListener((message) => {
  if (message.type === MessageType.STATE_CHANGED) {
    updateStatus(message.state);
    // Re-fetch list when a recording completes or upload finishes
    if (message.state === 'idle' || message.state === 'complete' || message.state === 'preview') {
      loadRecordings();
    }
  }
});

// Init
browser.runtime.sendMessage({ type: MessageType.GET_STATE }).then((state) => {
  if (state) updateStatus(state as ExtensionState);
});
loadRecordings();
