'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFile, spawn } = require('child_process');
const { app } = require('electron');
const store = require('./store');

/**
 * Everything the app needs to run is a plain executable, so the bootstrapper
 * never has to unpack an archive: yt-dlp ships single-file builds, and
 * ffmpeg-static publishes standalone ffmpeg/ffprobe per platform and arch.
 *
 * Lookup order for each tool:
 *   1. an explicit path the user set in Settings
 *   2. binaries shipped inside the installer (resources/bin)
 *   3. binaries this app downloaded earlier (userData/bin)
 *   4. whatever is already on PATH
 * If none of those turn up, onboarding downloads it.
 */

const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const FFMPEG_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/latest/download';

const YTDLP_ASSET = {
  'win32-x64': 'yt-dlp.exe',
  'win32-arm64': 'yt-dlp_arm64.exe',
  'win32-ia32': 'yt-dlp_x86.exe',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'linux-arm': 'yt-dlp_linux_armv7l.zip',
};

// ffmpeg-static has no Windows-on-ARM build; the x64 build runs under emulation.
const FFMPEG_SLUG = {
  'win32-x64': 'win32-x64',
  'win32-arm64': 'win32-x64',
  'win32-ia32': 'win32-x64',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'linux-arm': 'linux-arm',
  'linux-ia32': 'linux-ia32',
};

const platformKey = `${process.platform}-${process.arch}`;
const isWindows = process.platform === 'win32';
const exe = (name) => (isWindows ? `${name}.exe` : name);

const TOOLS = {
  // `label` is what the interface shows; the file name stays as published upstream.
  ytdlp: {
    label: 'Download engine',
    file: exe('yt-dlp'),
    versionArgs: ['--version'],
    settingKey: 'ytdlpPath',
  },
  ffmpeg: { label: 'ffmpeg', file: exe('ffmpeg'), versionArgs: ['-version'], settingKey: 'ffmpegPath' },
  ffprobe: { label: 'ffprobe', file: exe('ffprobe'), versionArgs: ['-version'], settingKey: '' },
};

function managedDir() {
  return path.join(app.getPath('userData'), 'bin');
}

/** Binaries placed next to the app by the installer (see scripts/fetch-binaries.js). */
function bundledDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(app.getAppPath(), 'resources', 'bin');
}

function downloadUrlFor(tool) {
  if (tool === 'ytdlp') {
    const asset = YTDLP_ASSET[platformKey] || YTDLP_ASSET[`${process.platform}-x64`];
    return asset ? `${YTDLP_RELEASE}/${asset}` : null;
  }
  const slug = FFMPEG_SLUG[platformKey] || FFMPEG_SLUG[`${process.platform}-x64`];
  if (!slug) return null;
  return `${FFMPEG_RELEASE}/${tool}-${slug}`;
}

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 1024) return false;
    if (!isWindows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Places tools live that PATH may not mention. On macOS this is load-bearing, not a
 * nicety: a GUI app launched from Finder gets a minimal PATH without /opt/homebrew/bin,
 * so a brew-installed ffmpeg is invisible unless we look for it ourselves. On Windows,
 * winget links new installs here, and the current process's PATH predates them.
 */
function wellKnownDirs() {
  if (isWindows) {
    return [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links')];
  }
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin'];
  }
  return ['/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
}

/** Walk PATH ourselves — cheaper and more predictable than shelling out to where/which. */
function findOnPath(fileName) {
  const dirs = [
    ...String(process.env.PATH || '').split(path.delimiter),
    ...wellKnownDirs(),
  ].filter(Boolean);
  const candidates = isWindows
    ? [fileName, ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT')
        .split(';')
        .filter(Boolean)
        .map((ext) => path.basename(fileName, path.extname(fileName)) + ext.toLowerCase())]
    : [fileName];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir.replace(/^"|"$/g, ''), candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

function runVersion(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout || '').split(/\r?\n/)[0].trim();
      resolve(first || 'unknown');
    });
  });
}

/** Where would this tool come from right now, without downloading anything? */
function locate(tool) {
  const meta = TOOLS[tool];
  const override = meta.settingKey ? String(store.getSettings()[meta.settingKey] || '').trim() : '';
  if (override && isExecutableFile(override)) return { path: override, source: 'custom' };

  const bundled = path.join(bundledDir(), meta.file);
  if (isExecutableFile(bundled)) return { path: bundled, source: 'bundled' };

  const managed = path.join(managedDir(), meta.file);
  if (isExecutableFile(managed)) return { path: managed, source: 'managed' };

  const onPath = findOnPath(meta.file);
  if (onPath) return { path: onPath, source: 'system' };

  return { path: null, source: null };
}

const versionCache = new Map();

/** yt-dlp versions are release dates (2026.07.04), so age is readable straight off. */
function ytDlpAgeDays(version) {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(String(version || '').trim());
  if (!match) return null;
  const released = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.floor((Date.now() - released) / 86400000);
}

async function inspect(tool) {
  const meta = TOOLS[tool];
  const found = locate(tool);
  if (!found.path) {
    return { tool, label: meta.label, ok: false, path: null, source: null, version: null };
  }
  let version = versionCache.get(found.path);
  if (version === undefined) {
    version = await runVersion(found.path, meta.versionArgs);
    versionCache.set(found.path, version);
  }
  return {
    tool,
    label: meta.label,
    ok: Boolean(version),
    path: found.path,
    source: found.source,
    version: version || null,
    ageDays: tool === 'ytdlp' ? ytDlpAgeDays(version) : null,
  };
}

async function getStatus() {
  const [ytdlp, ffmpeg, ffprobe] = await Promise.all([inspect('ytdlp'), inspect('ffmpeg'), inspect('ffprobe')]);
  return {
    platform: platformKey,
    managedDir: managedDir(),
    ytdlp,
    ffmpeg,
    ffprobe,
    // ffprobe is optional: yt-dlp merges and converts with ffmpeg alone.
    ready: ytdlp.ok && ffmpeg.ok,
  };
}

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'Grabber', Accept: '*/*' }, timeout: 60000 },
      (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          const next = new URL(headers.location, url).toString();
          return resolve(httpGet(next, redirects + 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`Download failed with HTTP ${statusCode}`));
        }
        resolve(res);
      }
    );
    request.on('timeout', () => request.destroy(new Error('Connection timed out')));
    request.on('error', reject);
  });
}

async function downloadTo(url, destination, onProgress) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.part-${process.pid}`;
  const res = await httpGet(url);
  const total = Number(res.headers['content-length']) || null;
  let received = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(temp);
    res.on('data', (chunk) => {
      received += chunk.length;
      if (onProgress) onProgress(received, total);
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });

  if (total && received !== total) {
    await fsp.rm(temp, { force: true });
    throw new Error('Download ended early — check your connection and try again.');
  }

  await fsp.rm(destination, { force: true }).catch(() => {});
  await fsp.rename(temp, destination);
  if (!isWindows) await fsp.chmod(destination, 0o755);
  return destination;
}

/**
 * Apple Silicon refuses to run an arm64 binary without a signature, and Gatekeeper
 * blocks quarantined files. Both fixes are best-effort and harmless elsewhere.
 */
function clearMacRestrictions(file) {
  if (process.platform !== 'darwin') return Promise.resolve();
  const run = (cmd, args) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
  return run('xattr', ['-d', 'com.apple.quarantine', file])
    .then(() => run('codesign', ['--force', '--sign', '-', file]))
    .catch(() => {});
}

/**
 * Download whatever is missing. onEvent reports {tool, label, phase, received, total, percent}
 * so onboarding can show real progress instead of a spinner.
 */
/* ------------------------------------------------ package-manager fallback */

/**
 * The direct download is the primary route: no admin rights, no package manager,
 * works the same everywhere. These run only when it fails — a firewall that blocks
 * GitHub but allows winget/brew traffic is the typical reason.
 */
const WINGET_ID = { ytdlp: 'yt-dlp.yt-dlp', ffmpeg: 'Gyan.FFmpeg', ffprobe: 'Gyan.FFmpeg' };
const BREW_PKG = { ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', ffprobe: 'ffmpeg' };

function packageManagerPlan(tool, platform = process.platform) {
  if (platform === 'win32') {
    return [
      {
        manager: 'winget',
        cmd: 'winget',
        args: [
          'install',
          '--id',
          WINGET_ID[tool],
          '--exact',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
          '--disable-interactivity',
        ],
      },
    ];
  }
  if (platform === 'darwin') {
    return [{ manager: 'brew', cmd: 'brew', args: ['install', BREW_PKG[tool]] }];
  }
  return [];
}

function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: 'took too long' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.code === 'ENOENT' ? 'not installed' : err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, error: code === 0 ? null : `exited with ${code}`, output });
    });
  });
}

async function installViaPackageManager(tool, onEvent) {
  const meta = TOOLS[tool];
  for (const step of packageManagerPlan(tool)) {
    onEvent({ tool, label: meta.label, phase: 'pm', manager: step.manager });
    const result = await runCommand(step.cmd, step.args, 8 * 60 * 1000);
    if (!result.ok) {
      onEvent({ tool, label: meta.label, phase: 'pm-failed', manager: step.manager, error: result.error });
      continue;
    }
    // The install landed somewhere PATH may not know yet; wellKnownDirs covers it.
    versionCache.clear();
    const found = locate(tool);
    if (found.path) {
      const version = await runVersion(found.path, meta.versionArgs);
      if (version) {
        onEvent({ tool, label: meta.label, phase: 'done', percent: 100, version, method: step.manager });
        return { tool, ok: true, path: found.path, version, method: step.manager };
      }
    }
    onEvent({
      tool,
      label: meta.label,
      phase: 'pm-failed',
      manager: step.manager,
      error: 'finished but the tool did not appear',
    });
  }
  return null;
}

/** A download interrupted by a quit or a crash leaves a .part file behind. */
async function sweepPartials() {
  try {
    const dir = managedDir();
    const entries = await fsp.readdir(dir);
    await Promise.all(
      entries
        .filter((name) => name.includes('.part-'))
        .map((name) => fsp.rm(path.join(dir, name), { force: true }))
    );
  } catch {
    /* nothing there yet */
  }
}

async function installOne(tool, onEvent) {
  const meta = TOOLS[tool];
  const url = downloadUrlFor(tool);
  let directError = null;

  if (url) {
    const destination = path.join(managedDir(), meta.file);
    onEvent({ tool, label: meta.label, phase: 'start', received: 0, total: null, percent: 0 });
    try {
      await downloadTo(url, destination, (received, total) => {
        onEvent({
          tool,
          label: meta.label,
          phase: 'downloading',
          received,
          total,
          percent: total ? Math.min(100, (received / total) * 100) : null,
        });
      });
      await clearMacRestrictions(destination);
      versionCache.delete(destination);
      const version = await runVersion(destination, meta.versionArgs);
      if (!version) throw new Error(`${meta.label} downloaded but would not run on this machine.`);
      onEvent({ tool, label: meta.label, phase: 'done', percent: 100, version, method: 'download' });
      return { tool, ok: true, path: destination, version, method: 'download' };
    } catch (err) {
      directError = err.message;
      onEvent({ tool, label: meta.label, phase: 'fallback', error: err.message });
    }
  } else {
    directError = `${meta.label} has no direct download for ${platformKey}.`;
  }

  const viaManager = await installViaPackageManager(tool, onEvent);
  if (viaManager) return viaManager;

  const error = directError || `${meta.label} could not be installed.`;
  onEvent({ tool, label: meta.label, phase: 'error', error });
  return { tool, ok: false, error };
}

/**
 * Installs are serialized. Two paths can ask at once — the boot screen's button and
 * the background self-heal — and both write the same temp file for a given tool, so
 * letting them interleave risks a corrupt binary.
 */
let installLock = Promise.resolve();

function install(tools, onEvent = () => {}) {
  const run = async () => {
    await sweepPartials();
    const results = [];
    for (const tool of tools) {
      results.push(await installOne(tool, onEvent));
    }
    return results;
  };
  const next = installLock.then(run, run);
  installLock = next.catch(() => {});
  return next;
}

/** Install only what is actually missing. */
async function ensureAll(onEvent) {
  const status = await getStatus();
  const missing = ['ytdlp', 'ffmpeg', 'ffprobe'].filter((tool) => !status[tool].ok);
  if (missing.length === 0) return { installed: [], status };
  const installed = await install(missing, onEvent);
  return { installed, status: await getStatus() };
}

/** Always pull a fresh yt-dlp into our own bin folder, whichever copy is in use today. */
async function updateYtDlp(onEvent) {
  const [result] = await install(['ytdlp'], onEvent);
  if (!result.ok) throw new Error(result.error);
  // A managed copy outranks PATH, so the new build is what runs from here on.
  return inspect('ytdlp');
}

function tempDir() {
  return path.join(os.tmpdir(), 'grabber');
}

/**
 * Sites break against old yt-dlp builds constantly, so a copy this far behind gets
 * replaced with the current release in our own bin folder — which outranks PATH.
 */
const STALE_AFTER_DAYS = 45;

module.exports = {
  TOOLS,
  platformKey,
  ytDlpAgeDays,
  STALE_AFTER_DAYS,
  wellKnownDirs,
  packageManagerPlan,
  managedDir,
  bundledDir,
  tempDir,
  getStatus,
  inspect,
  install,
  ensureAll,
  updateYtDlp,
  downloadUrlFor,
};
