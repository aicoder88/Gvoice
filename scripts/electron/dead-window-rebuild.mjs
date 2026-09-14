// Reproduces 2026-09-14 22:19:09Z: something outside GVoice stopped every web
// helper process at once. The hidden dictation window came back; the pill did
// not, so every later press ran with no pill and "Render frame was disposed".
// This kills every window's renderer with SIGTERM, the same signal, then checks
// that each always-open window is working again and that a press still shows
// the pill. Run: node scripts/electron/dead-window-rebuild.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'package.json'));
const say = message => console.log(`[dead-window-rebuild ${new Date().toISOString()}] ${message}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const playwright = await import(pathToFileURL(process.env.GVOICE_PLAYWRIGHT_PATH || require.resolve('playwright')).href);
const { _electron } = playwright.default || playwright;
const model = process.env.GVOICE_TEST_MODEL || join(root, 'models/ggml-small.en-q5_1.bin');
await access(model);
const profile = await mkdtemp(join(tmpdir(), 'gvoice-dead-window-'));

let electronApp;
const deadline = setTimeout(() => {
  console.error('[dead-window-rebuild] 120 second deadline exceeded');
  electronApp?.process()?.kill('SIGKILL');
  process.exit(1);
}, 120000);
deadline.unref();

const disposed = [];
try {
  electronApp = await _electron.launch({
    executablePath: require('electron'),
    args: [join(root, 'scripts/electron/entry.mjs')],
    cwd: profile,
    env: { ...process.env, GVOICE_TEST_MODE: '1', GVOICE_TEST_PROFILE: profile,
      GVOICE_TEST_MAIN: join(root, 'main.js'), GVOICE_HOME: profile, DOTENV_CONFIG_PATH: join(profile, 'absent-config'),
      TMPDIR: profile, STT_PROVIDER: 'whisper-local', WHISPER_MODEL: model, CLEANUP_ENABLED: 'false', MIC_DEVICE_ID: '' },
    timeout: 60000,
  });
  electronApp.process().stderr?.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      if (line.includes('Render frame was disposed')) disposed.push(line.slice(0, 200));
    }
  });
  for (let i = 0; i < 120; i++) {
    if (await electronApp.evaluate(() => !!globalThis.__gvoiceTest?.ready)) break;
    await sleep(250);
  }
  assert.ok(await electronApp.evaluate(() => !!globalThis.__gvoiceTest?.ready), 'app never became ready');

  const windows = () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({
    url: w.webContents.getURL(), pid: w.webContents.getOSProcessId(), crashed: w.webContents.isCrashed(),
  })));
  const before = await windows();
  say(`windows before: ${before.map(w => `${w.url.split('/').pop()} pid ${w.pid}`).join(', ')}`);
  const pages = ['pill.html', 'vocab-prompt.html', 'dictation.html'];
  for (const page of pages) assert.ok(before.some(w => w.url.includes(page)), `no ${page} window at start`);

  // The outside kill: SIGTERM to every renderer, all at once.
  for (const pid of new Set(before.map(w => w.pid))) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  say('sent SIGTERM to every renderer');
  await sleep(5000);

  const after = await windows();
  say(`windows after: ${after.map(w => `${w.url.split('/').pop()} pid ${w.pid}${w.crashed ? ' CRASHED' : ''}`).join(', ')}`);
  for (const page of pages) {
    const w = after.find(x => x.url.includes(page));
    assert.ok(w, `${page} window is gone`);
    assert.ok(!w.crashed, `${page} is still dead after its renderer was killed`);
    const alive = await electronApp.evaluate(({ BrowserWindow }, p) => {
      const win = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes(p));
      return Promise.race([win.webContents.executeJavaScript('document.readyState'), new Promise(r => setTimeout(() => r('no answer'), 3000))]);
    }, page);
    assert.equal(alive, 'complete', `${page} did not answer after the kill`);
  }

  // A press must still show the pill.
  assert.ok(await electronApp.evaluate(() => globalThis.__gvoiceTest.start()), 'press was refused');
  await sleep(500);
  const pillState = await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes('pill.html'));
    return win.webContents.executeJavaScript('document.body.getAttribute("data-state")');
  });
  await electronApp.evaluate(() => globalThis.__gvoiceTest.cancel());
  assert.equal(pillState, 'listening', 'pill did not show "listening" on the press after the kill');
  assert.equal(disposed.length, 0, `pill sends failed: ${disposed[0]}`);
  say('PASS: every always-open window came back and the press showed the pill');
} catch (error) {
  console.error(`[dead-window-rebuild] FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await electronApp?.close().catch(() => electronApp?.process()?.kill('SIGKILL'));
  clearTimeout(deadline);
}
