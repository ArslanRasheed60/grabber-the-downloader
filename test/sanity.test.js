'use strict';

// Final control-by-control sanity check. Dialog selections and OS launches are
// intercepted so this isolated test cannot open Explorer, browsers or account
// cookies. The renderer, preload, IPC, settings and queue remain real.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const vm = require('vm');
const assert = require('assert/strict');
const { createRequire } = require('module');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const { app, BrowserWindow, dialog, shell } = require('electron');
app.disableHardwareAcceleration();
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'release', `sanity-${Date.now()}`);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grabber-sanity-'));
app.setAppPath(root);
app.setPath('userData', profile);
fs.mkdirSync(output, { recursive: true });
const checks = [];
let downloader;
let server;
let win;
function pass(name, detail = '') {
  checks.push({ name, status: 'pass', detail });
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(checks, null, 2));
  console.log(`PASS: ${name}`);
}

app.whenReady().then(async () => {
  const store = require('../src/main/store');
  const binaries = require('../src/main/binaries');
  const probeModule = require('../src/main/probe');
  downloader = require('../src/main/downloader');
  store.updateSettings({ downloadDir: output });
  binaries.STALE_AFTER_DAYS = Infinity;
  const ready = await binaries.getStatus();
  assert.ok(ready.ready && ready.ffprobe.ok);
  const actualStatus = binaries.getStatus;
  const actualEnsure = binaries.ensureAll;
  const actualUpdate = binaries.updateYtDlp;
  const actualProbe = probeModule.probe;
  const actualPump = downloader.pump;
  downloader.pump = () => {};

  let probeCalls = [];
  let synthetic = true;
  probeModule.probe = async (url, options) => {
    probeCalls.push({ url, options });
    if (!synthetic) return actualProbe(url, options);
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (url.includes('invalid')) throw new Error('Sanity invalid link');
    if (url.includes('playlist')) {
      const count = url.includes('large') ? 26 : url.includes('empty') ? 0 : 3;
      return { type: 'playlist', title: 'Sanity playlist', extractor: 'Fixture', count,
        entries: Array.from({ length: count }, (_, i) => ({ id: String(i), title: `Video ${i + 1}`, url: `https://fixture.test/video-${i}` })) };
    }
    return { type: 'video', id: 'fixture', title: 'Sanity video', webpageUrl: url, duration: 4, heights: [360], extractor: 'Fixture' };
  };
  let dialogResult = { canceled: true, filePaths: [] };
  const dialogCalls = [];
  dialog.showOpenDialog = async (_window, options) => { dialogCalls.push(options); return dialogResult; };
  const shellCalls = [];
  let shellError = '';
  shell.openPath = async (file) => { shellCalls.push({ action: 'openPath', file }); return shellError; };
  shell.showItemInFolder = (file) => { shellCalls.push({ action: 'reveal', file }); };
  shell.openExternal = async (url) => { shellCalls.push({ action: 'external', url }); };
  BrowserWindow.prototype.show = function () {};
  const mainFile = path.join(root, 'src', 'main', 'main.js');
  let mainSource = fs.readFileSync(mainFile, 'utf8');
  const startup = mainSource.indexOf('const gotLock = app.requestSingleInstanceLock();');
  const menu = mainSource.indexOf('function buildMacMenu()');
  assert.ok(startup > 0 && menu > startup);
  mainSource = mainSource.slice(0, startup) + mainSource.slice(menu) + '\nmodule.exports={createWindow,getWindow:()=>mainWindow};';
  mainSource = mainSource.replace('webPreferences: {', 'webPreferences: { offscreen: true, backgroundThrottling: false,');
  const loaded = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,__dirname){${mainSource}\n})`, { filename: mainFile })(
    createRequire(mainFile), loaded, loaded.exports, path.dirname(mainFile)
  );
  loaded.exports.createWindow();
  win = loaded.exports.getWindow();
  const js = (code) => win.webContents.executeJavaScript(code);
  const errors = [];
  win.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason));
  async function until(code, seconds = 12) {
    for (let i = 0; i < seconds * 20; i++) {
      if (await js(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Condition timed out: ${code}`);
  }
  async function click(selector) { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
  async function setField(id, value) {
    await js(`{const field=document.getElementById(${JSON.stringify(id)});field[field.type==='checkbox'?'checked':'value']=${JSON.stringify(value)};field.dispatchEvent(new Event('change'));}`);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  async function submit(url, action = 'button') {
    if (/[\r\n]/.test(url)) {
      await js(`{const input=document.getElementById('urlInput');input.value='';const transfer=new DataTransfer();transfer.setData('text',${JSON.stringify(url)});input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));}`);
      await new Promise(resolve=>setTimeout(resolve,70));
      await until('!state.busy && !document.getElementById("analyzeBtn").disabled');
      return;
    }
    await js(`document.getElementById('urlInput').value=${JSON.stringify(url)}`);
    if (action === 'button') await click('#analyzeBtn');
    else await js(`document.getElementById('urlInput').dispatchEvent(${action === 'paste' ? "new Event('paste')" : "new KeyboardEvent('keydown',{key:'Enter',bubbles:true})"})`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await until('!state.busy && !document.getElementById("analyzeBtn").disabled');
  }
  async function clearQueue() {
    for (const id of [...downloader.order]) downloader.remove(id);
    await until('document.querySelectorAll(".job").length===0');
  }
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await until('document.getElementById("setup").hidden');
  assert.deepEqual(await js('({require:typeof require,api:typeof window.api.probe})'), { require: 'undefined', api: 'function' });
  pass('Startup, system check, empty state and sandboxed preload');

  await click('#analyzeBtn');
  assert.equal(await js('document.getElementById("intakeHint").textContent'), 'Paste a link first.');
  await submit('https://fixture.test/invalid');
  assert.match(await js('document.getElementById("intakeHint").textContent'), /invalid link/);
  for (const action of ['button', 'enter', 'paste']) {
    await submit(`https://fixture.test/${action}`, action);
    assert.equal(downloader.jobs.size, 1);
    await clearQueue();
  }
  pass('Add button, Enter, paste auto-add, empty and invalid input');

  for (const choice of [{ mode:'video',quality:'best' }, ...['2160','1440','1080','720','480'].map(quality=>({mode:'video',quality})), {mode:'audio',quality:'best'}]) {
    await click(`.chip[data-mode="${choice.mode}"][data-quality="${choice.quality}"]`);
    await submit('https://fixture.test/quality');
    const job = [...downloader.jobs.values()][0];
    assert.equal(job.opts.mode, choice.mode);
    assert.equal(job.opts.quality, choice.quality);
    assert.equal(await js('document.querySelectorAll(".chip[aria-checked=true]").length'), 1);
    await clearQueue();
  }
  pass('All seven video-quality/audio-only chips reach the queue');
  await click('.chip[data-mode="video"][data-quality="best"]');
  await submit('https://fixture.test/one\nhttps://fixture.test/two\nhttps://fixture.test/invalid');
  assert.equal(downloader.jobs.size, 2);
  assert.match(await js('document.getElementById("intakeHint").textContent'), /Added 2.*1 failed/);
  await clearQueue();
  pass('Multiple links and partial failure summary');

  await setField('playlistToggle', true);
  await submit('https://fixture.test/playlist-large');
  assert.equal(downloader.jobs.size, 0);
  assert.equal(await js('document.getElementById("preview").hidden'), false);
  await click('#previewDismiss');
  assert.equal(await js('document.getElementById("preview").hidden'), true);
  await submit('https://fixture.test/playlist-large');
  await click('#previewAdd');
  await until('document.querySelectorAll(".job").length===26');
  assert.equal([...downloader.jobs.values()][0].opts.indexLabel, '01');
  assert.equal([...downloader.jobs.values()][0].opts.folderPrefix, 'Sanity playlist');
  await clearQueue();
  await submit('https://fixture.test/playlist-small');
  assert.equal(downloader.jobs.size, 3);
  assert.equal(probeCalls.at(-1).options.playlist, true);
  await clearQueue();
  await submit('https://fixture.test/playlist-empty');
  assert.match(await js('document.getElementById("intakeHint").textContent'), /empty/);
  await setField('playlistToggle', false);
  pass('Playlist toggle, large-playlist confirmation, dismiss, numbering and empty state');

  await click('#settingsBtn');
  await click('#scrim');
  assert.equal(await js('document.getElementById("settingsDrawer").hidden'), true);
  await click('#settingsBtn');
  await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  assert.equal(await js('document.getElementById("settingsDrawer").hidden'), true);
  await click('#settingsBtn');
  const settingsCases = {
    containerSelect:['container','mkv'], audioSelect:['audioFormat','opus'], concurrentInput:['maxConcurrent','3'],
    fragmentsInput:['concurrentFragments','6'], cookiesSelect:['cookiesFrom','firefox'], rateInput:['limitRate','5'],
    proxyInput:['proxy','http://127.0.0.1:9999'], subLangsInput:['subLangs','en,ur'],
    optThumbnail:['embedThumbnail',false], optMetadata:['embedMetadata',false], optChapters:['embedChapters',false],
    optSubs:['writeSubs',true], optSponsor:['sponsorblock',true],
  };
  for (const [id,[key,value]] of Object.entries(settingsCases)) {
    await setField(id,value);
    assert.equal(store.getSettings()[key], key==='limitRate'?'5M':['maxConcurrent','concurrentFragments'].includes(key)?Number(value):value);
  }
  await setField('rateInput','nonsense');
  assert.equal(await js('document.getElementById("rateInput").value'), '5M');
  await setField('proxyInput','broken');
  assert.equal(store.getSettings().proxy, 'http://127.0.0.1:9999');
  await setField('concurrentInput','99');
  assert.equal(store.getSettings().maxConcurrent,8);
  pass('Every settings input/checkbox, validation and drawer close methods');

  const chosen = path.join(output,'chosen'); fs.mkdirSync(chosen);
  dialogResult = { canceled:false,filePaths:[chosen] };
  await click('#chooseDestBtn');
  await until(`document.getElementById('destInput').value===${JSON.stringify(chosen)}`);
  assert.equal(dialogCalls.at(-1).properties.includes('openDirectory'),true);
  const jar = path.join(output,'empty-cookies.txt'); fs.writeFileSync(jar,'# Netscape HTTP Cookie File\n');
  await setField('cookiesFileInput',jar);
  assert.equal(store.getSettings().cookiesFile,jar);
  dialogResult = { canceled:false,filePaths:[jar] };
  await click('#chooseCookiesBtn');
  await until(`document.getElementById('cookiesFileInput').value===${JSON.stringify(jar)}`);
  await click('#clearCookiesBtn');
  await until('document.getElementById("cookiesFileInput").value===""');
  dialogResult = { canceled:true,filePaths:[] };
  await click('#chooseDestBtn');
  assert.equal(store.getSettings().downloadDir,chosen);
  await click('#openFolderBtn');
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(shellCalls.at(-1).file,chosen);
  shellError='Sanity OS launch failed';
  await click('#openFolderBtn');
  await until('document.getElementById("toasts").textContent.includes("Sanity OS launch failed")');
  shellError='';
  pass('Folder/cookies Browse, Clear, dialog cancellation and folder launch/error handoff');

  await click('#repairBtn');
  await until('!document.getElementById("repairBtn").disabled && document.getElementById("toolsNote").textContent.includes("Everything")');
  // Verify button success/error states without re-downloading the same engine.
  binaries.updateYtDlp=async()=>{await new Promise(resolve=>setTimeout(resolve,120));return ready.ytdlp;};
  await click('#updateYtdlpBtn');
  assert.equal(await js('document.getElementById("updateYtdlpBtn").disabled'),true);
  await until('!document.getElementById("updateYtdlpBtn").disabled && document.getElementById("toolsNote").textContent.includes("Now running")');
  binaries.updateYtDlp=async()=>{throw new Error('Sanity update failed');};
  await click('#updateYtdlpBtn');
  await until('!document.getElementById("updateYtdlpBtn").disabled && document.getElementById("toolsNote").textContent.includes("Sanity update failed")');
  binaries.updateYtDlp=actualUpdate;
  pass('Repair tools and update button success/failure/loading states');

  // Create paused jobs through real queue actions, then check global controls.
  await submit('https://fixture.test/queue-one');
  await click('.job__pause');
  await until('document.querySelector(".job").dataset.state==="paused"');
  await click('.job__resume');
  await until('document.querySelector(".job").dataset.state==="queued"');
  await submit('https://fixture.test/queue-two');
  await click('#pauseAllBtn');
  await until('[...document.querySelectorAll(".job")].every(row=>row.dataset.state==="paused")');
  await click('#resumeAllBtn');
  await until('[...document.querySelectorAll(".job")].every(row=>row.dataset.state==="queued")');
  const first=[...downloader.jobs.values()][0];
  first.log=['Sanity log']; downloader.addLog(first,'Live log update');
  await click('.job__logtoggle');
  await until('document.querySelector(".job__log").textContent.includes("Live log update")');
  downloader.addLog(first,'Another live line');
  await until('document.querySelector(".job__log").textContent.includes("Another live line")');
  await click('.job__logtoggle');
  assert.equal(await js('document.querySelector(".job__log").hidden'),true);
  const file=path.join(chosen,'saved.mp4');fs.writeFileSync(file,Buffer.alloc(2048));
  first.state='done';first.filepath=file;first.percent=100;downloader.emitJob(first,{immediate:true});
  await until('document.querySelector(".job").dataset.state==="done"');
  await click('.job__reveal');
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(shellCalls.at(-1).action,'reveal');
  assert.equal(shellCalls.at(-1).file,file);
  await js('document.querySelector(".job__title").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))');
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(shellCalls.at(-1).action,'external');
  await click('#clearBtn');
  await until('document.querySelectorAll(".job").length===1');
  await click('.job__close');
  await until('document.querySelectorAll(".job").length===0');
  pass('Row/global pause/resume, log toggle/live updates, reveal, open source, clear and remove');

  // Simulate unavailable tools at the install boundary, without changing system tools.
  let missing=true;
  binaries.getStatus=async()=>missing?{...ready,ready:false,ytdlp:{...ready.ytdlp,ok:false}}:ready;
  binaries.ensureAll=async()=>{throw new Error('Sanity installation failed');};
  await js('runSystemCheck()');
  await until('!document.getElementById("bootActions").hidden');
  await click('#setupInstall');
  await until('!document.getElementById("setupSkip").hidden');
  await click('#setupSkip');
  await until('document.getElementById("setup").hidden');
  binaries.ensureAll=async()=>{missing=false;return {installed:[],status:ready};};
  await js('runSystemCheck()');
  await click('#setupInstall');
  await until('document.getElementById("setup").hidden');
  binaries.getStatus=actualStatus;binaries.ensureAll=actualEnsure;
  pass('Missing-tool setup, failed install, Continue anyway and successful retry');

  const blockedFolder=path.join(output,'not-a-directory');fs.writeFileSync(blockedFolder,'fixture');
  store.updateSettings({downloadDir:blockedFolder});
  dialogResult={canceled:false,filePaths:[chosen]};
  await js('runSystemCheck()');
  assert.equal(await js('document.getElementById("setupInstall").textContent'),'Choose a folder');
  await click('#setupInstall');
  await until('document.getElementById("setup").hidden');
  assert.equal(store.getSettings().downloadDir,chosen);
  pass('Startup storage failure and Choose a folder recovery');

  // Restore real media extraction and download processes for the format matrix.
  synthetic=false;downloader.pump=actualPump;
  store.updateSettings({ ...store.DEFAULTS,downloadDir:output,embedThumbnail:false,embedMetadata:false,embedChapters:false });
  await js('(async()=>applySettings(await window.api.settings.get()))()');
  const fixture=path.join(output,'fixture.mp4');
  execFileSync(ready.ffmpeg.path,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x240:rate=24','-f','lavfi','-i','sine=frequency=440','-t','4','-c:v','libx264','-g','24','-c:a','aac','-movflags','+faststart','-y',fixture],{windowsHide:true,timeout:30000});
  const media=fs.readFileSync(fixture);
  const cover=fs.readFileSync(path.join(root,'build','icon.png'));
  const captions=Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nSanity caption one\n\n00:00:02.000 --> 00:00:04.000\nSanity caption two\n');
  server=http.createServer((req,res)=>{
    const body=req.url.endsWith('.png')?cover:req.url.endsWith('.vtt')?captions:media;
    const type=req.url.endsWith('.png')?'image/png':req.url.endsWith('.vtt')?'text/vtt':'video/mp4';
    res.writeHead(200,{'Content-Type':type,'Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/fixture.mp4`;
  async function download(mode,format) {
    const destDir=path.join(output,`${mode}-${format}`);
    const [job]=downloader.add([{url,title:'Format sanity'}],{mode,container:mode==='video'?format:'mp4',audioFormat:format,destDir});
    const done=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{downloader.cancel(job.id);reject(new Error('Format download timed out'));},60000);
      const listen=j=>{if(j.id!==job.id)return;if(j.state==='done'||j.state==='failed'){clearTimeout(timer);downloader.off('job',listen);j.state==='done'?resolve(j):reject(new Error(j.error));}};
      downloader.on('job',listen);
    });
    const actual=JSON.parse(execFileSync(ready.ffprobe.path,['-v','error','-show_streams','-show_format','-of','json',done.filepath],{encoding:'utf8',windowsHide:true}));
    assert.ok(actual.streams.some(s=>s.codec_type==='audio'));
    if(mode==='video')assert.ok(actual.streams.some(s=>s.codec_type==='video'));
    if(format!=='auto'&&format!=='best')assert.equal(path.extname(done.filepath),`.${format}`);
    assert.ok(Math.abs(Number(actual.format.duration)-4)<0.3);
    pass(`${mode} output: ${format}`,done.filepath);
  }
  const failedFormats=[];
  for(const [mode,formats] of [['video',['mp4','mkv','webm','auto']],['audio',['mp3','m4a','opus','flac','wav','best']]]) {
    for(const format of formats) {
      try { await download(mode,format); }
      catch(error) {
        failedFormats.push(`${mode}/${format}: ${error.message}`);
        checks.push({name:`${mode} output: ${format}`,status:'fail',detail:error.message});
        console.log(`FAIL: ${mode}/${format}: ${error.message}`);
      }
    }
  }
  // Supply fixture metadata directly to the real engine to verify optional
  // postprocessing independently of a site's subtitle/segment availability.
  const info={id:'extras',title:'Sanity title',artist:'Sanity artist',duration:4,
    webpage_url:url,extractor:'generic',extractor_key:'Generic',ext:'mp4',
    formats:[{url,format_id:'combined',ext:'mp4',vcodec:'h264',acodec:'aac',height:240}],
    thumbnails:[{url:url.replace('fixture.mp4','cover.png'),id:'cover',ext:'png'}],
    chapters:[{start_time:0,end_time:2,title:'First chapter'},{start_time:2,end_time:4,title:'Second chapter'}],
    subtitles:{en:[{url:url.replace('fixture.mp4','captions.vtt'),ext:'vtt'}]},
  };
  for(const kind of ['mp4','mkv','webm','wav','sponsor-cut']) {
    try {
      store.updateSettings({embedThumbnail:true,embedMetadata:true,embedChapters:true,writeSubs:kind!=='wav',subLangs:'en',sponsorblock:kind==='sponsor-cut'});
      const dir=path.join(output,`extras-${kind}`);fs.mkdirSync(dir);
      const infoFile=path.join(dir,'fixture.json');
      const input={...info,...(kind==='sponsor-cut'?{sponsorblock_chapters:[{start_time:1,end_time:2,category:'sponsor',title:'Sponsor',type:'skip',_categories:[['sponsor',1,2,'Sponsor']]}]}:{})};
      fs.writeFileSync(infoFile,JSON.stringify(input));
      const opts={mode:kind==='wav'?'audio':'video',quality:'best',container:kind==='sponsor-cut'?'mp4':kind,audioFormat:'wav'};
      const args=downloader.buildArgs({url,destDir:dir,opts},{ffmpeg:ready.ffmpeg,ffprobe:ready.ffprobe});
      args.splice(-2);args.push('--load-info-json',infoFile);
      const result=await promisify(execFile)(ready.ytdlp.path,args,{...require('../src/main/engine').spawnOptions(),encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024});
      fs.writeFileSync(path.join(dir,'engine.log'),result.stdout+result.stderr);
      const saved=result.stdout.split(/\r?\n/).find(line=>line.startsWith('@@FILE@@'))?.slice(8);
      assert.ok(saved&&fs.existsSync(saved),'Postprocessed file exists');
      const details=JSON.parse(execFileSync(ready.ffprobe.path,['-v','error','-show_streams','-show_format','-show_chapters','-of','json',saved],{encoding:'utf8',windowsHide:true}));
      assert.equal(details.format.tags.title,'Sanity title');
      if(kind==='sponsor-cut') assert.ok(Math.abs(Number(details.format.duration)-3)<0.3,'Sponsor segment was removed');
      else if(kind!=='wav') {
        assert.equal(details.chapters.length,2,'Chapters embedded');
        assert.ok(details.streams.some(stream=>stream.codec_type==='subtitle'),'Captions embedded');
      }
      if(kind==='mp4')assert.ok(details.streams.some(stream=>stream.disposition?.attached_pic),'Cover embedded');
      if(kind==='webm'||kind==='wav')assert.ok(!args.includes('--embed-thumbnail'),'Unsupported cover art does not break download');
      pass(`Postprocessing: ${kind}`,saved);
    } catch(error) {
      failedFormats.push(`extras/${kind}: ${error.message}`);
      checks.push({name:`Postprocessing: ${kind}`,status:'fail',detail:error.message});
      console.log(`FAIL: extras/${kind}: ${error.message.slice(0,500)}`);
    }
  }
  await clearQueue();
  assert.equal(errors.length,0);
  await new Promise(resolve=>setTimeout(resolve,150));
  fs.writeFileSync(path.join(output,'final.png'),(await win.webContents.capturePage()).toPNG());
  await new Promise(resolve=>server.close(resolve));
  server=null;
  store.flush();
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(checks,null,2));
  console.log(`Final sanity ${failedFormats.length?'failed':'passed'}. Results: ${output}`);
  app.exit(failedFormats.length?1:0);
}).catch(error=>{
  console.error(error.stack);
  fs.writeFileSync(path.join(output,'failure.txt'),error.stack);
  if(downloader)downloader.shutdown();
  if(server)server.close();
  app.exit(1);
});
