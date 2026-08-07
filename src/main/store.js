'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Settings + history live in two small JSON files under userData.
 * Writes are debounced so a fast-moving queue never thrashes the disk.
 */

const DEFAULTS = {
  downloadDir: app.getPath('downloads'),
  quality: 'best',
  container: 'mp4',
  audioFormat: 'mp3',
  maxConcurrent: 2,
  concurrentFragments: 4,
  limitRate: '',
  proxy: '',
  cookiesFrom: 'none',
  // A Netscape-format cookies.txt. Chromium browsers on Windows encrypt their
  // cookie store in a way yt-dlp cannot read, so this is the reliable way in.
  cookiesFile: '',
  embedThumbnail: true,
  embedMetadata: true,
  embedChapters: true,
  writeSubs: false,
  subLangs: 'en.*',
  sponsorblock: false,
  playlistFolders: true,
  ytdlpPath: '',
  ffmpegPath: '',
  windowBounds: null,
};

const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const historyFile = path.join(app.getPath('userData'), 'history.json');

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

let settings = { ...DEFAULTS, ...readJson(settingsFile, {}) };
let history = Array.isArray(readJson(historyFile, [])) ? readJson(historyFile, []) : [];

const timers = new Map();
function writeSoon(file, getData, delay = 400) {
  clearTimeout(timers.get(file));
  timers.set(
    file,
    setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(getData(), null, 2), 'utf8');
      } catch (err) {
        console.error(`Could not save ${path.basename(file)}:`, err.message);
      }
    }, delay)
  );
}

function flush() {
  for (const [file, timer] of timers) {
    clearTimeout(timer);
    timers.delete(file);
    void file;
  }
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not flush state:', err.message);
  }
}

// The unit is optional — a bare number is the whole point of normalising here.
const RATE = /^(\d+(?:\.\d+)?)\s*([KMG])?B?\/?S?$/i;
const PROXY = /^(https?|socks4a?|socks5h?):\/\/\S+$/i;

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * Settings arrive from a text field, so they have to be checked before they become
 * command-line arguments. Two of these are traps rather than typos:
 *
 *  - a bare number in the speed limit means bytes per second to the engine, so "5"
 *    caps the download at 5 B/s and looks exactly like a hang;
 *  - a malformed proxy is accepted silently and then fails every single download
 *    with an error that points nowhere near Settings.
 *
 * Both now fail loudly at the point of entry instead.
 */
function sanitizePatch(patch) {
  const clean = { ...patch };
  delete clean.windowBounds;

  if (typeof clean.limitRate === 'string') {
    const value = clean.limitRate.trim();
    if (!value) {
      clean.limitRate = '';
    } else {
      const match = RATE.exec(value);
      if (!match) {
        throw new Error('Speed limit should look like 5M, 800K or 2.5M. Leave it blank for full speed.');
      }
      clean.limitRate = `${match[1]}${(match[2] || 'M').toUpperCase()}`;
    }
  }

  if (typeof clean.proxy === 'string') {
    const value = clean.proxy.trim();
    if (value && !PROXY.test(value)) {
      throw new Error('Proxy should look like socks5://127.0.0.1:1080 or http://host:8080. Leave it blank for none.');
    }
    clean.proxy = value;
  }

  if (clean.maxConcurrent !== undefined) clean.maxConcurrent = clampInt(clean.maxConcurrent, 1, 8);
  if (clean.concurrentFragments !== undefined) {
    clean.concurrentFragments = clampInt(clean.concurrentFragments, 1, 16);
  }
  if (typeof clean.cookiesFile === 'string') {
    const value = clean.cookiesFile.trim().replace(/^"|"$/g, '');
    if (value && !fs.existsSync(value)) {
      throw new Error('There is no file at that path. Pick your cookies file with Browse.');
    }
    clean.cookiesFile = value;
  }
  if (typeof clean.subLangs === 'string') clean.subLangs = clean.subLangs.trim() || 'en.*';
  if (typeof clean.downloadDir === 'string') clean.downloadDir = clean.downloadDir.trim();

  return clean;
}

module.exports = {
  DEFAULTS,
  sanitizePatch,
  getSettings() {
    return { ...settings };
  },
  updateSettings(patch) {
    settings = { ...settings, ...patch };
    writeSoon(settingsFile, () => settings);
    return { ...settings };
  },
  getHistory() {
    return history.slice();
  },
  addHistory(entry) {
    history.unshift(entry);
    if (history.length > 300) history.length = 300;
    writeSoon(historyFile, () => history);
  },
  clearHistory() {
    history = [];
    writeSoon(historyFile, () => history, 0);
  },
  flush,
};
