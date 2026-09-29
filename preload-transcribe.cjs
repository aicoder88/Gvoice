const { contextBridge, ipcRenderer } = require('electron');

const actions = new Set(['pause', 'resume', 'export', 'copy']);
const formats = new Set(['txt', 'srt', 'json']);

async function invoke(channel, ...args) {
  try { return await ipcRenderer.invoke(channel, ...args); }
  catch (error) { throw new Error(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
}

function jobValue(value, allowFormat = false) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) {
    throw new TypeError('A file transcription job is required.');
  }
  if (allowFormat && !formats.has(value.format)) {
    throw new TypeError('Choose a supported export format.');
  }
  return allowFormat ? { id: value.id, format: value.format } : { id: value.id };
}

contextBridge.exposeInMainWorld('fileTranscription', Object.freeze({
  get: () => invoke('files:get'),
  read: id => {
    if (typeof id !== 'string' || !id) throw new TypeError('A file transcription job is required.');
    return invoke('files:read', id);
  },
  pick: () => invoke('files:pick'),
  action: (action, value) => {
    if (!actions.has(action)) throw new TypeError('Unsupported file transcription action.');
    return invoke('files:action', action, jobValue(value, action === 'export'));
  }
}));
