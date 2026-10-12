'use strict';

// Both metadata lookup and downloads must use the same runtime and cookie policy.
// Electron already ships Node, including in packaged apps. Give yt-dlp its exact
// executable and launch child runtimes in Node mode instead of opening another UI.
function runtimeArgs() {
  return ['--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`];
}

function spawnOptions() {
  return { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
}

function cookieArgs(settings, withoutBrowserCookies = false) {
  if (settings.cookiesFile) return ['--cookies', String(settings.cookiesFile)];
  const browser = String(settings.cookiesFrom || 'none');
  return !withoutBrowserCookies && browser !== 'none'
    ? ['--cookies-from-browser', browser]
    : [];
}

function shouldRetryWithoutBrowser(settings, stderr) {
  if (settings.cookiesFile || !settings.cookiesFrom || settings.cookiesFrom === 'none') return false;
  // Only retry failures reading the local browser store. Authentication failures,
  // bad exported files and network errors must retain their original meaning.
  return /could not copy.*cookie|(?:could not find|unable to (?:open|read)|failed to (?:open|read)).*cookie|failed to decrypt|\bDPAPI\b|app.?bound.*encrypt/i.test(stderr);
}

const COOKIE_RETRY_NOTICE =
  'Could not read browser cookies. Retrying without browser sign-in for this video. For videos that need sign-in, use Firefox or an exported cookies.txt in Settings.';

function isMediaForbidden(stderr) {
  return /unable to download video data[^\n]*HTTP Error 403/i.test(stderr);
}

function downloadArgs(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return []; }
  // YouTube can accept short range requests while rejecting or stalling a full
  // media request. Bound each request; this also keeps long downloads resumable.
  return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')
    ? ['--http-chunk-size', '10M']
    : [];
}

const MEDIA_RETRY_NOTICE =
  'The video host refused a media link. Refreshing links and checking available formats before retrying.';

module.exports = {
  runtimeArgs, spawnOptions, cookieArgs, shouldRetryWithoutBrowser, COOKIE_RETRY_NOTICE,
  isMediaForbidden, MEDIA_RETRY_NOTICE, downloadArgs,
};
