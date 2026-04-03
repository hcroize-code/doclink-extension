/**
 * DocLink — Background Service Worker (Manifest V3)
 *
 * Scan strategy:
 *  - Full scan  (doclink_sync,  every 15 min): fetches last 50 messages, stores historyId
 *  - Quick scan (doclink_quick, every 1 min):  uses Gmail History API — only fetches
 *    messages added since the last historyId, so it is very fast and cheap
 *  - On-demand: popup sends SCAN_NOW → triggers quick scan (falls back to full if needed)
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
const QUICK_INTERVAL_MIN = 1;   // Chrome MV3 minimum is 1 minute

const GDOC_PATTERN = /https:\/\/(?:docs\.google\.com\/(?:document|spreadsheets|presentation|forms)\/d\/|drive\.google\.com\/(?:file|open)\?(?:[^"'\s]*&)?id=|drive\.google\.com\/file\/d\/)([a-zA-Z0-9_-]{10,})/g;

const DOC_TYPE_MAP = {
  document:     { label: 'Document',     icon: '📄' },
  spreadsheets: { label: 'Spreadsheet',  icon: '📊' },
  presentation: { label: 'Présentation', icon: '📑' },
  forms:        { label: 'Formulaire',   icon: '📋' },
  file:         { label: 'Fichier Drive',icon: '📁' },
};

/* ── alarms ──────────────────────────────────────────────────────────── */

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_FULL,  { periodInMinutes: FULL_INTERVAL_MIN });
  chrome.alarms.create(ALARM_QUICK, { periodInMinutes: QUICK_INTERVAL_MIN });
  updateBadge();
});

// Re-register alarms when service worker wakes up (MV3 can kill it)
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

// Clicking a single-doc notification opens it directly
chrome.notifications.onClicked.addListener((notifId) => {
  chrome.notifications.clear(notifId);
});

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

/* ── full scan (every 15 min) ────────────────────────────────────────── */

export async function scanGmail() {
  const token = await getToken(false);
  if (!token) return 0;

  // Snapshot current historyId before we start reading
  const profile = await gmailFetch('/profile', token);
  const currentHistoryId = profile.historyId;

  const list     = await gmailFetch('/messages?maxResults=50&q=in:inbox', token);
  const messages = list.messages ?? [];

  const allDocs = (await Promise.allSettled(
    messages.map(({ id }) => parseMessage(id, token))
  )).flatMap(r => r.status === 'fulfilled' ? r.value : []);

  const added = await upsertDocs(allDocs);
  await setLastSyncAt(new Date().toISOString());
  await setLastHistoryId(currentHistoryId);
  await updateBadge();

  if (added > 0) {
    const all     = await (await import('../storage/store.js')).getDocs();
    const newDocs = all.slice(-added);
    notifyNewDocs(newDocs);
  }
  return added;
}

/* ── quick scan via Gmail History API (every 1 min) ─────────────────── */

async function quickScan() {
  const token = await getToken(false);
  if (!token) return 0;

  const lastHistoryId = await getLastHistoryId();
  if (!lastHistoryId) {
    // First run — do a full scan to get an initial historyId
    return scanGmail();
  }

  let historyRes;
  try {
    historyRes = await gmailFetch(
      `/history?startHistoryId=${lastHistoryId}&historyTypes=messageAdded`,
      token
    );
  } catch (e) {
    if (e.status === 404 || e.status === 410) {
      // historyId expired (> 30 days old) → fall back to full scan
      return scanGmail();
    }
    throw e;
  }

  // Always advance the historyId even if no new messages
  if (historyRes.historyId) {
    await setLastHistoryId(historyRes.historyId);
  }

  const history  = historyRes.history ?? [];
  if (history.length === 0) return 0;

  // Collect unique message IDs that were newly added
  const msgIds = [...new Set(
    history.flatMap(h => (h.messagesAdded ?? []).map(m => m.message.id))
  )];
  if (msgIds.length === 0) return 0;

  const allDocs = (await Promise.allSettled(
    msgIds.map(id => parseMessage(id, token))
  )).flatMap(r => r.status === 'fulfilled' ? r.value : []);

  const added = await upsertDocs(allDocs);
  await setLastSyncAt(new Date().toISOString());
  await updateBadge();

  if (added > 0) {
    const all     = await (await import('../storage/store.js')).getDocs();
    const newDocs = all.slice(-added);
    notifyNewDocs(newDocs);
  }
  return added;
}
