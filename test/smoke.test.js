'use strict';

// Opt-in live integration check: downloads media, merges/embeds it, then asks
// ffprobe to verify the resulting streams. Never reads the user's real profile.
// npm run test:smoke -- [public-video-url] [--quality=360]
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { app } = require('electron');
app.setAppPath(path.resolve(__dirname, '..'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grabber-smoke-'));
app.setPath('userData', profile);
const output = path.resolve(__dirname, '..', 'release', `smoke-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const url = process.argv.slice(2).find((arg) => /^https?:\/\//.test(arg)) || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const quality = process.argv.find((arg) => arg.startsWith('--quality='))?.slice(10) || 'best';

app.whenReady().then(async () => {
  const binaries = require('../src/main/binaries');
  const store = require('../src/main/store');
  const { probe } = require('../src/main/probe');
  const downloader = require('../src/main/downloader');
  store.updateSettings({ downloadDir: output });
  if (process.argv.includes('--update-engine')) {
    const updated = await binaries.updateYtDlp();
    const resolved = await binaries.inspect('ytdlp');
    assert.equal(resolved.path, updated.path);
    assert.equal(resolved.source, 'managed');
    console.log(`Update OK: ${resolved.version} (${resolved.source})`);
  }
  const status = await binaries.getStatus();
  assert.ok(status.ready, 'Install bundled tools before running the live check');
  console.log(`Engine ${status.ytdlp.version} (${status.ytdlp.source}); output: ${output}`);
  const info = await probe(url);
  console.log(`Metadata OK: ${info.title} (${info.duration}s)`);
  const item = { ...info, url: info.webpageUrl };

  async function download(mode, entry, selectedQuality) {
    let id;
    let lastProgress = 0;
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (id) downloader.cancel(id);
        cleanup();
        reject(new Error('Live download timed out'));
      }, 12 * 60 * 1000);
      function cleanup() { clearTimeout(timer); downloader.off('job', changed); }
      function changed(job) {
        if (job.id !== id) return;
        if (Date.now() - lastProgress > 15000) {
          console.log(`${mode}: ${job.state} ${job.percent.toFixed(1)}%`);
          lastProgress = Date.now();
        }
        if (job.state === 'done') { cleanup(); resolve(job); }
        if (job.state === 'failed') { cleanup(); reject(new Error(job.error)); }
      }
      downloader.on('job', changed);
      [ { id } ] = downloader.add([entry], { mode, quality: selectedQuality, audioFormat: 'mp3' });
    });
    const log = fs.createWriteStream(path.join(output, `${mode}.log`));
    const logger = ({ id: jobId, line }) => { if (jobId === id) log.write(`${line}\n`); };
    downloader.on('log', logger);
    let job;
    try { job = await completed; }
    finally { downloader.off('log', logger); log.end(); }
    assert.ok(job.filepath && fs.statSync(job.filepath).size > 1024, 'Completed output exists');
    const media = JSON.parse(execFileSync(status.ffprobe.path, [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', job.filepath,
    ], { encoding: 'utf8', windowsHide: true }));
    assert.ok(media.streams.some((s) => s.codec_type === 'audio'), 'Audio stream exists');
    if (mode === 'video') assert.ok(media.streams.some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic));
    assert.ok(Number(media.format.duration) > 0, 'Output has a duration');
    if (entry.duration) assert.ok(Math.abs(Number(media.format.duration) - entry.duration) < 5, 'Complete media duration');
    console.log(`${mode} OK: ${job.filepath} (${media.format.duration}s, ${media.format.size} bytes)`);
  }

  await download('video', item, quality);
  // Verify conversion on a short public video even when the main input is long.
  const audioInfo = await probe('https://www.youtube.com/watch?v=jNQXAC9IVRw');
  await download('audio', { ...audioInfo, url: audioInfo.webpageUrl }, 'best');
  store.flush();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log('Live download checks passed.');
  app.exit(0);
}).catch((error) => {
  console.error(error.stack);
  app.exit(1);
});
