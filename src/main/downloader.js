'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const binaries = require('./binaries');
const store = require('./store');
const {
  makeId,
  num,
  sanitizeSegment,
  escapeOutputLiteral,
  scrubToolNames,
  asciiKey,
  idTokenFrom,
} = require('./util');

/**
 * The download queue.
 *
 * Progress does not come from scraping yt-dlp's human-readable bar — we hand it a
 * --progress-template with machine fields, so every update arrives as one tagged
 * line with exact byte counts. Everything else yt-dlp prints is kept as a log.
 */

const P_TAG = '@@P@@';
const PP_TAG = '@@PP@@';
const FILE_TAG = '@@FILE@@';

const PROGRESS_TEMPLATE =
  `download:${P_TAG}%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s` +
  '|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s' +
  '|%(progress.fragment_index)s|%(progress.fragment_count)s' +
  '|%(info.vcodec)s|%(info.acodec)s';

const POSTPROCESS_TEMPLATE = `postprocess:${PP_TAG}%(progress.status)s|%(progress.postprocessor)s`;

const MAX_LOG_LINES = 400;
/** Share of the meter given to the video stream when audio is still to come. */
const VIDEO_SHARE = 85;
const ACTIVE_STATES = new Set(['downloading', 'processing', 'starting']);

class Downloader extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.order = [];
    this.children = new Map();
    this.lastEmit = new Map();
    this.emitTimers = new Map();
  }

  /* ---------------------------------------------------------------- state */

  list() {
    return this.order.map((id) => this.publicJob(this.jobs.get(id))).filter(Boolean);
  }

  publicJob(job) {
    if (!job) return null;
    const { log, ...rest } = job;
    void log;
    return rest;
  }

  activeCount() {
    let count = 0;
    for (const job of this.jobs.values()) if (ACTIVE_STATES.has(job.state)) count += 1;
    return count;
  }

  /** Structural changes redraw the whole list; progress ticks patch one row. */
  emitList() {
    this.emit('list', this.list());
  }

  emitJob(job, { immediate = false } = {}) {
    if (!job) return;
    if (immediate) {
      clearTimeout(this.emitTimers.get(job.id));
      this.emitTimers.delete(job.id);
      this.lastEmit.set(job.id, Date.now());
      this.emit('job', this.publicJob(job));
      return;
    }
    const last = this.lastEmit.get(job.id) || 0;
    const wait = 120 - (Date.now() - last);
    if (wait <= 0) {
      this.lastEmit.set(job.id, Date.now());
      this.emit('job', this.publicJob(job));
    } else if (!this.emitTimers.has(job.id)) {
      this.emitTimers.set(
        job.id,
        setTimeout(() => {
          this.emitTimers.delete(job.id);
          this.lastEmit.set(job.id, Date.now());
          const current = this.jobs.get(job.id);
          if (current) this.emit('job', this.publicJob(current));
        }, wait)
      );
    }
  }

  addLog(job, line) {
    // The log pane shows the engine's own output, so it gets scrubbed too. Parsing
    // in consumeLine runs against the raw line, not this copy.
    const text = scrubToolNames(String(line).replace(/\r/g, '').trimEnd());
    if (!text) return;
    job.log.push(text);
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
    this.emit('log', { id: job.id, line: text });
  }

  getLog(id) {
    const job = this.jobs.get(id);
    return job ? job.log.slice() : [];
  }

  /* ----------------------------------------------------------------- queue */

  /**
   * @param {Array} items  [{url, title, thumbnail, duration, uploader, extractor, folderPrefix, indexLabel}]
   * @param {Object} opts  {mode, quality, container, audioFormat}
   */
  add(items, opts = {}) {
    const settings = store.getSettings();
    const created = [];
    for (const item of items) {
      if (!item || !item.url) continue;
      const job = {
        id: makeId(),
        url: item.url,
        // The site's own id, which is baked into every filename we write.
        videoId: item.id || null,
        title: item.title || item.url,
        uploader: item.uploader || null,
        duration: item.duration ?? null,
        thumbnail: item.thumbnail || null,
        extractor: item.extractor || null,
        opts: {
          mode: opts.mode === 'audio' ? 'audio' : 'video',
          quality: opts.quality || settings.quality || 'best',
          container: opts.container || settings.container || 'mp4',
          audioFormat: opts.audioFormat || settings.audioFormat || 'mp3',
          folderPrefix: item.folderPrefix || null,
          indexLabel: item.indexLabel || null,
        },
        destDir: opts.destDir || settings.downloadDir,
        state: 'queued',
        percent: 0,
        downloaded: null,
        total: null,
        speed: null,
        eta: null,
        fragmentIndex: null,
        fragmentCount: null,
        // A "bv+ba" download arrives as two separate streams. streamBytes carries
        // the finished ones so the meter fills once instead of once per stream.
        streamBytes: 0,
        stage: null,
        filepath: null,
        error: null,
        note: null,
        addedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        log: [],
      };
      this.jobs.set(job.id, job);
      this.order.push(job.id);
      created.push(job);
    }
    this.emitList();
    this.pump();
    return created.map((job) => this.publicJob(job));
  }

  pump() {
    const settings = store.getSettings();
    const limit = Math.max(1, Number(settings.maxConcurrent) || 2);
    for (const id of this.order) {
      if (this.activeCount() >= limit) break;
      const job = this.jobs.get(id);
      if (job && job.state === 'queued') this.start(job);
    }
  }

  /* ------------------------------------------------------------ arguments */

  buildArgs(job, tools) {
    const settings = store.getSettings();
    const args = [
      '--ignore-config',
      '--no-warnings',
      '--newline',
      '--color',
      'no_color',
      // Without this the engine writes stdout in the console code page and silently
      // drops anything it cannot encode. Titles routinely contain emoji, non-Latin
      // scripts, and the full-width ｜ ？ ： it substitutes for illegal Windows
      // characters — so the path it reports back would not be the file it wrote.
      '--encoding',
      'utf-8',
      '--progress',
      '--no-quiet',
      '--no-simulate',
      '--progress-template',
      PROGRESS_TEMPLATE,
      '--progress-template',
      POSTPROCESS_TEMPLATE,
      '--print',
      `after_move:${FILE_TAG}%(filepath)s`,
      '--no-playlist',
      '--retries',
      '10',
      '--fragment-retries',
      '10',
      '--socket-timeout',
      '20',
      '--concurrent-fragments',
      String(Math.max(1, Number(settings.concurrentFragments) || 4)),
    ];

    if (tools.ffmpeg.ok) args.push('--ffmpeg-location', path.dirname(tools.ffmpeg.path));
    if (settings.limitRate) args.push('--limit-rate', String(settings.limitRate));
    if (settings.proxy) args.push('--proxy', String(settings.proxy));
    // An explicit cookies file wins: it is the only route that works for Chromium
    // browsers on Windows, so if one is set it should not be second-guessed.
    if (settings.cookiesFile) {
      args.push('--cookies', String(settings.cookiesFile));
    } else if (settings.cookiesFrom && settings.cookiesFrom !== 'none') {
      args.push('--cookies-from-browser', String(settings.cookiesFrom));
    }

    const { mode, quality, container, audioFormat } = job.opts;

    if (mode === 'audio') {
      args.push('-f', 'bestaudio/best', '--extract-audio');
      if (audioFormat && audioFormat !== 'best') {
        args.push('--audio-format', audioFormat, '--audio-quality', '0');
      }
    } else {
      args.push('-f', this.formatSelector(quality, container));
      if (container && container !== 'auto') args.push('--merge-output-format', container);
    }

    if (settings.embedMetadata) args.push('--embed-metadata');
    if (settings.embedChapters) args.push('--embed-chapters');
    if (settings.embedThumbnail) args.push('--embed-thumbnail');
    if (settings.sponsorblock) args.push('--sponsorblock-remove', 'default');
    if (settings.writeSubs && mode !== 'audio') {
      args.push(
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        settings.subLangs || 'en.*',
        '--embed-subs'
      );
    }

    args.push('--paths', `home:${job.destDir}`, '-o', this.outputTemplate(job), job.url);
    return args;
  }

  formatSelector(quality, container) {
    const height = Number(quality);
    const wantsMp4 = container === 'mp4';
    if (!Number.isFinite(height) || height <= 0) {
      return wantsMp4 ? 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b' : 'bv*+ba/b';
    }
    const cap = `[height<=${height}]`;
    // Try the cap first, then fall back so an unusual host still yields a file.
    return wantsMp4
      ? `bv*${cap}[ext=mp4]+ba[ext=m4a]/bv*${cap}+ba/b${cap}/bv*+ba/b`
      : `bv*${cap}+ba/b${cap}/bv*+ba/b`;
  }

  outputTemplate(job) {
    let name = '%(title).150s [%(id)s].%(ext)s';
    if (job.opts.indexLabel) {
      name = `${escapeOutputLiteral(job.opts.indexLabel)} - ${name}`;
    }
    if (job.opts.folderPrefix) {
      return `${escapeOutputLiteral(sanitizeSegment(job.opts.folderPrefix))}/${name}`;
    }
    return name;
  }

  /* ------------------------------------------------------------- lifecycle */

  async start(job) {
    if (!job || ACTIVE_STATES.has(job.state)) return;
    job.state = 'starting';
    job.error = null;
    job.note = null;
    job.stage = 'Preparing';
    // A restart replays the stream sequence from the beginning. lastError has to go
    // too, or a retry that dies without printing ERROR: reports the previous reason.
    job.streamBytes = 0;
    job.lastError = null;
    job.startedAt = job.startedAt || Date.now();
    this.emitJob(job, { immediate: true });

    const [ytdlp, ffmpeg, ffprobe] = await Promise.all([
      binaries.inspect('ytdlp'),
      binaries.inspect('ffmpeg'),
      binaries.inspect('ffprobe'),
    ]);

    if (!ytdlp.ok) {
      this.fail(job, 'The download engine is not installed yet. Finish setup first.');
      return;
    }
    if (this.jobs.get(job.id) !== job || job.state !== 'starting') return;

    try {
      fs.mkdirSync(job.destDir, { recursive: true });
    } catch (err) {
      this.fail(job, `Cannot write to ${job.destDir}: ${err.message}`);
      return;
    }

    const args = this.buildArgs(job, { ffmpeg, ffprobe });
    this.addLog(job, `$ engine ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);

    let child;
    try {
      child = spawn(ytdlp.path, args, {
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      this.fail(job, `Could not start the download engine: ${err.message}`);
      return;
    }

    this.children.set(job.id, child);
    job.state = 'downloading';
    job.stage = 'Connecting';
    job.killReason = null;
    this.emitJob(job, { immediate: true });

    let outBuffer = '';
    let errBuffer = '';

    const handleOut = (chunk) => {
      outBuffer += chunk;
      const lines = outBuffer.split(/\r?\n/);
      outBuffer = lines.pop();
      for (const line of lines) this.consumeLine(job, line);
    };
    const handleErr = (chunk) => {
      errBuffer += chunk;
      const lines = errBuffer.split(/\r?\n/);
      errBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        this.addLog(job, line);
        if (/^ERROR:/i.test(line.trim())) job.lastError = line.trim();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', handleOut);
    child.stderr.on('data', handleErr);

    child.on('error', (err) => {
      this.children.delete(job.id);
      this.fail(job, `The download engine stopped unexpectedly: ${err.message}`);
    });

    child.on('close', (code) => {
      if (outBuffer.trim()) this.consumeLine(job, outBuffer);
      if (errBuffer.trim()) this.addLog(job, errBuffer);
      outBuffer = '';
      errBuffer = '';
      this.children.delete(job.id);
      this.finish(job, code);
    });
  }

  consumeLine(job, rawLine) {
    const line = String(rawLine).replace(/\r/g, '').trimEnd();
    if (!line) return;

    if (line.startsWith(P_TAG)) {
      this.applyProgress(job, line.slice(P_TAG.length));
      return;
    }
    if (line.startsWith(PP_TAG)) {
      const [status, processor] = line.slice(PP_TAG.length).split('|');
      if (status === 'started' || status === 'processing') {
        job.state = 'processing';
        job.stage = this.describeProcessor(processor, job);
        job.speed = null;
        job.eta = null;
        this.emitJob(job, { immediate: true });
      }
      return;
    }
    if (line.startsWith(FILE_TAG)) {
      job.filepath = line.slice(FILE_TAG.length).trim() || job.filepath;
      return;
    }

    // Anything else is human-readable output: log it, and mine it for the
    // final path in the cases where after_move never fires.
    this.addLog(job, line);

    let match = line.match(/^\[download\]\s+(.+?)\s+has already been downloaded/i);
    if (match) {
      job.filepath = match[1].trim();
      job.note = 'Already in your downloads folder';
      job.percent = 100;
      return;
    }
    match = line.match(/^\[(?:download|ExtractAudio)\]\s+Destination:\s+(.+)$/i);
    if (match) {
      job.filepath = match[1].trim();
      return;
    }
    match = line.match(/^\[Merger\] Merging formats into "(.+)"$/i);
    if (match) {
      job.filepath = match[1].trim();
      return;
    }
    if (/^\[info\]/i.test(line) || /^\[youtube/i.test(line)) return;
  }

  describeProcessor(processor, job) {
    const name = String(processor || '').trim();
    if (/Merger/i.test(name)) return 'Merging video and audio';
    if (/ExtractAudio/i.test(name)) return `Converting to ${job.opts.audioFormat.toUpperCase()}`;
    if (/EmbedThumbnail/i.test(name)) return 'Embedding cover art';
    if (/Metadata/i.test(name)) return 'Writing metadata';
    if (/SubtitlesConvertor|EmbedSubtitle/i.test(name)) return 'Embedding subtitles';
    if (/SponsorBlock|ModifyChapters/i.test(name)) return 'Removing sponsor segments';
    if (/VideoConvertor|Remux/i.test(name)) return 'Remuxing';
    return name ? `Processing (${name})` : 'Processing';
  }

  applyProgress(job, payload) {
    const [status, downloaded, total, estimate, speed, eta, fragIndex, fragCount, vcodec, acodec] =
      payload.split('|');

    const done = num(downloaded);
    const size = num(total) ?? num(estimate);
    const index = num(fragIndex);
    const count = num(fragCount);
    const base = job.streamBytes || 0;

    if (done !== null) job.downloaded = base + done;
    job.total = size !== null ? base + size : null;
    job.speed = num(speed);
    job.eta = num(eta);
    job.fragmentIndex = index;
    job.fragmentCount = count;

    // yt-dlp reports each stream from zero, so raw numbers would fill the meter once
    // per stream. Split the scale instead: a video-only stream (audio must still be
    // coming) drives the first 85%, and whatever follows drives the rest.
    let ratio = null;
    if (done !== null && size) ratio = done / size;
    else if (index !== null && count) ratio = index / count;

    let percent = null;
    if (ratio !== null) {
      if (base > 0) percent = VIDEO_SHARE + ratio * (100 - VIDEO_SHARE);
      else if (this.isVideoOnly(vcodec, acodec)) percent = ratio * VIDEO_SHARE;
      else percent = ratio * 100;
    }
    // Never show 100% while the process is still working — a finished stream is not
    // a finished download, and post-processing still has to run. Never go backwards
    // either: a meter that retreats reads as a bug even when the number is honest.
    if (percent !== null) {
      job.percent = Math.min(99.5, Math.max(job.percent || 0, percent));
    }

    if (status === 'finished') {
      job.streamBytes = base + (size ?? done ?? 0);
      job.stage = 'Fetched';
      job.speed = null;
      job.eta = null;
      this.emitJob(job, { immediate: true });
      return;
    }

    if (job.state === 'downloading') {
      const what = this.describeStream(vcodec, acodec);
      job.stage =
        count && count > 1 ? `${what} — fragment ${index || 0} of ${count}` : what;
    }
    this.emitJob(job);
  }

  /** yt-dlp downloads video and audio separately; say which one is moving. */
  describeStream(vcodec, acodec) {
    const hasVideo = this.present(vcodec);
    const hasAudio = this.present(acodec);
    if (hasVideo && !hasAudio) return 'Downloading video';
    if (hasAudio && !hasVideo) return 'Downloading audio';
    return 'Downloading';
  }

  present(codec) {
    return Boolean(codec) && codec !== 'none' && codec !== 'NA';
  }

  isVideoOnly(vcodec, acodec) {
    return this.present(vcodec) && !this.present(acodec);
  }

  finish(job, code) {
    // The child's close event lands after a remove(), and reviving a row the user
    // deleted — or filing it into history — is worse than losing the exit code.
    if (this.jobs.get(job.id) !== job) return;
    const reason = job.killReason;
    job.killReason = null;
    job.speed = null;
    job.eta = null;

    if (reason === 'pause') {
      job.state = 'paused';
      job.stage = 'Paused';
      job.finishedAt = null;
      this.emitJob(job, { immediate: true });
      this.pump();
      return;
    }
    if (reason === 'cancel') {
      job.state = 'canceled';
      job.stage = null;
      job.finishedAt = Date.now();
      this.emitJob(job, { immediate: true });
      this.pump();
      return;
    }

    if (code === 0) {
      job.state = 'done';
      job.percent = 100;
      job.stage = null;
      job.finishedAt = Date.now();
      this.emitJob(job, { immediate: true });
      store.addHistory({
        title: job.title,
        url: job.url,
        filepath: job.filepath,
        mode: job.opts.mode,
        finishedAt: job.finishedAt,
        bytes: job.total,
      });
      this.emit('done', this.publicJob(job));
      this.pump();
      return;
    }

    const detail = job.lastError
      ? require('./probe').friendlyError(job.lastError, job.url)
      : `The download engine stopped with code ${code}.`;
    this.fail(job, detail);
  }

  fail(job, message) {
    if (this.jobs.get(job.id) !== job) return;
    job.state = 'failed';
    job.stage = null;
    job.error = message;
    job.speed = null;
    job.eta = null;
    job.finishedAt = Date.now();
    this.emitJob(job, { immediate: true });
    this.pump();
  }

  /* ------------------------------------------------------------ finding it */

  /**
   * Where did this download actually land?
   *
   * The recorded path is right almost always. When it is not — a name written before
   * the encoding fix, or a file the user has since renamed or moved — search for it
   * rather than dead-ending, and remember what we find.
   *
   * @returns {{file: string|null, dir: string|null}}
   */
  resolveFile(id) {
    const job = this.jobs.get(id);
    if (!job) return { file: null, dir: null };

    if (job.filepath && this.isFile(job.filepath)) {
      return { file: job.filepath, dir: path.dirname(job.filepath) };
    }

    const found = this.searchForFile(job);
    if (found) {
      job.filepath = found;
      job.note = null;
      this.emitJob(job, { immediate: true });
      return { file: found, dir: path.dirname(found) };
    }

    const dir = this.candidateDirs(job).find((candidate) => this.isDir(candidate));
    return { file: null, dir: dir || null };
  }

  isFile(target) {
    try {
      return fs.statSync(target).isFile();
    } catch {
      return false;
    }
  }

  isDir(target) {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  }

  /** Everywhere this job's file could reasonably be, most specific first. */
  candidateDirs(job) {
    const dirs = [];
    if (job.filepath) dirs.push(path.dirname(job.filepath));
    if (job.destDir) {
      if (job.opts.folderPrefix) {
        dirs.push(path.join(job.destDir, sanitizeSegment(job.opts.folderPrefix)));
      }
      dirs.push(job.destDir);
    }
    return [...new Set(dirs)];
  }

  searchForFile(job) {
    const recorded = job.filepath ? path.basename(job.filepath) : null;
    // The id survives both mangling and renaming, so it is the strongest anchor.
    const token = job.videoId || (recorded ? idTokenFrom(recorded) : null);
    const wanted = recorded ? asciiKey(recorded) : null;

    for (const dir of this.candidateDirs(job)) {
      let names;
      try {
        names = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
      } catch {
        continue;
      }

      if (recorded) {
        const exact = names.find((name) => name.toLowerCase() === recorded.toLowerCase());
        if (exact) return path.join(dir, exact);
      }
      if (token) {
        const byId = names.filter((name) => name.includes(`[${token}]`));
        // Only trust it when it is unambiguous.
        if (byId.length === 1) return path.join(dir, byId[0]);
      }
      if (wanted) {
        const loose = names.filter((name) => asciiKey(name) === wanted);
        if (loose.length === 1) return path.join(dir, loose[0]);
      }
    }
    return null;
  }

  /* --------------------------------------------------------------- control */

  killTree(job, reason) {
    const child = this.children.get(job.id);
    if (!child) return false;
    job.killReason = reason;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
        'error',
        () => child.kill('SIGKILL')
      );
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 4000);
    }
    return true;
  }

  pause(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (ACTIVE_STATES.has(job.state)) {
      this.killTree(job, 'pause');
    } else if (job.state === 'queued') {
      job.state = 'paused';
      job.stage = 'Paused';
      this.emitJob(job, { immediate: true });
    }
  }

  resume(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.state === 'paused' || job.state === 'failed' || job.state === 'canceled') {
      job.state = 'queued';
      job.stage = 'Waiting';
      job.error = null;
      this.emitJob(job, { immediate: true });
      this.pump();
    }
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (ACTIVE_STATES.has(job.state)) {
      this.killTree(job, 'cancel');
    } else if (job.state !== 'done') {
      job.state = 'canceled';
      job.stage = null;
      job.finishedAt = Date.now();
      this.emitJob(job, { immediate: true });
      this.pump();
    }
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (ACTIVE_STATES.has(job.state)) this.killTree(job, 'cancel');
    this.jobs.delete(id);
    this.order = this.order.filter((jobId) => jobId !== id);
    clearTimeout(this.emitTimers.get(id));
    this.emitTimers.delete(id);
    this.lastEmit.delete(id);
    this.emitList();
    this.pump();
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.percent = 0;
    job.downloaded = null;
    job.total = null;
    job.filepath = null;
    job.note = null;
    job.log.length = 0;
    this.resume(id);
  }

  clearFinished() {
    const finished = new Set(['done', 'canceled', 'failed']);
    for (const id of [...this.order]) {
      const job = this.jobs.get(id);
      if (job && finished.has(job.state)) {
        this.jobs.delete(id);
        this.order = this.order.filter((jobId) => jobId !== id);
      }
    }
    this.emitList();
  }

  pauseAll() {
    for (const id of this.order) {
      const job = this.jobs.get(id);
      if (job && (ACTIVE_STATES.has(job.state) || job.state === 'queued')) this.pause(id);
    }
  }

  resumeAll() {
    for (const id of this.order) {
      const job = this.jobs.get(id);
      if (job && (job.state === 'paused' || job.state === 'failed')) this.resume(id);
    }
  }

  /** Aggregate figure for the taskbar/dock progress indicator. */
  summary() {
    let active = 0;
    let queued = 0;
    let done = 0;
    let failed = 0;
    let percentSum = 0;
    let speed = 0;
    for (const job of this.jobs.values()) {
      if (ACTIVE_STATES.has(job.state)) {
        active += 1;
        percentSum += job.percent || 0;
        speed += job.speed || 0;
      } else if (job.state === 'queued') queued += 1;
      else if (job.state === 'done') done += 1;
      else if (job.state === 'failed') failed += 1;
    }
    return {
      active,
      queued,
      done,
      failed,
      total: this.jobs.size,
      percent: active ? percentSum / active : null,
      speed: active ? speed : null,
    };
  }

  shutdown() {
    for (const [id, child] of this.children) {
      const job = this.jobs.get(id);
      if (job) job.killReason = 'cancel';
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    }
    this.children.clear();
  }
}

module.exports = new Downloader();
