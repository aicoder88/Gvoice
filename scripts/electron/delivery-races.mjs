// Run explicitly on a desktop with Accessibility permission. Three timing races
// on the real app, each one a bug that was fixed on 2026-09-12:
//   1. A quick second press must not throw away the first sentence.
//   2. A cancel just before the paste must not copy the words or show an error.
//   3. A cancel during the empty-transcript retry must be obeyed.
// Race 3 sends the saved clip to Deepgram, so it needs the network.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'package.json'));
const progress = message => console.log(`[gvoice-races ${new Date().toISOString()}] ${message}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const playwright = await import(pathToFileURL(process.env.GVOICE_PLAYWRIGHT_PATH || require.resolve('playwright')).href);
const { _electron } = playwright.default || playwright;
const profile = await mkdtemp(join(tmpdir(), 'gvoice-races-'));
const fox = (await readFile(join(root, 'scripts/smoke/fixtures/quick-fox.pcm16'))).toString('base64');
const results = {};
let electronApp;
let targetApp;
const deadline = setTimeout(() => {
  console.error('[gvoice-races] 180 second deadline exceeded');
  electronApp?.process()?.kill('SIGKILL');
  targetApp?.process()?.kill('SIGKILL');
  process.exit(1);
}, 180000);
deadline.unref();

const poll = async (fn, message, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(message);
};

try {
  electronApp = await _electron.launch({
    executablePath: require('electron'),
    args: [join(root, 'scripts/electron/entry.mjs')],
    cwd: profile,
    env: { ...process.env, GVOICE_TEST_MODE: '1', GVOICE_TEST_PROFILE: profile,
      GVOICE_TEST_MAIN: process.env.GVOICE_TEST_MAIN || join(root, 'main.js'), GVOICE_HOME: profile,
      DOTENV_CONFIG_PATH: join(profile, 'absent-config'), TMPDIR: profile,
      STT_PROVIDER: 'deepgram', CLEANUP_ENABLED: 'false', MIC_DEVICE_ID: '', RECORDING_RETENTION_DAYS: '1' },
    timeout: 60000,
  });
  await poll(() => electronApp.evaluate(() => globalThis.__gvoiceTest?.ready), 'Test bridge did not become ready');
  targetApp = await _electron.launch({
    executablePath: require('electron'), args: [join(root, 'scripts/electron/target.mjs')], cwd: profile,
    env: { ...process.env, GVOICE_TEST_MODE: '1', GVOICE_TEST_PROFILE: profile, TMPDIR: profile }, timeout: 60000,
  });
  const target = await poll(async () => {
    for (const page of targetApp.windows()) if ((await page.title()) === 'GVoice Regression Target') return page;
  }, 'Editable target window missing');
  const field = target.locator('#target');
  const focusTarget = () => poll(async () => {
    await targetApp.evaluate(({ app }) => { app.focus({ steal: true }); globalThis.__gvoiceRegressionTarget.focus(); });
    await field.focus();
    return electronApp.evaluate(() => globalThis.__gvoiceHarnessFocus());
  }, 'Stop before paste: the editable target is not focused', 15000);
  const pillText = async () => {
    const pill = electronApp.windows().find(page => page.url().includes('/pill.html'));
    return pill ? (await pill.locator('body').innerText()).replace(/\s+/g, ' ').trim() : '';
  };
  const history = () => electronApp.evaluate(() => globalThis.__gvoiceTest.snapshot().history);
  const entryFor = async text => (await history()).find(item => item.text?.includes(text));
  const setClipboard = text => electronApp.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  const readClipboard = () => electronApp.evaluate(({ clipboard }) => clipboard.readText());
  const idle = () => poll(() => electronApp.evaluate(() => !globalThis.__gvoiceTest.snapshot().busy), 'Session did not go idle');

  // 1. Words arrive, the session re-opens, and a new press starts before the
  //    paste has run. The first sentence must still land.
  progress('Race 1: quick second press');
  await field.fill('');
  await focusTarget();
  assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.startSynthetic()), true);
  const race1 = await electronApp.evaluate(async () => {
    const t = globalThis.__gvoiceTest;
    const gen = t.snapshot().generation;
    await t.injectTranscript({ text: 'First sentence sentinel', chunks: [], sampleRate: 24000 }, gen);
    const end = Date.now() + 5000;
    while (t.snapshot().busy && Date.now() < end) await new Promise(r => setTimeout(r, 1));
    const accepted = t.startSynthetic();
    const pastedBeforePress = t.snapshot().history.some(item => item.text?.includes('First sentence sentinel'));
    return { accepted, pastedBeforePress };
  });
  assert.equal(race1.accepted, true, 'The second press must be accepted');
  assert.equal(race1.pastedBeforePress, false, 'Race not reached: the first sentence was already delivered');
  await sleep(1500);
  const race1Field = await field.inputValue();
  const race1Entry = await entryFor('First sentence sentinel');
  await electronApp.evaluate(() => globalThis.__gvoiceTest.expire());
  results.quickSecondPress = { typed: race1Field.includes('First sentence sentinel'), history: race1Entry?.deliveryState };
  progress(`Race 1: ${JSON.stringify(results.quickSecondPress)}`);
  assert.ok(results.quickSecondPress.typed, 'The first sentence must be typed after a quick second press');
  await idle();

  // 2. Cancel after the last cancel check, while the paste waits to go out.
  progress('Race 2: cancel just before the paste');
  await field.fill('');
  await focusTarget();
  await setClipboard('clipboard before race 2');
  assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.startSynthetic()), true);
  const race2Cancel = await electronApp.evaluate(async () => {
    const t = globalThis.__gvoiceTest;
    const gen = t.snapshot().generation;
    await t.injectTranscript({ text: 'Gap cancel sentinel', chunks: [], sampleRate: 24000 }, gen);
    const end = Date.now() + 5000;
    while (t.snapshot().busy && Date.now() < end) await new Promise(r => setTimeout(r, 1));
    await new Promise(r => setTimeout(r, 25));
    return t.cancel();
  });
  await sleep(1500);
  const race2Entry = await entryFor('Gap cancel sentinel');
  results.cancelBeforePaste = { cancelHeard: race2Cancel, typed: (await field.inputValue()).includes('Gap cancel sentinel'),
    clipboardKept: (await readClipboard()) === 'clipboard before race 2', history: race2Entry?.deliveryState, pill: await pillText() };
  progress(`Race 2: ${JSON.stringify(results.cancelBeforePaste)}`);
  assert.equal(race2Cancel, true, 'The cancel must be heard');
  assert.equal(results.cancelBeforePaste.typed, false, 'A cancelled sentence must not be typed');
  assert.equal(results.cancelBeforePaste.clipboardKept, true, 'A cancel must leave the clipboard alone');
  assert.equal(results.cancelBeforePaste.history, 'cancelled', 'History must record a cancel');
  assert.match(results.cancelBeforePaste.pill, /cancel/i, 'The pill must say cancelled, not an error');
  await idle();

  // 3. Blank live transcript with audio: the clip goes to Deepgram for a second
  //    try. A cancel during that try must stop the recovered words.
  progress('Race 3: cancel during the empty-transcript retry');
  await field.fill('');
  await focusTarget();
  await setClipboard('clipboard before race 3');
  const before3 = (await history()).length;
  assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.startSynthetic()), true);
  const race3Cancel = await electronApp.evaluate(async ({}, chunk) => {
    const t = globalThis.__gvoiceTest;
    const gen = t.snapshot().generation;
    await t.injectTranscript({ text: '', chunks: [chunk], sampleRate: 24000 }, gen);
    const end = Date.now() + 5000;
    while (t.snapshot().busy && Date.now() < end) await new Promise(r => setTimeout(r, 1));
    return t.cancel();
  }, fox);
  const race3Entry = await poll(async () => {
    const all = await history();
    return all.length > before3 && all[0];
  }, 'The retried dictation never reached history', 30000);
  await sleep(1000);
  results.cancelDuringRetry = { cancelHeard: race3Cancel, typed: /fox/i.test(await field.inputValue()),
    clipboardKept: (await readClipboard()) === 'clipboard before race 3', history: race3Entry.deliveryState,
    recoveredWords: /fox/i.test(race3Entry.text || ''), pill: await pillText() };
  progress(`Race 3: ${JSON.stringify(results.cancelDuringRetry)}`);
  assert.equal(race3Cancel, true, 'The cancel must be heard during the retry');
  assert.equal(results.cancelDuringRetry.typed, false, 'Recovered words must not be typed after a cancel');
  assert.equal(results.cancelDuringRetry.clipboardKept, true, 'A cancel must leave the clipboard alone');
  assert.equal(results.cancelDuringRetry.history, 'cancelled', 'History must record a cancel');
  assert.match(results.cancelDuringRetry.pill, /cancel/i, 'The pill must still say cancelled');
  console.log(JSON.stringify({ result: 'passed', ...results }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ result: 'failed', error: error.message, ...results }, null, 2));
  process.exitCode = 1;
} finally {
  for (const owned of [electronApp, targetApp]) {
    if (!owned) continue;
    try { await owned.close(); } catch { owned.process()?.kill('SIGKILL'); }
  }
  clearTimeout(deadline);
}
