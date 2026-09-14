// Reproduces 2026-09-14 22:19:09Z: something outside GVoice stopped every web
// helper process at once. The hidden dictation window came back; the pill did
// not, so every later press ran with no pill and "Render frame was disposed".
// Kills renderers with SIGTERM, the same signal, and checks:
//   1. every always-open window works again and a press shows the pill,
//   2. a pill killed mid-press comes back showing that press,
//   3. a press while the recorder reloads is refused on screen, not lost,
//   4. a window that keeps dying stops being reloaded and is reported,
//   5. a pill that silently never reaches the screen is replaced and shown.
// Run: node scripts/electron/dead-window-rebuild.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, access, readFile } from 'node:fs/promises';
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
  console.error('[dead-window-rebuild] 180 second deadline exceeded');
  electronApp?.process()?.kill('SIGKILL');
  process.exit(1);
}, 180000);
deadline.unref();

// Wait for a condition instead of a fixed pause, so a slow machine only runs slower.
async function until(check, label, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`${label} (waited ${ms} ms)`);
}

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
  await until(() => electronApp.evaluate(() => !!globalThis.__gvoiceTest?.ready), 'app never became ready', 30000);

  const windows = () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({
    url: w.webContents.getURL(), pid: w.webContents.getOSProcessId(), crashed: w.webContents.isCrashed(),
  })));
  const find = async page => (await windows()).find(w => w.url.includes(page));
  const run = (page, js) => electronApp.evaluate(({ BrowserWindow }, [p, code]) => {
    const win = BrowserWindow.getAllWindows().find(x => x.webContents.getURL().includes(p));
    return Promise.race([win.webContents.executeJavaScript(code), new Promise(r => setTimeout(() => r(null), 2000))]);
  }, [page, js]);
  const kill = pid => { try { process.kill(pid, 'SIGTERM'); } catch {} };
  const answers = async (page, oldPid) => {
    const w = await find(page);
    return w && !w.crashed && w.pid && w.pid !== oldPid && (await run(page, 'document.readyState')) === 'complete';
  };
  const pillState = () => run('pill.html', 'document.body.getAttribute("data-state")');
  const log = async () => readFile(join(profile, 'debug.log'), 'utf8').catch(() => '');

  // 1. The outside kill: SIGTERM to every renderer at once.
  const before = await windows();
  say(`windows before: ${before.map(w => `${w.url.split('/').pop()} pid ${w.pid}`).join(', ')}`);
  const pages = ['pill.html', 'vocab-prompt.html', 'dictation.html'];
  for (const page of pages) assert.ok(before.some(w => w.url.includes(page)), `no ${page} window at start`);
  for (const pid of new Set(before.map(w => w.pid))) kill(pid);
  for (const page of pages) {
    const old = before.find(w => w.url.includes(page)).pid;
    await until(() => answers(page, old), `${page} did not come back after the kill`);
  }
  assert.ok(await electronApp.evaluate(() => globalThis.__gvoiceTest.start()), 'press was refused after recovery');
  await until(async () => (await pillState()) === 'listening', 'pill did not show "listening" on the press after the kill', 3000);
  say('1 PASS: every window came back and a press showed the pill');

  // 2. The pill dies in the middle of that press.
  const pillPid = (await find('pill.html')).pid;
  kill(pillPid);
  await until(() => answers('pill.html', pillPid), 'pill did not come back mid-press');
  await until(async () => (await pillState()) === 'listening', 'reloaded pill forgot the press it was showing', 3000);
  await electronApp.evaluate(() => globalThis.__gvoiceTest.cancel());
  say('2 PASS: a pill killed mid-press came back showing that press');

  // 3. A press while the recorder is reloading.
  await sleep(2500); // let the cancelled notice clear
  const recPid = (await find('dictation.html')).pid;
  kill(recPid);
  await until(async () => (await find('dictation.html'))?.crashed, 'recorder never looked dead');
  assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.start()), false, 'press during the reload was accepted and would be lost');
  await until(async () => (await pillState()) === 'error', 'refused press showed nothing on the pill', 3000);
  await until(() => answers('dictation.html', recPid), 'recorder did not come back');
  assert.ok((await log()).includes('press-refused'), 'refused press not written to the log');
  say('3 PASS: a press during the reload was refused on screen');

  // 4. A window that keeps dying.
  // The pop-up already died once in step 1, inside the same minute, so it is
  // reloaded twice more and given up on at its fourth death.
  for (let death = 2; death <= 4; death++) {
    const pid = (await find('vocab-prompt.html')).pid;
    kill(pid);
    if (death < 4) await until(() => answers('vocab-prompt.html', pid), `pop-up did not come back on death ${death}`);
  }
  await until(async () => (await log()).includes('window-gave-up {"page":"vocab-prompt.html","deaths":4}'),
    'fourth death in a minute was not reported');
  await sleep(1500);
  assert.ok((await find('vocab-prompt.html')).crashed, 'gave up but reloaded anyway');
  say('4 PASS: a window dying four times in a minute was left off and reported');

  // 5. The pill is asked to show and silently doesn't (2026-09-14 00:46 to 01:43:
  // macOS logged no GVoice window for any press, and nothing raised an error).
  await until(async () => !(await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('pill.html'))?.isVisible())), 'pill never hid', 15000);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const pill = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('pill.html'));
    pill.showInactive = () => {}; // this window never reaches the screen again
  });
  assert.ok(await electronApp.evaluate(() => globalThis.__gvoiceTest.start()), 'press was refused before the hidden-pill check');
  await until(async () => (await log()).includes('pill-not-shown {"visible":false,"crashed":false,"rebuilt":true}'),
    'a pill that never appeared was not noticed');
  await until(() => electronApp.evaluate(({ BrowserWindow }) => {
    const pill = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('pill.html'));
    return !!pill && pill.isVisible() && pill.webContents.executeJavaScript('document.body.getAttribute("data-state")')
      .then(s => s === 'listening');
  }), 'the rebuilt pill is not on screen showing the press', 5000);
  assert.ok((await log()).includes('press {"trigger":"test"'), 'the press log does not say what started it');
  await electronApp.evaluate(() => globalThis.__gvoiceTest.cancel());
  say('5 PASS: a pill that never appeared was replaced and shown');

  assert.equal(disposed.length, 0, `pill sends failed: ${disposed[0]}`);
  say('PASS');
} catch (error) {
  console.error(`[dead-window-rebuild] FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await electronApp?.close().catch(() => electronApp?.process()?.kill('SIGKILL'));
  clearTimeout(deadline);
}
