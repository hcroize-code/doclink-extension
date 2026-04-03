/**
 * DocLink — Popup controller
 */

import { getToken, revokeToken, isSignedIn } from '../auth/oauth.js';
import {
  getFolders, createFolder, renameFolder, deleteFolder,
  getDocs, getPendingDocs, getDocsByFolder,
  moveDocToFolder, removeDoc,
} from '../storage/store.js';

/* ── State ───────────────────────────────────────────────────────────── */

let currentView = 'pending'; // 'pending' | folder-id

/* ── DOM refs ────────────────────────────────────────────────────────── */

const authBanner      = document.getElementById('authBanner');
const appLayout       = document.getElementById('appLayout');
const signInBtn       = document.getElementById('signInBtn');
const signOutBtn      = document.getElementById('signOutBtn');
const syncBtn         = document.getElementById('syncBtn');
const folderList      = document.getElementById('folderList');
const pendingCount    = document.getElementById('pendingCount');
const addFolderBtn    = document.getElementById('addFolderBtn');
const newFolderRow    = document.getElementById('newFolderRow');
const newFolderInput  = document.getElementById('newFolderInput');
const newFolderConfirm= document.getElementById('newFolderConfirm');
const newFolderCancel = document.getElementById('newFolderCancel');
const panelTitle      = document.getElementById('panelTitle');
const panelSubtitle   = document.getElementById('panelSubtitle');
const docList         = document.getElementById('docList');
const statusBar       = document.getElementById('statusBar');
const navInbox        = document.getElementById('navInbox');
const toast           = document.getElementById('toast');

/* ── Boot ────────────────────────────────────────────────────────────── */

(async () => {
  const signedIn = await isSignedIn();
  if (signedIn) {
    showApp();
    await refresh();
    // Trigger a quick scan immediately so the popup is never stale
    chrome.runtime.sendMessage({ type: 'SCAN_NOW' }).catch(() => {});
    startPolling();
  } else {
    showAuthBanner();
  }
})();

/* ── Auto-refresh ────────────────────────────────────────────────────── */

// Refresh the UI whenever the service worker writes new docs to storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.doclink_docs || changes.doclink_folders)) {
    refresh();
  }
});

// Poll every 30 s while the popup is open (triggers background quick scan)
let pollTimer;
function startPolling() {
  pollTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'SCAN_NOW' }).catch(() => {});
  }, 30_000);
}
window.addEventListener('unload', () => clearInterval(pollTimer));

/* ── Auth ────────────────────────────────────────────────────────────── */

function showAuthBanner() {
  authBanner.classList.add('visible');
  appLayout.style.display = 'none';
  statusBar.textContent = 'Non connecté';
}

function showApp() {
  authBanner.classList.remove('visible');
  appLayout.style.display = 'flex';
}

signInBtn.addEventListener('click', async () => {
  try {
    await getToken(true);
    showApp();
    await triggerScan();
    await refresh();
    startPolling();
  } catch (e) {
    showToast('Échec de la connexion : ' + e.message);
  }
});

signOutBtn.addEventListener('click', async () => {
  await revokeToken();
  showAuthBanner();
});

/* ── Scan ────────────────────────────────────────────────────────────── */

syncBtn.addEventListener('click', () => triggerScan());

async function triggerScan() {
  syncBtn.classList.add('spinning');
  statusBar.textContent = 'Scan Gmail en cours…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SCAN_NOW' });
    if (result?.ok) {
      const msg = result.count > 0
        ? `${result.count} nouveau(x) document(s) détecté(s)`
        : 'Aucun nouveau document';
      statusBar.textContent = msg;
      showToast(msg);
    } else {
      throw new Error(result?.error ?? 'Erreur inconnue');
    }
  } catch (e) {
    statusBar.textContent = 'Erreur : ' + e.message;
    showToast('Erreur : ' + e.message);
  } finally {
    syncBtn.classList.remove('spinning');
    await refresh();
  }
}

/* ── Render ──────────────────────────────────────────────────────────── */

async function refresh() {
  const [folders, pending] = await Promise.all([getFolders(), getPendingDocs()]);
  renderSidebar(folders, pending.length);
  await renderPanel(folders);
  updateStatus();
}

function renderSidebar(folders, pCount) {
  pendingCount.textContent = pCount;
  pendingCount.style.display = pCount > 0 ? '' : 'none';

  folderList.innerHTML = '';
  for (const folder of folders) {
    const item = document.createElement('div');
    item.className = 'nav-item' + (currentView === folder.id ? ' active' : '');
    item.dataset.folderId = folder.id;
    item.innerHTML = `
      <span class="nav-icon">📁</span>
      <span class="nav-name" title="${esc(folder.name)}">${esc(folder.name)}</span>
      <button class="folder-delete-btn" data-folder-id="${folder.id}" title="Supprimer le dossier">×</button>
    `;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('folder-delete-btn')) return;
      setView(folder.id);
    });
    item.querySelector('.folder-delete-btn').addEventListener('click', () => confirmDeleteFolder(folder));
    folderList.appendChild(item);
  }

  // Highlight inbox nav
  navInbox.classList.toggle('active', currentView === 'pending');
}

async function renderPanel(folders) {
  let docs;
  if (currentView === 'pending') {
    docs = await getPendingDocs();
    panelTitle.textContent = 'En attente';
    panelSubtitle.textContent = docs.length
      ? `${docs.length} document(s) à classer`
      : 'Aucun document en attente';
  } else {
    docs = await getDocsByFolder(currentView);
    const folder = folders.find(f => f.id === currentView);
    panelTitle.textContent = folder?.name ?? 'Dossier';
    panelSubtitle.textContent = docs.length
      ? `${docs.length} document(s)`
      : 'Dossier vide';
  }

  docList.innerHTML = '';
  if (docs.length === 0) {
    docList.appendChild(emptyState(currentView === 'pending'));
    return;
  }

  for (const doc of docs) {
    docList.appendChild(buildDocCard(doc, folders));
  }
}

function buildDocCard(doc, folders) {
  const card = document.createElement('div');
  card.className = 'doc-card';
  card.dataset.docId = doc.id;

  const folderId = currentView !== 'pending' ? currentView : null;
  const isPending = doc.folderId === null || doc.folderId === undefined;

  card.innerHTML = `
    <div class="doc-type-icon">${doc.typeIcon ?? '📄'}</div>
    <div class="doc-info">
      <a class="doc-title" href="${esc(doc.url)}" target="_blank" title="${esc(doc.url)}">
        ${esc(doc.title || doc.typeLabel)}
      </a>
      <div class="doc-meta">
        <span>${esc(doc.typeLabel ?? 'Document')}</span>
        <span title="${esc(doc.emailSubject)}">${esc(truncate(doc.emailSubject, 30))}</span>
        <span>${relativeTime(doc.detectedAt)}</span>
      </div>
    </div>
    <div class="doc-actions">
      ${isPending ? buildClasserBtn(doc, folders) : ''}
      <button class="btn btn-ghost btn-danger remove-btn" title="Supprimer">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
    </div>
  `;

  // Remove button
  card.querySelector('.remove-btn').addEventListener('click', async () => {
    await removeDoc(doc.id);
    showToast('Document supprimé');
    await refresh();
  });

  // Classer dropdown toggle
  const classerBtn = card.querySelector('.classer-btn');
  const dropdown   = card.querySelector('.folder-dropdown');
  if (classerBtn && dropdown) {
    classerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      dropdown.classList.toggle('open');
    });

    dropdown.querySelectorAll('.dropdown-item[data-target-folder]').forEach(item => {
      item.addEventListener('click', async () => {
        const targetId = item.dataset.targetFolder;
        await moveDocToFolder(doc.id, targetId === '__pending__' ? null : targetId);
        dropdown.classList.remove('open');
        showToast(targetId === '__pending__' ? 'Remis en attente' : 'Classé !');
        await refresh();
      });
    });
  }

  return card;
}

function buildClasserBtn(doc, folders) {
  const folderOptions = folders.map(f => `
    <div class="dropdown-item" data-target-folder="${esc(f.id)}">
      <span>📁</span> ${esc(f.name)}
    </div>
  `).join('');

  const moveBackOption = doc.folderId
    ? `<div class="dropdown-divider"></div>
       <div class="dropdown-item" data-target-folder="__pending__">
         <span>📥</span> Remettre en attente
       </div>`
    : '';

  return `
    <div class="dropdown-wrapper">
      <button class="btn btn-primary classer-btn" title="Classer dans un dossier">
        Classer
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div class="folder-dropdown">
        ${folderOptions.length
          ? folderOptions
          : '<div class="dropdown-item" style="color:var(--gray-text);cursor:default">Créez d\'abord un dossier</div>'}
        ${moveBackOption}
      </div>
    </div>
  `;
}

function emptyState(isPending) {
  const el = document.createElement('div');
  el.className = 'empty-state';
  if (isPending) {
    el.innerHTML = `
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <p>Aucun document en attente.<br/>Cliquez sur <strong>↺</strong> pour scanner Gmail.</p>
    `;
  } else {
    el.innerHTML = `
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <p>Ce dossier est vide.<br/>Classez des documents depuis "En attente".</p>
    `;
  }
  return el;
}

/* ── Navigation ──────────────────────────────────────────────────────── */

function setView(viewId) {
  currentView = viewId;
  refresh();
}

navInbox.addEventListener('click', () => setView('pending'));

/* ── Folder creation ─────────────────────────────────────────────────── */

addFolderBtn.addEventListener('click', () => {
  newFolderRow.classList.add('visible');
  newFolderInput.focus();
  addFolderBtn.style.display = 'none';
});

newFolderCancel.addEventListener('click', closeFolderInput);

newFolderConfirm.addEventListener('click', async () => {
  const name = newFolderInput.value.trim();
  if (!name) return;
  await createFolder(name);
  showToast(`Dossier "${name}" créé`);
  closeFolderInput();
  await refresh();
});

newFolderInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') newFolderConfirm.click();
  if (e.key === 'Escape') closeFolderInput();
});

function closeFolderInput() {
  newFolderRow.classList.remove('visible');
  newFolderInput.value = '';
  addFolderBtn.style.display = '';
}

/* ── Folder deletion ─────────────────────────────────────────────────── */

async function confirmDeleteFolder(folder) {
  const docs = await getDocsByFolder(folder.id);
  const msg = docs.length > 0
    ? `Supprimer le dossier "${folder.name}" ? Les ${docs.length} document(s) seront remis en attente.`
    : `Supprimer le dossier "${folder.name}" ?`;
  if (!confirm(msg)) return;
  await deleteFolder(folder.id);
  if (currentView === folder.id) setView('pending');
  showToast(`Dossier "${folder.name}" supprimé`);
  await refresh();
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

function closeAllDropdowns() {
  document.querySelectorAll('.folder-dropdown.open').forEach(d => d.classList.remove('open'));
}

document.addEventListener('click', closeAllDropdowns);

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function relativeTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'À l\'instant';
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

async function updateStatus() {
  const docs = await getDocs();
  const pending = docs.filter(d => !d.folderId).length;
  const total   = docs.length;
  statusBar.textContent = `${total} document(s) total · ${pending} en attente`;
}
