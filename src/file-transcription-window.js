import { app, BrowserWindow, clipboard, dialog, ipcMain } from 'electron';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createFileTranscriptionQueue } from './file-transcription.js';
import { AUDIO_EXTENSIONS, findMediaBinary, probeMedia, decodeMediaChunk } from './file-media.js';
import { findInstalledWhisperCli } from './model-download.js';
import { transcribeParakeet, parakeetAvailability } from './providers/parakeet-local.js';
import { transcribeFileChunk } from './providers/whisper-local.js';

export function createFileTranscriptionWindow({ root, isInteractiveBusy, isEngineChanging = () => false }) {
  let window = null, picking = false, saving = false;
  const page = join(root, 'public/transcribe.html');
  const trusted = event => !!window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === pathToFileURL(page).href;
  const requireTrusted = event => { if (!trusted(event)) throw new Error('Untrusted file transcription sender.'); };
  const engine = async () => {
    const home = process.env.GVOICE_HOME || (app.isPackaged ? app.getPath('userData') : root);
    const windowsBinary = join(home, 'bin', 'whisper-cli.exe');
    const bin = process.env.WHISPER_BIN || process.env.WHISPER_CLI
      || (process.platform === 'win32' && existsSync(windowsBinary) ? windowsBinary : findInstalledWhisperCli());
    const modelPath = resolve(home, process.env.WHISPER_MODEL || 'models/ggml-small.en-q5_1.bin');
    const [ffmpeg, ffprobe] = await Promise.all([findMediaBinary('ffmpeg'), findMediaBinary('ffprobe')]);
    if (process.env.STT_PROVIDER === 'parakeet-local') {
      const local = parakeetAvailability();
      const reason = isEngineChanging() ? 'Wait for the speech engine change to finish.'
        : local.reason || (!ffmpeg || !ffprobe ? 'File transcription needs FFmpeg and FFprobe.' : '');
      return { available: !reason, reason, provider: 'parakeet-local', model: basename(local.model), modelPath: local.model, bin: local.bin, ffmpeg, ffprobe };
    }
    let reason = '';
    if (isEngineChanging()) reason = 'Wait for the speech engine change or speed test to finish.';
    else if (!bin || !existsSync(bin.replace(/-cli(\.exe)?$/i, '-server$1'))) reason = 'Install the local Whisper engine in GVoice before transcribing files.';
    else if (!existsSync(modelPath)) reason = 'Choose an installed local speech model in GVoice first.';
    else if (!ffmpeg || !ffprobe) reason = 'File transcription needs FFmpeg and FFprobe available on this computer.';
    return { available: !reason, reason, model: basename(modelPath), modelPath, bin, ffmpeg, ffprobe };
  };
  const queue = createFileTranscriptionQueue({
    directory: join(app.getPath('userData'), 'file-transcriptions'), engine, isInteractiveBusy,
    probe: async path => probeMedia(path, await engine()),
    decode: async (path, start, duration, signal) => decodeMediaChunk(path, start, duration, { ...await engine(), signal }),
    transcribe: async (pcm, { signal, model }) => {
      const current = await engine();
      if (!current.available || current.modelPath !== model) throw new Error('The local speech engine changed. Restore it before resuming.');
      if (current.provider === 'parakeet-local') return transcribeParakeet(pcm, { bin: current.bin, model, signal, priority: 'background' });
      return transcribeFileChunk(pcm, { bin: current.bin, model, signal });
    },
  });
  ipcMain.handle('files:get', event => { requireTrusted(event); return queue.snapshot(); });
  ipcMain.handle('files:read', (event, id) => { requireTrusted(event); return queue.read(id); });
  ipcMain.handle('files:pick', async event => {
    requireTrusted(event);
    if (picking) throw new Error('Finish choosing the current files first.');
    picking = true;
    try {
      const picked = await dialog.showOpenDialog(window, { title: 'Transcribe local recordings', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio and video', extensions: AUDIO_EXTENSIONS }] });
      if (picked.canceled) return { ...await queue.snapshot(), canceled: true };
      return await queue.add(picked.filePaths);
    } finally { picking = false; }
  });
  ipcMain.handle('files:action', async (event, action, value) => {
    requireTrusted(event);
    if (action === 'pause') await queue.pause(value?.id);
    else if (action === 'resume') await queue.resume(value?.id);
    else if (action === 'copy') clipboard.writeText(await queue.export(value?.id, 'txt'));
    else if (action === 'export') {
      const format = value?.format;
      if (!['txt', 'srt', 'json'].includes(format)) throw new Error('Choose TXT, SRT or JSON.');
      if (saving) throw new Error('Finish saving the current transcript first.');
      saving = true;
      try {
        const job = await queue.read(value.id);
        const text = await queue.export(value.id, format);
        const picked = await dialog.showSaveDialog(window, { title: 'Save transcript to a new file', defaultPath: `${job.name.replace(/\.[^.]+$/, '')}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
        if (picked.canceled || !picked.filePath) return { ...await queue.snapshot(), canceled: true };
        if (!picked.filePath.toLowerCase().endsWith(`.${format}`) || /(?:^|[/\\])(?:\.env[^/\\]*|\.npmrc|\.netrc|credentials\.json|service-account[^/\\]*\.json)$/i.test(picked.filePath)) throw new Error('Choose a new transcript filename.');
        // Exclusive creation also rejects symlinks and prevents overwriting
        // existing recordings, credentials, or someone else's document.
        try { await writeFile(picked.filePath, text, { flag: 'wx', mode: 0o600 }); }
        catch (error) { throw new Error(error.code === 'EEXIST' ? 'That file already exists. Choose a new filename.' : 'Could not save the transcript. Check the destination and free space.'); }
      } finally { saving = false; }
    } else throw new Error('Invalid file transcription action.');
    return queue.snapshot();
  });
  return {
    get active() { return queue.active; },
    open() {
      if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
      window = new BrowserWindow({ title: 'GVoice - Transcribe files', width: 1020, height: 760, minWidth: 740, minHeight: 560,
        webPreferences: { preload: join(root, 'preload-transcribe.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.loadFile(page);
      window.on('closed', () => { window = null; });
    },
    close() { void queue.close().catch(() => {}); window?.close(); },
  };
}
