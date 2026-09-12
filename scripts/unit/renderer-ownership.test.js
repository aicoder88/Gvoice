import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// dictation.js is a browser module; the vm runs it as a plain script. Its one
// import is swapped for the real mic-health.js code (a pure module), with
// classifyHold pinned to "ok" so the fake silent audio never raises a mic
// warning that has nothing to do with ownership. Matched by pattern, not by the
// exact import line, so adding a name to that import cannot silently break
// every test here again.
const micHealth = readFileSync(new URL('../../public/mic-health.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '');
const source = readFileSync(new URL('../../public/dictation.js', import.meta.url), 'utf8')
  .replace(/^import \{[^}]*\} from "\/mic-health\.js";\s*$/m,
    micHealth + '\nclassifyHold = () => ({ action: "ok", silentStreak: 0 });\n');
const turn = () => new Promise(resolve => setImmediate(resolve));
// A press name as main mints it: "<generation>-<random>".
const press = n => `${n}-test`;
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
    sendMicWarning() {}, sendMicRecovered() {}, requestEscalation() {}, reportSuperseded() {},
    getMicPrefs: async () => ({ micMode: 'always', preferredMicId: '' }), onMicPrefs() {},
    onReportMics() {}, sendMicState() {}
  };
  const context = vm.createContext({
    window: { location: { search: '', host: 'localhost' }, DICTATION_STARTUP_MS: startupMs,
      DICTATION_SOCKET_OPEN_MS: 20, dictationBridge: bridge,
      btoa: text => Buffer.from(text, 'binary').toString('base64') },
    document: { getElementById: id => elements[id] },
    navigator: { onLine: true, mediaDevices: { getUserMedia, enumerateDevices: async () => [], addEventListener() {} } },
    WebSocket: Socket, AudioContext: Audio, AudioWorkletNode: Worklet,
    URLSearchParams, Uint8Array, Buffer, console: { log() {} }, setTimeout, clearTimeout, queueMicrotask
  });
  new vm.Script(source).runInContext(context);
  return { start: profile => start(profile), sent, sockets, context, elements };
}

test('socket that never opens settles and permits another start', async () => {
  const f = fixture({ socketMode: 'pending', startupMs: 100 });
  await f.start({ sessionId: press(11) });
  assert.equal(f.sent.filter(x => x[0] === 'error').length, 1);
  assert.equal(f.sent.find(x => x[0] === 'error')[2], press(11));
  await f.start({ sessionId: press(12) });
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sent.filter(x => x[0] === 'error')[1][2], press(12));
  assert.ok(f.sockets.every(s => s.readyState === 3));
});

test('close before open rejects immediately rather than waiting for startup deadline', async () => {
  const f = fixture({ socketMode: 'close', startupMs: 1000 });
  await f.start({ sessionId: press(21) });
  assert.equal(f.elements.status.textContent, 'WS failed');
  assert.equal(f.sent.find(x => x[0] === 'error')[2], press(21));
});

test('timed out microphone acquisition releases late stream without harming next session', async () => {
  let resolveFirst, calls = 0;
  const oldStream = stream(), newStream = stream();
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const f = fixture({ getUserMedia: () => ++calls === 1 ? first : Promise.resolve(newStream) });
  await f.start({ sessionId: press(31) });
  assert.equal(f.sent.find(x => x[0] === 'error')[2], press(31));
  await f.start({ sessionId: press(32) });
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
  assert.equal(f.sent.find(x => x[0] === 'transcript')[2], press(32));
  assert.equal(f.sent.find(x => x[0] === 'timing' && x[1] === 'captureReady')[3], press(32));
});

test('preload preserves an explicit press name after a newer start notification', () => {
  let bridge;
  const events = {}, sent = [];
  const context = vm.createContext({ require: () => ({
    contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } },
    ipcRenderer: { on(name, callback) { events[name] = callback; }, send(...args) { sent.push(args); } }
  }) });
  vm.runInContext(readFileSync(new URL('../../preload.cjs', import.meta.url), 'utf8'), context);
  bridge.onStart(() => {});
  events['dictation:start']({}, { sessionId: press(42) });
  bridge.sendTranscript({ text: 'old' }, press(41));
  bridge.sendError('old failure', press(41));
  bridge.reportFailure({ reason: 'old failure' }, press(41));
  bridge.sendTiming('terminal', {}, press(41));
  assert.equal(sent[0][2], press(41));
  assert.equal(sent[1][2], press(41));
  assert.equal(sent[2][2], press(41));
  assert.equal(sent[3][3], press(41));
  bridge.sendMicWarning('background');
  assert.equal(sent[4][2], press(42));
});

test('an ignored newer start cannot relabel a pending startup error', async () => {
  let rejectCapture;
  const capture = new Promise((_resolve, reject) => { rejectCapture = reject; });
  const f = fixture({ getUserMedia: () => capture, startupMs: 1000 });
  const first = f.start({ sessionId: press(51) });
  await f.start({ sessionId: press(52) });
  rejectCapture(new Error('Microphone unavailable'));
  await first;
  assert.equal(f.sent.find(x => x[0] === 'error')[2], press(51));
});
