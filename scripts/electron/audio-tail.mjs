// Actual GVoice renderer + worklet + local Parakeet, synthetic audio only.
// No native paste, real microphone, cleanup, or user history is involved.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { _electron } from 'playwright';
import { attach, stopParakeet } from '../../src/providers/parakeet-local.js';
const root = resolve(import.meta.dirname, '../..'), require = createRequire(import.meta.url);
const disk = statfsSync(root);
if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw new Error('Preserve 2 GiB free');
const profile = await mkdtemp(join(tmpdir(), 'gvoice-audio-tail-'));
const wav = join(profile, 'synthetic.wav');
execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '150', '-o', wav, '--data-format=LEI16@16000', 'Please close the green folder.']);
const bytes = await readFile(wav); let pcm;
for (let offset = 12; offset + 8 <= bytes.length;) {
  const size = bytes.readUInt32LE(offset + 4);
  if (bytes.toString('ascii', offset, offset + 4) === 'data') { pcm = bytes.subarray(offset + 8, offset + 8 + size); break; }
  offset += 8 + size + size % 2;
}
assert.ok(pcm);
let finalVoiced = pcm.length / 2 - 1;
while (finalVoiced > 0 && Math.abs(pcm.readInt16LE(finalVoiced * 2)) < 300) finalVoiced--;
const speechEndMs = (finalVoiced + 1) / 16;
const server = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1);
  if (!['dictation.html', 'dictation.js', 'mic-health.js', 'audio-capture-worklet.js'].includes(name)) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', name.endsWith('.html') ? 'text/html' : 'text/javascript');
  response.end(await readFile(join(root, 'public', name)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const wss = new WebSocketServer({ server }); wss.on('connection', attach);
let app; const rows = [];
const deadline = setTimeout(() => { app?.process().kill('SIGKILL'); stopParakeet(); process.exit(1); }, 120000);
try {
  console.log('Launching isolated capture renderer');
  app = await _electron.launch({ timeout: 15000, executablePath: require('electron'), args: [join(root, 'scripts/electron/audio-tail-entry.mjs')],
    env: { ...process.env, GVOICE_TEST_MODE: '1', GVOICE_TEST_PROFILE: profile,
      GVOICE_TAIL_URL: `http://127.0.0.1:${server.address().port}/dictation.html?provider=parakeet-local` } });
  console.log('Capture renderer launched');
  const page = await app.firstWindow();
  await page.addInitScript(({ audio }) => {
    window.__events = []; window.__results = []; window.__errors = [];
    window.DICTATION_PARAKEET_TAIL_MS = Number(new URLSearchParams(location.search).get('tail'));
    window.dictationBridge = {
      onStart: callback => window.__start = callback, onStop: callback => window.__stop = callback, onRebuildCapture() {},
      sendTranscript: payload => window.__results.push({ payload, at: performance.now() }),
      sendTiming: (stage, meta) => window.__events.push({ stage, ...meta, at: performance.now() }),
      sendError: message => window.__errors.push(message), sendMicWarning: message => window.__errors.push(message),
      sendMicRecovered() {}, sendMicState() {}, requestEscalation() {}, reportSuperseded() {},
      reportFailure: () => window.__errors.push('capture failure'),
    };
    window.__prepare = async () => {
      const context = new AudioContext({ sampleRate: 16000 }); await context.resume();
      const bytes = Uint8Array.from(atob(audio), char => char.charCodeAt(0));
      const view = new DataView(bytes.buffer), buffer = context.createBuffer(1, bytes.length / 2, 16000);
      for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = view.getInt16(i * 2, true) / 32768;
      const output = context.createMediaStreamDestination();
      navigator.mediaDevices.getUserMedia = async () => output.stream.clone();
      window.__play = () => { const source = context.createBufferSource(); source.buffer = buffer; source.connect(output); source.start(); };
    };
  }, { audio: pcm.toString('base64') });
  for (const tailMs of [0, 100, 200, 300, 450]) {
    for (const releaseBeforeEndMs of [0, 200]) {
      console.log(`Checking tail ${tailMs}ms, release ${releaseBeforeEndMs}ms before ending`);
      await page.goto(`http://127.0.0.1:${server.address().port}/dictation.html?provider=parakeet-local&tail=${tailMs}`);
      await page.waitForFunction(() => window.__start && window.__prepare, null, { timeout: 10000 });
      await page.evaluate(async () => { await window.__prepare(); await window.__start({ sessionId: 'tail-check' }); });
      await page.waitForFunction(() => document.querySelector('#status').textContent === 'Listening', null, { timeout: 10000 });
      await page.evaluate(() => window.__play());
      await new Promise(resolve => setTimeout(resolve, Math.max(0, speechEndMs - releaseBeforeEndMs)));
      await page.evaluate(() => { window.__released = performance.now(); window.__stop(); });
      await page.waitForFunction(() => window.__results.length || window.__errors.length, null, { timeout: 20000 });
      const row = await page.evaluate(() => {
        const result = window.__results[0], text = result?.payload?.text || '';
        const committed = window.__events.find(event => event.stage === 'committed');
        return { nonempty: !!text, referencePass: text.toLowerCase().replace(/[^a-z ]/g, '').trim() === 'please close the green folder',
          finalWordPass: /folder[.!?]?$/i.test(text), trailingMs: committed?.at - window.__released,
          releaseToResultMs: result?.at - window.__released, errors: window.__errors.length,
          delivery: window.__events.find(event => event.stage === 'audio-delivered')?.outcome };
      });
      rows.push({ tailMs, releaseBeforeEndMs, ...row }); console.log(JSON.stringify(rows.at(-1)));
      assert.equal(row.errors, 0);
      if (tailMs === 450) assert.ok(row.referencePass && row.finalWordPass, 'Retained production allowance must preserve the full reference');
    }
  }
  await writeFile(join(root, 'docs/reports/parakeet-audio-tail.json'), JSON.stringify({ conditions: { synthetic: true, voice: 'Samantha', rate: 150, speechEndThreshold: 300, speechEndMs, trialsPerCondition: 1, physicalMicrophone: false, paste: false, cleanup: false, runningCaptureRenderer: true }, rows }, null, 2) + '\n');
} catch (error) {
  console.error(error); throw error;
} finally {
  stopParakeet();
  if (app) {
    const shutdown = setTimeout(() => app.process().kill('SIGKILL'), 3000);
    try { await app.close(); } finally { clearTimeout(shutdown); }
  }
  clearTimeout(deadline);
  for (const client of wss.clients) client.terminate();
  await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
}
