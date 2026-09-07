import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { createCorpusStore, MAX_JSON_BYTES, atomicJson } from './benchmark-corpus.js';

import { runPersonalLocalBenchmark } from './benchmark-local.js';
import { findInstalledWhisperCli } from './model-download.js';

export function createBenchmarkWindow({ root }) {
  let window = null, store = null, busy = false, localRun = null;
  const page = join(root, 'public/benchmark.html');
  const getStore = () => store ||= createCorpusStore(join(app.getPath('userData'), 'benchmark'));
  const trusted = event => !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === pathToFileURL(page).href;
  const actions = {
    async runLocal() {
      const home = process.env.GVOICE_HOME || (app.isPackaged ? app.getPath('userData') : root);
      const configured = process.env.WHISPER_BIN || process.env.WHISPER_CLI;
      const windowsBinary = join(home, 'bin', 'whisper-cli.exe');
      const binary = configured || (process.platform === 'win32' && existsSync(windowsBinary) ? windowsBinary : findInstalledWhisperCli());
      const modelFile = process.env.WHISPER_MODEL ? resolve(home, process.env.WHISPER_MODEL) : join(home, 'models', 'ggml-base-q5_1.bin');
      localRun = new AbortController();
      try {
        const report = await runPersonalLocalBenchmark({ store: getStore(), binary, modelFile, signal: localRun.signal });
        getStore().importResults(report);
      } finally { localRun = null; }
    },
    async importAudio() {
      const picked = await dialog.showOpenDialog(window, { title: 'Choose one recording for your personal benchmark', properties: ['openFile'], filters: [{ name: 'Audio (20 MB maximum)', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'webm'] }] });
      if (picked.canceled || picked.filePaths.length !== 1) return;
      const answer = await dialog.showMessageBox(window, { type: 'question', buttons: ['Cancel', 'Add this recording'], defaultId: 0, cancelId: 0, title: 'Keep a local benchmark copy?', message: 'Add only this selected recording?', detail: 'GVoice will keep a local copy for your benchmark. Nothing is sent to a model by importing it. You can remove the copy at any time.' });
      if (answer.response === 1) getStore().importAudio(picked.filePaths[0], true);
    },
    update: value => getStore().update(value?.id, value?.patch),
    approve: value => getStore().approve(value?.id, value?.revision, value?.humanConfirmed),
    review: value => getStore().review(value?.id, value?.verdict, value?.note),
    remove: value => getStore().remove(value?.id),
    async importResults() {
      const picked = await dialog.showOpenDialog(window, { title: 'Import benchmark results JSON', properties: ['openFile'], filters: [{ name: 'Results', extensions: ['json'] }] });
      if (picked.canceled || picked.filePaths.length !== 1) return;
      const path = picked.filePaths[0];
      if (!statSync(path).isFile() || statSync(path).size > MAX_JSON_BYTES) throw new Error('Results JSON must be at most 2 MB.');
      getStore().importResults(JSON.parse(readFileSync(path, 'utf8')));
    },
    async exportManifest() {
      const picked = await dialog.showSaveDialog(window, { title: 'Export references and scores', defaultPath: 'gvoice-benchmark.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!picked.canceled && picked.filePath) {
        if (!picked.filePath.toLowerCase().endsWith('.json') || /(?:^|[/\\])(?:\.env[^/\\]*|\.npmrc|\.netrc|credentials\.json|service-account[^/\\]*\.json)$/i.test(picked.filePath)) throw new Error('Choose a benchmark JSON filename, not a settings or credentials file.');
        atomicJson(picked.filePath, getStore().snapshot());
      }
    },
  };
  ipcMain.handle('benchmark:cancel', event => { if (!trusted(event)) throw new Error('Untrusted benchmark sender.'); localRun?.abort(); return true; });
  ipcMain.handle('benchmark:get', event => { if (!trusted(event)) throw new Error('Untrusted benchmark sender.'); return getStore().snapshot(); });
  ipcMain.handle('benchmark:audio', (event, id) => { if (!trusted(event)) throw new Error('Untrusted benchmark sender.'); return getStore().audio(id); });
  ipcMain.handle('benchmark:action', async (event, action, value) => {
    if (!trusted(event) || !Object.hasOwn(actions, action)) throw new Error('Invalid benchmark action.');
    if (busy) throw new Error('Finish the current benchmark action first.');
    busy = true;
    try { await actions[action](value); return getStore().snapshot(); } finally { busy = false; }
  });
  return {
    open() {
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
      window = new BrowserWindow({ title: 'GVoice - Personal speech benchmark', width: 1120, height: 820, minWidth: 780, minHeight: 560, webPreferences: { preload: join(root, 'preload-benchmark.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.loadFile(page);
      window.on('closed', () => { localRun?.abort(); window = null; });
    },
    close() { window?.close(); },
  };
}
