/**
 * DocLink — OAuth2 helpers.
 *
 * Primary:  chrome.identity.getAuthToken   (works when extension is published
 *           or the Chrome Extension OAuth client is verified)
 * Fallback: chrome.identity.launchWebAuthFlow  (always works for unpacked
 *           extensions — uses the standard OAuth2 implicit token flow)
 */

const CLIENT_ID =
  '779013325294-81h2mgvd61borau1bfrsviv922cqee8j.apps.googleusercontent.com';
const SCOPE         = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_KEY     = 'doclink_webflow_token'; // stored in chrome.storage.session

/* ── session token cache (for web-flow tokens) ───────────────────────── */

const session = () => chrome.storage.session ?? chrome.storage.local;

async function getCached() {
  return new Promise(resolve => {
    session().get(TOKEN_KEY, r => {
      const c = r[TOKEN_KEY];
      resolve(c && c.exp > Date.now() ? c.token : null);
    });
  });
}

async function setCached(token, expiresInSec) {
  const exp = Date.now() + (expiresInSec - 60) * 1000; // 60 s safety margin
  return new Promise(resolve => session().set({ [TOKEN_KEY]: { token, exp } }, resolve));
}

async function clearCached() {
  return new Promise(resolve => session().remove(TOKEN_KEY, resolve));
}

/* ── primary: getAuthToken ────────────────────────────────────────────── */

function _getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      chrome.runtime.lastError
        ? reject(new Error(chrome.runtime.lastError.message))
        : resolve(token);
    });
  });
}

/* ── fallback: launchWebAuthFlow (implicit token flow) ───────────────── */

async function _webAuthFlow(interactive) {
  // Return cached token if still valid
  const cached = await getCached();
  if (cached) return cached;

  if (!interactive) throw new Error('Not signed in');

  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const url = `${AUTH_ENDPOINT}?${new URLSearchParams({
    client_id:    CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope:         SCOPE,
    prompt:        'select_account',
  })}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, responseUrl => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!responseUrl) {
        return reject(new Error('Sign-in was cancelled.'));
      }
      try {
        // Token is in the URL hash: #access_token=...&expires_in=3600&...
        const hash   = new URL(responseUrl).hash.slice(1);
        const params = new URLSearchParams(hash);
        const token  = params.get('access_token');
        const expIn  = parseInt(params.get('expires_in') ?? '3600', 10);
        if (!token) throw new Error('No access_token in OAuth response.');
        setCached(token, expIn);
        resolve(token);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/* ── public API ──────────────────────────────────────────────────────── */

/**
 * Returns a valid access token.
 * Tries getAuthToken first; if Chrome rejects it (bad client, -106, etc.)
 * falls back to launchWebAuthFlow which always works for unpacked extensions.
 */
export async function getToken(interactive = true) {
  try {
    return await _getAuthToken(interactive);
  } catch {
    return await _webAuthFlow(interactive);
  }
}

/**
 * Signs the user out: clears both cached web-flow token and Chrome's token.
 */
export async function revokeToken() {
  await clearCached();

  const token = await _getAuthToken(false).catch(() => null);
  if (!token) return;

  await new Promise(resolve => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
  fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).catch(() => {});
}

/**
 * True if a valid token exists (without triggering a sign-in prompt).
 */
export async function isSignedIn() {
  try {
    const token = await getToken(false);
    return !!token;
  } catch {
    return false;
  }
}
