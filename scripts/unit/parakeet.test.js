import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createParakeetRuntime, MAX_SAMPLES } from '../../src/providers/parakeet-local.js';
import { resolvePreferredInput } from '../../public/mic-health.js';
import { normalizePreferences } from '../../src/preferences.js';

const paths = { bin: fileURLToPath(import.meta.url), model: fileURLToPath(import.meta.url) };
function fakeWorker({ hangAfter = Infinity, split = false, delayMs = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const frame = text => {
    const header = Buffer.alloc(8), body = Buffer.from(text);
    header.writeUInt32LE(body.length, 4);
    const packet = Buffer.concat([header, body]);
    if (split) { child.stdout.write(packet.subarray(0, 3)); setImmediate(() => child.stdout.write(packet.subarray(3))); }
    else child.stdout.write(packet);
  };
  child.packetCount = 0;
  child.stdin = new Writable({ write(packet, _, done) {
    assert.equal(packet.length, 4 + packet.readUInt32LE(0) * 4);
    child.packetCount++;
    if (child.packetCount <= hangAfter) {
      const reply = () => frame('Complete sentence.');
      delayMs ? setTimeout(reply, delayMs) : setImmediate(reply);
    }
    done();
  } });
  setImmediate(() => frame(''));
  return child;
}

test('Parakeet reuses a warm worker and handles split response frames', async () => {
  let starts = 0;
  const runtime = createParakeetRuntime({ spawnWorker: () => { starts++; return fakeWorker({ split: true }); } });
  try {
    assert.equal(await runtime.run(Buffer.alloc(32000), paths), 'Complete sentence.');
    assert.equal(await runtime.run(Buffer.alloc(64000), paths), 'Complete sentence.');
    assert.equal(starts, 1);
    await assert.rejects(runtime.run(Buffer.alloc(32000), { ...paths, sampleRate: 24000 }), /16 kHz/);
    await assert.rejects(runtime.run(Buffer.alloc(MAX_SAMPLES * 2 + 2), paths), /120 seconds/);
  } finally { runtime.stop(); }
});

test('readiness and dictation share one worker despite paths object key order', async () => {
  const workers = [];
  const runtime = createParakeetRuntime({ spawnWorker: () => {
    const worker = fakeWorker(); workers.push(worker); return worker;
  } });
  try {
    const preparing = runtime.ensure({ bin: paths.bin, model: paths.model });
    const dictation = runtime.run(Buffer.alloc(32000), { model: paths.model, bin: paths.bin });
    await preparing;
    assert.equal(await dictation, 'Complete sentence.');
    assert.equal(workers.length, 1);
    assert.equal(workers[0].packetCount, 2);
  } finally { runtime.stop(); }
});

test('a wedged worker is killed, then the next dictation can recover', async () => {
  const workers = [];
  const runtime = createParakeetRuntime({ runTimeoutMs: 40, spawnWorker: () => {
    const worker = fakeWorker({ hangAfter: workers.length === 0 ? 1 : Infinity }); workers.push(worker); return worker;
  } });
  try {
    await assert.rejects(runtime.run(Buffer.alloc(32000), paths), /timed out/);
    assert.equal(workers[0].killed, true);
    assert.equal(await runtime.run(Buffer.alloc(32000), paths), 'Complete sentence.');
  } finally { runtime.stop(); }
});

test('a failed readiness preparation is visible and a replacement worker recovers', async () => {
  const workers = [];
  const runtime = createParakeetRuntime({ loadTimeoutMs: 40, spawnWorker: () => {
    const worker = fakeWorker({ hangAfter: workers.length === 0 ? 0 : Infinity }); workers.push(worker); return worker;
  } });
  try {
    await assert.rejects(runtime.ensure(paths), /timed out/);
    assert.equal(workers[0].killed, true);
    assert.equal(await runtime.run(Buffer.alloc(32000), paths), 'Complete sentence.');
    assert.equal(workers.length, 2);
  } finally { runtime.stop(); }
});

test('canceling inference kills only its worker and suppresses its pending result', async () => {
  let worker;
  const runtime = createParakeetRuntime({ spawnWorker: () => (worker = fakeWorker({ hangAfter: 1 })) });
  await runtime.ensure(paths);
  const abort = new AbortController();
  const pending = runtime.run(Buffer.alloc(32000), { ...paths, signal: abort.signal });
  setImmediate(() => abort.abort());
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(worker.killed, true);
  runtime.stop();
});

test('a canceled dictation waiting for preparation neither replaces nor competes with the worker', async () => {
  let starts = 0;
  const runtime = createParakeetRuntime({ spawnWorker: () => { starts++; return fakeWorker({ delayMs: 25 }); } });
  const abort = new AbortController();
  try {
    const preparing = runtime.ensure(paths);
    const canceled = runtime.run(Buffer.alloc(32000), { ...paths, signal: abort.signal });
    abort.abort();
    await preparing;
    await assert.rejects(canceled, { name: 'AbortError' });
    assert.equal(await runtime.run(Buffer.alloc(32000), paths), 'Complete sentence.');
    assert.equal(starts, 1);
  } finally { runtime.stop(); }
});

test('saved Anker name survives changed device IDs and never selects default or Lenovo', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default - Anker PowerConf C200' },
    { kind: 'audioinput', deviceId: 'old', label: 'Lenovo Thinkplus' },
    { kind: 'audioinput', deviceId: 'new', label: 'Anker PowerConf C200 (291a:3369)' },
  ];
  assert.equal(resolvePreferredInput(devices, 'old', 'Anker PowerConf C200').deviceId, 'new');
  assert.equal(resolvePreferredInput(devices.slice(0, 2), 'old', 'Anker PowerConf C200'), null);
  assert.equal(normalizePreferences({ preferredMicId: '', preferredMicLabel: 'Anker PowerConf C200' }).preferredMicLabel, 'Anker PowerConf C200');
});
