const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('voiceEdit', {
  get: () => ipcRenderer.invoke('voice-edit:get'),
  action: (action, value) => ipcRenderer.invoke('voice-edit:action', action, value),
  onState: fn => ipcRenderer.on('voice-edit:state', (_event, state) => fn(state)),
});
