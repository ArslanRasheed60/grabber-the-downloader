'use strict';

/**
 * The behaviour that is easy to get wrong and hard to see by reading:
 *
 *   1. the progress meter, driven by lines captured from real engine runs — it must
 *      rise and never fall, though a "bv*+ba" download arrives as two separate
 *      streams each reported from zero;
 *   2. playlist output paths, which decide the folder and the ordering;
 *   3. a job deleted mid-download staying deleted;
 *   4. the interface never naming the tool underneath it.
 *
 * Run with: npm test   (it needs Electron, because the queue module reaches into
 * app paths for settings; no window is ever opened.)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

// Point the app at a throwaway profile before anything reads settings, so the suite
// can write whatever it likes without touching the real configuration.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'grabber-test-profile-')));

const failures = [];
const NAMES_THE_TOOL = /yt[-_ ]?dlp/i;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

function makeJob(mode = 'video') {
  return {
    id: 'test',
    title: 'test',
    state: 'downloading',
    percent: 0,
    downloaded: null,
    total: null,
    streamBytes: 0,
    stage: null,
    opts: { mode, quality: 'best', container: 'mp4', audioFormat: 'mp3' },
    log: [],
  };
}

function run(downloader, job, lines) {
  const seen = [];
  for (const line of lines) {
    downloader.applyProgress(job, line);
    seen.push({ percent: job.percent, stage: job.stage });
  }
  return seen;
}

function isMonotonic(steps) {
  for (let i = 1; i < steps.length; i += 1) {
    if (steps[i].percent < steps[i - 1].percent - 1e-9) return false;
  }
  return true;
}

function main() {
  const downloader = require('../src/main/downloader');

  // Byte counts below are exactly what yt-dlp reported for a real two-stream
  // download: an AV1 video track followed by a separate Opus audio track.
  console.log('two-stream video + audio');
  const merged = makeJob();
  const mergedSteps = run(downloader, merged, [
    'downloading|1024|223779|NA|NA|NA|NA|NA|av01.0.00M.08|none',
    'downloading|111890|223779|NA|500000|2|NA|NA|av01.0.00M.08|none',
    'downloading|223779|223779|NA|500000|0|NA|NA|av01.0.00M.08|none',
    'finished|223779|223779|NA|500000|NA|NA|NA|av01.0.00M.08|none',
    'downloading|1024|252182|NA|NA|NA|NA|NA|none|opus',
    'downloading|126091|252182|NA|500000|1|NA|NA|none|opus',
    'downloading|252182|252182|NA|500000|0|NA|NA|none|opus',
    'finished|252182|252182|NA|500000|NA|NA|NA|none|opus',
  ]);
  console.log(`  path: ${mergedSteps.map((s) => s.percent.toFixed(1)).join(' → ')}`);
  check('meter never goes backwards', isMonotonic(mergedSteps), JSON.stringify(mergedSteps.map((s) => s.percent)));
  check('meter stays under 100 while running', mergedSteps.every((s) => s.percent <= 99.5));
  check('video stream is held back for the audio to come', mergedSteps[3].percent <= 85 + 1e-9, `got ${mergedSteps[3].percent}`);
  check(
    'meter keeps moving during the audio stream',
    mergedSteps[6].percent > mergedSteps[4].percent,
    `${mergedSteps[4].percent} → ${mergedSteps[6].percent}`
  );
  check('meter ends high', mergedSteps[mergedSteps.length - 1].percent > 90, `got ${mergedSteps[7].percent}`);
  check('video stream is named', mergedSteps[1].stage === 'Downloading video', mergedSteps[1].stage);
  check('audio stream is named', mergedSteps[5].stage === 'Downloading audio', mergedSteps[5].stage);
  check('byte totals accumulate across streams', merged.total === 223779 + 252182, String(merged.total));

  console.log('single progressive file');
  const single = makeJob();
  const singleSteps = run(downloader, single, [
    'downloading|100000|1000000|NA|NA|NA|NA|NA|avc1.4d401e|mp4a.40.2',
    'downloading|500000|1000000|NA|900000|1|NA|NA|avc1.4d401e|mp4a.40.2',
    'downloading|990000|1000000|NA|900000|0|NA|NA|avc1.4d401e|mp4a.40.2',
  ]);
  console.log(`  path: ${singleSteps.map((s) => s.percent.toFixed(1)).join(' → ')}`);
  check('uses the full scale when nothing follows', singleSteps[1].percent === 50, String(singleSteps[1].percent));
  check('single stream is not held back', singleSteps[2].percent > 85);
  check('single stream is not mislabelled', singleSteps[0].stage === 'Downloading', singleSteps[0].stage);

  console.log('audio-only download');
  const audio = makeJob('audio');
  const audioSteps = run(downloader, audio, [
    'downloading|250000|1000000|NA|NA|NA|NA|NA|none|opus',
    'downloading|750000|1000000|NA|800000|1|NA|NA|none|opus',
  ]);
  console.log(`  path: ${audioSteps.map((s) => s.percent.toFixed(1)).join(' → ')}`);
  check('audio-only uses the full scale', audioSteps[1].percent === 75, String(audioSteps[1].percent));

  console.log('size unknown, fragmented stream');
  const frag = makeJob();
  const fragSteps = run(downloader, frag, [
    'downloading|500|NA|NA|NA|NA|1|10|avc1|mp4a',
    'downloading|9000|NA|NA|NA|NA|5|10|avc1|mp4a',
    'downloading|18000|NA|NA|NA|NA|9|10|avc1|mp4a',
  ]);
  console.log(`  path: ${fragSteps.map((s) => s.percent.toFixed(1)).join(' → ')}`);
  check('falls back to fragment counts', fragSteps[1].percent === 50, String(fragSteps[1].percent));
  check('fragment progress is monotonic', isMonotonic(fragSteps));

  // Playlist entries are queued one job per video, so the folder and the ordering
  // live entirely in the output template. Nothing else enforces either.
  console.log('playlist output paths');
  const plain = downloader.outputTemplate({ opts: { folderPrefix: null, indexLabel: null } });
  check('a single video keeps a flat name', plain === '%(title).150s [%(id)s].%(ext)s', plain);

  const numbered = downloader.outputTemplate({
    opts: { folderPrefix: 'Lo-Fi Beats / Study Mix', indexLabel: '03' },
  });
  check(
    'playlist items are foldered and numbered',
    numbered === 'Lo-Fi Beats Study Mix/03 - %(title).150s [%(id)s].%(ext)s',
    numbered
  );

  const percent = downloader.outputTemplate({
    opts: { folderPrefix: '100% Hits', indexLabel: null },
  });
  check(
    'a percent sign in a playlist name is escaped, not read as a field',
    percent === '100%% Hits/%(title).150s [%(id)s].%(ext)s',
    percent
  );

  console.log('removed jobs stay removed');
  const ghost = makeJob();
  ghost.id = 'ghost';
  let revived = false;
  const watch = (updated) => {
    if (updated.id === 'ghost') revived = true;
  };
  downloader.on('job', watch);
  downloader.finish(ghost, 0); // never registered, i.e. already removed
  downloader.fail(ghost, 'boom');
  downloader.off('job', watch);
  check('a job deleted mid-download does not come back', !revived);
  check('a deleted job is not filed into history', ghost.state === 'downloading', ghost.state);

  // The interface talks about "the download engine" and never names the tool behind
  // it — including in text the app does not author, like engine stdout in the log.
  console.log('the interface never names the underlying tool');
  const { scrubToolNames } = require('../src/main/util');
  const { friendlyError } = require('../src/main/probe');
  const binaries = require('../src/main/binaries');

  const raw = [
    'yt-dlp',
    'YT-DLP',
    'ytdlp',
    'yt_dlp',
    'Yt-Dlp.exe',
    'File "yt_dlp\\extractor\\common.py", line 1',
    'ERROR: see https://github.com/yt-dlp/yt-dlp/wiki/FAQ for help',
    '$ engine --ffmpeg-location C:\\WinGet\\Packages\\yt-dlp.FFmpeg_x\\bin',
  ];
  const leaked = raw.map(scrubToolNames).filter((line) => NAMES_THE_TOOL.test(line));
  check('engine output is scrubbed before it reaches the log', leaked.length === 0, leaked.join(' | '));
  check(
    'a link that would name it is dropped, not left dead',
    !scrubToolNames('see https://github.com/yt-dlp/yt-dlp/wiki now').includes('github'),
    scrubToolNames('see https://github.com/yt-dlp/yt-dlp/wiki now')
  );
  check(
    'quoted error text is scrubbed',
    !NAMES_THE_TOOL.test(friendlyError('ERROR: yt-dlp could not do the thing', 'https://x.test/v')),
    friendlyError('ERROR: yt-dlp could not do the thing', 'https://x.test/v')
  );
  check(
    'the engine carries a generic label',
    !NAMES_THE_TOOL.test(binaries.TOOLS.ytdlp.label),
    binaries.TOOLS.ytdlp.label
  );

  // Strip tags so attributes and element ids are ignored and only on-screen text is left.
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const onScreen = html.replace(/<[^>]*>/g, ' ');
  const named = onScreen.split('\n').filter((line) => NAMES_THE_TOOL.test(line));
  check('no visible copy in the page names the tool', named.length === 0, named.join(' | '));

  // "Show in folder" used to fail outright when the recorded name did not match the
  // file on disk. The fixtures below are real filenames from a real downloads folder.
  console.log('finding a file whose recorded name is wrong');
  const { asciiKey, idTokenFrom } = require('../src/main/util');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grabber-test-'));

  const REAL = 'Shiva vs Smoky Man： चोर पकड़ा गया! ｜ Shiva ｜ शिवा [irfGta8rxL0].mp4';
  // Exactly what the engine reported before the fix: non-ASCII silently dropped.
  const MANGLED = REAL.replace(/[^\x20-\x7E]/g, '');
  fs.writeFileSync(path.join(tmp, REAL), 'x');

  check('an id token is read back out of a filename', idTokenFrom(REAL) === 'irfGta8rxL0', String(idTokenFrom(REAL)));
  check('mangled and real names share an ASCII skeleton', asciiKey(REAL) === asciiKey(MANGLED));

  const stage = (id, filepath, extra = {}) => {
    const job = {
      id,
      title: 'fixture',
      url: 'https://example.test/v',
      videoId: null,
      opts: { mode: 'video', quality: 'best', container: 'mp4', audioFormat: 'mp3', folderPrefix: null, indexLabel: null },
      destDir: tmp,
      state: 'done',
      percent: 100,
      filepath,
      log: [],
      ...extra,
    };
    downloader.jobs.set(id, job);
    return job;
  };

  const mangledJob = stage('recover-mangled', path.join(tmp, MANGLED));
  const recovered = downloader.resolveFile('recover-mangled');
  check(
    'a mangled path still finds the real file',
    recovered.file === path.join(tmp, REAL),
    String(recovered.file)
  );
  check('the job keeps the corrected path', mangledJob.filepath === path.join(tmp, REAL));

  fs.writeFileSync(path.join(tmp, 'whatever I renamed it to [abc12345].mp4'), 'x');
  stage('recover-renamed', path.join(tmp, 'Original Title [abc12345].mp4'));
  const renamed = downloader.resolveFile('recover-renamed');
  check(
    'a file the user renamed is found by its id',
    renamed.file === path.join(tmp, 'whatever I renamed it to [abc12345].mp4'),
    String(renamed.file)
  );

  stage('recover-gone', path.join(tmp, 'not here [zzz99999].mp4'));
  const gone = downloader.resolveFile('recover-gone');
  check('a genuinely missing file falls back to its folder', gone.file === null && gone.dir === tmp, JSON.stringify(gone));

  // Two files sharing an id would make a guess a coin flip, so it must not guess.
  fs.writeFileSync(path.join(tmp, 'copy one [dup00001].mp4'), 'x');
  fs.writeFileSync(path.join(tmp, 'copy two [dup00001].mkv'), 'x');
  stage('recover-ambiguous', path.join(tmp, 'gone [dup00001].mp4'));
  const ambiguous = downloader.resolveFile('recover-ambiguous');
  check('an ambiguous id is not guessed at', ambiguous.file === null, String(ambiguous.file));

  for (const id of ['recover-mangled', 'recover-renamed', 'recover-gone', 'recover-ambiguous']) {
    downloader.jobs.delete(id);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  // Every switch in Settings has to actually change what gets run. Reading the code
  // is not evidence; this builds the real command line and looks for the flag.
  console.log('every setting reaches the command line');
  const store = require('../src/main/store');
  const TOOLS = {
    ffmpeg: { ok: true, path: path.join('C:', 'tools', 'ffmpeg.exe') },
    ffprobe: { ok: true, path: path.join('C:', 'tools', 'ffprobe.exe') },
  };

  function argsWith(patch, jobOpts = {}) {
    store.updateSettings(patch);
    return downloader.buildArgs(
      {
        id: 'args', url: 'https://example.test/v', videoId: 'vid', title: 't',
        destDir: path.join('C:', 'out'), log: [],
        opts: {
          mode: 'video', quality: 'best', container: 'mp4', audioFormat: 'mp3',
          folderPrefix: null, indexLabel: null, ...jobOpts,
        },
      },
      TOOLS
    );
  }
  const valueAfter = (args, flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };

  const base = {
    limitRate: '', proxy: '', cookiesFrom: 'none', concurrentFragments: 4,
    embedThumbnail: false, embedMetadata: false, embedChapters: false,
    writeSubs: false, sponsorblock: false, subLangs: 'en.*',
  };

  check('speed limit is passed through', valueAfter(argsWith({ ...base, limitRate: '5M' }), '--limit-rate') === '5M');
  check('a blank speed limit means no cap', !argsWith({ ...base }).includes('--limit-rate'));
  check('proxy is passed through', valueAfter(argsWith({ ...base, proxy: 'socks5://127.0.0.1:1080' }), '--proxy') === 'socks5://127.0.0.1:1080');
  check('no proxy means no flag', !argsWith({ ...base }).includes('--proxy'));
  check('cookies name the browser', valueAfter(argsWith({ ...base, cookiesFrom: 'chrome' }), '--cookies-from-browser') === 'chrome');
  check('"No browser" sends no cookie flag', !argsWith({ ...base, cookiesFrom: 'none' }).includes('--cookies-from-browser'));
  check('connections per video is honoured', valueAfter(argsWith({ ...base, concurrentFragments: 8 }), '--concurrent-fragments') === '8');

  check('cover art on', argsWith({ ...base, embedThumbnail: true }).includes('--embed-thumbnail'));
  check('cover art off', !argsWith({ ...base }).includes('--embed-thumbnail'));
  check('metadata on', argsWith({ ...base, embedMetadata: true }).includes('--embed-metadata'));
  check('metadata off', !argsWith({ ...base }).includes('--embed-metadata'));
  check('chapters on', argsWith({ ...base, embedChapters: true }).includes('--embed-chapters'));
  check('chapters off', !argsWith({ ...base }).includes('--embed-chapters'));
  check('sponsor removal on', argsWith({ ...base, sponsorblock: true }).includes('--sponsorblock-remove'));
  check('sponsor removal off', !argsWith({ ...base }).includes('--sponsorblock-remove'));

  const subs = argsWith({ ...base, writeSubs: true, subLangs: 'en.*,hi' });
  check('subtitles are requested and embedded', subs.includes('--embed-subs') && subs.includes('--write-subs'));
  check('subtitle languages are honoured', valueAfter(subs, '--sub-langs') === 'en.*,hi');
  check(
    'subtitles are skipped for an audio-only download',
    !argsWith({ ...base, writeSubs: true }, { mode: 'audio' }).includes('--embed-subs')
  );

  const mp4 = argsWith({ ...base }, { container: 'mp4' });
  check('mp4 asks for an mp4 merge', valueAfter(mp4, '--merge-output-format') === 'mp4');
  check('mp4 is preferred in the format selector', valueAfter(mp4, '-f').includes('ext=mp4'));
  check('mkv asks for an mkv merge', valueAfter(argsWith({ ...base }, { container: 'mkv' }), '--merge-output-format') === 'mkv');
  check('"leave as downloaded" does not remux', !argsWith({ ...base }, { container: 'auto' }).includes('--merge-output-format'));
  check('a quality cap reaches the format selector', valueAfter(argsWith({ ...base }, { quality: '1080' }), '-f').includes('height<=1080'));

  const mp3 = argsWith({ ...base }, { mode: 'audio', audioFormat: 'mp3' });
  check('audio-only extracts audio', mp3.includes('--extract-audio'));
  check('audio format is honoured', valueAfter(mp3, '--audio-format') === 'mp3');
  check('audio-only does not remux video', !mp3.includes('--merge-output-format'));
  check(
    '"keep original" audio does not convert',
    !argsWith({ ...base }, { mode: 'audio', audioFormat: 'best' }).includes('--audio-format')
  );

  check('the download folder is passed as a path', valueAfter(argsWith({ ...base }), '--paths').startsWith('home:'));
  check('ffmpeg is located for the engine', Boolean(valueAfter(argsWith({ ...base }), '--ffmpeg-location')));

  // What the user types is not what the engine should be handed.
  console.log('settings are checked before they become arguments');
  const clean = (patch) => store.sanitizePatch(patch);
  const rejects = (patch) => {
    try {
      store.sanitizePatch(patch);
      return false;
    } catch {
      return true;
    }
  };

  check('a bare speed limit is read as megabytes, not bytes', clean({ limitRate: '5' }).limitRate === '5M', clean({ limitRate: '5' }).limitRate);
  check('speed limit units are normalised', clean({ limitRate: '800k' }).limitRate === '800K');
  check('a decimal speed limit is kept', clean({ limitRate: '2.5M' }).limitRate === '2.5M');
  check('a blank speed limit stays blank', clean({ limitRate: '   ' }).limitRate === '');
  check('nonsense in the speed limit is refused', rejects({ limitRate: 'fast please' }));

  check('a good proxy is kept', clean({ proxy: 'socks5://127.0.0.1:1080' }).proxy === 'socks5://127.0.0.1:1080');
  check('a blank proxy stays blank', clean({ proxy: '' }).proxy === '');
  check('a proxy with no scheme is refused', rejects({ proxy: '127.0.0.1:1080' }));

  check('downloads at once is clamped down', clean({ maxConcurrent: 99 }).maxConcurrent === 8);
  check('downloads at once is clamped up', clean({ maxConcurrent: 0 }).maxConcurrent === 1);
  check('connections per video is clamped', clean({ concurrentFragments: 999 }).concurrentFragments === 16);
  check('a non-number falls back to the minimum', clean({ maxConcurrent: '' }).maxConcurrent === 1);
  check('blank subtitle languages fall back to a default', clean({ subLangs: '  ' }).subLangs === 'en.*');
  check('window bounds cannot be set from the page', clean({ windowBounds: { x: 1 } }).windowBounds === undefined);

  // The matrix above proves a settings key reaches the command line. This proves the
  // control in the drawer is wired to that key — a checkbox bound to the wrong name,
  // or restored from a different one, would silently do nothing and pass every test.
  console.log('every control in Settings is wired to a real setting');
  const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
  const page = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8');

  const drawer = page.slice(page.indexOf('<aside class="drawer"'), page.indexOf('</aside>'));
  const controls = [...drawer.matchAll(/<(?:input|select)[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  // The folder field is read-only and set by the folder picker, not by typing.
  const expected = controls.filter((id) => id !== 'destInput');

  const bindings = new Map(
    [...script.matchAll(/bind\(\$\('([^']+)'\),\s*'([^']+)'/g)].map((m) => [m[1], m[2]])
  );
  const restores = new Map(
    [...script.matchAll(/\$\('([^']+)'\)\.(?:value|checked)\s*=\s*(?:Boolean\()?settings\.(\w+)/g)]
      .map((m) => [m[1], m[2]])
  );

  const unbound = expected.filter((id) => !bindings.has(id));
  check('no control is left unwired', unbound.length === 0, unbound.join(', '));

  const unknown = [...bindings.values()].filter((key) => !(key in store.DEFAULTS));
  check('every control writes a setting that exists', unknown.length === 0, unknown.join(', '));

  const notRestored = [...bindings.keys()].filter((id) => !restores.has(id));
  check('every control is repopulated when the drawer opens', notRestored.length === 0, notRestored.join(', '));

  const mismatched = [...bindings.entries()]
    .filter(([id, key]) => restores.has(id) && restores.get(id) !== key)
    .map(([id, key]) => `${id}: writes ${key}, reads ${restores.get(id)}`);
  check('a control reads back the same setting it writes', mismatched.length === 0, mismatched.join(' | '));

  check(`all ${expected.length} settings controls accounted for`, expected.length >= 13, String(expected.length));

  const cookieError = friendlyError('ERROR: Could not copy Chrome cookie database', 'https://x.test/v');
  check('a locked cookie database explains itself', /close it completely/i.test(cookieError), cookieError);
  const staleError = friendlyError('ERROR: Unable to extract player response', 'https://x.test/v');
  check('an extractor failure points at Update engine', /update engine/i.test(staleError), staleError);

  console.log('');
  if (failures.length) {
    console.log(`${failures.length} check(s) failed: ${failures.join(', ')}`);
    app.exit(1);
  } else {
    console.log('All checks passed.');
    app.exit(0);
  }
}

app.whenReady()
  .then(main)
  .catch((err) => {
    // Without this an assertion that throws leaves Electron running with no window
    // and no output, which looks like a hang rather than a failure.
    console.error(`\nthe suite crashed: ${err && err.stack ? err.stack : err}`);
    app.exit(1);
  });
