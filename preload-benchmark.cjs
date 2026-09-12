const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('benchmark', Object.freeze({
  cancel: () => ipcRenderer.invoke('benchmark:cancel'),
  get: () => ipcRenderer.invoke('benchmark:get'),
  audio: id => ipcRenderer.invoke('benchmark:audio', id),
  action: (action, value) => ipcRenderer.invoke('benchmark:action', action, value),
}));
