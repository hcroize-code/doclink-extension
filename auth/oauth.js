/**
 * DocLink — OAuth2 helpers.
 *
 * Two OAuth clients are used:
 *
 *  1. EXTENSION_CLIENT_ID — type "Chrome Extension" in Google Cloud Console
 *     Used by chrome.identity.getAuthToken (Chrome handles flow internally).
 *
 *  2. WEB_CLIENT_ID — type "Web Application" in Google Cloud Console
 *     Used by launchWebAuthFlow (implicit token flow) when getAuthToken fails.
 *     Required setup in Google Cloud Console:
 *       → Edit the Web Application client
 *       → Authorized redirect URIs → Add URI:
 *         https://hhlfjpncjejeohbbkkmeoibopkaklnki.chromiumapp.org/
 *       → Save
 */

const EXTENSION_CLIENT_ID =
  '779013325294-81h2mgvd61borau1bfrsviv922cqee8j.apps.googleusercontent.com';

// Web Application type client — supports launchWebAuthFlow with chromiumapp.org
const WEB_CLIENT_ID =
  '779013325294-rqnil7qjaf4cqi1l9fvjg706c1a550i3.apps.googleusercontent.com';

const SCOPE         = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_KEY     = 'doclink_token';

/* ── token cache ─────────────────────────────────────────────────────── */

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

/* ── fallback: launchWebAuthFlow — implicit token flow ───────────────── */

async function _webAuthFlow(interactive) {
  const cached = await getCached();
  if (cached) return cached;
  if (!interactive) throw new Error('Not signed in');

  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;

  // Implicit flow: Google returns access_token directly in the redirect hash.
  // Chrome intercepts the chromiumapp.org redirect before it hits any server.
  const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
    client_id:     WEB_CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'token',
    scope:         SCOPE,
    prompt:        'select_account',
  })}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, responseUrl => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!responseUrl) {
        return reject(new Error('Sign-in was cancelled.'));
      }
      try {
        // Token is in the URL hash: #access_token=TOKEN&expires_in=3600&...
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
