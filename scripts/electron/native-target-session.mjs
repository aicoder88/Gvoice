// Interactive, provider-free desktop verification. UI focus is controlled by the
// operator; every paste is refused unless the expected native PID is foreground.
import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const profile = await mkdtemp(join(tmpdir(), 'gvoice-native-targets-'));
const desktopEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const report = value => process.stdout.write(JSON.stringify(value) + '\n');
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><title>GVoice native clipboard verification</title><h1>GVoice native clipboard verification</h1><label>Disposable paste target<textarea id="target" style="display:block;width:90vw;height:60vh" autofocus></textarea></label>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const app = await _electron.launch({ executablePath: require('electron'), args: [join(root, 'scripts/electron/entry.mjs')], cwd: profile,
  env: { ...desktopEnv, GVOICE_TEST_MODE: '1', GVOICE_TEST_PROFILE: profile, GVOICE_TEST_MAIN: join(root, 'main.js'), GVOICE_HOME: profile,
    TMPDIR: profile, DOTENV_CONFIG_PATH: join(profile, 'absent-config'), STT_PROVIDER: 'whisper-local', WHISPER_MODEL: join(root, 'models/ggml-base-q5_1.bin'),
    CLEANUP_ENABLED: 'false', MIC_DEVICE_ID: '', RECORDING_RETENTION_DAYS: '0' }, timeout: 45000 });
const poll = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise(done => setTimeout(done, 100)); }
  throw new Error('Bounded verification wait expired');
};
let seq = 0;
try {
  await poll(() => app.evaluate(() => globalThis.__gvoiceTest?.ready));
  report({ ready: true, profile, pid: app.process().pid, browserUrl: `http://127.0.0.1:${server.address().port}` });
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const request = JSON.parse(line);
      if (request.action === 'quit') break;
      if (request.action === 'status') {
        report(await app.evaluate(({ systemPreferences }) => ({ accessibility: systemPreferences.isTrustedAccessibilityClient(false),
          targetPid: globalThis.__gvoiceHarnessTargetPid(), editable: globalThis.__gvoiceHarnessFocus(), tray: globalThis.__gvoiceTest.snapshot().tray,
          trayBounds: globalThis.__gvoiceTest.snapshot().trayBounds })));
      } else if (request.action === 'tray') {
        await app.evaluate(() => globalThis.__gvoiceTest.openTray()); report({ trayOpened: true });
      } else if (request.action === 'closeTray') {
        await app.evaluate(() => globalThis.__gvoiceTest.closeTray()); report({ trayClosed: true });
      } else if (request.action === 'paste') {
        if (!Number.isInteger(request.pid) || request.pid <= 0) throw new Error('Expected native PID required');
        const token = `DICTATION-${randomUUID()}.`, old = `OLD-CLIPBOARD-${randomUUID()}`;
        const started = Date.now();
        const generation = await app.evaluate(({ clipboard }, args) => {
          if (globalThis.__gvoiceHarnessTargetPid() !== args.pid) throw new Error('Focus mismatch: no clipboard mutation or paste');
          if (!globalThis.__gvoiceTest.startSynthetic()) throw new Error('App busy');
          clipboard.writeText(args.old);
          return globalThis.__gvoiceTest.snapshot().generation;
        }, { pid: request.pid, old });
        await app.evaluate(({}, args) => globalThis.__gvoiceTest.injectTranscript({ text: args.token, chunks: [], sampleRate: 24000 }, args.generation), { token, generation });
        await poll(() => app.evaluate(() => !globalThis.__gvoiceTest.snapshot().busy));
        const result = await app.evaluate(({ clipboard }, args) => {
          const item = globalThis.__gvoiceTest.snapshot().history[0];
          return { historyExact: item?.text === args.token, deliveryState: item?.deliveryState ?? null, pasted: item?.pasted,
            clipboardIsDictation: clipboard.readText().trim() === args.token, clipboardIsOld: clipboard.readText() === args.old,
            targetPidAfter: globalThis.__gvoiceHarnessTargetPid() };
        }, { token, old });
        const log = await readFile(join(profile, 'debug.log'), 'utf8').catch(() => '');
        report({ sequence: ++seq, label: request.label, started, completed: Date.now(), durationMs: Date.now() - started,
          ...result, sentinelAbsentFromDebugLog: !log.includes(token) && !log.includes(old) });
      } else throw new Error('Unknown action');
    } catch (error) { report({ error: error.message }); }
  }
} finally {
  process.stdin.pause();
  server.closeAllConnections();
  server.close();
  let timer;
  try {
    await Promise.race([app.close(), new Promise(done => {
      timer = setTimeout(() => { app.process()?.kill('SIGKILL'); done(); }, 8000);
    })]);
  } finally { clearTimeout(timer); }
}
