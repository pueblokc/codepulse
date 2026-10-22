/**
 * Small, pure security helpers used by the main process.
 */

const path = require('path');
const { pathToFileURL } = require('url');

/** Only plain web links may be handed to the OS browser. */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** True if `target` resolves to a location inside `root` (no traversal, no NUL). */
function isPathInside(root, target) {
  if (typeof target !== 'string' || !target || target.includes('\0')) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True if an IPC sender URL is our own bundled renderer page. */
function isTrustedRendererUrl(senderUrl, indexHtmlPath) {
  if (typeof senderUrl !== 'string') return false;
  const expected = pathToFileURL(indexHtmlPath).href;
  return senderUrl.split(/[?#]/)[0] === expected;
}

module.exports = { isSafeExternalUrl, isPathInside, isTrustedRendererUrl };
