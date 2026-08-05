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

module.exports = {
  DEFAULTS,
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
