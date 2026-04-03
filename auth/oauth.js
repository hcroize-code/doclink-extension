/**
 * DocLink — OAuth2 helpers.
 *
 * Two OAuth clients are used:
 *
 *  1. EXTENSION_CLIENT_ID  — type "Chrome Extension" in Google Cloud Console
 *     Used by chrome.identity.getAuthToken (Chrome handles the flow internally)
 *
 *  2. DESKTOP_CLIENT_ID    — type "Desktop app" in Google Cloud Console
 *     Used by launchWebAuthFlow + PKCE when getAuthToken fails (e.g. unpacked
 *     extensions, development).  Desktop app clients support authorization code
 *     + PKCE with no client secret.
 *
 * How to create DESKTOP_CLIENT_ID:
 *   Google Cloud Console › APIs & Services › Credentials
 *   → Create Credentials → OAuth 2.0 Client ID
 *   → Application type: Desktop app
 *   → Name: DocLink Desktop
 *   → Copy the client ID and paste it below as DESKTOP_CLIENT_ID.
 *   No redirect URI registration is needed — Chrome handles chromiumapp.org.
 */

const EXTENSION_CLIENT_ID =
  '779013325294-81h2mgvd61borau1bfrsviv922cqee8j.apps.googleusercontent.com';

const DESKTOP_CLIENT_ID =
  '779013325294-rqnil7qjaf4cqi1l9fvjg706c1a550i3.apps.googleusercontent.com';

const SCOPE         = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT= 'https://oauth2.googleapis.com/token';
const TOKEN_KEY     = 'doclink_token';

/* ── token cache (chrome.storage.session when available) ─────────────── */

const store = () => chrome.storage.session ?? chrome.storage.local;

async function getCached() {
  return new Promise(resolve => {
    store().get(TOKEN_KEY, r => {
      const c = r[TOKEN_KEY];
      resolve(c && c.exp > Date.now() ? c.token : null);
    });
  });
}

async function setCached(token, expiresInSec) {
  const exp = Date.now() + (expiresInSec - 60) * 1000;
  return new Promise(resolve => store().set({ [TOKEN_KEY]: { token, exp } }, resolve));
}

async function clearCached() {
  return new Promise(resolve => store().remove(TOKEN_KEY, resolve));
}

/* ── PKCE helpers ────────────────────────────────────────────────────── */

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function pkce() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier      = base64url(verifierBytes);
  const challenge     = base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  return { verifier, challenge };
}

/* ── primary: chrome.identity.getAuthToken ───────────────────────────── */

function _getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : resolve(token);
    });
  });
}

/* ── fallback: launchWebAuthFlow + PKCE (Desktop app client) ─────────── */

async function _webAuthFlow(interactive) {
  const cached = await getCached();
  if (cached) return cached;
  if (!interactive) throw new Error('Not signed in');

  if (DESKTOP_CLIENT_ID.startsWith('YOUR_')) {
    throw new Error(
      'Web auth fallback not configured. ' +
      'Create a Desktop app OAuth client in Google Cloud Console and ' +
      'set DESKTOP_CLIENT_ID in auth/oauth.js.'
    );
  }

  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const { verifier, challenge } = await pkce();

  const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
    client_id:             DESKTOP_CLIENT_ID,
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 SCOPE,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    access_type:           'online',
    prompt:                'select_account',
  })}`;

  // Step 1: get authorization code via the browser
  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, url => {
      chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : url
          ? resolve(url)
          : reject(new Error('Sign-in was cancelled.'));
    });
  });

  const code = new URL(responseUrl).searchParams.get('code');
  if (!code) throw new Error('No authorization code in OAuth response.');

  // Step 2: exchange code + PKCE verifier for access token (no client secret needed)
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     DESKTOP_CLIENT_ID,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
      code_verifier: verifier,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Token exchange failed: ${data.error_description ?? data.error ?? res.status}`
    );
  }

  const token = data.access_token;
  await setCached(token, data.expires_in ?? 3600);
  return token;
}

/* ── public API ──────────────────────────────────────────────────────── */

export async function getToken(interactive = true) {
  try {
    return await _getAuthToken(interactive);
  } catch {
    return await _webAuthFlow(interactive);
  }
}

export async function revokeToken() {
  await clearCached();
  const token = await _getAuthToken(false).catch(() => null);
  if (!token) return;
  await new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
  fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).catch(() => {});
}

export async function isSignedIn() {
  try {
    return !!(await getToken(false));
  } catch {
    return false;
  }
}
