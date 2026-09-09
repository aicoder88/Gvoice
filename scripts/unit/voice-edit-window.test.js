import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';
const local = new URL('../../src/voice-edit-window.js', import.meta.url);
const source = readFileSync(process.env.VOICE_EDIT_CONTROLLER_SOURCE || local, 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export function createVoiceEditWindow', 'function createVoiceEditWindow');

function setup(overrides = {}) {
  const handlers = new Map(), windows = [], calls = [];
  let captured = 0;
  class Window {
    constructor() { this.events = {}; this.destroyed = false; this.focused = true; this.webContents = { send: (_, view) => { this.view = { ...view }; } }; windows.push(this); }
    loadFile() {} on(event, callback) { this.events[event] = callback; }
    show() {} focus() { this.focused = true; } isFocused() { return this.focused; }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.events.closed?.(); }
  }
  const context = vm.createContext({ BrowserWindow: Window, join, AbortController,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    globalShortcut: { register: () => true, unregister: () => {} },
    requestVoiceEdit: async ({ selection }) => ({ replacement: `Edited ${selection}` }),
    captureSelection: () => ({ target: { id: ++captured }, original: 'Original text' }),
    applySelectionEdit: (target, text) => calls.push(['apply', target.id, text]),
    undoSelectionEdit: target => calls.push(['undo', target.id]),
    disposeSelectionEdit: target => calls.push(['dispose', target.id]),
    ...overrides,
  });
  vm.runInContext(source + '\nglobalThis.factory = createVoiceEditWindow;', context);
  let controller;
  controller = context.factory({ root: '/test', start: () => { controller.begin(10); return true; }, stop: () => calls.push(['stop']) });
  const action = (name, value, sender = windows.at(-1)?.webContents) => handlers.get('voice-edit:action')({ sender }, name, value);
  return { controller, action, calls, windows, handlers };
}

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('preview, apply and undo use the captured target and expose no token to renderer', async () => {
  const { controller, action, calls, windows } = setup();
  assert.equal(controller.open(), true);
  await action('generate', 'Shorten this');
  assert.equal(controller.snapshot().phase, 'preview');
  assert.equal(windows[0].view.target, undefined);
  await action('apply');
  assert.equal(controller.snapshot().phase, 'applied');
  await action('undo');
  assert.equal(controller.snapshot().phase, 'undone');
  assert.deepEqual(calls, [['apply', 1, 'Edited Original text'], ['undo', 1]]);
  controller.close();
  assert.deepEqual(calls.at(-1), ['dispose', 1]);
});

test('cancel aborts deferred generation and ignores its late result', async () => {
  const work = deferred(); let signal;
  const { controller, action } = setup({ requestVoiceEdit: params => { signal = params.signal; return work.promise; } });
  controller.open();
  const generating = action('generate', 'Shorten');
  assert.equal(controller.snapshot().phase, 'working');
  await action('cancel');
  assert.equal(signal.aborted, true);
  work.resolve({ replacement: 'Late text' }); await generating;
  assert.equal(controller.snapshot().phase, 'ready');
  assert.equal(controller.snapshot().replacement, '');
});

test('closing during a request aborts and disposes once, suppressing late results', async () => {
  const work = deferred(); let signal;
  const { controller, action, calls } = setup({ requestVoiceEdit: params => { signal = params.signal; return work.promise; } });
  controller.open(); const generating = action('generate', 'Shorten');
  controller.close(); assert.equal(signal.aborted, true);
  work.resolve({ replacement: 'Late text' }); await generating;
  assert.equal(controller.snapshot().replacement, '');
  assert.deepEqual(calls, [['dispose', 1]]);
});

test('capture failure stays empty and blocks provider and native writes', async () => {
  const { controller, action, calls } = setup({ captureSelection: () => { throw new Error('Unsupported field'); }, requestVoiceEdit: () => assert.fail('must not generate') });
  assert.equal(controller.open(), false);
  assert.equal(controller.snapshot().phase, 'empty');
  assert.equal(controller.snapshot().status, 'Unsupported field');
  await action('generate', 'Shorten'); await action('apply');
  assert.deepEqual(calls, []);
});

test('foreign renderer cannot read or invoke editing IPC', async () => {
  const { controller, action, calls, handlers } = setup();
  controller.open();
  assert.equal(handlers.get('voice-edit:get')({ sender: {} }), null);
  await action('generate', 'Shorten', {});
  await action('apply', undefined, {});
  await action('__proto__');
  assert.equal(controller.snapshot().phase, 'ready');
  assert.deepEqual(calls, []);
});

test('spoken instruction is sent to preview generation and never applied automatically', async () => {
  const { controller, action, calls } = setup();
  controller.open(); await action('speak');
  assert.equal(controller.snapshot().phase, 'listening');
  assert.equal(controller.owns(10), true);
  await action('speak');
  assert.equal(controller.snapshot().phase, 'transcribing');
  await controller.accept('Shorten this', 10);
  assert.equal(controller.snapshot().phase, 'preview');
  assert.deepEqual(calls, [['stop']]);
});

test('native apply failure cannot claim success or expose undo', async () => {
  const { controller, action } = setup({ applySelectionEdit: () => { throw new Error('Original selection changed'); } });
  controller.open(); await action('generate', 'Shorten'); await action('apply');
  assert.equal(controller.snapshot().phase, 'error');
  assert.equal(controller.snapshot().status, 'Original selection changed');
});

test('old voice generations cannot finish or fail a newer instruction', async () => {
  const { controller, action } = setup();
  controller.open(); controller.begin(10); await action('cancel'); controller.begin(11);
  controller.fail(10, 'Old failed instruction');
  assert.equal(controller.snapshot().phase, 'listening');
  await controller.accept('old instruction', 10);
  assert.equal(controller.snapshot().phase, 'listening');
  await controller.accept('new instruction', 11);
  assert.equal(controller.snapshot().phase, 'preview');
});

test('re-pressing the hotkey while listening keeps the spoken instruction alive', async () => {
  const { controller, action, calls, windows } = setup();
  controller.open(); await action('speak');
  assert.equal(controller.snapshot().phase, 'listening');
  windows[0].focused = false; // the user is back in the app they selected text in
  assert.equal(controller.open(), false);
  assert.equal(controller.snapshot().phase, 'listening');
  assert.deepEqual(calls, []); // the recording was not stopped, the field not released
  // The transcript still has somewhere to land — this is what a second press
  // used to destroy silently.
  await action('speak');
  assert.equal(controller.snapshot().phase, 'transcribing');
  assert.equal(controller.open(), false);
  await controller.accept('Shorten this', 10);
  assert.equal(controller.snapshot().phase, 'preview');
  assert.equal(controller.snapshot().replacement, 'Edited Original text');
});

test('re-pressing the hotkey keeps the preview instead of recapturing', async () => {
  const { controller, action, calls, windows } = setup();
  controller.open(); await action('generate', 'Shorten');
  assert.equal(controller.snapshot().phase, 'preview');
  windows[0].focused = false; // the user is back in the app they selected text in
  assert.equal(controller.open(), false);
  assert.equal(controller.snapshot().phase, 'preview');
  assert.equal(controller.snapshot().replacement, 'Edited Original text');
  assert.deepEqual(calls, []); // the captured field was never released
});
test('the hotkey never recaptures from the edit window itself', () => {
  const { controller, calls, windows } = setup();
  assert.equal(controller.open(), true);
  assert.equal(windows[0].isFocused(), true);
  assert.equal(controller.open(), false);
  assert.equal(controller.snapshot().original, 'Original text');
  assert.deepEqual(calls, []);
});
test('a fresh selection is captured once the edit window loses focus', () => {
  const { controller, calls, windows } = setup();
  controller.open();
  windows[0].focused = false;
  assert.equal(controller.open(), true);
  assert.deepEqual(calls, [['dispose', 1]]);
  assert.equal(controller.snapshot().phase, 'ready');
});
test('pending native apply is single flight and cannot be cancelled or recaptured', async () => {
  const work = deferred(); let count = 0;
  const { controller, action } = setup({ applySelectionEdit: () => { count++; return work.promise; } });
  controller.open(); await action('generate', 'Shorten');
  const applying = action('apply');
  assert.equal(controller.snapshot().phase, 'applying');
  await action('apply'); await action('cancel');
  assert.equal(controller.open(), false);
  assert.equal(controller.snapshot().phase, 'applying');
  assert.equal(count, 1);
  work.resolve(); await applying;
  assert.equal(controller.snapshot().phase, 'applied');
});

test('closing while native apply finishes suppresses stale success', async () => {
  const work = deferred();
  const { controller, action } = setup({ applySelectionEdit: () => work.promise });
  controller.open(); await action('generate', 'Shorten');
  const applying = action('apply'); controller.close();
  work.resolve(); await applying;
  assert.notEqual(controller.snapshot().phase, 'applied');
});
