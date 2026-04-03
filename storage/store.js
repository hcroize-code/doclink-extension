/**
 * DocLink — Chrome Storage abstraction.
 *
 * Schema:
 *   folders: [{ id, name, createdAt }]
 *   docs:    [{ id, title, url, type, emailId, emailSubject, sender, detectedAt, folderId|null }]
 *   lastSyncAt: ISO string
 */

const FOLDERS_KEY = 'doclink_folders';
const DOCS_KEY    = 'doclink_docs';
const SYNC_KEY    = 'doclink_lastSyncAt';

/* ── helpers ─────────────────────────────────────────────────────────── */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function get(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result[key]);
    });
  });
}

async function set(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

/* ── folders ─────────────────────────────────────────────────────────── */

export async function getFolders() {
  return (await get(FOLDERS_KEY)) ?? [];
}

export async function createFolder(name) {
  const folders = await getFolders();
  const folder  = { id: uid(), name: name.trim(), createdAt: new Date().toISOString() };
  await set(FOLDERS_KEY, [...folders, folder]);
  return folder;
}

export async function renameFolder(id, name) {
  const folders = await getFolders();
  await set(FOLDERS_KEY, folders.map(f => f.id === id ? { ...f, name: name.trim() } : f));
}

export async function deleteFolder(id) {
  const [folders, docs] = await Promise.all([getFolders(), getDocs()]);
  // Move docs from deleted folder back to pending
  await set(DOCS_KEY, docs.map(d => d.folderId === id ? { ...d, folderId: null } : d));
  await set(FOLDERS_KEY, folders.filter(f => f.id !== id));
}

/* ── docs ────────────────────────────────────────────────────────────── */

export async function getDocs() {
  return (await get(DOCS_KEY)) ?? [];
}

export async function getPendingDocs() {
  const docs = await getDocs();
  return docs.filter(d => d.folderId === null || d.folderId === undefined);
}

export async function getDocsByFolder(folderId) {
  const docs = await getDocs();
  return docs.filter(d => d.folderId === folderId);
}

/**
 * Add docs detected from Gmail (deduped by url + emailId).
 * @param {Array} newDocs  — raw doc objects from the scanner
 */
export async function upsertDocs(newDocs) {
  const existing = await getDocs();
  const existingKeys = new Set(existing.map(d => `${d.emailId}::${d.url}`));

  const toAdd = newDocs
    .filter(d => !existingKeys.has(`${d.emailId}::${d.url}`))
    .map(d => ({ ...d, id: uid(), folderId: null, detectedAt: new Date().toISOString() }));

  if (toAdd.length > 0) {
    await set(DOCS_KEY, [...existing, ...toAdd]);
  }
  return toAdd.length;
}

export async function moveDocToFolder(docId, folderId) {
  const docs = await getDocs();
  await set(DOCS_KEY, docs.map(d => d.id === docId ? { ...d, folderId } : d));
}

export async function removeDoc(docId) {
  const docs = await getDocs();
  await set(DOCS_KEY, docs.filter(d => d.id !== docId));
}

/* ── sync timestamp ──────────────────────────────────────────────────── */

export async function getLastSyncAt() {
  return (await get(SYNC_KEY)) ?? null;
}

export async function setLastSyncAt(iso) {
  await set(SYNC_KEY, iso);
}
