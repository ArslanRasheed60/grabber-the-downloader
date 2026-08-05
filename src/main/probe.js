'use strict';

const { spawn } = require('child_process');
const binaries = require('./binaries');
const store = require('./store');
const { num, str, scrubToolNames } = require('./util');

/**
 * Ask yt-dlp what a link actually is before queueing anything.
 * One call covers both cases: a single video comes back with its formats,
 * a playlist comes back flat (fast) with one entry per item.
 */

const PROBE_TIMEOUT_MS = 120000;

function cookieArgs(settings) {
  const browser = String(settings.cookiesFrom || 'none');
  return browser && browser !== 'none' ? ['--cookies-from-browser', browser] : [];
}

function networkArgs(settings) {
  // JSON output is ASCII-escaped so it survives regardless, but error text quoted
  // back to the user comes through stderr and would otherwise lose non-Latin words.
  const args = ['--encoding', 'utf-8', '--socket-timeout', '20', '--retries', '3'];
  if (settings.proxy) args.push('--proxy', settings.proxy);
  return args;
}

/** Turn the engine's stderr into something a person can act on. */
function friendlyError(stderr, url) {
  const text = String(stderr || '').replace(/\r/g, '');
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^ERROR:/i.test(l))
    .pop();
  const raw = (line || text.split('\n').filter(Boolean).pop() || '').replace(/^ERROR:\s*/i, '').trim();

  if (/confirm (you'?re|your) not a bot|sign in to confirm/i.test(raw)) {
    return 'This site wants a signed-in session. Open Settings and pick the browser you are logged into under "Use cookies from".';
  }
  if (/unsupported url/i.test(raw)) {
    return `No extractor handles ${url}. If the page embeds a video, try the direct link to it.`;
  }
  if (/private video|members[- ]only|paid members/i.test(raw)) {
    return 'This video is private or members-only. Set "Use cookies from" to a browser with access.';
  }
  if (/video unavailable|removed by the uploader|no longer available/i.test(raw)) {
    return 'The host says this video is no longer available.';
  }
  if (/geo[- ]?restricted|not available in your country/i.test(raw)) {
    return 'The host blocks this video in your region. A proxy in Settings can get around it.';
  }
  if (/unable to download webpage|getaddrinfo|network is unreachable|timed out/i.test(raw)) {
    return 'Could not reach the site. Check your connection and try again.';
  }
  if (/requested format is not available/i.test(raw)) {
    return 'That quality is not published for this video. Try "Best available".';
  }
  // Nothing matched, so the engine's own words get quoted back — with its name,
  // and any link that would reveal it, taken out.
  return scrubToolNames(raw) || 'Grabber could not read this link.';
}

function pickThumbnail(info) {
  if (info.thumbnail) return info.thumbnail;
  const list = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  if (!list.length) return null;
  // Prefer a mid-size still: big enough to look sharp, small enough to load instantly.
  const sorted = list
    .filter((t) => t && t.url)
    .sort((a, b) => (a.width || 0) - (b.width || 0));
  const mid = sorted.find((t) => (t.width || 0) >= 320) || sorted[sorted.length - 1];
  return mid ? mid.url : null;
}

function describeFormats(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const heights = new Set();
  let hasAudioOnly = false;
  for (const f of formats) {
    if (!f) continue;
    const height = num(f.height);
    const vcodec = String(f.vcodec || 'none');
    const acodec = String(f.acodec || 'none');
    if (height && vcodec !== 'none') heights.add(height);
    if (vcodec === 'none' && acodec !== 'none') hasAudioOnly = true;
  }
  return {
    heights: [...heights].sort((a, b) => b - a),
    hasAudioOnly,
    formatCount: formats.length,
  };
}

function normalizeEntry(entry, parent) {
  const id = str(entry.id);
  let url = str(entry.url) || str(entry.webpage_url);
  if (url && !/^https?:\/\//i.test(url) && id) {
    // Flat playlists from some extractors give a bare id; rebuild a usable link.
    url = String(parent.webpage_url || '').includes('youtube')
      ? `https://www.youtube.com/watch?v=${id}`
      : url;
  }
  return {
    id,
    url,
    title: str(entry.title) || str(entry.id) || 'Untitled',
    duration: num(entry.duration),
    thumbnail: pickThumbnail(entry),
    uploader: str(entry.uploader) || str(entry.channel) || str(parent.uploader),
  };
}

/**
 * @returns {Promise<{type:'video'|'playlist', ...}>}
 */
function probe(url, { playlist = false, signal } = {}) {
  const settings = store.getSettings();
  return binaries.inspect('ytdlp').then(
    (tool) =>
      new Promise((resolve, reject) => {
        if (!tool.ok) {
          return reject(new Error('The download engine is not installed yet. Finish setup first.'));
        }

        const args = [
          '--ignore-config',
          '--no-warnings',
          '--dump-single-json',
          '--flat-playlist',
          ...(playlist ? [] : ['--no-playlist']),
          ...networkArgs(settings),
          ...cookieArgs(settings),
          url,
        ];

        const child = spawn(tool.path, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };

        const timer = setTimeout(() => {
          child.kill();
          finish(reject, new Error('The site took too long to answer. Try again.'));
        }, PROBE_TIMEOUT_MS);

        if (signal) {
          signal.addEventListener('abort', () => {
            child.kill();
            finish(reject, new Error('Canceled'));
          });
        }

        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', (err) =>
          finish(reject, new Error(`Could not start the download engine: ${err.message}`))
        );

        child.on('close', (code) => {
          if (code !== 0 || !stdout.trim()) {
            return finish(reject, new Error(friendlyError(stderr, url)));
          }
          let info;
          try {
            info = JSON.parse(stdout);
          } catch {
            return finish(reject, new Error('That link returned something Grabber could not read.'));
          }

          const isPlaylist = info._type === 'playlist' || Array.isArray(info.entries);
          if (isPlaylist) {
            const entries = (info.entries || [])
              .filter(Boolean)
              .map((entry) => normalizeEntry(entry, info))
              .filter((entry) => entry.url);
            return finish(resolve, {
              type: 'playlist',
              id: str(info.id),
              title: str(info.title) || 'Playlist',
              uploader: str(info.uploader) || str(info.channel),
              webpageUrl: str(info.webpage_url) || url,
              extractor: str(info.extractor_key) || str(info.extractor),
              thumbnail: pickThumbnail(info) || (entries[0] && entries[0].thumbnail) || null,
              count: entries.length,
              entries,
            });
          }

          const formats = describeFormats(info);
          finish(resolve, {
            type: 'video',
            id: str(info.id),
            title: str(info.title) || 'Untitled',
            uploader: str(info.uploader) || str(info.channel) || str(info.uploader_id),
            duration: num(info.duration),
            thumbnail: pickThumbnail(info),
            webpageUrl: str(info.webpage_url) || url,
            extractor: str(info.extractor_key) || str(info.extractor),
            isLive: Boolean(info.is_live),
            liveStatus: str(info.live_status),
            viewCount: num(info.view_count),
            uploadDate: str(info.upload_date),
            ...formats,
          });
        });
      })
  );
}

module.exports = { probe, friendlyError };
