'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the page can reach. Every call returns {ok, data} | {ok, error}
 * from the main process; `call` unwraps that so renderer code can use try/catch.
 */

async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result || result.ok !== true) {
    throw new Error((result && result.error) || 'Something went wrong.');
  }
  return result.data;
}

function subscribe(channel) {
  return (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('api', {
  appInfo: () => call('app:info'),

  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
  },

  binaries: {
    status: () => call('binaries:status'),
    install: () => call('binaries:install'),
    updateYtDlp: () => call('binaries:update-ytdlp'),
  },

  probe: (url, options) => call('probe:run', url, options),
  extractUrls: (text) => call('probe:urls', text),

  queue: {
    add: (items, opts) => call('queue:add', items, opts),
    list: () => call('queue:list'),
    log: (id) => call('queue:log', id),
    pause: (id) => call('queue:pause', id),
    resume: (id) => call('queue:resume', id),
    cancel: (id) => call('queue:cancel', id),
    remove: (id) => call('queue:remove', id),
    retry: (id) => call('queue:retry', id),
    clearFinished: () => call('queue:clear'),
    pauseAll: () => call('queue:pause-all'),
    resumeAll: () => call('queue:resume-all'),
    summary: () => call('queue:summary'),
  },

  history: {
    get: () => call('history:get'),
    clear: () => call('history:clear'),
  },

  reveal: (filePath) => call('shell:reveal', filePath),
  openFile: (filePath) => call('shell:open-file', filePath),
  openFolder: (dir) => call('shell:open-folder', dir),
  openExternal: (url) => call('shell:open-external', url),
  chooseFolder: () => call('dialog:choose-folder'),
  chooseCookiesFile: () => call('dialog:choose-cookies-file'),
  readClipboard: () => call('clipboard:read'),

  onQueueList: subscribe('queue:list'),
  onQueueJob: subscribe('queue:job'),
  onQueueLog: subscribe('queue:log'),
  onQueueDone: subscribe('queue:done'),
  onQueueSummary: subscribe('queue:summary'),
  onSetupProgress: subscribe('setup:progress'),
  onToast: subscribe('app:toast'),
  onBinariesChanged: subscribe('binaries:changed'),
});
