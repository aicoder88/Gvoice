import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { localInference } from '../inference-scheduler.js';
import { sendToClient } from './_shared.js';

export const PARAKEET_MODEL_NAME = 'parakeet-unified-en-0.6b-Q8_0.gguf';
export const MAX_SAMPLES = 16000 * 120;
const READINESS_SAMPLES = 16000;
const root = resolve(import.meta.dirname, '../..');

export function parakeetPaths(env = process.env) {
  const executable = process.platform === 'win32' ? 'gvoice-parakeet.exe' : 'gvoice-parakeet';
  const bundled = process.resourcesPath && join(process.resourcesPath, 'parakeet', executable);
  const bin = env.PARAKEET_BIN || (bundled && existsSync(bundled) ? bundled : join(root, 'build/parakeet', executable));
  if (env.PARAKEET_MODEL) return { bin, model: resolve(env.PARAKEET_MODEL) };
  const local = join(env.GVOICE_HOME || env.GVOICE_USER_DATA_RESOLVED || root, 'models', PARAKEET_MODEL_NAME);
  if (existsSync(local)) return { bin, model: local };
  const hf = env.HF_HUB_CACHE || join(env.HF_HOME || join(homedir(), '.cache/huggingface'), 'hub');
  const snapshots = join(hf, 'models--handy-computer--parakeet-unified-en-0.6b-gguf', 'snapshots');
  try {
    for (const revision of readdirSync(snapshots).sort()) {
      const model = join(snapshots, revision, PARAKEET_MODEL_NAME);
      if (existsSync(model)) return { bin, model };
    }
  } catch {}
  return { bin, model: local };
}

export function parakeetAvailability() {
  const paths = parakeetPaths();
  const reason = !existsSync(paths.bin) ? 'The Parakeet engine is not installed in this GVoice build.'
    : !existsSync(paths.model) ? 'The Parakeet Unified EN model is missing. Restore it before dictating.' : '';
  return { ...paths, available: !reason, reason };
}

// One persistent model per GVoice process; pipes close automatically if GVoice
// exits. The shared inference scheduler serializes dictation and file chunks.
export function createParakeetRuntime({ spawnWorker = spawn, loadTimeoutMs = 45000, runTimeoutMs = 18000, onTiming = () => {} } = {}) {
  let worker = null, identity = '', ready = null, prepared = false, pending = null;
  let operations = Promise.resolve();
  const measure = (stage, ms, extra = {}) => { try { onTiming({ stage, ms, ...extra }); } catch {} };
  const error = message => new Error(`Parakeet: ${message}`);
  function stop(reason = error('engine stopped')) {
    const old = worker;
    worker = null; ready = null; identity = ''; prepared = false;
    const wait = pending; pending = null;
    wait?.finish(reason);
    if (old) { old.stdin.destroy(); old.kill('SIGKILL'); }
  }
  function waitForReply(timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => stop(signal.reason || new DOMException('Canceled', 'AbortError'));
      const timer = setTimeout(() => stop(error('timed out. Please try again.')), timeoutMs);
      pending = { finish(err, text) {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        err ? reject(err) : resolve(text);
      } };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  function serialize(operation) {
    const result = operations.then(operation);
    operations = result.catch(() => {});
    return result;
  }
  function normalizePaths(paths) {
    return { bin: resolve(paths.bin), model: resolve(paths.model) };
  }
  async function ensureWorker(paths) {
    paths = normalizePaths(paths);
    const next = `${paths.bin}\u0000${paths.model}`;
    if (worker && identity === next && ready) return ready;
    stop();
    if (!existsSync(paths.bin) || !existsSync(paths.model)) throw error('engine or model file is missing.');
    const startupAt = performance.now();
    const child = spawnWorker(paths.bin, [paths.model], { stdio: ['pipe', 'pipe', 'pipe'] });
    worker = child; identity = next;
    let buffer = Buffer.alloc(0), diagnostics = '';
    ready = waitForReply(loadTimeoutMs);
    child.stdout.on('data', data => {
      if (worker !== child) return;
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 1024 * 1024 + 8) { stop(error('invalid engine response.')); return; }
      while (buffer.length >= 8) {
        const status = buffer.readUInt32LE(0), size = buffer.readUInt32LE(4);
        if (size > 1024 * 1024) { stop(error('invalid engine response.')); return; }
        if (buffer.length < size + 8) return;
        const text = buffer.subarray(8, size + 8).toString('utf8');
        buffer = buffer.subarray(size + 8);
        const wait = pending; pending = null;
        if (!wait) { stop(error('unexpected engine response.')); return; }
        wait.finish(status ? error(text || 'transcription failed.') : null, text);
      }
    });
    let timingBuffer = '';
    child.stderr.on('data', data => {
      diagnostics = (diagnostics + data.toString()).slice(-2000);
      timingBuffer = (timingBuffer + data.toString()).slice(-8192);
      const lines = timingBuffer.split('\n'); timingBuffer = lines.pop();
      for (const line of lines) {
        const match = /^GVOICE_TIMING (model_open|inference) ([\d.]+) (\d+)$/.exec(line);
        if (match) measure(match[1], Number(match[2]), { samples: Number(match[3]) });
      }
    });
    child.stdin.on('error', () => { if (worker === child) stop(error('audio connection closed.')); });
    child.on('error', err => { if (worker === child) stop(error(err.message)); });
    child.on('exit', code => {
      if (worker === child) {
        console.error('[parakeet] worker exited', code, diagnostics.slice(-300));
        stop(error('engine exited. Please try again.'));
      }
    });
    try { await ready; measure('worker_ready', performance.now() - startupAt); } catch (err) { if (worker === child) stop(err); throw err; }
  }
  async function prepare(paths) {
    await ensureWorker(paths);
    if (prepared) return;
    // transcribe.cpp allocates its execution graph on the first inference. Run
    // one second of silence before reporting ready so that cost cannot land on
    // the first dictation. Its text is deliberately discarded.
    const packet = Buffer.alloc(4 + READINESS_SAMPLES * 4);
    packet.writeUInt32LE(READINESS_SAMPLES, 0);
    const preparedAt = performance.now();
    const reply = waitForReply(loadTimeoutMs);
    worker?.stdin.write(packet);
    await reply;
    prepared = true;
    measure('readiness_inference', performance.now() - preparedAt, { samples: READINESS_SAMPLES });
  }
  function ensure(paths = parakeetPaths()) {
    return serialize(() => prepare(paths));
  }
  async function run(pcm, { model, bin, signal, sampleRate = 16000 } = {}) {
    if (sampleRate !== 16000 || pcm.length % 2 || pcm.length > MAX_SAMPLES * 2) {
      throw error('expected at most 120 seconds of 16 kHz mono audio.');
    }
    signal?.throwIfAborted();
    if (pcm.length < 3200) return '';
    const paths = parakeetPaths();
    return serialize(async () => {
      signal?.throwIfAborted();
      await prepare({ bin: bin || paths.bin, model: model || paths.model });
      signal?.throwIfAborted();
      const samples = pcm.length / 2;
      const packet = Buffer.allocUnsafe(4 + samples * 4);
      packet.writeUInt32LE(samples, 0);
      for (let i = 0; i < samples; i++) packet.writeFloatLE(pcm.readInt16LE(i * 2) / 32768, 4 + i * 4);
      const inferenceAt = performance.now();
      const reply = waitForReply(runTimeoutMs, signal);
      worker?.stdin.write(packet);
      const text = await reply;
      measure('request', performance.now() - inferenceAt, { samples });
      return text.replace(/\s+/g, ' ').trim();
    });
  }
  return { ensure, run, stop };
}

const runtime = createParakeetRuntime();
process.once('exit', () => runtime.stop());
export const ensureParakeet = () => runtime.ensure();
export const stopParakeet = () => runtime.stop();
export function transcribeParakeet(pcm, options = {}) {
  const queuedAt = performance.now();
  return localInference.run(() => {
    try { options.onTiming?.({ stage: 'queue_wait', ms: performance.now() - queuedAt }); } catch {}
    return runtime.run(pcm, options);
  }, { priority: options.priority || 'interactive', signal: options.signal });
}

export function attach(clientSocket) {
  const abort = new AbortController();
  let chunks = [], bytes = 0, closed = false;
  let chain = Promise.resolve();
  const paths = parakeetPaths();
  const connected = runtime.ensure(paths).then(() => {
    if (!closed) sendToClient(clientSocket, { type: 'local.status', status: 'connected', provider: 'parakeet-local', model: PARAKEET_MODEL_NAME });
  });
  connected.catch(err => { if (!closed) sendToClient(clientSocket, { type: 'local.error', message: err.message }); });
  clientSocket.on('message', raw => {
    if (closed) return;
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'input_audio_buffer.append' && typeof message.audio === 'string') {
      const pcm = Buffer.from(message.audio, 'base64');
      bytes += pcm.length;
      if (bytes > MAX_SAMPLES * 2) {
        chunks = []; closed = true; abort.abort();
        sendToClient(clientSocket, { type: 'local.error', message: 'Parakeet accepts up to two minutes per dictation. Use file transcription for longer recordings.' });
        clientSocket.close(); return;
      }
      chunks.push(pcm);
    } else if (message.type === 'input_audio_buffer.commit') {
      const pcm = Buffer.concat(chunks); chunks = []; bytes = 0;
      chain = chain.then(async () => {
        await connected;
        if (closed) return;
        const transcript = await transcribeParakeet(pcm, { ...paths, signal: abort.signal });
        if (!closed) sendToClient(clientSocket, { type: 'conversation.item.input_audio_transcription.completed', transcript });
      }).catch(err => { if (!closed) sendToClient(clientSocket, { type: 'local.error', message: err.message }); });
    }
  });
  clientSocket.on('close', () => { closed = true; chunks = []; abort.abort(); });
}
