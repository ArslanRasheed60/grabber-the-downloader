'use strict';

/** Small shared helpers for the main process. */

let counter = 0;
function makeId(prefix = 'j') {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/** yt-dlp prints "NA" for absent numbers; turn anything unusable into null. */
function num(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text === 'NA' || text === 'None') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text === 'NA' || text === 'None') return null;
  return text;
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Strip characters Windows (and everyone else) refuses in a path segment.
 * Hyphens stay — they are legal everywhere and common in playlist names.
 */
function sanitizeSegment(name, max = 120) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
  return (cleaned || 'untitled').slice(0, max);
}

/**
 * The interface never names the underlying tool — it talks about "the download
 * engine". Static copy is written that way; this handles the text we do not author:
 * the engine's own stdout in the log pane, and error text quoted back to the user.
 * Links that carry the name are dropped rather than mangled into dead URLs.
 */
const ENGINE_LABEL = 'engine';

// Matches the hyphenated name, the bare one, and the underscored module name that
// shows up in tracebacks.
const TOOL_NAME = /yt[-_ ]?dlp/gi;
const TOOL_LINK = /https?:\/\/\S*yt[-_]?dlp\S*/gi;

function scrubToolNames(text) {
  return String(text)
    .replace(TOOL_LINK, '')
    .replace(TOOL_NAME, ENGINE_LABEL)
    .replace(/ {2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1');
}

/**
 * A filename reduced to the part that survives a bad encoding round-trip.
 * The engine used to write its stdout in the console code page, dropping every
 * character it could not represent, so a path recorded then does not string-match
 * the file on disk. Comparing on the ASCII skeleton finds it anyway.
 */
function asciiKey(name) {
  return String(name)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Every name this app writes ends in "[id].ext", and an id is always ASCII — so it
 * survives mangling and renaming, which makes it the most reliable way back to a file.
 */
function idTokenFrom(fileName) {
  const match = String(fileName || '').match(/\[([^[\]]{3,})\]\.[^.]+$/);
  return match ? match[1] : null;
}

/** Literal text inside an output template must not contain "%(". */
function escapeOutputLiteral(text) {
  return String(text).replace(/%/g, '%%');
}

function isProbablyUrl(text) {
  if (!text) return false;
  return /^(https?:\/\/|www\.)\S+$/i.test(String(text).trim());
}

/** Pull every http(s) URL out of a blob of pasted text, in order, de-duplicated. */
function extractUrls(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s"'<>)\]]+/gi) || [];
  const seen = new Set();
  const out = [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function throttle(fn, wait) {
  let last = 0;
  let timer = null;
  let pending = null;
  const run = () => {
    last = Date.now();
    timer = null;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  return (...args) => {
    pending = args;
    const elapsed = Date.now() - last;
    if (elapsed >= wait) {
      run();
    } else if (!timer) {
      timer = setTimeout(run, wait - elapsed);
    }
  };
}

module.exports = {
  ENGINE_LABEL,
  scrubToolNames,
  asciiKey,
  idTokenFrom,
  makeId,
  num,
  str,
  formatBytes,
  formatDuration,
  sanitizeSegment,
  escapeOutputLiteral,
  isProbablyUrl,
  extractUrls,
  throttle,
};
