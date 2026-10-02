// Offline Windows regression: real Electron, Win32 paste and isolated fake mic.
// Run on a desktop: node scripts/electron/windows-compatibility.mjs
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'Run this Windows-specific check on Windows');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const profile = await mkdtemp(join(tmpdir(), 'gvoice-windows-'));
const evidence = join(root, '.verification');
await mkdir(evidence, { recursive: true });
const env = { ...process.env, GVOICE_TEST_MODE: '1', GVOICE_TEST_PROFILE: profile,
  GVOICE_TEST_MAIN: join(root, 'main.js'), GVOICE_USER_DATA: profile, GVOICE_HOME: profile,
  GVOICE_NO_ENV: '1', STT_PROVIDER: 'whisper-local', CLEANUP_ENABLED: 'false',
  RECORDINGS_ENABLED: 'false' };
delete env.ELECTRON_RUN_AS_NODE;
let app, targetApp;
const checks = [];
const pass = name => { checks.push(name); console.log(`PASS: ${name}`); };
const poll = async (fn, label, timeout = 15000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(label);
};
const launch = async () => {
  app = await _electron.launch({ executablePath: require('electron'),
    args: [join(root, 'scripts/electron/entry.mjs')], cwd: profile, env, timeout: 30000 });
  await poll(() => app.evaluate(() => globalThis.__gvoiceTest?.ready), 'App did not become ready');
};
const deadline = setTimeout(() => {
  app?.process()?.kill(); targetApp?.process()?.kill(); process.exitCode = 1;
}, 120000);
try {
  await launch();
  const state = await app.evaluate(() => globalThis.__gvoiceTest.snapshot());
  assert.equal(state.tray, true);
  assert.ok(state.trayBounds.width > 0 && state.trayBounds.height > 0);
  const log = await readFile(join(profile, 'debug.log'), 'utf8');
  assert.doesNotMatch(log, /control-socket.*(?:EACCES|server error)/);
  pass('Startup and Windows tray exist without Unix socket errors');

  await app.evaluate(() => globalThis.__gvoiceTest.openSettings());
  const settings = await app.waitForEvent('window', { timeout: 1000 }).catch(() =>
    app.windows().find(p => p.url().includes('settings.html')));
  assert.ok(settings, 'Settings window must exist');
  await settings.locator('[data-sec="mic"]').click();
  await poll(async () => (await settings.locator('#micDevice option').count()) > 1, 'Fake mic choices missing');
  const chosen = await settings.locator('#micDevice option').evaluateAll(options =>
    options.map(o => ({ value: o.value, label: o.textContent })).find(o => o.value && o.value !== 'default'));
  assert.ok(chosen, 'Specific microphone required');
  const originBefore = new URL(settings.url()).origin;
  await settings.locator('#micDevice').selectOption(chosen.value);
  await poll(async () => {
    const prefs = JSON.parse(await readFile(join(profile, 'preferences.json'), 'utf8'));
    return prefs.preferredMicId === chosen.value;
  }, 'Microphone preference not saved');
  await app.close(); app = null;
  await launch();
  await app.evaluate(() => globalThis.__gvoiceTest.openSettings());
  await poll(() => app.windows().some(p => p.url().includes('settings.html')), 'Settings did not reopen');
  const reopened = app.windows().find(p => p.url().includes('settings.html'));
  await reopened.locator('[data-sec="mic"]').click();
  assert.notEqual(new URL(reopened.url()).origin, originBefore, 'Test must exercise a new relay origin');
  let resolvedId;
  await poll(async () => {
    const mic = await reopened.evaluate(() => window.settingsBridge.micGet());
    resolvedId = mic.prefs.preferredMicId;
    return mic.prefs.preferredMicLabel === chosen.label
      && mic.state.devices.some(d => d.id === resolvedId && d.label === chosen.label);
  }, 'Microphone choice did not reconnect after restart');
  assert.notEqual(resolvedId, chosen.value, 'Test must exercise changed device IDs');
  await reopened.locator('[data-sec="mic"]').click();
  await poll(async () => (await reopened.locator('#micDevice').inputValue()) === resolvedId,
    'Settings does not display the reconnected microphone');
  // GVoice deliberately waits for the first press before opening any mic.
  // Keep the real capture graph, but terminate the speech connection locally.
  const recorder = app.windows().find(p => p.url().includes('dictation.html'));
  await recorder.routeWebSocket(/\/realtime\?/, socket => {
    socket.onMessage(message => {
      const frame = JSON.parse(String(message));
      if (frame.type === 'input_audio_buffer.commit') socket.send(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'Cancelled microphone fixture.'
      }));
    });
  });
  assert.equal(await app.evaluate(() => globalThis.__gvoiceTest.start()), true);
  await poll(async () => {
    const mic = await reopened.evaluate(() => window.settingsBridge.micGet());
    return mic.state?.activeId === resolvedId && mic.state.open;
  }, 'Restarted capture is not using the selected microphone');
  await reopened.getByRole('button', { name: 'Look again' }).click();
  await reopened.screenshot({ path: join(evidence, 'windows-microphone.png') });
  await app.evaluate(() => globalThis.__gvoiceTest.cancel());
  await poll(() => app.evaluate(() => !globalThis.__gvoiceTest.snapshot().busy), 'Cancelled mic check stayed busy');
  pass('Specific microphone persists across restart and is the active capture device (fake media)');

  const before = await app.evaluate(({ BrowserWindow }) => {
    const pill = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('pill.html'));
    const pid = pill.webContents.getOSProcessId();
    pill.webContents.forcefullyCrashRenderer();
    return pid;
  });
  await poll(() => app.evaluate(({ BrowserWindow }, oldPid) => {
    const pill = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('pill.html'));
    return !pill.webContents.isCrashed() && !pill.webContents.isLoading()
      && pill.webContents.getOSProcessId() !== oldPid;
  }, before), 'Pill did not recover after its renderer crashed');
  pass('Crashed pill renderer reloads on Windows');

  targetApp = await _electron.launch({ executablePath: require('electron'),
    args: [join(root, 'scripts/electron/target.mjs')], cwd: profile, env, timeout: 30000 });
  const target = await targetApp.firstWindow();
  const field = target.locator('#target');
  await field.waitFor();
  const targetHwnd = await targetApp.evaluate(() =>
    globalThis.__gvoiceRegressionTarget.getNativeWindowHandle().readUInt32LE(0));
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.hide();
  });
  const focusTarget = async () => {
    await targetApp.evaluate(() => globalThis.__gvoiceRegressionTarget.focus());
    await field.focus();
    await poll(() => app.evaluate(({}, hwnd) => globalThis.__gvoiceHarnessTargetWindow() === hwnd,
      targetHwnd), 'Refusing paste: disposable target is not foreground', 5000);
  };
  await focusTarget();
  await app.evaluate(({ clipboard }) => { globalThis.__windowsClipboardBefore = clipboard.readText(); });
  assert.equal(await app.evaluate(() => globalThis.__gvoiceTest.startSynthetic()), true);
  await app.evaluate(async () => {
    const t = globalThis.__gvoiceTest, gen = t.snapshot().generation;
    const payload = { text: 'Windows dictation compatibility check.', chunks: [], sampleRate: 24000 };
    await t.injectTranscript(payload, gen);
    await t.injectTranscript(payload, gen);
  });
  await poll(async () => (await field.inputValue()).trim() === 'Windows dictation compatibility check.',
    'Transcript did not paste exactly once into the Windows target');
  await poll(() => app.evaluate(({ clipboard }) => clipboard.readText() === globalThis.__windowsClipboardBefore),
    'Original clipboard was not restored');
  await target.screenshot({ path: join(evidence, 'windows-paste.png') });
  pass('Transcript pastes once through Win32 and the original clipboard returns');

  await field.fill('');
  await focusTarget();
  assert.equal(await app.evaluate(() => globalThis.__gvoiceTest.startSynthetic()), true);
  await app.evaluate(async () => {
    const t = globalThis.__gvoiceTest, gen = t.snapshot().generation;
    t.cancel();
    await t.injectTranscript({ text: 'Cancelled words must not paste.', chunks: [] }, gen);
  });
  await new Promise(r => setTimeout(r, 800));
  assert.equal(await field.inputValue(), '');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText() === globalThis.__windowsClipboardBefore), true);
  pass('Cancellation rejects a late transcript without changing the clipboard');
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  for (const owned of [app, targetApp]) if (owned) await owned.close().catch(() => owned.process()?.kill());
  clearTimeout(deadline);
  await writeFile(join(evidence, 'windows-compatibility.json'), JSON.stringify({
    passed: process.exitCode !== 1, profile, checks,
    limits: 'Fake microphone and injected transcripts; no real speech recognition or physical hotkey test.'
  }, null, 2));
}
