const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  chooseFiles: () => ipcRenderer.invoke('files:choose'),
  addFiles: (files) => ipcRenderer.invoke('files:add', [...files].map(f => webUtils.getPathForFile(f)).filter(Boolean)),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  recStart: (sampleRate) => ipcRenderer.invoke('rec:start', { sampleRate }),
  recChunk: (float32) => ipcRenderer.send('rec:chunk', float32.buffer),
  recStop: (discard, name) => ipcRenderer.invoke('rec:stop', { discard, name }),
  onJob: (cb) => ipcRenderer.on('job', (_e, j) => cb(j)),
});
