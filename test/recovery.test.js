'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const engine = require('../src/main/engine');

// Load fresh module instances with only the process boundary replaced. Exercise
// the real queue/probe lifecycle without contacting sites or reading browser data.
function load(name, mocks = {}) {
  const file = path.join(__dirname, '..', 'src', 'main', `${name}.js`);
  const nativeRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,__dirname){${fs.readFileSync(file, 'utf8')}\n})`, { filename: file })(
    (id) => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id), module, module.exports, path.dirname(file)
  );
  return module.exports;
}

function harness(settings = {}, responses = []) {
  const calls = [];
  const history = [];
  const config = { cookiesFrom: 'chrome', cookiesFile: '', downloadDir: os.tmpdir(), ...settings };
  const store = { getSettings: () => ({ ...config }), addHistory: (entry) => history.push(entry) };
  const binaries = { inspect: async () => ({ ok: true, path: process.execPath }) };
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    calls.push({ file, args, options, child });
    const response = responses.shift();
    if (response) setImmediate(() => {
      if (response.beforeClose) response.beforeClose(child);
      if (response.stdout) child.stdout.write(response.stdout);
      if (response.stderr) child.stderr.write(response.stderr);
      if (response.error) child.emit('error', response.error);
      child.emit('close', response.code ?? 1);
    });
    return child;
  };
  const mocks = { './store': store, './binaries': binaries, child_process: { spawn } };
  const probe = load('probe', mocks);
  const downloader = load('downloader', { ...mocks, './probe': probe });
  return { calls, history, config, probe, downloader, binaries };
}

const video = JSON.stringify({ id: 'v', title: 'Video', webpage_url: 'https://example.test/v', formats: [] });
const locked = 'ERROR: Could not copy Chrome cookie database';
const forbidden = 'ERROR: unable to download video data: HTTP Error 403: Forbidden';
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function runJob(h) {
  const [item] = h.downloader.add([{ url: 'https://example.test/v' }]);
  for (let i = 0; i < 50; i++) {
    await nextTurn();
    const job = h.downloader.jobs.get(item.id);
    if (['done', 'failed', 'paused', 'canceled'].includes(job?.state)) return job;
  }
  throw new Error('Job did not settle');
}

test('metadata retries a locked browser once and keeps saved settings', async () => {
  const h = harness({}, [{ stderr: locked }, { code: 0, stdout: video }]);
  const result = await h.probe.probe('https://example.test/v');
  assert.equal(result.title, 'Video');
  assert.match(result.notice, /browser cookies/i);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[0].args.includes('--cookies-from-browser'));
  assert.ok(!h.calls[1].args.includes('--cookies-from-browser'));
  assert.equal(h.config.cookiesFrom, 'chrome');
  assert.ok(h.calls.every((c) => c.args.includes(`node:${process.execPath}`)));
  assert.ok(h.calls.every((c) => c.options.env.ELECTRON_RUN_AS_NODE === '1'));
});

test('DPAPI warning before generic error is recognized; auth errors retain guidance', async () => {
  const h = harness({}, [
    { stderr: "WARNING: failed to decrypt with DPAPI\nERROR: 'NoneType' object has no attribute 'decode'" },
    { stderr: "ERROR: Sign in to confirm you're not a bot" },
  ]);
  await assert.rejects(h.probe.probe('https://example.test/v'), /signed-in session/);
  assert.equal(h.calls.length, 2);
});

test('exported cookie files and unrelated errors never trigger anonymous retries', async () => {
  for (const [settings, stderr] of [
    [{ cookiesFile: 'explicit.txt' }, locked],
    [{}, 'ERROR: HTTP Error 403: Forbidden'],
    [{ cookiesFrom: 'none' }, locked],
    [{}, "ERROR: Sign in to confirm you're not a bot"],
  ]) {
    const h = harness(settings, [{ stderr }]);
    await assert.rejects(h.probe.probe('https://example.test/v'));
    assert.equal(h.calls.length, 1);
  }
});

test('an already canceled metadata request never spawns', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.probe.probe('https://example.test/v', { signal: controller.signal }), /Canceled/);
  assert.equal(h.calls.length, 0);
});

test('queue retries browser failure, completes once, and exposes its recovery', async () => {
  const h = harness({}, [{ stderr: locked }, { code: 0, stdout: '@@FILE@@C:/test.mp4\n' }]);
  const job = await runJob(h);
  assert.equal(job.state, 'done');
  assert.equal(h.history.length, 1);
  assert.equal(h.calls.length, 2);
  assert.ok(!h.calls[1].args.includes('--cookies-from-browser'));
  assert.ok(job.log.some((line) => /Retrying without browser/.test(line)));
});

test('media 403 refreshes extraction and checks formats once, retaining cookies', async () => {
  const h = harness({}, [{ stderr: forbidden }, { code: 0 }]);
  assert.equal((await runJob(h)).state, 'done');
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[1].args.includes('--check-formats'));
  assert.ok(h.calls[1].args.includes('--cookies-from-browser'));
});

test('repeated 403 stops and reports actionable error, including a final unterminated line', async () => {
  const h = harness({}, [{ stderr: forbidden }, { stderr: forbidden }]);
  const job = await runJob(h);
  assert.equal(job.state, 'failed');
  assert.match(job.error, /host refused.*Update yt-dlp/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.history.length, 0);
});

test('browser and media retries are independently bounded', async () => {
  const h = harness({}, [{ stderr: locked }, { stderr: forbidden }, { stderr: forbidden }]);
  assert.equal((await runJob(h)).state, 'failed');
  assert.equal(h.calls.length, 3);
  assert.ok(!h.calls[2].args.includes('--cookies-from-browser'));
  assert.ok(h.calls[2].args.includes('--check-formats'));
});

test('canceled or removed downloads never retry on close', async () => {
  for (const removed of [false, true]) {
    const h = harness({}, [{ stderr: locked, beforeClose: () => {
      const job = [...h.downloader.jobs.values()][0];
      job.killReason = 'cancel';
      if (removed) h.downloader.jobs.delete(job.id);
    } }]);
    h.downloader.add([{ url: 'https://example.test/v' }]);
    for (let i = 0; i < 5; i++) await nextTurn();
    assert.equal(h.calls.length, 1);
    assert.equal(h.history.length, 0);
  }
});

test('pause and cancel during preparation stop a download before it spawns', async () => {
  for (const action of ['pause', 'cancel']) {
    const h = harness();
    const pending = [];
    h.binaries.inspect = () => new Promise((resolve) => pending.push(resolve));
    const [item] = h.downloader.add([{ url: 'https://example.test/v' }]);
    assert.equal(h.downloader.jobs.get(item.id).state, 'starting');
    h.downloader[action](item.id);
    pending.forEach((resolve) => resolve({ ok: true, path: process.execPath }));
    await nextTurn();
    assert.equal(h.calls.length, 0, `${action} must prevent spawn`);
    assert.equal(h.downloader.jobs.get(item.id).state, action === 'pause' ? 'paused' : 'canceled');
  }
});

test('resuming during preparation cannot revive the older start attempt', async () => {
  const h = harness({}, [{ code: 0 }]);
  const pending = [];
  h.binaries.inspect = () => new Promise((resolve) => pending.push(resolve));
  const [item] = h.downloader.add([{ url: 'https://example.test/v' }]);
  h.downloader.pause(item.id);
  h.downloader.resume(item.id);
  pending.slice(0, 3).forEach((resolve) => resolve({ ok: true, path: process.execPath }));
  await nextTurn();
  assert.equal(h.calls.length, 0);
  pending.slice(3).forEach((resolve) => resolve({ ok: true, path: process.execPath }));
  for (let i = 0; i < 3; i++) await nextTurn();
  assert.equal(h.calls.length, 1);
  assert.equal(h.downloader.jobs.get(item.id).state, 'done');
});

test('spawn error is not overwritten by the subsequent close event', async () => {
  const h = harness({}, [{ error: new Error('ENOENT'), code: -1 }]);
  const job = await runJob(h);
  assert.match(job.error, /ENOENT/);
  assert.equal(h.calls.length, 1);
});

test('managed updates outrank bundled tools, invalid copies fall back, replacements invalidate cache', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grabber-resolution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ext = process.platform === 'win32' ? '.exe' : '';
  const bundled = path.join(root, 'resources', 'bin', `yt-dlp${ext}`);
  const managed = path.join(root, 'profile', 'bin', `yt-dlp${ext}`);
  const custom = path.join(root, `custom${ext}`);
  function binary(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content.padEnd(2048), { mode: 0o755 });
  }
  binary(bundled, '2026.01.01');
  binary(managed, '2026.10.01');
  binary(custom, '2025.01.01');
  const settings = {};
  const binaries = load('binaries', {
    electron: { app: { isPackaged: false, getPath: () => path.join(root, 'profile'), getAppPath: () => root } },
    './store': { getSettings: () => settings },
    child_process: { execFile: (file, args, options, callback) => {
      const version = fs.readFileSync(file, 'utf8').trim();
      callback(version === 'broken' ? new Error('bad executable') : null, version);
    } },
  });
  assert.equal((await binaries.inspect('ytdlp')).path, managed);
  assert.equal((await binaries.inspect('ytdlp')).version, '2026.10.01');
  binary(managed, 'broken');
  fs.utimesSync(managed, new Date(), new Date(Date.now() + 1000));
  assert.equal((await binaries.inspect('ytdlp')).path, bundled);
  binary(managed, '2026.10.12');
  fs.utimesSync(managed, new Date(), new Date(Date.now() + 2000));
  assert.equal((await binaries.inspect('ytdlp')).version, '2026.10.12');
  binary(bundled, '2026.10.13');
  fs.utimesSync(bundled, new Date(), new Date(Date.now() + 3000));
  assert.equal((await binaries.inspect('ytdlp')).path, bundled);
  settings.ytdlpPath = custom;
  assert.equal((await binaries.inspect('ytdlp')).path, custom);
});

test('runtime does not depend on a system installation', () => {
  assert.deepEqual(engine.runtimeArgs(), ['--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`]);
});

test('sign-in and removed-video errors do not get mislabeled as connection failures', () => {
  const h = harness();
  assert.match(h.probe.friendlyError('ERROR: [vimeo] 1: The web client only works when logged-in.', 'https://vimeo.com/1'), /requires a signed-in session/);
  assert.match(h.probe.friendlyError('ERROR: Unable to download webpage: HTTP Error 404: Not Found', 'https://vimeo.com/1'), /could not find this video/);
});

test('public Vimeo web-client failure retries its equivalent player URL once', async () => {
  const h = harness({ cookiesFrom: 'none' }, [
    { stderr: 'ERROR: [vimeo] 76979871: The web client only works when logged-in.' },
    { code: 0, stdout: video },
  ]);
  await h.probe.probe('https://vimeo.com/76979871');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].args.at(-1), 'https://player.vimeo.com/video/76979871');
});

test('Vimeo private errors and ambiguous URLs do not trigger player fallback', async () => {
  for (const [url, stderr] of [
    ['https://vimeo.com/1', 'ERROR: This video is private'],
    ['https://vimeo.com/1/secret', 'ERROR: The web client only works when logged-in.'],
    ['https://player.vimeo.com/video/1', 'ERROR: The web client only works when logged-in.'],
  ]) {
    const h = harness({ cookiesFrom: 'none' }, [{ stderr }]);
    await assert.rejects(h.probe.probe(url));
    assert.equal(h.calls.length, 1);
  }
});

test('YouTube media uses bounded requests without changing other sites', () => {
  for (const url of ['https://youtube.com/watch?v=x', 'https://www.youtube.com/watch?v=x', 'https://youtu.be/x']) {
    assert.deepEqual(engine.downloadArgs(url), ['--http-chunk-size', '10M']);
  }
  for (const url of ['https://youtube.com.example.test/v', 'https://vimeo.com/123', 'invalid']) {
    assert.deepEqual(engine.downloadArgs(url), []);
  }
});
