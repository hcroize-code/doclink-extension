# DocLink Chrome Extension

Automatically detects Google Docs / Sheets / Slides links in Gmail and lets you organize them into custom folders via a popup.

## Features

- Scans your Gmail inbox for Google Workspace links (Docs, Sheets, Slides, Forms, Drive)
- Pending queue ("En attente") for newly detected links
- Create and name folders freely, then classify each link with one click
- Fully offline storage via Chrome Storage API — no backend required
- Gmail-native design (Google Blue, Google Sans, Material buttons)

---

## Fixing OAuth errors

### Error: "bad client id: {0}"

This means the OAuth 2.0 client in Google Cloud Console is not configured for this Chrome extension.

**Steps to fix:**

1. Go to [Google Cloud Console › Credentials](https://console.cloud.google.com/apis/credentials)
2. Click the OAuth 2.0 client `779013325294-81h2mgvd61borau1bfrsviv922cqee8j`
3. Confirm **Application type** is **Chrome Extension** (not Web Application)
4. Under **Item ID**, enter the extension ID: `gfhacaanbnknlecpaipegmlepabecchh`
5. Save

> If the client was created as Web Application you must delete it and create a new one with type Chrome Extension — the type cannot be changed after creation.

---

### Error: "OAuth2 request failed: Connection failed (-106)"

This cascades from the client ID error above, but can also mean the `manifest.json` `key` field is missing, causing Chrome to derive a different extension ID than the one registered in Google Cloud Console.

**Fix: add the `key` field to `manifest.json`**

The `key` pins the extension to ID `gfhacaanbnknlecpaipegmlepabecchh` regardless of install path or machine.

#### How to get your key (one-time, ~2 minutes)

**Method A — Pack extension (recommended)**

1. Open `chrome://extensions`
2. Click **Pack extension**
3. Browse to this folder, leave Private key blank, click **Pack Extension**
4. Chrome creates `doclink-extension.crx` and `doclink-extension.pem` next to this folder
5. Open `doclink-extension.pem` in a text editor — it looks like:
   ```
   -----BEGIN PRIVATE KEY-----
   MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
   -----END PRIVATE KEY-----
   ```
6. Run this command to extract the public key in the format Chrome expects:
   ```bash
   openssl rsa -in doclink-extension.pem -pubout -outform DER 2>/dev/null | base64 | tr -d '\n'
   ```
7. Paste the output as the `"key"` value in `manifest.json`

**Method B — DevTools console**

1. Open `chrome://extensions`, enable Developer mode
2. Open DevTools on the extensions page (right-click › Inspect)
3. Run in the console:
   ```js
   chrome.management.get('gfhacaanbnknlecpaipegmlepabecchh', e => console.log(e))
   ```
   This shows the extension info but not the key directly.

**Method C — Chrome preferences file**

- **Mac:** `~/Library/Application Support/Google/Chrome/Default/Preferences`
- **Windows:** `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Preferences`
- **Linux:** `~/.config/google-chrome/Default/Preferences`

Open in a text editor, search for `gfhacaanbnknlecpaipegmlepabecchh`, find the `"manifest"` object inside it — it contains a `"key"` field. Copy that value into `manifest.json`.

#### After getting the key

Replace `PASTE_YOUR_BASE64_KEY_HERE` in `manifest.json`:

```json
"key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...",
```

Then **reload the extension** in `chrome://extensions`.

---

## Initial setup

### 1. Create a Google Cloud Project & OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g. **DocLink**)
3. Enable the **Gmail API** under *APIs & Services › Library*
4. Go to *APIs & Services › Credentials* → **Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Chrome Extension**
6. Item ID (Extension ID): `gfhacaanbnknlecpaipegmlepabecchh`
7. Copy the generated **Client ID** — already set in `manifest.json`

### 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. The DocLink icon appears in your toolbar

### 3. Generate proper icons (optional)

```bash
# Requires rsvg-convert, Inkscape, or ImageMagick
./icons/generate-icons.sh
```

---

## File structure

```
manifest.json               — Extension manifest (MV3)
popup/
  popup.html                — Popup UI
  popup.js                  — UI controller
  popup.css                 — Gmail-native styles
background/
  service-worker.js         — Gmail scanner (runs in background)
auth/
  oauth.js                  — chrome.identity OAuth2 helpers
storage/
  store.js                  — Chrome Storage CRUD abstraction
icons/
  icon16/48/128.png         — Extension icons
  generate-icons.sh         — Icon generator script
```

---

## How it works

1. **Sign in** with Google via the popup → `chrome.identity` handles OAuth2 consent
2. The **service worker** scans recent Gmail messages every 15 minutes (or on demand via the ↺ button)
3. Google Workspace URLs are extracted via regex from message bodies
4. New links are stored in `chrome.storage.local` as pending docs
5. Open the popup → pending docs appear in **En attente**
6. Click **Classer** on any doc to move it to a folder
7. Create folders freely with **+ Nouveau dossier**

---

## Permissions used

| Permission | Reason |
|---|---|
| `identity` | OAuth2 sign-in via `chrome.identity.getAuthToken` |
| `storage` | Save folders and docs locally |
| `alarms` | Periodic background scan every 15 minutes |
| `https://gmail.googleapis.com/*` | Read Gmail message list and bodies |
