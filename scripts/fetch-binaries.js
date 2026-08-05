#!/usr/bin/env node
'use strict';

/**
 * Downloads yt-dlp, ffmpeg and ffprobe into resources/bin so the installer can
 * ship them. Run before packaging; electron-builder copies the folder in via
 * extraResources, and the app then finds them without touching the network.
 *
 *   node scripts/fetch-binaries.js                      # this machine
 *   node scripts/fetch-binaries.js --platform darwin --arch arm64
 *
 * Skipping this step is fine — the app downloads whatever is missing on first run.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');

const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const FFMPEG_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/latest/download';

const YTDLP_ASSET = {
  'win32-x64': 'yt-dlp.exe',
  'win32-arm64': 'yt-dlp_arm64.exe',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
};

const FFMPEG_SLUG = {
  'win32-x64': 'win32-x64',
  'win32-arm64': 'win32-x64',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};

function parseArgs(argv) {
  const out = { platform: process.platform, arch: process.arch, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--platform') out.platform = argv[++i];
    else if (argv[i] === '--arch') out.arch = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'grabber-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

async function download(url, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const res = await get(url);
  const total = Number(res.headers['content-length']) || 0;
  let received = 0;
  const label = path.basename(destination);

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(`${destination}.part`);
    res.on('data', (chunk) => {
      received += chunk.length;
      if (total && process.stdout.isTTY) {
        process.stdout.write(`\r  ${label}  ${((received / total) * 100).toFixed(0)}%   `);
      }
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });

  await fsp.rm(destination, { force: true });
  await fsp.rename(`${destination}.part`, destination);
  await fsp.chmod(destination, 0o755).catch(() => {});
  if (process.stdout.isTTY) process.stdout.write('\r');
  console.log(`  ${label}  ${(received / 1048576).toFixed(1)} MB`);
}

async function main() {
  const { platform, arch, out } = parseArgs(process.argv.slice(2));
  const key = `${platform}-${arch}`;
  const ytdlpAsset = YTDLP_ASSET[key];
  const ffmpegSlug = FFMPEG_SLUG[key];

  if (!ytdlpAsset || !ffmpegSlug) {
    console.error(`No published builds for ${key}. Supported: ${Object.keys(YTDLP_ASSET).join(', ')}`);
    process.exit(1);
  }

  const dir = out || path.join(__dirname, '..', 'resources', 'bin');
  const ext = platform === 'win32' ? '.exe' : '';
  console.log(`Fetching tools for ${key} into ${dir}`);

  await download(`${YTDLP_RELEASE}/${ytdlpAsset}`, path.join(dir, `yt-dlp${ext}`));
  await download(`${FFMPEG_RELEASE}/ffmpeg-${ffmpegSlug}`, path.join(dir, `ffmpeg${ext}`));
  await download(`${FFMPEG_RELEASE}/ffprobe-${ffmpegSlug}`, path.join(dir, `ffprobe${ext}`));

  console.log('Done. Package now and the installer will carry these along.');
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
