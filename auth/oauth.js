/**
 * DocLink — OAuth2 helpers via chrome.identity.
 *
 * Uses the key declared in manifest.json › oauth2.
 * The token is cached by Chrome automatically.
 */

/**
 * Returns a valid access token, prompting the user to sign-in if needed.
 * @param {boolean} interactive  Whether to show the consent screen.
 */
export async function getToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
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
