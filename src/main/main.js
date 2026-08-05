'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, Menu } = require('electron');

const store = require('./store');
const binaries = require('./binaries');
const { probe } = require('./probe');
const downloader = require('./downloader');
const { throttle, extractUrls } = require('./util');

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

if (isWindows) app.setAppUserModelId('dev.arsla.grabber');

let mainWindow = null;

/* --------------------------------------------------------------- window */

function createWindow() {
  const saved = store.getSettings().windowBounds;
  const bounds = saved && Number.isFinite(saved.width) ? saved : { width: 1120, height: 760 };

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 560,
    show: false,
    backgroundColor: '#0F1319',
    title: 'Grabber',
    autoHideMenuBar: true,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isWindows
      ? {
          titleBarOverlay: { color: '#0F1319', symbolColor: '#93A2B5', height: 44 },
        }
      : {}),
    trafficLightPosition: isMac ? { x: 16, y: 15 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.webContents.once('did-finish-load', keepYtDlpFresh);

  const saveBounds = throttle(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
      store.updateSettings({ windowBounds: mainWindow.getNormalBounds() });
    }
  }, 800);
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Links belong in the user's browser, never in an app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/**
 * An out-of-date download engine is the single most common reason a download stops
 * working, and the user should never have to know that. Replace a stale copy on startup.
 */
async function keepYtDlpFresh() {
  try {
    const tool = await binaries.inspect('ytdlp');
    if (!tool.ok || tool.ageDays === null || tool.ageDays < binaries.STALE_AFTER_DAYS) return;
    send('app:toast', {
      message: `The download engine is ${tool.ageDays} days old. Getting the current one…`,
    });
    const updated = await binaries.updateYtDlp((event) => send('setup:progress', event));
    send('app:toast', { message: `Download engine updated to ${updated.version}.`, kind: 'ok' });
    send('binaries:changed');
  } catch (err) {
    // Not fatal — the copy already on this machine still works.
    send('app:toast', {
      message: `Could not update the download engine: ${err.message}`,
      kind: 'bad',
    });
  }
}

/* ---------------------------------------------------- downloader plumbing */

const pushSummary = throttle(() => {
  const summary = downloader.summary();
  send('queue:summary', summary);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (summary.active > 0 && summary.percent !== null) {
      mainWindow.setProgressBar(Math.max(0.01, Math.min(1, summary.percent / 100)));
    } else if (summary.active > 0) {
      mainWindow.setProgressBar(2, { mode: 'indeterminate' });
    } else {
      mainWindow.setProgressBar(-1);
    }
  }
}, 200);

downloader.on('list', (jobs) => {
  send('queue:list', jobs);
  pushSummary();
});
downloader.on('job', (job) => {
  send('queue:job', job);
  pushSummary();
});
downloader.on('log', (entry) => send('queue:log', entry));
downloader.on('done', (job) => send('queue:done', job));

/* ------------------------------------------------------------------- IPC */

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

handle('app:info', () => ({
  version: app.getVersion(),
  name: app.getName(),
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  defaultDownloadDir: app.getPath('downloads'),
}));

handle('settings:get', () => store.getSettings());
handle('settings:set', (patch) => {
  const clean = { ...patch };
  delete clean.windowBounds;
  if (clean.downloadDir) {
    try {
      fs.mkdirSync(clean.downloadDir, { recursive: true });
    } catch (err) {
      throw new Error(`Cannot use that folder: ${err.message}`);
    }
  }
  const next = store.updateSettings(clean);
  downloader.pump();
  return next;
});

handle('binaries:status', () => binaries.getStatus());
handle('binaries:install', async () => {
  const result = await binaries.ensureAll((event) => send('setup:progress', event));
  const failures = result.installed.filter((item) => !item.ok);
  if (failures.length) throw new Error(failures.map((f) => f.error).join(' '));
  return result.status;
});
handle('binaries:update-ytdlp', async () => {
  const tool = await binaries.updateYtDlp((event) => send('setup:progress', event));
  return tool;
});

handle('probe:run', (url, options) => probe(url, options || {}));
handle('probe:urls', (text) => extractUrls(text));

handle('queue:add', (items, opts) => downloader.add(items || [], opts || {}));
handle('queue:list', () => downloader.list());
handle('queue:log', (id) => downloader.getLog(id));
handle('queue:pause', (id) => downloader.pause(id));
handle('queue:resume', (id) => downloader.resume(id));
handle('queue:cancel', (id) => downloader.cancel(id));
handle('queue:remove', (id) => downloader.remove(id));
handle('queue:retry', (id) => downloader.retry(id));
handle('queue:clear', () => downloader.clearFinished());
handle('queue:pause-all', () => downloader.pauseAll());
handle('queue:resume-all', () => downloader.resumeAll());
handle('queue:summary', () => downloader.summary());

handle('history:get', () => store.getHistory());
handle('history:clear', () => store.clearHistory());

/**
 * Takes a job id rather than a path: the queue knows where the file was meant to go,
 * so it can go looking when the recorded name turns out to be wrong. Opening the
 * containing folder is a far better answer than an error the user cannot act on.
 */
handle('shell:reveal', async (jobId) => {
  const { file, dir } = downloader.resolveFile(jobId);
  if (file) {
    shell.showItemInFolder(file);
    return { revealed: true, path: file };
  }
  if (dir) {
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
    return { revealed: false, dir };
  }
  throw new Error('That download has no file on disk yet.');
});
handle('shell:open-file', async (filePath) => {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('The file is no longer where the app left it.');
  const error = await shell.openPath(filePath);
  if (error) throw new Error(error);
  return true;
});
handle('shell:open-folder', async (dir) => {
  const target = dir || store.getSettings().downloadDir;
  fs.mkdirSync(target, { recursive: true });
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return true;
});
handle('shell:open-external', (url) => {
  if (!/^https?:/i.test(url || '')) throw new Error('Only web links can be opened.');
  return shell.openExternal(url);
});

handle('dialog:choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where downloads go',
    defaultPath: store.getSettings().downloadDir,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Save here',
  });
  if (result.canceled || !result.filePaths.length) return null;
  const dir = result.filePaths[0];
  store.updateSettings({ downloadDir: dir });
  return dir;
});

handle('clipboard:read', () => clipboard.readText());

/* --------------------------------------------------------------- startup */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(isMac ? buildMacMenu() : null);
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

function buildMacMenu() {
  return Menu.buildFromTemplate([
    {
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
  ]);
}

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('before-quit', () => {
  downloader.shutdown();
  store.flush();
});
