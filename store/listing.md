# DocLink — Chrome Web Store Listing

## Metadata

| Field | Value |
|---|---|
| **Name** | DocLink |
| **Category** | Productivity |
| **Language** | French / English |
| **Version** | 1.0.0 |
| **Homepage** | https://github.com/hcroize-code/doclink-extension |

---

## Short description
*(132 characters max — used in search results)*

```
Detect Google Docs, Sheets & Slides links shared via Gmail. Organize them into folders without leaving Chrome.
```
**110 characters** ✓

---

## Keywords

`gmail` · `google docs` · `google sheets` · `google slides` · `organize` · `folders` · `links` · `productivity` · `document management` · `email`

---

## Full description
*(shown on the store detail page — plain text, line breaks allowed)*

```
DocLink automatically detects Google Docs, Sheets, Slides, and Drive links shared in your Gmail inbox, and lets you organize them into custom folders — all without leaving Chrome.

── HOW IT WORKS ──

1. DocLink scans your Gmail for emails containing Google Workspace document links.
2. Detected links appear in the "En attente" (Pending) queue inside the popup.
3. Create custom folders and classify documents with one click.
4. Access all your organized docs instantly at any time from the extension icon.

── FEATURES ──

📥 Automatic scanning — new links detected every minute in the background.
🔍 Full history scan — find every Google Doc ever shared with you in a single click.
📁 Custom folders — create, rename and delete folders freely.
🔢 Badge counter — see how many docs are waiting without opening the popup.
🔔 Desktop notifications — get alerted the moment a new doc arrives in your inbox.
⚡ No manual refresh — the popup updates automatically when new docs are found.
🔒 100 % private — all data stored locally on your device, nothing sent to external servers.

── PRIVACY ──

DocLink only reads your Gmail to detect Google Workspace URLs. Your emails are never stored, transmitted, or shared. All folders and links are saved exclusively on your device using Chrome's built-in storage API. DocLink does not have its own backend server.

── PERMISSIONS ──

• Gmail (read-only) — to scan your inbox for document links.
• Storage — to save your folders and links locally on your device.
• Notifications — to alert you when new documents are detected.
• Alarms — to run lightweight background scans every minute.

── SUPPORTED DOCUMENT TYPES ──

• Google Docs (docs.google.com/document)
• Google Sheets (docs.google.com/spreadsheets)
• Google Slides (docs.google.com/presentation)
• Google Forms (docs.google.com/forms)
• Google Drive files (drive.google.com)

── OPEN SOURCE ──

DocLink is open source. Source code available at:
https://github.com/hcroize-code/doclink-extension
```

---

## Required store assets checklist

| Asset | Size | Status |
|---|---|---|
| Icon 128×128 | PNG | ✅ `icons/icon128.png` |
| Small tile | 440×280 PNG | ⬜ To create |
| Large promo image | 1280×800 PNG | ⬜ To create (optional) |
| Screenshot 1 | 1280×800 or 640×400 | ⬜ To capture |
| Privacy policy URL | Public URL | ⬜ See `store/privacy-policy.md` |

---

## Permissions justification
*(For the Chrome Web Store review form — "Single purpose" description)*

**Single purpose:** DocLink has one clear purpose — detecting and organizing Google Workspace document links found in Gmail emails.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `identity` | Required to authenticate the user with Google via OAuth 2.0 so the Gmail API can be called. |
| `storage` | Required to persist the user's folders and detected document links locally on their device. No data is stored externally. |
| `alarms` | Required to run a background scan every 1 minute (incremental, via Gmail History API) and a full scan every 15 minutes without keeping the service worker awake permanently. |
| `notifications` | Required to show a desktop notification when a new Google Workspace document link is detected in a newly received email. |
| `https://gmail.googleapis.com/*` | Required to call the Gmail REST API to list messages and read message content in order to detect document URLs. |
| `https://www.googleapis.com/*` | Required for the OAuth 2.0 token exchange endpoint used during sign-in. |

**OAuth scope:** `https://www.googleapis.com/auth/gmail.readonly`
— Read-only access. DocLink cannot send, delete, or modify any emails.
