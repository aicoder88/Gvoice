import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../public/dictation.js', import.meta.url), 'utf8')
  .replace('import { classifyHold } from "/mic-health.js";', 'const classifyHold = () => ({ action: "ok", silentStreak: 0 });');
const turn = () => new Promise(resolve => setImmediate(resolve));
function stream() {
  const track = { label: 'Test mic', muted: false, readyState: 'live', stopped: false,
    getSettings: () => ({ deviceId: 'test' }), stop() { this.stopped = true; } };
  return { track, getAudioTracks: () => [track], getTracks: () => [track] };
}
function fixture({ getUserMedia = async () => stream(), socketMode = 'open', startupMs = 30 } = {}) {
  let start;
  const sent = [], sockets = [];
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0; this.listeners = {}; sockets.push(this);
      if (socketMode === 'open') queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
      if (socketMode === 'close') queueMicrotask(() => this.close());
    }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    emit(type, value) { this.listeners[type]?.(value); }
    send() {}
    close() { this.readyState = 3; this.emit('close'); }
  }
  class Audio {
    constructor() { this.state = 'running'; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { connect() {}, disconnect() {}, gain: { value: 1 } }; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  class Worklet { constructor() { this.port = {}; } connect() {} disconnect() {} }
  const elements = { status: { textContent: '' }, log: { textContent: '' } };
  const bridge = {
    onStart(cb) { start = cb; }, onStop() {}, onRebuildCapture() {},
    sendError: (...args) => sent.push(['error', ...args]),
    sendTranscript: (...args) => sent.push(['transcript', ...args]),
    reportFailure: (...args) => sent.push(['failure', ...args]),
    sendTiming: (...args) => sent.push(['timing', ...args]),
    sendMicWarning() {}, sendMicRecovered() {}, requestEscalation() {}, reportSuperseded() {}
  };
  const context = vm.createContext({
    window: { location: { search: '', host: 'localhost' }, DICTATION_STARTUP_MS: startupMs,
      DICTATION_SOCKET_OPEN_MS: 20, dictationBridge: bridge,
      btoa: text => Buffer.from(text, 'binary').toString('base64') },
    document: { getElementById: id => elements[id] },
    navigator: { onLine: true, mediaDevices: { getUserMedia, addEventListener() {} } },
    WebSocket: Socket, AudioContext: Audio, AudioWorkletNode: Worklet,
    URLSearchParams, Uint8Array, Buffer, console: { log() {} }, setTimeout, clearTimeout, queueMicrotask
  });
  new vm.Script(source).runInContext(context);
  return { start: profile => start(profile), sent, sockets, context, elements };
}

test('socket that never opens settles and permits another start', async () => {
  const f = fixture({ socketMode: 'pending', startupMs: 100 });
  await f.start({ gen: 11 });
  assert.equal(f.sent.filter(x => x[0] === 'error').length, 1);
  assert.equal(f.sent.find(x => x[0] === 'error')[2], 11);
  await f.start({ gen: 12 });
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sent.filter(x => x[0] === 'error')[1][2], 12);
  assert.ok(f.sockets.every(s => s.readyState === 3));
});

test('close before open rejects immediately rather than waiting for startup deadline', async () => {
  const f = fixture({ socketMode: 'close', startupMs: 1000 });
  await f.start({ gen: 21 });
  assert.equal(f.elements.status.textContent, 'WS failed');
  assert.equal(f.sent.find(x => x[0] === 'error')[2], 21);
});

test('timed out microphone acquisition releases late stream without harming next session', async () => {
  let resolveFirst, calls = 0;
  const oldStream = stream(), newStream = stream();
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const f = fixture({ getUserMedia: () => ++calls === 1 ? first : Promise.resolve(newStream) });
  await f.start({ gen: 31 });
  assert.equal(f.sent.find(x => x[0] === 'error')[2], 31);
  await f.start({ gen: 32 });
  assert.equal(f.elements.status.textContent, 'Listening');
  resolveFirst(oldStream);
  await turn(); await turn();
  assert.equal(oldStream.track.stopped, true);
  assert.equal(newStream.track.stopped, false);
  assert.equal(f.elements.status.textContent, 'Listening');
  assert.equal(f.sent.filter(x => x[0] === 'error').length, 1);
  f.sockets[0].emit('message', { data: JSON.stringify({ type: 'response.text.done', text: 'old' }) });
  assert.equal(f.sent.filter(x => x[0] === 'transcript').length, 0);
  f.sockets[1].emit('message', { data: JSON.stringify({ type: 'response.text.done', text: 'new' }) });
  assert.equal(f.sent.find(x => x[0] === 'transcript')[2], 32);
  assert.equal(f.sent.find(x => x[0] === 'timing' && x[1] === 'captureReady')[3], 32);
});

test('preload preserves explicit operation generation after a newer start notification', () => {
  let bridge;
  const events = {}, sent = [];
  const context = vm.createContext({ require: () => ({
    contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } },
    ipcRenderer: { on(name, callback) { events[name] = callback; }, send(...args) { sent.push(args); } }
  }) });
  vm.runInContext(readFileSync(new URL('../../preload.cjs', import.meta.url), 'utf8'), context);
  bridge.onStart(() => {});
  events['dictation:start']({}, { gen: 42 });
  bridge.sendTranscript({ text: 'old' }, 41);
  bridge.sendError('old failure', 41);
  bridge.reportFailure({ reason: 'old failure' }, 41);
  bridge.sendTiming('terminal', {}, 41);
  assert.equal(sent[0][2], 41);
  assert.equal(sent[1][2], 41);
  assert.equal(sent[2][2], 41);
  assert.equal(sent[3][3], 41);
  bridge.sendMicWarning('background');
  assert.equal(sent[4][2], 42);
});

test('an ignored newer start cannot relabel a pending startup error', async () => {
  let rejectCapture;
  const capture = new Promise((_resolve, reject) => { rejectCapture = reject; });
  const f = fixture({ getUserMedia: () => capture, startupMs: 1000 });
  const first = f.start({ gen: 51 });
  await f.start({ gen: 52 });
  rejectCapture(new Error('Microphone unavailable'));
  await first;
  assert.equal(f.sent.find(x => x[0] === 'error')[2], 51);
});
