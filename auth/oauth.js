/**
 * DocLink — OAuth2 helpers via chrome.identity.
 *
 * Uses the key declared in manifest.json › oauth2.
 * The token is cached by Chrome automatically.
 */

// Human-readable translations of Chrome's opaque identity errors.
const ERROR_HINTS = {
  'bad client id':
    'OAuth client not configured. In Google Cloud Console: ' +
    'APIs & Services › Credentials › your OAuth client › ' +
    'make sure it is type "Chrome Extension" and Application ID = ' +
    chrome.runtime.id,
  'OAuth2 not granted or revoked':
    'Access was revoked. Click Sign in to reconnect.',
  'Connection failed':
    'Could not reach Google\'s auth servers (error -106). ' +
    'Check network connectivity, or ensure the manifest "key" field ' +
    'matches the extension ID registered in Google Cloud Console.',
  'The user did not approve access':
    'Sign-in was cancelled.',
};

function humanizeError(raw) {
  for (const [fragment, hint] of Object.entries(ERROR_HINTS)) {
    if (raw.includes(fragment)) return hint;
  }
  return raw;
}

/**
 * Returns a valid access token, prompting the user to sign-in if needed.
 * @param {boolean} interactive  Whether to show the consent screen.
 */
export async function getToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        const raw = chrome.runtime.lastError.message ?? 'Unknown error';
        reject(new Error(humanizeError(raw)));
      } else {
        resolve(token);
      }
    });
  });
}

/**
 * Revoke the cached token and force re-login on next call.
 */
export async function revokeToken() {
  const token = await getToken(false).catch(() => null);
  if (!token) return;

  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => {
      // Best-effort server-side revocation
      fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`).catch(() => {});
      resolve();
    });
  });
}

/**
 * Returns true if the user is currently signed-in (token exists without prompting).
 */
export async function isSignedIn() {
  const token = await getToken(false).catch(() => null);
  return token !== null;
}
