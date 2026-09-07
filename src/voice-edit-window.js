import { BrowserWindow, ipcMain, globalShortcut } from 'electron';
import { join } from 'node:path';
import { requestVoiceEdit } from './voice-edit.js';
import { captureSelection, applySelectionEdit, undoSelectionEdit, disposeSelectionEdit } from './selection-edit.js';

// The retained native target and model credentials never cross the preload bridge.
export function createVoiceEditWindow({ root, start, stop, request = requestVoiceEdit }) {
  let window = null, current = null, pending = null, revision = 0, activeGeneration = null;
  const generations = new Set();
  let view = { original: '', replacement: '', instruction: '', status: 'Select text in another app, then press Cmd+Shift+E.', phase: 'empty' };
  const publish = patch => {
    view = { ...view, ...patch };
    if (window && !window.isDestroyed()) window.webContents.send('voice-edit:state', view);
  };
  const cancel = () => { activeGeneration = null; revision++; pending?.abort(); pending = null; };
  const dispose = () => {
    cancel();
    if (view.phase === 'listening') stop();
    if (current) disposeSelectionEdit(current.target);
    current = null;
  };
  function ensureWindow() {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
    window = new BrowserWindow({ width: 820, height: 650, minWidth: 600, minHeight: 500,
      title: 'GVoice - Edit selection', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
        preload: join(root, 'preload-edit.cjs') } });
    window.loadFile(join(root, 'public/voice-edit.html'));
    window.on('closed', () => { dispose(); window = null; });
  }
  function open() {
    // Re-pressing the hotkey must never destroy work already on screen.
    // dispose() would throw away a generated replacement and let go of the
    // captured field; and a re-capture while our own window holds focus would
    // read this window's textarea instead of the user's selection. In both
    // cases the window is already up, so leave everything exactly as it is.
    // 'listening'/'transcribing' belong here too: a second press while the user
    // is still speaking the instruction would cancel the generation it is
    // stamped with, and the transcript would then arrive with nowhere to go —
    // no preview, no history entry, no message. The spoken instruction simply
    // vanished. Leave the recording alone; the window is already up and saying
    // it is listening.
    if (current && ['listening', 'transcribing', 'working', 'preview', 'applying', 'undoing'].includes(view.phase)) return false;
    if (window && !window.isDestroyed() && window.isFocused()) return false;
    dispose();
    try {
      current = captureSelection();
      view = { original: current.original, replacement: '', instruction: '', phase: 'ready', status: 'Speak or type how to change the selection. You review the result before applying it.' };
    } catch (error) {
      view = { original: '', replacement: '', instruction: '', phase: 'empty', status: error.message || 'Could not capture the selection.' };
    }
    ensureWindow(); publish({});
    return !!current;
  }
  async function generate(instruction) {
    if (!current || !['ready', 'preview', 'error'].includes(view.phase)) return;
    cancel(); const mine = revision; const source = current;
    pending = new AbortController();
    publish({ instruction, replacement: '', phase: 'working', status: 'Preparing your preview…' });
    try {
      const preview = await request({ selection: source.original, instruction, signal: pending.signal });
      if (revision !== mine || current !== source) return;
      publish({ replacement: preview.replacement, phase: 'preview', status: 'Review the replacement. Apply changes only the original selection.' });
    } catch (error) {
      if (revision === mine) publish({ phase: 'error', status: error.message || 'The edit could not be completed.' });
    } finally { if (revision === mine) pending = null; }
  }
  const actions = {
    generate: instruction => generate(instruction),
    speak: () => {
      if (view.phase === 'listening') { stop(); publish({ phase: 'transcribing', status: 'Transcribing your instruction…' }); return; }
      if (!current || !['ready', 'preview', 'error'].includes(view.phase)) return;
      if (!start()) publish({ status: 'Finish the current dictation first.' });
    },
    cancel: () => {
      if (['applying', 'undoing', 'applied', 'undone'].includes(view.phase)) return;
      if (view.phase === 'listening') stop();
      cancel(); publish({ phase: current ? 'ready' : 'empty', replacement: '', status: 'Cancelled. The original text is unchanged.' });
    },
    apply: async () => {
      if (!current || view.phase !== 'preview') return;
      const source = current, mine = revision, replacement = view.replacement;
      publish({ phase: 'applying', status: 'Applying and checking the original field…' });
      try {
        await applySelectionEdit(source.target, replacement);
        if (current === source && revision === mine) publish({ phase: 'applied', status: 'Applied to the original selection. Undo is available while that field remains unchanged.' });
      } catch (error) {
        if (current === source && revision === mine) publish({ phase: 'error', status: error.message });
      }
      if (current === source && revision === mine) window?.show();
    },
    undo: async () => {
      if (!current || view.phase !== 'applied') return;
      const source = current, mine = revision;
      publish({ phase: 'undoing', status: 'Restoring and checking the original text…' });
      try {
        await undoSelectionEdit(source.target);
        if (current === source && revision === mine) publish({ phase: 'undone', status: 'Original text restored.' });
      } catch (error) {
        if (current === source && revision === mine) publish({ phase: 'error', status: error.message });
      }
      if (current === source && revision === mine) window?.show();
    },
  };
  ipcMain.handle('voice-edit:get', event => event.sender === window?.webContents ? view : null);
  ipcMain.handle('voice-edit:action', async (event, action, value) => {
    if (event.sender !== window?.webContents || !Object.hasOwn(actions, action)) return;
    await actions[action](value);
    return view;
  });
  const registered = globalShortcut.register('CommandOrControl+Shift+E', open);
  return {
    open,
    registered,
    wantsDictation: () => !!current && !!window?.isFocused() && ['ready', 'preview', 'error'].includes(view.phase),
    begin: gen => {
      activeGeneration = gen;
      generations.add(gen);
      for (const old of generations) if (old < gen - 128) generations.delete(old);
      publish({ phase: 'listening', status: 'Listening to your editing instruction…' });
    },
    owns: gen => generations.has(gen),
    accept: async (text, gen) => {
      if (gen !== activeGeneration || !generations.has(gen) || !['listening', 'transcribing'].includes(view.phase) || !current) return;
      publish({ phase: 'ready' });
      await generate(text);
    },
    fail: (gen, message) => { if (gen === activeGeneration && generations.has(gen) && ['listening', 'transcribing'].includes(view.phase)) publish({ phase: 'error', status: message }); },
    close: () => { dispose(); window?.close(); globalShortcut.unregister('CommandOrControl+Shift+E'); },
    snapshot: () => ({ ...view }),
  };
}
