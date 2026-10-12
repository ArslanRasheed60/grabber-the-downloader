'use strict';

// Exercise the real main-process IPC, sandboxed preload and renderer together.
// Only the desktop startup/window-show step and background tool maintenance are
// suppressed; this test never opens the user's app profile or an external window.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const assert = require('assert/strict');
const { createRequire } = require('module');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grabber-ui-qa-'));
app.setAppPath(root);
app.setPath('userData', profile);
const output = path.join(root, 'release', `ui-qa-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
let win;

app.whenReady().then(async () => {
  const store = require('../src/main/store');
  const binaries = require('../src/main/binaries');
  const downloader = require('../src/main/downloader');
  store.updateSettings({ downloadDir: output });
  binaries.STALE_AFTER_DAYS = Infinity;
  BrowserWindow.prototype.show = function () {};
  const mainFile = path.join(root, 'src', 'main', 'main.js');
  let source = fs.readFileSync(mainFile, 'utf8');
  const startup = source.indexOf('const gotLock = app.requestSingleInstanceLock();');
  const menu = source.indexOf('function buildMacMenu()');
  assert.ok(startup > 0 && menu > startup, 'Main startup boundary is recognized');
  source = source.slice(0, startup) + source.slice(menu) + '\nmodule.exports = { createWindow, getWindow: () => mainWindow };';
  source = source.replace('webPreferences: {', 'webPreferences: { offscreen: true, backgroundThrottling: false,');
  const loaded = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,__dirname){${source}\n})`, { filename: mainFile })(
    createRequire(mainFile), loaded, loaded.exports, path.dirname(mainFile)
  );
  loaded.exports.createWindow();
  win = loaded.exports.getWindow();
  const errors = [];
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer stopped: ${details.reason}`));
  const js = (code) => win.webContents.executeJavaScript(code);
  async function until(code) {
    for (let i = 0; i < 100; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`UI condition timed out: ${code}`);
  }
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await until('document.getElementById("setup").hidden && !!window.api');
  assert.deepEqual(await js('({node: typeof require, isolated: typeof window.api.settings.get})'), { node: 'undefined', isolated: 'function' });
  console.log('PASS: Application boot, sandboxed preload and IPC');

  await js('document.getElementById("settingsBtn").click()');
  assert.equal(await js('document.getElementById("settingsDrawer").hidden'), false);
  await js('document.getElementById("concurrentInput").value = "20"; document.getElementById("concurrentInput").dispatchEvent(new Event("change"))');
  await until('document.getElementById("concurrentInput").value === "8"');
  assert.equal(store.getSettings().maxConcurrent, 8);
  await js('document.getElementById("closeSettings").click()');
  assert.equal(await js('document.getElementById("settingsDrawer").hidden'), true);
  console.log('PASS: Settings open/close, IPC persistence and normalized values');

  await js('document.querySelector(".chip[data-quality=\\"720\\"]").click()');
  assert.equal(await js('document.querySelector(".chip[data-quality=\\"720\\"]").getAttribute("aria-checked")'), 'true');
  const fixture = {
    id: 'ui-qa', title: '<img src=x onerror=alert(1)> QA title', url: 'https://example.test/video',
    state: 'failed', error: 'QA failure message', opts: { mode: 'video', quality: 'best', container: 'mp4' },
    percent: 0, log: ['<script>unsafe()</script>'], downloaded: null, total: null,
  };
  downloader.jobs.set(fixture.id, fixture);
  downloader.order.push(fixture.id);
  downloader.emitList();
  await until('document.querySelector(".job__title")?.textContent.includes("QA title")');
  assert.equal(await js('document.querySelector(".job__title img")'), null);
  assert.equal(await js('document.querySelector(".job__error").textContent'), 'QA failure message');
  await js('document.querySelector(".job__logtoggle").click()');
  await until('document.querySelector(".job__log")?.textContent.includes("unsafe()")');
  assert.equal(await js('document.querySelector(".job__log script")'), null);
  await new Promise((resolve) => setTimeout(resolve, 250));
  fs.writeFileSync(path.join(output, 'queue.png'), (await win.webContents.capturePage()).toPNG());
  await js('document.querySelector(".job__close").click()');
  await until('document.querySelectorAll(".job").length === 0');
  assert.equal(downloader.jobs.has(fixture.id), false);
  assert.equal(errors.length, 0);
  console.log('PASS: Quality selection, failed rows, safe title/log rendering and remove control');
  store.flush();
  console.log(`UI QA passed. Screenshot: ${path.join(output, 'queue.png')}`);
  app.exit(0);
}).catch((error) => { console.error(error.stack); app.exit(1); });
