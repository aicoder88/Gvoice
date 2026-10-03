import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as micHealth from '../../public/mic-health.js';

const renderer = readFileSync(new URL('../../public/dictation.js', import.meta.url), 'utf8').replace(/^import .*mic-health.js.*\n/m, '');
const worklet = readFileSync(new URL('../../public/audio-capture-worklet.js', import.meta.url), 'utf8');

async function harness(provider = 'parakeet-local') {
  let now = 1000, id = 0, Processor, node;
  const timers = new Map(), queued = [], sent = [], timings = [], requests = [];
  const workletContext = vm.createContext({ sampleRate: 16000, Float32Array, Int16Array,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => queued.push(data) }; } },
    registerProcessor: (_name, implementation) => { Processor = implementation; }
  });
  vm.runInContext(worklet, workletContext);
  class WorkletNode {
    constructor(_context, _name, options) {
      node = this; this.processor = new Processor(options);
      this.port = { onmessage: null, postMessage: data => { requests.push(data); this.processor.port.onmessage({ data }); } };
    }
    connect() {} disconnect() {}
  }
  class AudioContext {
    state = 'running'; destination = {}; audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
  }
  const track = { label: 'Synthetic', getSettings: () => ({}), stop() {} };
  const elements = { status: {}, log: { textContent: '' } };
  const context = vm.createContext({ ...micHealth, AudioContext, AudioWorkletNode: WorkletNode,
    window: { location: { search: `?provider=${provider}`, host: 'localhost' },
      btoa: text => Buffer.from(text, 'binary').toString('base64'),
      dictationBridge: { onStart() {}, onStop() {}, onRebuildCapture() {}, sendTiming: (stage, meta) => timings.push({ stage, ...meta }) } },
    document: { getElementById: id => elements[id] },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }), addEventListener() {} } },
    WebSocket: { OPEN: 1 }, URLSearchParams, Uint8Array, console: { log() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimeout: key => timers.delete(key), sent,
  });
  vm.runInContext(renderer, context);
  await vm.runInContext('buildCaptureGraph()', context);
  vm.runInContext(`activeProvider = '${provider}'; socket = { readyState: 1, send: value => sent.push(JSON.parse(value)) }; isRecording = true; holdStartedAt = Date.now();`, context);
  const tick = ms => {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn();
    }
    now = end;
  };
  return { context, sent, timings, requests, tick, queued,
    stop: () => vm.runInContext('stopRecording()', context),
    input: count => node.processor.process([[new Float32Array(count).fill(0.3)]]),
    deliver: () => { while (queued.length) node.port.onmessage({ data: queued.shift() }); },
    ack: requestId => node.port.onmessage({ data: { type: 'flushed', requestId } }),
    reset: () => vm.runInContext('cancelTailDrain(); clearFailureTimer(); clearTimeout(fallbackTimer); isRecording = true;', context),
  };
}
const commits = h => h.sent.filter(frame => frame.type === 'input_audio_buffer.commit').length;
const samples = h => h.sent.filter(frame => frame.audio).reduce((count, frame) => count + Buffer.from(frame.audio, 'base64').length / 2, 0);

test('flush delivers a partial batch before commit and never repeats its final samples', async () => {
  const h = await harness();
  h.input(4096 + 128); h.deliver();
  assert.equal(samples(h), 4096);
  h.stop(); h.tick(450);
  assert.equal(commits(h), 0);
  h.deliver();
  assert.equal(samples(h), 4224);
  assert.equal(commits(h), 1);
  h.ack(h.requests[0].requestId);
  h.tick(250);
  assert.equal(commits(h), 1);
  h.reset(); h.input(128); h.stop(); h.tick(450); h.deliver();
  assert.equal(samples(h), 4352, 'the next hold must not repeat flushed PCM');
});

test('delayed PCM and ack remain ordered; no commit can overtake final samples', async () => {
  const h = await harness(); h.input(128); h.stop(); h.tick(450); h.tick(200);
  assert.equal(commits(h), 0);
  h.deliver();
  assert.equal(samples(h), 128); assert.equal(commits(h), 1);
  assert.equal(h.sent.at(-1).type, 'input_audio_buffer.commit');
});

test('missing ack has one bounded fallback and a late ack cannot commit twice', async () => {
  const h = await harness(); h.input(4096); h.deliver(); h.stop(); h.tick(699);
  assert.equal(commits(h), 0); h.tick(1); assert.equal(commits(h), 1);
  h.deliver(); assert.equal(commits(h), 1);
  assert.ok(h.timings.some(timing => timing.outcome === 'flush-timeout'));
});

test('rapid holds reject a previous flush acknowledgement', async () => {
  const h = await harness(); h.input(128); h.stop(); h.tick(450);
  const old = h.requests[0].requestId; h.reset(); h.ack(old); assert.equal(commits(h), 0);
  h.input(256); h.stop(); h.tick(450); h.ack(old); assert.equal(commits(h), 0);
  h.deliver(); assert.equal(commits(h), 1);
});

test('quick empty tap acknowledges an empty buffer without phantom PCM or hanging', async () => {
  const h = await harness(); h.stop(); h.tick(450); h.deliver();
  assert.equal(samples(h), 0); assert.equal(commits(h), 1);
});

test('other engines keep their original timer and never request a flush', async () => {
  const h = await harness('deepgram'); h.input(4096); h.deliver(); h.stop(); h.tick(450);
  assert.equal(commits(h), 1); assert.equal(h.requests.length, 0);
});

test('48 kHz final partial batch retains its last available 16 kHz sampling point', () => {
  let Processor; const messages = [];
  vm.runInNewContext(worklet, { sampleRate: 48000, Float32Array, Int16Array,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => messages.push(data) }; } },
    registerProcessor: (_name, implementation) => { Processor = implementation; },
  });
  const processor = new Processor({ processorOptions: { outputRate: 16000 } });
  const input = new Float32Array(128); input[126] = 0.5;
  processor.process([[input]]);
  processor.port.onmessage({ data: { type: 'flush', requestId: 1 } });
  const pcm = new Int16Array(messages[0].pcm16);
  assert.equal(pcm.length, 43); assert.ok(pcm[42] > 0);
  assert.equal(messages[1].type, 'flushed');
});
