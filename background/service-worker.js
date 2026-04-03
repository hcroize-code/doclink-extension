/**
 * DocLink — Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *  - Periodically scan recent Gmail messages for Google Workspace links
 *  - Respond to messages from the popup (manual scan trigger)
 */

import { getToken } from '../auth/oauth.js';
import { upsertDocs, setLastSyncAt } from '../storage/store.js';

/* ── constants ───────────────────────────────────────────────────────── */

const GMAIL_API   = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ALARM_NAME  = 'doclink_sync';
const SYNC_INTERVAL_MINUTES = 15;

// Matches Google Docs, Sheets, Slides, Forms, and Drive file URLs
const GDOC_PATTERN = /https:\/\/(?:docs\.google\.com\/(?:document|spreadsheets|presentation|forms)\/d\/|drive\.google\.com\/(?:file|open)\?(?:[^"'\s]*&)?id=|drive\.google\.com\/file\/d\/)([a-zA-Z0-9_-]{10,})/g;

const DOC_TYPE_MAP = {
  document:      { label: 'Document', icon: '📄' },
  spreadsheets:  { label: 'Spreadsheet', icon: '📊' },
  presentation:  { label: 'Presentation', icon: '📑' },
  forms:         { label: 'Form', icon: '📋' },
  file:          { label: 'Drive file', icon: '📁' },
};

/* ── alarm setup ─────────────────────────────────────────────────────── */

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: SYNC_INTERVAL_MINUTES,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    scanGmail().catch(console.error);
  }
});

/* ── message bridge (popup → service worker) ─────────────────────────── */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'SCAN_NOW') {
    scanGmail()
      .then((count) => sendResponse({ ok: true, count }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }
});

/* ── Gmail scanner ───────────────────────────────────────────────────── */

async function gmailFetch(path, token) {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gmail API ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Extract all Google Workspace link objects from a plain-text or HTML string.
 */
function extractLinks(text) {
  const links = [];
  let m;
  const re = new RegExp(GDOC_PATTERN.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const url  = m[0].split(/["'\s]/)[0]; // trim trailing junk chars
    const type = detectType(url);
    links.push({ url, type });
  }
  // Deduplicate by url
  const seen = new Set();
  return links.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
}

function detectType(url) {
  const segments = ['document', 'spreadsheets', 'presentation', 'forms'];
  for (const seg of segments) {
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

  const extractParts = (parts) => {
    for (const part of parts ?? []) {
      if ((part.mimeType === 'text/plain' || part.mimeType === 'text/html') && part.body?.data) {
        text += decodeBase64Url(part.body.data);
      }
      if (part.parts) extractParts(part.parts);
    }
  };

  if (payload.body?.data) {
    text += decodeBase64Url(payload.body.data);
  }
  extractParts(payload.parts);
  return text;
}

function headerValue(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/**
 * Main scan: fetch recent Gmail messages and extract Google Workspace links.
 * @returns {Promise<number>} number of new docs added
 */
export async function scanGmail() {
  const token = await getToken(false); // non-interactive — skip if not signed in
  if (!token) return 0;

  // List last 50 messages (Gmail returns newest first)
  const list = await gmailFetch('/messages?maxResults=50&q=from:* has:attachment OR label:inbox', token);
  const messages = list.messages ?? [];

  const allDocs = [];

  await Promise.allSettled(
    messages.map(async ({ id }) => {
      const msg = await gmailFetch(`/messages/${id}?format=full`, token);
      const body    = extractBody(msg.payload);
      const headers = msg.payload?.headers ?? [];
      const subject = headerValue(headers, 'Subject') || '(no subject)';
      const sender  = headerValue(headers, 'From')    || 'Unknown';

      const links = extractLinks(body);
      for (const link of links) {
        allDocs.push({
          url:          link.url,
          type:         link.type,
          typeLabel:    DOC_TYPE_MAP[link.type]?.label ?? 'Document',
          typeIcon:     DOC_TYPE_MAP[link.type]?.icon  ?? '📄',
          emailId:      id,
          emailSubject: subject,
          sender,
          title:        subject, // default title = email subject
        });
      }
    })
  );

  const added = await upsertDocs(allDocs);
  await setLastSyncAt(new Date().toISOString());
  return added;
}
