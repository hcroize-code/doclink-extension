/**
 * DocLink — Background Service Worker (Manifest V3)
 *
 * Scan strategy:
 *  - Full scan  (doclink_sync,  every 15 min): fetches last 50 messages, stores historyId
 *  - Quick scan (doclink_quick, every 1 min):  uses Gmail History API — only fetches
 *    messages added since the last historyId, so it is very fast and cheap
 *  - History scan: paginates through ALL of Gmail (manual trigger or first install)
 *  - On-demand: popup sends SCAN_NOW → triggers quick scan
 *
 * After every scan:
 *  - Badge count is updated (red number = pending docs)
 *  - Desktop notification shown for each newly detected doc
 */

import { getToken }                                     from '../auth/oauth.js';
import { upsertDocs, setLastSyncAt,
         getLastHistoryId, setLastHistoryId,
         getPendingDocs }                               from '../storage/store.js';

/* ── constants ───────────────────────────────────────────────────────── */

const GMAIL_API          = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ALARM_FULL         = 'doclink_sync';
const ALARM_QUICK        = 'doclink_quick';
const FULL_INTERVAL_MIN  = 15;
const QUICK_INTERVAL_MIN = 1;

// Storage keys
const HISTORY_DONE_KEY   = 'doclink_history_done';
const SCAN_PROGRESS_KEY  = 'doclink_scan_progress';

// Gmail search query for history scan — broad match, regex filters precisely
const HISTORY_QUERY = 'docs.google.com';

const GDOC_PATTERN = /https:\/\/(?:docs\.google\.com\/(?:document|spreadsheets|presentation|forms)\/d\/|drive\.google\.com\/(?:file|open)\?(?:[^"'\s]*&)?id=|drive\.google\.com\/file\/d\/)([a-zA-Z0-9_-]{10,})/g;

const DOC_TYPE_MAP = {
  document:     { label: 'Document',      icon: '📄' },
  spreadsheets: { label: 'Spreadsheet',   icon: '📊' },
  presentation: { label: 'Présentation',  icon: '📑' },
  forms:        { label: 'Formulaire',    icon: '📋' },
  file:         { label: 'Fichier Drive', icon: '📁' },
};

/* ── alarms ──────────────────────────────────────────────────────────── */

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(ALARM_FULL,  { periodInMinutes: FULL_INTERVAL_MIN });
  chrome.alarms.create(ALARM_QUICK, { periodInMinutes: QUICK_INTERVAL_MIN });
  updateBadge();

  // Auto-run history scan on first install if user is signed in
  const done = await storageGet(HISTORY_DONE_KEY);
  if (!done) {
    const token = await getToken(false).catch(() => null);
    if (token) scanFullHistory().catch(console.error);
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_FULL,  { periodInMinutes: FULL_INTERVAL_MIN });
  chrome.alarms.create(ALARM_QUICK, { periodInMinutes: QUICK_INTERVAL_MIN });
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_FULL)  scanGmail().catch(console.error);
  if (alarm.name === ALARM_QUICK) quickScan().catch(console.error);
});

/* ── message bridge (popup → service worker) ─────────────────────────── */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SCAN_NOW') {
    quickScan()
      .then((count) => sendResponse({ ok: true, count }))
      .catch((err)  => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SCAN_HISTORY') {
    // Guard: don't start if already running
    storageGet(SCAN_PROGRESS_KEY).then(progress => {
      if (progress?.active) {
        sendResponse({ ok: false, error: 'Scan déjà en cours' });
        return;
      }
      // Fire-and-forget — progress is communicated via storage
      scanFullHistory().catch(console.error);
      sendResponse({ ok: true, started: true });
    });
    return true;
  }
});

/* ── badge ───────────────────────────────────────────────────────────── */

async function updateBadge() {
  const pending = await getPendingDocs();
  const count   = pending.length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
}

/* ── notifications ───────────────────────────────────────────────────── */

function notifyNewDocs(docs) {
  if (docs.length === 0) return;
  if (docs.length === 1) {
    const doc = docs[0];
    chrome.notifications.create(`doclink_${doc.id ?? Date.now()}`, {
      type:    'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title:   `DocLink — ${doc.typeIcon ?? '📄'} Nouveau document`,
      message: doc.title || doc.typeLabel || 'Document détecté',
      contextMessage: doc.sender ?? '',
    });
  } else {
    chrome.notifications.create(`doclink_batch_${Date.now()}`, {
      type:    'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title:   `DocLink — ${docs.length} nouveaux documents`,
      message: docs.map(d => d.title || d.typeLabel).join(', '),
    });
  }
}

chrome.notifications.onClicked.addListener((id) => chrome.notifications.clear(id));

/* ── Gmail helpers ───────────────────────────────────────────────────── */

async function gmailFetch(path, token) {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err  = new Error(`Gmail API ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function extractLinks(text) {
  const links = [];
  const re    = new RegExp(GDOC_PATTERN.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const url  = m[0].split(/["'\s]/)[0];
    const type = detectType(url);
    links.push({ url, type });
  }
  const seen = new Set();
  return links.filter(l => seen.has(l.url) ? false : (seen.add(l.url), true));
}

function detectType(url) {
  for (const seg of ['document', 'spreadsheets', 'presentation', 'forms']) {
    if (url.includes(`/${seg}/`)) return seg;
  }
  return 'file';
}

function decodeBase64Url(str) {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

function extractBody(payload) {
  let text = '';
  if (!payload) return text;
  const walk = (parts) => {
    for (const part of parts ?? []) {
      if ((part.mimeType === 'text/plain' || part.mimeType === 'text/html') && part.body?.data) {
        text += decodeBase64Url(part.body.data);
      }
      if (part.parts) walk(part.parts);
    }
  };
  if (payload.body?.data) text += decodeBase64Url(payload.body.data);
  walk(payload.parts);
  return text;
}

function headerValue(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

async function parseMessage(id, token) {
  const msg     = await gmailFetch(`/messages/${id}?format=full`, token);
  const body    = extractBody(msg.payload);
  const headers = msg.payload?.headers ?? [];
  const subject = headerValue(headers, 'Subject') || '(no subject)';
  const sender  = headerValue(headers, 'From')    || 'Unknown';
  return extractLinks(body).map(link => ({
    url:          link.url,
    type:         link.type,
    typeLabel:    DOC_TYPE_MAP[link.type]?.label ?? 'Document',
    typeIcon:     DOC_TYPE_MAP[link.type]?.icon  ?? '📄',
    emailId:      id,
    emailSubject: subject,
    sender,
    title:        subject,
  }));
}

/** Fetch message IDs in controlled-concurrency batches to avoid rate-limiting */
async function fetchMessageBatch(ids, token) {
  const BATCH = 20;
  const results = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const settled = await Promise.allSettled(slice.map(id => parseMessage(id, token)));
    results.push(...settled);
  }
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

/* ── storage helpers ─────────────────────────────────────────────────── */

function storageGet(key) {
  return new Promise(resolve =>
    chrome.storage.local.get(key, r => resolve(r[key] ?? null))
  );
}

function storageSet(key, value) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
}

async function setProgress(data) {
  return storageSet(SCAN_PROGRESS_KEY, data);
}

/* ── full scan (every 15 min) ────────────────────────────────────────── */

export async function scanGmail() {
  const token = await getToken(false);
  if (!token) return 0;

  const profile        = await gmailFetch('/profile', token);
  const currentHistory = profile.historyId;

  const list     = await gmailFetch('/messages?maxResults=50&q=in:inbox', token);
  const messages = list.messages ?? [];

  const allDocs = await fetchMessageBatch(messages.map(m => m.id), token);
  const added   = await upsertDocs(allDocs);

  await setLastSyncAt(new Date().toISOString());
  await setLastHistoryId(currentHistory);
  await updateBadge();

  if (added > 0) {
    const store   = await import('../storage/store.js');
    const all     = await store.getDocs();
    notifyNewDocs(all.slice(-added));
  }
  return added;
}

/* ── quick scan via Gmail History API (every 1 min) ─────────────────── */

async function quickScan() {
  const token = await getToken(false);
  if (!token) return 0;

  const lastHistoryId = await getLastHistoryId();
  if (!lastHistoryId) return scanGmail();

  let historyRes;
  try {
    historyRes = await gmailFetch(
      `/history?startHistoryId=${lastHistoryId}&historyTypes=messageAdded`,
      token
    );
  } catch (e) {
    if (e.status === 404 || e.status === 410) return scanGmail();
    throw e;
  }

  if (historyRes.historyId) await setLastHistoryId(historyRes.historyId);

  const history = historyRes.history ?? [];
  if (history.length === 0) return 0;

  const msgIds = [...new Set(
    history.flatMap(h => (h.messagesAdded ?? []).map(m => m.message.id))
  )];
  if (msgIds.length === 0) return 0;

  const allDocs = await fetchMessageBatch(msgIds, token);
  const added   = await upsertDocs(allDocs);

  await setLastSyncAt(new Date().toISOString());
  await updateBadge();

  if (added > 0) {
    const store = await import('../storage/store.js');
    const all   = await store.getDocs();
    notifyNewDocs(all.slice(-added));
  }
  return added;
}

/* ── full history scan (manual trigger + first install) ──────────────── */

export async function scanFullHistory() {
  const token = await getToken(false);
  if (!token) {
    await setProgress({ active: false, scanned: 0, found: 0, done: false,
                        error: 'Non connecté — connectez-vous d\'abord.' });
    return 0;
  }

  await setProgress({ active: true, scanned: 0, found: 0, done: false, error: null });

  let pageToken    = null;
  let totalScanned = 0;
  let totalFound   = 0;

  try {
    do {
      const params = new URLSearchParams({ maxResults: '100', q: HISTORY_QUERY });
      if (pageToken) params.set('pageToken', pageToken);

      const list  = await gmailFetch(`/messages?${params}`, token);
      const msgs  = list.messages ?? [];
      pageToken   = list.nextPageToken ?? null;

      if (msgs.length === 0) break;

      const docs  = await fetchMessageBatch(msgs.map(m => m.id), token);
      const added = await upsertDocs(docs);

      totalScanned += msgs.length;
      totalFound   += added;

      await setProgress({ active: true, scanned: totalScanned, found: totalFound,
                          done: false, error: null });
      await updateBadge();

    } while (pageToken);

    await setProgress({ active: false, scanned: totalScanned, found: totalFound,
                        done: true, error: null });
    await storageSet(HISTORY_DONE_KEY, true);
    await updateBadge();

    return totalFound;

  } catch (e) {
    await setProgress({ active: false, scanned: totalScanned, found: totalFound,
                        done: false, error: e.message });
    throw e;
  }
}
