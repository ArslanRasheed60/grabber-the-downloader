'use strict';

/* Grabber renderer: one queue, one intake, no build step. */

const $ = (id) => document.getElementById(id);

const el = {
  setup: $('setup'),
  setupInstall: $('setupInstall'),
  setupSkip: $('setupSkip'),
  setupNote: $('setupNote'),
  setupLede: $('setupLede'),
  toolList: $('toolList'),
  toolStatusList: $('toolStatusList'),
  lamp: $('lamp'),
  urlInput: $('urlInput'),
  analyzeBtn: $('analyzeBtn'),
  qualityChips: $('qualityChips'),
  playlistToggle: $('playlistToggle'),
  intakeHint: $('intakeHint'),
  preview: $('preview'),
  previewThumb: $('previewThumb'),
  previewDuration: $('previewDuration'),
  previewKind: $('previewKind'),
  previewTitle: $('previewTitle'),
  previewSpecs: $('previewSpecs'),
  previewAdd: $('previewAdd'),
  previewDismiss: $('previewDismiss'),
  jobList: $('jobList'),
  emptyState: $('emptyState'),
  queueCount: $('queueCount'),
  pauseAllBtn: $('pauseAllBtn'),
  resumeAllBtn: $('resumeAllBtn'),
  clearBtn: $('clearBtn'),
  railYtdlp: $('railYtdlp'),
  railFfmpeg: $('railFfmpeg'),
  railDest: $('railDest'),
  railStatus: $('railStatus'),
  settingsBtn: $('settingsBtn'),
  settingsDrawer: $('settingsDrawer'),
  closeSettings: $('closeSettings'),
  scrim: $('scrim'),
  openFolderBtn: $('openFolderBtn'),
  toasts: $('toasts'),
  jobTemplate: $('jobTemplate'),
  toolsNote: $('toolsNote'),
  aboutNote: $('aboutNote'),
};

const state = {
  settings: {},
  info: {},
  binaries: null,
  choice: { mode: 'video', quality: 'best' },
  rows: new Map(),
  jobs: new Map(),
  openLogs: new Set(),
  pending: null,
  busy: false,
};

/* ------------------------------------------------------------- formatting */

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtEta(seconds) {
  const text = fmtDuration(seconds);
  return text ? `${text} left` : null;
}

function fmtSpeed(bytesPerSecond) {
  const text = fmtBytes(bytesPerSecond);
  return text ? `${text}/s` : null;
}

function qualityLabel(job) {
  if (job.opts.mode === 'audio') {
    return job.opts.audioFormat === 'best' ? 'Audio' : job.opts.audioFormat.toUpperCase();
  }
  return job.opts.quality === 'best' ? 'Best' : `${job.opts.quality}p`;
}

function baseName(filePath) {
  if (!filePath) return null;
  const parts = String(filePath).split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

/* ----------------------------------------------------------------- toasts */

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast${kind ? ` toast--${kind}` : ''}`;
  node.textContent = message;
  el.toasts.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s ease';
    setTimeout(() => node.remove(), 260);
  }, kind === 'bad' ? 7000 : 4000);
}

function hint(message, kind = '') {
  el.intakeHint.textContent = message;
  el.intakeHint.className = `intake__hint${kind ? ` is-${kind}` : ''}`;
}

const DEFAULT_HINT = 'Paste one link, or several at once — one per line.';

/* ------------------------------------------------------------------ tools */

const TOOL_BLURB = {
  ytdlp: 'Reads the page and fetches the streams',
  ffmpeg: 'Merges video with audio, converts formats',
  ffprobe: 'Inspects media — optional, but keeps the engine quiet',
};

function renderTools(target, status, progressByTool = {}) {
  if (!target || !status) return;
  target.replaceChildren();
  for (const key of ['ytdlp', 'ffmpeg', 'ffprobe']) {
    const tool = status[key];
    const live = progressByTool[key];
    // The status snapshot is from before the install began, so a tool that just
    // finished downloading is still "missing" there. Trust the live event first.
    const busy = live && live.phase === 'downloading';
    const failed = live && live.phase === 'error';
    const justInstalled = live && live.phase === 'done';
    const ready = tool.ok || justInstalled;

    const li = document.createElement('li');
    li.className = 'tool';
    if (busy) li.classList.add('is-busy');
    else if (ready) li.classList.add('is-ok');
    else if (failed || key !== 'ffprobe') li.classList.add('is-bad');

    const dot = document.createElement('span');
    dot.className = 'tool__dot';

    const name = document.createElement('span');
    name.className = 'tool__name';
    name.textContent = tool.label;

    const status_ = document.createElement('span');
    status_.className = 'tool__status';
    if (busy) {
      status_.textContent =
        live.percent !== null && live.percent !== undefined
          ? `${live.percent.toFixed(0)}%`
          : fmtBytes(live.received) || 'downloading';
    } else if (failed) {
      status_.textContent = 'failed';
    } else if (justInstalled && !tool.ok) {
      status_.textContent = 'installed';
    } else if (tool.ok) {
      status_.textContent = sourceLabel(tool.source);
    } else {
      status_.textContent = key === 'ffprobe' ? 'optional' : 'missing';
    }

    // Deliberately not the file path: it ends in the upstream binary's name, and the
    // status column already says where the tool came from.
    const detail = document.createElement('span');
    detail.className = 'tool__detail';
    if (tool.ok) detail.textContent = `version ${shortVersion(tool.version)}`;
    else if (justInstalled) detail.textContent = `version ${shortVersion(live.version)} — ready`;
    else if (failed) detail.textContent = live.error || TOOL_BLURB[key];
    else detail.textContent = TOOL_BLURB[key];

    li.append(dot, name, status_, detail);
    target.append(li);
  }
}

function sourceLabel(source) {
  if (source === 'managed') return 'installed';
  if (source === 'bundled') return 'bundled';
  if (source === 'system') return 'on PATH';
  if (source === 'custom') return 'custom path';
  return 'ready';
}

function shortVersion(version) {
  if (!version) return 'unknown';
  const match = String(version).match(/version\s+([^\s,]+)/i);
  return match ? match[1] : String(version).split(/\s+/)[0];
}

async function refreshBinaries() {
  state.binaries = await window.api.binaries.status();
  renderTools(el.toolStatusList, state.binaries);
  el.railYtdlp.textContent = state.binaries.ytdlp.ok
    ? `engine ${shortVersion(state.binaries.ytdlp.version)}`
    : 'engine missing';
  el.railFfmpeg.textContent = state.binaries.ffmpeg.ok
    ? `ffmpeg ${shortVersion(state.binaries.ffmpeg.version)}`
    : 'ffmpeg missing';
  return state.binaries;
}

/* -------------------------------------------------------------- onboarding */

const setupProgress = {};

async function runInstall() {
  el.setupInstall.disabled = true;
  el.setupSkip.disabled = true;
  el.setupNote.className = 'setup__note';
  el.setupNote.textContent = 'Fetching from GitHub…';
  try {
    const status = await window.api.binaries.install();
    state.binaries = status;
    renderTools(el.toolList, status, setupProgress);
    await refreshBinaries();
    el.setupNote.textContent = 'Ready.';
    setTimeout(() => {
      el.setup.hidden = true;
      el.urlInput.focus();
    }, 500);
  } catch (err) {
    el.setupNote.className = 'setup__note is-error';
    el.setupNote.textContent = err.message;
    el.setupInstall.textContent = 'Try again';
    el.setupInstall.disabled = false;
    el.setupSkip.disabled = false;
  }
}

function showSetup(status) {
  el.setup.hidden = false;
  renderTools(el.toolList, status, setupProgress);
  runInstall();
}

/* ------------------------------------------------------------------- jobs */

function stateLabel(job) {
  switch (job.state) {
    case 'queued':
      return 'Waiting';
    case 'starting':
      return 'Starting';
    case 'downloading':
      return `${(job.percent || 0).toFixed(1)}%`;
    case 'processing':
      return 'Processing';
    case 'paused':
      return 'Paused';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'canceled':
      return 'Canceled';
    default:
      return job.state;
  }
}

function telemetryFor(job) {
  const size = fmtBytes(job.total);
  const got = fmtBytes(job.downloaded);
  const parts = [];

  if (job.state === 'downloading') {
    parts.push(qualityLabel(job));
    if (got && size) parts.push(`${got} of ${size}`);
    else if (got) parts.push(got);
    else if (job.fragmentCount) parts.push(`fragment ${job.fragmentIndex || 0} of ${job.fragmentCount}`);
    const speed = fmtSpeed(job.speed);
    if (speed) parts.push(speed);
    const eta = fmtEta(job.eta);
    if (eta) parts.push(eta);
  } else if (job.state === 'processing') {
    parts.push(job.stage || 'Processing');
    if (size) parts.push(size);
  } else if (job.state === 'paused') {
    parts.push('Paused');
    if (got && size) parts.push(`${got} of ${size}`);
    parts.push('Resume picks up where it stopped');
  } else if (job.state === 'queued') {
    parts.push(qualityLabel(job), 'waiting for a free slot');
  } else if (job.state === 'starting') {
    parts.push(job.stage || 'Preparing');
  } else if (job.state === 'done') {
    parts.push(job.note || baseName(job.filepath) || 'Saved');
    if (size) parts.push(size);
  } else if (job.state === 'canceled') {
    parts.push('Canceled — partial file kept for resume');
  } else if (job.state === 'failed') {
    parts.push(qualityLabel(job));
  }
  return parts.filter(Boolean).join('  ·  ');
}

function makeRow(job) {
  const node = el.jobTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = job.id;

  const q = (selector) => node.querySelector(selector);
  const report = (err) => toast(err.message, 'bad');
  q('.job__pause').addEventListener('click', () => window.api.queue.pause(job.id).catch(report));
  q('.job__resume').addEventListener('click', () => window.api.queue.resume(job.id).catch(report));
  q('.job__reveal').addEventListener('click', async () => {
    try {
      const result = await window.api.reveal(job.id);
      if (result && !result.revealed) {
        toast('Could not pin down that file, so here is the folder it was saved to.');
      }
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  q('.job__close').addEventListener('click', () => window.api.queue.remove(job.id).catch(report));
  q('.job__logtoggle').addEventListener('click', () => toggleLog(job.id));

  node.querySelector('.job__title').addEventListener('dblclick', () => {
    const current = state.jobs.get(job.id);
    if (current) window.api.openExternal(current.url).catch(() => {});
  });

  return node;
}

async function toggleLog(id) {
  const row = state.rows.get(id);
  if (!row) return;
  const pane = row.querySelector('.job__log');
  if (state.openLogs.has(id)) {
    state.openLogs.delete(id);
    pane.hidden = true;
    return;
  }
  state.openLogs.add(id);
  pane.hidden = false;
  try {
    const lines = await window.api.queue.log(id);
    pane.textContent = lines.join('\n');
    pane.scrollTop = pane.scrollHeight;
  } catch {
    pane.textContent = '';
  }
}

function paintRow(row, job) {
  row.dataset.state = job.state;
  row.dataset.mode = job.opts.mode;

  const thumb = row.querySelector('.job__thumb');
  if (job.thumbnail && thumb.getAttribute('src') !== job.thumbnail) {
    thumb.src = job.thumbnail;
    thumb.alt = '';
  } else if (!job.thumbnail) {
    thumb.removeAttribute('src');
  }
  row.classList.toggle('job--noart', !job.thumbnail);

  const title = row.querySelector('.job__title');
  if (title.textContent !== job.title) {
    title.textContent = job.title;
    title.title = `${job.title}\n${job.url}`;
  }

  row.querySelector('.job__state').textContent = stateLabel(job);

  const meter = row.querySelector('.meter');
  const sweeping = job.state === 'processing' || (job.state === 'starting');
  meter.classList.toggle('is-sweeping', sweeping);
  const pct = job.state === 'done' ? 100 : Math.round((job.percent || 0) * 10) / 10;
  meter.style.setProperty('--pct', String(pct));
  meter.setAttribute('aria-valuenow', String(Math.round(pct)));
  meter.setAttribute('aria-label', `${job.title} — ${stateLabel(job)}`);

  row.querySelector('.job__telemetry').textContent = telemetryFor(job);

  const error = row.querySelector('.job__error');
  error.textContent = job.error || '';

  const pauseBtn = row.querySelector('.job__pause');
  pauseBtn.disabled = job.state === 'starting';
}

function renderQueue(jobs) {
  state.jobs = new Map(jobs.map((job) => [job.id, job]));

  const seen = new Set();
  let previous = null;
  for (const job of jobs) {
    seen.add(job.id);
    let row = state.rows.get(job.id);
    if (!row) {
      row = makeRow(job);
      state.rows.set(job.id, row);
    }
    // Keep DOM order in sync with queue order without rebuilding the list.
    const expected = previous ? previous.nextElementSibling : el.jobList.firstElementChild;
    if (expected !== row) {
      if (previous) previous.after(row);
      else el.jobList.prepend(row);
    }
    paintRow(row, job);
    previous = row;
  }

  for (const [id, row] of state.rows) {
    if (!seen.has(id)) {
      row.remove();
      state.rows.delete(id);
      state.openLogs.delete(id);
    }
  }

  const has = jobs.length > 0;
  el.emptyState.hidden = has;
  el.jobList.hidden = !has;
  updateCounts(jobs);
}

function patchJob(job) {
  state.jobs.set(job.id, job);
  const row = state.rows.get(job.id);
  if (!row) {
    renderQueue([...state.jobs.values()]);
    return;
  }
  paintRow(row, job);
  updateCounts([...state.jobs.values()]);
}

function updateCounts(jobs) {
  const counts = jobs.reduce((acc, job) => {
    acc[job.state] = (acc[job.state] || 0) + 1;
    return acc;
  }, {});
  const active = (counts.downloading || 0) + (counts.processing || 0) + (counts.starting || 0);
  const bits = [];
  if (active) bits.push(`${active} running`);
  if (counts.queued) bits.push(`${counts.queued} waiting`);
  if (counts.paused) bits.push(`${counts.paused} paused`);
  if (counts.done) bits.push(`${counts.done} done`);
  if (counts.failed) bits.push(`${counts.failed} failed`);
  el.queueCount.textContent = bits.length ? bits.join(' · ') : 'Nothing queued';

  const finished = (counts.done || 0) + (counts.failed || 0) + (counts.canceled || 0);
  el.clearBtn.disabled = finished === 0;
  el.pauseAllBtn.disabled = active + (counts.queued || 0) === 0;
  el.resumeAllBtn.disabled = (counts.paused || 0) + (counts.failed || 0) === 0;
}

/* ---------------------------------------------------------------- preview */

function spec(term, value) {
  if (!value) return null;
  const wrap = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  wrap.append(dt, dd);
  return wrap;
}

function showPreview(result, { pendingAdd = false } = {}) {
  el.preview.hidden = false;
  el.previewKind.textContent = result.type === 'playlist' ? 'Playlist' : result.extractor || 'Video';
  el.previewTitle.textContent = result.title;

  if (result.thumbnail) {
    el.previewThumb.src = result.thumbnail;
    el.previewThumb.style.visibility = 'visible';
  } else {
    el.previewThumb.removeAttribute('src');
    el.previewThumb.style.visibility = 'hidden';
  }

  const duration = fmtDuration(result.duration);
  el.previewDuration.textContent = duration || '';
  el.previewDuration.hidden = !duration;

  const specs = [];
  if (result.type === 'playlist') {
    specs.push(spec('Videos', String(result.count)));
    if (result.uploader) specs.push(spec('From', result.uploader));
  } else {
    if (result.uploader) specs.push(spec('From', result.uploader));
    if (result.heights && result.heights.length) {
      specs.push(spec('Available', `${result.heights.slice(0, 5).map((h) => `${h}p`).join(', ')}`));
    }
    if (result.isLive) specs.push(spec('Live', 'streaming now'));
    if (result.formatCount) specs.push(spec('Formats', String(result.formatCount)));
  }
  el.previewSpecs.replaceChildren(...specs.filter(Boolean));

  state.pending = pendingAdd ? result : null;
  el.previewAdd.hidden = !pendingAdd;
  el.previewAdd.textContent =
    result.type === 'playlist' ? `Add all ${result.count} videos` : 'Add to queue';
}

function hidePreview() {
  el.preview.hidden = true;
  state.pending = null;
}

/* ------------------------------------------------------------------ queue */

function itemsFrom(result) {
  if (result.type === 'playlist') {
    const folder = result.title;
    const width = String(result.entries.length).length;
    return result.entries.map((entry, index) => ({
      url: entry.url,
      id: entry.id,
      title: entry.title,
      thumbnail: entry.thumbnail,
      duration: entry.duration,
      uploader: entry.uploader,
      extractor: result.extractor,
      folderPrefix: folder,
      indexLabel: String(index + 1).padStart(width, '0'),
    }));
  }
  return [
    {
      url: result.webpageUrl || result.url,
      id: result.id,
      title: result.title,
      thumbnail: result.thumbnail,
      duration: result.duration,
      uploader: result.uploader,
      extractor: result.extractor,
    },
  ];
}

function currentOpts() {
  return {
    mode: state.choice.mode,
    quality: state.choice.quality,
    container: state.settings.container,
    audioFormat: state.settings.audioFormat,
  };
}

async function enqueue(result) {
  const items = itemsFrom(result);
  await window.api.queue.add(items, currentOpts());
  toast(
    items.length > 1 ? `Added ${items.length} videos to the queue` : `Added “${trim(result.title)}”`,
    'ok'
  );
}

function trim(text, max = 48) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const AUTO_ADD_LIMIT = 25;

async function handleSubmit() {
  if (state.busy) return;
  const raw = el.urlInput.value.trim();
  if (!raw) {
    hint('Paste a link first.', 'error');
    return;
  }

  const urls = await window.api.extractUrls(raw);
  const list = urls.length ? urls : [raw];

  state.busy = true;
  el.analyzeBtn.disabled = true;
  hidePreview();

  try {
    if (list.length > 1) {
      await addMany(list);
    } else {
      hint('Reading the link…', 'busy');
      const result = await window.api.probe(list[0], { playlist: el.playlistToggle.checked });
      if (result.type === 'playlist' && result.count > AUTO_ADD_LIMIT) {
        showPreview(result, { pendingAdd: true });
        hint(`That playlist has ${result.count} videos. Confirm to queue them all.`);
      } else if (result.type === 'playlist' && result.count === 0) {
        hint('That playlist came back empty.', 'error');
      } else {
        // The queue row already shows the thumbnail and title, so a preview card
        // here would just say the same thing twice.
        await enqueue(result);
        el.urlInput.value = '';
        hint(DEFAULT_HINT);
      }
    }
  } catch (err) {
    hint(err.message, 'error');
  } finally {
    state.busy = false;
    el.analyzeBtn.disabled = false;
  }
}

/** Several links at once: read them a few at a time and queue each as it resolves. */
async function addMany(urls) {
  let added = 0;
  let index = 0;
  const failures = [];

  const worker = async () => {
    while (index < urls.length) {
      const current = urls[index++];
      hint(`Reading link ${Math.min(index, urls.length)} of ${urls.length}…`, 'busy');
      try {
        const result = await window.api.probe(current, { playlist: el.playlistToggle.checked });
        await window.api.queue.add(itemsFrom(result), currentOpts());
        added += 1;
      } catch (err) {
        failures.push({ url: current, message: err.message });
      }
    }
  };

  await Promise.all([worker(), worker()]);
  el.urlInput.value = '';

  if (!failures.length) {
    hint(DEFAULT_HINT);
    toast(`Added ${added} links to the queue`, 'ok');
    return;
  }

  // Name the site and the reason — "1 could not be read" tells nobody anything.
  const first = failures[0];
  const site = hostOf(first.url);
  const detail = `${site}: ${first.message}`;
  if (added) {
    hint(`Added ${added}. ${failures.length} failed — ${detail}`, 'error');
  } else if (failures.length === 1) {
    hint(detail, 'error');
  } else {
    hint(`None of those ${failures.length} links could be read. ${detail}`, 'error');
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'that link';
  }
}

/* --------------------------------------------------------------- settings */

function bindSettings() {
  const bind = (node, key, read) => {
    node.addEventListener('change', async () => {
      try {
        state.settings = await window.api.settings.set({ [key]: read(node) });
        applySettings(state.settings, { skipInputs: true });
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
  };

  bind($('containerSelect'), 'container', (n) => n.value);
  bind($('audioSelect'), 'audioFormat', (n) => n.value);
  bind($('concurrentInput'), 'maxConcurrent', (n) => Math.max(1, Math.min(8, Number(n.value) || 1)));
  bind($('fragmentsInput'), 'concurrentFragments', (n) =>
    Math.max(1, Math.min(16, Number(n.value) || 1))
  );
  bind($('cookiesSelect'), 'cookiesFrom', (n) => n.value);
  bind($('rateInput'), 'limitRate', (n) => n.value.trim());
  bind($('proxyInput'), 'proxy', (n) => n.value.trim());
  bind($('subLangsInput'), 'subLangs', (n) => n.value.trim() || 'en.*');
  bind($('optThumbnail'), 'embedThumbnail', (n) => n.checked);
  bind($('optMetadata'), 'embedMetadata', (n) => n.checked);
  bind($('optChapters'), 'embedChapters', (n) => n.checked);
  bind($('optSubs'), 'writeSubs', (n) => n.checked);
  bind($('optSponsor'), 'sponsorblock', (n) => n.checked);

  $('chooseDestBtn').addEventListener('click', async () => {
    try {
      const dir = await window.api.chooseFolder();
      if (dir) {
        state.settings = await window.api.settings.get();
        applySettings(state.settings);
        toast('Downloads will go to the new folder', 'ok');
      }
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  $('updateYtdlpBtn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    el.toolsNote.textContent = 'Downloading the latest engine…';
    try {
      const tool = await window.api.binaries.updateYtDlp();
      await refreshBinaries();
      el.toolsNote.textContent = `Now running ${shortVersion(tool.version)}.`;
      toast('Engine updated', 'ok');
    } catch (err) {
      el.toolsNote.textContent = err.message;
      toast(err.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });

  $('repairBtn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    el.toolsNote.textContent = 'Checking…';
    try {
      await window.api.binaries.install();
      await refreshBinaries();
      el.toolsNote.textContent = 'Everything is in place.';
      toast('Tools are ready', 'ok');
    } catch (err) {
      el.toolsNote.textContent = err.message;
      toast(err.message, 'bad');
    } finally {
      button.disabled = false;
    }
  });
}

function applySettings(settings, { skipInputs = false } = {}) {
  state.settings = settings;
  el.railDest.textContent = settings.downloadDir;
  el.railDest.title = `Open ${settings.downloadDir}`;

  if (skipInputs) return;
  $('destInput').value = settings.downloadDir;
  $('containerSelect').value = settings.container;
  $('audioSelect').value = settings.audioFormat;
  $('concurrentInput').value = settings.maxConcurrent;
  $('fragmentsInput').value = settings.concurrentFragments;
  $('cookiesSelect').value = settings.cookiesFrom;
  $('rateInput').value = settings.limitRate || '';
  $('proxyInput').value = settings.proxy || '';
  $('subLangsInput').value = settings.subLangs || 'en.*';
  $('optThumbnail').checked = Boolean(settings.embedThumbnail);
  $('optMetadata').checked = Boolean(settings.embedMetadata);
  $('optChapters').checked = Boolean(settings.embedChapters);
  $('optSubs').checked = Boolean(settings.writeSubs);
  $('optSponsor').checked = Boolean(settings.sponsorblock);
}

function openDrawer() {
  el.settingsDrawer.hidden = false;
  el.scrim.hidden = false;
  el.closeSettings.focus();
}

function closeDrawer() {
  el.settingsDrawer.hidden = true;
  el.scrim.hidden = true;
}

/* ------------------------------------------------------------------- wire */

function wireUi() {
  el.qualityChips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    for (const node of el.qualityChips.querySelectorAll('.chip')) {
      const on = node === chip;
      node.classList.toggle('is-on', on);
      node.setAttribute('aria-checked', String(on));
    }
    state.choice = { mode: chip.dataset.mode, quality: chip.dataset.quality };
  });

  el.analyzeBtn.addEventListener('click', handleSubmit);
  el.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSubmit();
    }
  });

  // "Just paste the link" — a paste that looks like a link goes straight in.
  el.urlInput.addEventListener('paste', () => {
    setTimeout(() => {
      const value = el.urlInput.value.trim();
      if (/^https?:\/\//i.test(value) && !state.busy) handleSubmit();
    }, 30);
  });

  el.previewAdd.addEventListener('click', async () => {
    if (!state.pending) return;
    const result = state.pending;
    el.previewAdd.disabled = true;
    try {
      await enqueue(result);
      el.urlInput.value = '';
      hint(DEFAULT_HINT);
      state.pending = null;
      el.previewAdd.hidden = true;
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.previewAdd.disabled = false;
    }
  });
  el.previewDismiss.addEventListener('click', hidePreview);

  el.pauseAllBtn.addEventListener('click', () => window.api.queue.pauseAll());
  el.resumeAllBtn.addEventListener('click', () => window.api.queue.resumeAll());
  el.clearBtn.addEventListener('click', () => window.api.queue.clearFinished());

  el.settingsBtn.addEventListener('click', () => {
    if (el.settingsDrawer.hidden) openDrawer();
    else closeDrawer();
  });
  el.closeSettings.addEventListener('click', closeDrawer);
  el.scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.settingsDrawer.hidden) closeDrawer();
  });

  const openDest = () => window.api.openFolder().catch((err) => toast(err.message, 'bad'));
  el.openFolderBtn.addEventListener('click', openDest);
  el.railDest.addEventListener('click', openDest);

  el.setupInstall.addEventListener('click', runInstall);
  el.setupSkip.addEventListener('click', () => {
    el.setup.hidden = true;
    el.urlInput.focus();
  });

  window.api.onToast(({ message, kind }) => toast(message, kind || ''));
  window.api.onBinariesChanged(() => {
    refreshBinaries().catch(() => {});
  });

  window.api.onQueueList(renderQueue);
  window.api.onQueueJob(patchJob);
  window.api.onQueueDone((job) => toast(`Finished “${trim(job.title)}”`, 'ok'));
  window.api.onQueueSummary((summary) => {
    el.lamp.classList.toggle('is-live', summary.active > 0);
    if (summary.active > 0) {
      const speed = fmtSpeed(summary.speed);
      el.railStatus.textContent = `${summary.active} downloading${speed ? ` · ${speed}` : ''}`;
    } else if (summary.queued > 0) {
      el.railStatus.textContent = `${summary.queued} waiting`;
    } else {
      el.railStatus.textContent = 'Idle';
    }
  });

  window.api.onQueueLog(({ id, line }) => {
    if (!state.openLogs.has(id)) return;
    const row = state.rows.get(id);
    if (!row) return;
    const pane = row.querySelector('.job__log');
    const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 24;
    pane.textContent += (pane.textContent ? '\n' : '') + line;
    if (atBottom) pane.scrollTop = pane.scrollHeight;
  });

  window.api.onSetupProgress((event) => {
    setupProgress[event.tool] = event;
    if (state.binaries) {
      renderTools(el.toolList, state.binaries, setupProgress);
      renderTools(el.toolStatusList, state.binaries, setupProgress);
    }
    if (event.phase === 'downloading' && !el.setup.hidden) {
      const size = fmtBytes(event.received);
      el.setupNote.textContent = `${event.label} — ${size || 'downloading'}${
        event.percent ? ` (${event.percent.toFixed(0)}%)` : ''
      }`;
    }
  });
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  wireUi();
  bindSettings();

  state.info = await window.api.appInfo();
  document.body.classList.add(
    state.info.platform === 'darwin' ? 'platform-mac' : state.info.platform === 'win32' ? 'platform-win' : 'platform-linux'
  );
  el.aboutNote.textContent = `Grabber ${state.info.version} · Electron ${state.info.electron} · ${state.info.platform}-${state.info.arch}`;

  state.settings = await window.api.settings.get();
  applySettings(state.settings);

  const status = await refreshBinaries();
  renderQueue(await window.api.queue.list());

  if (!status.ready) {
    showSetup(status);
  } else {
    el.setup.hidden = true;
    el.urlInput.focus();
  }
}

boot().catch((err) => {
  document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#e7eef6">
    <h1>Grabber could not start</h1><p style="color:#93a2b5">${err.message}</p></div>`;
});
