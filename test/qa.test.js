'use strict';

// Opt-in QA against real executables and representative public service links.
// Uses an isolated settings profile; does not read browser cookies.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'release', `qa-${Date.now()}`);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grabber-qa-'));
app.setAppPath(root);
app.setPath('userData', profile);
fs.mkdirSync(output, { recursive: true });
const results = [];
let downloader;

function record(name, status, detail = {}) {
  const result = { name, status, ...detail };
  results.push(result);
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${status.toUpperCase()}: ${name}${detail.error ? ` — ${detail.error}` : ''}`);
}

function waitForJob(id, predicate, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); downloader.cancel(id); reject(new Error('QA timeout')); }, timeout);
    function cleanup() { clearTimeout(timer); downloader.off('job', changed); }
    function changed(job) {
      if (job.id !== id) return;
      if (predicate(job)) { cleanup(); resolve(job); }
      else if (job.state === 'failed') { cleanup(); reject(new Error(job.error)); }
    }
    downloader.on('job', changed);
    const job = downloader.jobs.get(id);
    if (job) changed(downloader.publicJob(job));
  });
}

app.whenReady().then(async () => {
  const binaries = require('../src/main/binaries');
  const store = require('../src/main/store');
  const { probe } = require('../src/main/probe');
  downloader = require('../src/main/downloader');
  store.updateSettings({ downloadDir: output, maxConcurrent: 2, cookiesFrom: 'none', cookiesFile: '' });
  const status = await binaries.getStatus();
  assert.ok(status.ready && status.ffprobe.ok, 'Working download tools are required');
  record('Windows tool check', 'pass', { engine: status.ytdlp.version, source: status.ytdlp.source });
  console.log(`QA output: ${output}`);

  function verify(job, mode, duration) {
    assert.ok(job.filepath && fs.statSync(job.filepath).size > 1024, 'Output file exists');
    const media = JSON.parse(execFileSync(status.ffprobe.path, [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', job.filepath,
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 }));
    assert.ok(media.streams.some((s) => s.codec_type === 'audio'), 'Output has audio');
    if (mode === 'video') assert.ok(media.streams.some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic), 'Output has video');
    const actualDuration = Number(media.format.duration);
    assert.ok(actualDuration > 0, 'Output has duration');
    if (duration) assert.ok(Math.abs(actualDuration - duration) < 5, 'Full duration matches metadata');
    execFileSync(status.ffmpeg.path, ['-v', 'error', '-i', job.filepath, '-t', '2', '-f', 'null', '-'], {
      windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    });
    return { filepath: job.filepath, duration: actualDuration, bytes: Number(media.format.size), streams: media.streams.map((s) => ({ type: s.codec_type, codec: s.codec_name, height: s.height })) };
  }

  // A local server makes interruption tests reproducible and avoids relying on
  // a remote site's rate limits. Send a real playable MP4 at a controlled rate.
  const fixture = path.join(output, 'fixture.mp4');
  execFileSync(status.ffmpeg.path, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '12',
    '-c:v', 'libx264', '-b:v', '2M', '-c:a', 'aac', '-movflags', '+faststart', '-y', fixture,
  ], { windowsHide: true, timeout: 30000 });
  const data = fs.readFileSync(fixture);
  let rangeRequests = 0;
  const server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    if (range && start) rangeRequests++;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    let position = start;
    const interval = setInterval(() => {
      const next = Math.min(position + 32768, end + 1);
      res.write(data.subarray(position, next));
      position = next;
      if (position > end) { clearInterval(interval); res.end(); }
    }, 35);
    res.on('close', () => clearInterval(interval));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const localUrl = (name) => `http://127.0.0.1:${server.address().port}/${name}.mp4`;
  store.updateSettings({ embedThumbnail: false, embedMetadata: false, embedChapters: false });
  try {
    const [job] = downloader.add([{ url: localUrl('pause-resume'), title: 'Pause/resume QA' }]);
    await waitForJob(job.id, (j) => j.downloaded > 131072);
    downloader.pause(job.id);
    await waitForJob(job.id, (j) => j.state === 'paused');
    downloader.resume(job.id);
    const complete = await waitForJob(job.id, (j) => j.state === 'done');
    assert.ok(rangeRequests > 0, 'Resume used an HTTP Range request');
    record('Pause and resume preserves partial data', 'pass', verify(complete, 'video', 12));
  } catch (error) { record('Pause and resume preserves partial data', 'fail', { error: error.message }); }

  try {
    const [job] = downloader.add([{ url: localUrl('cancel'), title: 'Cancel QA' }]);
    await waitForJob(job.id, (j) => j.downloaded > 65536);
    downloader.cancel(job.id);
    await waitForJob(job.id, (j) => j.state === 'canceled');
    assert.equal(downloader.children.has(job.id), false);
    record('Cancel stops the running downloader', 'pass');
  } catch (error) { record('Cancel stops the running downloader', 'fail', { error: error.message }); }
  await new Promise((resolve) => server.close(resolve));
  store.updateSettings({ embedThumbnail: true, embedMetadata: true, embedChapters: true });

  const cases = [
    { name: 'YouTube MP4 / best quality', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'video', quality: 'best' },
    { name: 'YouTube MP3 conversion', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'audio' },
    { name: 'YouTube MKV', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'video', container: 'mkv' },
    { name: 'YouTube M4A', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'audio', audioFormat: 'm4a' },
    { name: 'Vimeo', url: 'https://vimeo.com/76979871', mode: 'video' },
    { name: 'Dailymotion', url: 'https://www.dailymotion.com/video/x5kesuj', mode: 'video' },
    { name: 'TikTok', url: 'https://www.tiktok.com/@patroxofficial/video/6742501081818877190', mode: 'video' },
    { name: 'X / Twitter', url: 'https://twitter.com/captainamerica/status/719944021058060289', mode: 'video' },
    { name: 'Reddit', url: 'https://www.reddit.com/r/videos/comments/6rrwyj/that_small_heart_attack/', mode: 'video' },
    { name: 'SoundCloud', url: 'https://soundcloud.com/ethmusic/lostin-powers-she-so-heavy', mode: 'audio' },
  ];
  let next = 0;
  async function worker() {
    while (next < cases.length) {
      const entry = cases[next++];
      let jobId;
      let logger;
      const started = Date.now();
      try {
        const info = await probe(entry.url);
        assert.equal(info.type, 'video', 'Single media item expected');
        if (info.duration > 600 || info.isLive) {
          record(entry.name, 'skip', { url: entry.url, title: info.title, reason: 'Live or longer than 10 minutes; metadata only' });
          continue;
        }
        const destDir = path.join(output, entry.name.replace(/[^a-z0-9]/gi, '-'));
        const [job] = downloader.add([{ ...info, url: info.webpageUrl }], {
          mode: entry.mode, quality: entry.quality || '360', container: entry.container || 'mp4',
          audioFormat: entry.audioFormat || 'mp3', destDir,
        });
        jobId = job.id;
        logger = ({ id, line }) => { if (id === jobId) fs.appendFileSync(path.join(destDir, 'download.log'), `${line}\n`); };
        fs.mkdirSync(destDir, { recursive: true });
        downloader.on('log', logger);
        const complete = await waitForJob(jobId, (j) => j.state === 'done');
        record(entry.name, 'pass', { url: entry.url, title: info.title, elapsedSeconds: (Date.now() - started) / 1000, ...verify(complete, entry.mode, info.duration) });
      } catch (error) {
        const outcome = /requires a signed-in session|wants a signed-in session|private or members-only/i.test(error.message) ? 'blocked' : 'fail';
        record(entry.name, outcome, { url: entry.url, elapsedSeconds: (Date.now() - started) / 1000, error: error.message });
        if (error.stderr) fs.writeFileSync(path.join(output, `${entry.name.replace(/[^a-z0-9]/gi, '-')}-probe.log`), error.stderr);
        if (jobId) downloader.cancel(jobId);
      } finally { if (logger) downloader.off('log', logger); }
    }
  }
  await Promise.all([worker(), worker()]);
  store.flush();
  downloader.shutdown();
  const escaped = (text) => String(text || '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  fs.writeFileSync(path.join(output, 'QA-report.md'),
    `# Grabber QA — 12 October 2026\n\nWindows ${process.arch}; engine ${status.ytdlp.version}. Public links tested without browser cookies.\n\n` +
    '| Check | Result | Details |\n|---|---|---|\n' + results.map((r) =>
      `| ${escaped(r.name)} | ${r.status.toUpperCase()} | ${escaped(r.error || r.reason || (r.duration ? `Complete file: ${r.duration}s, ${r.bytes} bytes` : r.engine || 'Verified'))} |`
    ).join('\n') + '\n\nThese are representative samples. macOS/Linux and signed-in videos were not exercised.\n');
  console.log(`REPORT: ${path.join(output, 'QA-report.md')}`);
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(results.some((r) => r.status === 'fail') ? 1 : 0);
}).catch((error) => {
  record('QA harness', 'fail', { error: error.stack });
  if (downloader) downloader.shutdown();
  app.exit(1);
});
