// Explicit desktop test. All mutations belong to one temporary app profile.
// Fixture comparisons exercise the UI, not real model accuracy or human review.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'package.json'));
const playwright = await import(pathToFileURL(process.env.GVOICE_PLAYWRIGHT_PATH || require.resolve('playwright')).href);
const { _electron } = playwright.default || playwright;
const profile = await mkdtemp(join(tmpdir(), 'gvoice-profiles-benchmark-'));
const model = process.env.GVOICE_TEST_MODEL || join(root, 'models/ggml-base-q5_1.bin');
const log = message => console.log(`[profiles-benchmark] ${message}`);
const delay = ms => new Promise(done => setTimeout(done, ms));
let electronApp, targetApp;
const bounded = async (operation, label, ms = 20000) => {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  })]); } finally { clearTimeout(timer); }
};
const poll = async (fn, label, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = await bounded(Promise.resolve().then(fn), label, Math.min(20000, end - Date.now()));
    if (found) return found;
    await delay(100);
  }
  throw new Error(label);
};
const deadline = setTimeout(() => {
  console.error('Profiles/benchmark desktop verification exceeded 240 seconds');
  electronApp?.process()?.kill('SIGKILL'); targetApp?.process()?.kill('SIGKILL'); process.exit(1);
}, 240000);
deadline.unref();
// Inherit only desktop runtime settings, never provider credentials.
const desktopEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const env = { ...desktopEnv, GVOICE_TEST_MODE: '1', GVOICE_TEST_PROFILE: profile,
  GVOICE_TEST_MAIN: join(root, 'main.js'), GVOICE_HOME: profile, DOTENV_CONFIG_PATH: join(profile, 'absent-config'), TMPDIR: profile,
  STT_PROVIDER: 'whisper-local', WHISPER_MODEL: model, CLEANUP_ENABLED: 'false', MIC_DEVICE_ID: '', RECORDING_RETENTION_DAYS: '1' };
const launch = async () => {
  const owned = await _electron.launch({ executablePath: require('electron'), args: [join(root, 'scripts/electron/entry.mjs')], cwd: profile, env, timeout: 45000 });
  owned.context().setDefaultTimeout(10000);
  const evaluate = owned.evaluate.bind(owned);
  owned.evaluate = (...args) => bounded(evaluate(...args), 'App main-process operation');
  try {
    await poll(() => owned.evaluate(() => globalThis.__gvoiceTest?.ready), 'Application did not become ready');
    return owned;
  } catch (error) { await close(owned); throw error; }
};
const close = async owned => {
  if (!owned) return;
  try { await bounded(owned.close(), 'Closing owned Electron', 8000); }
  catch { owned.process()?.kill('SIGKILL'); }
};
const settings = async () => {
  await electronApp.evaluate(() => globalThis.__gvoiceTest.openSettings());
  const page = await poll(() => electronApp.windows().find(page => page.url().includes('/settings.html')), 'Settings window missing');
  await page.locator('[data-sec="output"]').click();
  await poll(async () => (await page.locator('#outputDefault option').count()) === 4, 'Output profiles did not load');
  return page;
};
const saveProfiles = async page => {
  const expected = { mode: await page.locator('#outputMode').inputValue(), selectedProfile: await page.locator('#outputDefault').inputValue() };
  await page.locator('#saveOutputProfiles').click();
  await poll(async () => {
    const saved = await electronApp.evaluate(() => globalThis.__gvoiceTest.profileView());
    return saved.mode === expected.mode && saved.selectedProfile === expected.selectedProfile
      && (await page.locator('#outputStatus').innerText()).startsWith('Saved.');
  }, 'Profiles save did not complete');
};
const assertNoSecretFiles = async () => {
  const entries = await readdir(profile, { recursive: true });
  assert.equal(entries.some(file => /(?:^|[/\\])(?:\.env[^/\\]*|\.npmrc|\.netrc|credentials\.json|service-account[^/\\]*\.json)$/.test(file)), false, 'Profile actions must not create any secret settings file');
};
try {
  await access(model);
  log(`Launching isolated app in ${profile}`);
  electronApp = await launch();
  let page = await settings();
  await page.locator('#outputMode').selectOption('manual');
  await page.locator('#outputDefault').selectOption('email');
  await saveProfiles(page);
  assert.equal((await electronApp.evaluate(() => globalThis.__gvoiceTest.profileView())).selectedProfile, 'email');
  await assertNoSecretFiles();

  log('Checking real native destination detection in a separate Electron process');
  targetApp = await _electron.launch({ executablePath: require('electron'), args: [join(root, 'scripts/electron/target.mjs')], cwd: profile, env, timeout: 45000 });
  targetApp.context().setDefaultTimeout(10000);
  const target = await poll(() => targetApp.windows()[0], 'External target window missing');
  await target.locator('#target').waitFor();
  const targetIdentity = await targetApp.evaluate(() => `mac:${process.execPath.toLowerCase()}`);
  const focusTarget = async () => {
    await poll(async () => {
      await targetApp.evaluate(({ app }) => { app.focus({ steal: true }); globalThis.__gvoiceRegressionTarget.focus(); });
      await target.locator('#target').focus();
      return electronApp.evaluate(({}, pid) => globalThis.__gvoiceHarnessTargetPid() === pid, targetApp.process().pid);
    }, 'Native focus did not match external target PID', 10000);
  };
  await page.locator('#detectOutputApp').click();
  await poll(async () => {
    await focusTarget();
    return (await page.locator('#outputStatus').innerText()).startsWith('App detected.');
  }, 'Native app identity detection failed', 12000);
  await page.locator('#outputAppProfile').selectOption('coding');
  await page.locator('#addOutputApp').click();
  await saveProfiles(page);
  const saved = await electronApp.evaluate(() => globalThis.__gvoiceTest.profileView());
  assert.equal(saved.mode, 'per-app');
  assert.equal(saved.mappings.length, 1);
  assert.equal(saved.mappings[0].profile, 'coding');
  assert.equal(saved.mappings[0].id, targetIdentity, 'Detected identity must match the exact owned external target executable');
  assert.deepEqual(Object.keys(saved.mappings[0]).sort(), ['id', 'name', 'profile']);
  assert.equal((await electronApp.evaluate(({}, identity) => globalThis.__gvoiceTest.resolveProfile(identity), saved.mappings[0])).source, 'app');
  assert.equal((await electronApp.evaluate(() => globalThis.__gvoiceTest.resolveProfile(null))).profile, 'email');
  await page.screenshot({ path: join(profile, 'output-profiles-proof.png') });

  log('Checking mapped and fallback profiles reach the actual cleanup pipeline with offline fixture responses');
  const formatted = await electronApp.evaluate(async ({}, identity) => {
    const originalFetch = globalThis.fetch, originalCleanup = process.env.CLEANUP_ENABLED;
    let prompt = '';
    try {
      process.env.CLEANUP_ENABLED = 'true';
      globalThis.fetch = async (_url, options) => {
        // Deliberately inspect only the synthetic request body, never headers
        // or provider credentials. No request leaves this process.
        prompt = JSON.parse(options.body).messages.find(message => message.role === 'system').content;
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Keep the apiClient identifier.' } }] }) };
      };
      const mapped = await globalThis.__gvoiceTest.formatProfileFixture('Keep the apiClient identifier.', identity);
      const codingPrompt = prompt;
      const fallback = await globalThis.__gvoiceTest.formatProfileFixture('Please send the update tomorrow.', null);
      return { mapped, fallback, codingPromptApplied: codingPrompt.includes('Preserve technical terms, identifiers'), emailPromptApplied: prompt.includes('Use readable paragraph breaks') };
    } finally {
      globalThis.fetch = originalFetch;
      if (originalCleanup === undefined) delete process.env.CLEANUP_ENABLED; else process.env.CLEANUP_ENABLED = originalCleanup;
    }
  }, saved.mappings[0]);
  assert.equal(formatted.codingPromptApplied, true);
  assert.equal(formatted.emailPromptApplied, true);
  assert.equal(formatted.mapped.text, 'Keep the apiClient identifier.');
  assert.equal(formatted.mapped.pasted, false);
  assert.equal(formatted.fallback.pasted, false);

  log('Checking immutable active-utterance profile while UI settings change');
  await focusTarget();
  assert.equal(await electronApp.evaluate(({}, pid) => globalThis.__gvoiceHarnessTargetPid() === pid && globalThis.__gvoiceTest.startSynthetic(), targetApp.process().pid), true);
  const active = await electronApp.evaluate(() => globalThis.__gvoiceTest.activeProfile());
  assert.equal(active?.profile, 'coding');
  await page.locator('#outputMode').selectOption('manual');
  await page.locator('#outputDefault').selectOption('chat');
  await saveProfiles(page);
  assert.deepEqual(await electronApp.evaluate(() => globalThis.__gvoiceTest.activeProfile()), active);
  await electronApp.evaluate(() => globalThis.__gvoiceTest.expire());
  assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.startSynthetic()), true);
  assert.equal((await electronApp.evaluate(() => globalThis.__gvoiceTest.activeProfile())).profile, 'chat');
  await electronApp.evaluate(() => globalThis.__gvoiceTest.expire());
  await page.locator('#outputMode').selectOption('per-app');
  await page.locator('#outputDefault').selectOption('email');
  await saveProfiles(page);

  log('Checking benchmark import, reference approval, comparison and human-review UI using fixtures');
  const pcm = await readFile(join(root, 'scripts/smoke/fixtures/quick-fox.pcm16'));
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const wav = join(profile, 'quick-fox.wav'), resultsFile = join(profile, 'fixture-results.json');
  await writeFile(wav, Buffer.concat([header, pcm]));
  await electronApp.evaluate(({ dialog }, paths) => {
    const originalOpen = dialog.showOpenDialog, originalMessage = dialog.showMessageBox;
    dialog.showOpenDialog = async (window, options) => {
      if (options.title === 'Choose one recording for your personal benchmark') return { canceled: false, filePaths: [paths.wav] };
      if (options.title === 'Import benchmark results JSON') return { canceled: false, filePaths: [paths.resultsFile] };
      throw new Error('Test chooser refused an unexpected file request');
    };
    dialog.showMessageBox = async (window, options) => {
      if (options.title === 'Keep a local benchmark copy?' && options.buttons?.[1] === 'Add this recording') return { response: 1, checkboxChecked: false };
      throw new Error('Test consent refused an unexpected request');
    };
    globalThis.__restoreFixtureDialogs = () => { dialog.showOpenDialog = originalOpen; dialog.showMessageBox = originalMessage; };
  }, { wav, resultsFile });
  await electronApp.evaluate(() => globalThis.__gvoiceTest.openBenchmark());
  let benchmark = await poll(() => electronApp.windows().find(page => page.url().includes('/benchmark.html')), 'Benchmark window missing');
  await benchmark.locator('#import').click();
  await poll(async () => (await benchmark.evaluate(() => window.benchmark.get())).clips.length === 1, 'Fixture import did not create one clip');
  assert.equal((await benchmark.evaluate(() => window.benchmark.get())).comparison.groups.length, 0);
  const reference = 'The quick brown fox jumps over the lazy dog.';
  await benchmark.getByLabel('Human reference (what the transcript should say)', { exact: true }).fill(reference);
  await benchmark.getByLabel('English', { exact: true }).check();
  await benchmark.getByRole('button', { name: 'Save reference', exact: true }).click();
  await poll(async () => (await benchmark.evaluate(() => window.benchmark.get())).clips[0].revision === 2, 'Reference save did not advance revision');
  await benchmark.getByRole('button', { name: 'I reviewed this reference - approve for scoring', exact: true }).click();
  const approved = await poll(async () => { const state = await benchmark.evaluate(() => window.benchmark.get()); return state.clips[0].approvedAt && state.clips[0]; }, 'Reference approval did not persist');
  const rows = [
    { clipId: approved.id, referenceRevision: approved.revision, engine: 'fixture-exact', cleanupModel: 'none', runLabel: 'synthetic test fixture', output: reference, elapsedMs: 12 },
    { clipId: approved.id, referenceRevision: approved.revision, engine: 'fixture-omission', cleanupModel: 'none', runLabel: 'synthetic test fixture', output: 'The quick brown fox jumps over the dog.', elapsedMs: 18 },
  ];
  await writeFile(resultsFile, JSON.stringify(rows));
  await benchmark.locator('#results').click();
  const compared = await poll(async () => { const state = await benchmark.evaluate(() => window.benchmark.get()); return state.comparison.groups.length === 2 && state; }, 'Fixture comparison did not render both engines');
  assert.equal(compared.comparison.groups.find(group => group.engine === 'fixture-exact').wer, 0);
  assert.equal(compared.comparison.groups.find(group => group.engine === 'fixture-omission').wer, 1 / 9);
  assert.equal(compared.comparison.details.every(result => result.humanReview === 'pending'), true);
  const review = benchmark.locator('details').filter({ has: benchmark.locator('summary', { hasText: 'fixture-exact' }) });
  await review.locator('summary').click();
  await review.getByLabel(/^Your meaning assessment/).selectOption('preserved');
  await review.getByRole('button', { name: 'Save human review', exact: true }).click();
  await poll(async () => (await benchmark.evaluate(() => window.benchmark.get())).comparison.groups.find(group => group.engine === 'fixture-exact').reviewed === 1, 'Meaning review did not persist');
  log('Running the actual installed local Whisper engine from the benchmark UI on the approved fixture');
  await benchmark.locator('#local').click();
  const localResult = await poll(async () => {
    const state = await benchmark.evaluate(() => window.benchmark.get());
    const result = state.comparison.details.find(item => item.engine.startsWith('whisper.cpp/'));
    if (result) return result;
    const status = await benchmark.locator('#status').innerText();
    if (!status.startsWith('Running')) throw new Error(`Local benchmark did not complete: ${status}`);
    return null;
  }, 'Actual local Whisper benchmark exceeded its fixture deadline', 90000);
  assert.equal(localResult.output.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(), 'the quick brown fox jumps over the lazy dog');
  assert.equal(localResult.wer, 0);
  assert.equal(localResult.humanReview, 'pending');
  assert.ok(localResult.elapsedMs > 0);
  assert.equal(localResult.cleanupModel, 'none');
  log(`Actual local Whisper recognized the fixture with 0 WER in ${localResult.elapsedMs}ms (cold CLI including model loading)`);
  await benchmark.locator('#comparison').scrollIntoViewIfNeeded();
  await benchmark.screenshot({ path: join(profile, 'benchmark-proof.png') });
  await electronApp.evaluate(() => globalThis.__restoreFixtureDialogs());
  await assertNoSecretFiles();

  log('Restarting the same isolated profile and verifying both settings and benchmark persistence');
  await close(electronApp); electronApp = null;
  electronApp = await launch();
  page = await settings();
  assert.equal(await page.locator('#outputMode').inputValue(), 'per-app');
  assert.equal(await page.locator('#outputDefault').inputValue(), 'email');
  assert.deepEqual(await electronApp.evaluate(() => globalThis.__gvoiceTest.profileView()), saved);
  await electronApp.evaluate(() => globalThis.__gvoiceTest.openBenchmark());
  benchmark = await poll(() => electronApp.windows().find(page => page.url().includes('/benchmark.html')), 'Benchmark restart window missing');
  const persisted = await poll(async () => benchmark.evaluate(() => window.benchmark?.get()), 'Benchmark restart state missing');
  assert.equal(persisted.clips[0].id, approved.id);
  assert.equal(persisted.clips[0].approvedAt, approved.approvedAt);
  assert.equal(persisted.comparison.groups.length, 3);
  assert.equal(persisted.comparison.groups.find(group => group.engine === 'fixture-exact').reviewed, 1);
  assert.equal(persisted.comparison.details.find(result => result.engine.startsWith('whisper.cpp/')).id, localResult.id);
  await assertNoSecretFiles();

  log('Capturing the actual native tray and open menu from the independent target process');
  const tray = await electronApp.evaluate(() => globalThis.__gvoiceTest.snapshot());
  assert.equal(tray.tray, true); assert.ok(tray.trayBounds?.width > 0);
  // Native menus can block the app's own evaluation. Keep it pending and take
  // the screenshot from the separate target process instead.
  const menu = electronApp.evaluate(() => globalThis.__gvoiceTest.openTray()).catch(() => {});
  await delay(800);
  const png = await bounded(targetApp.evaluate(async ({ desktopCapturer, screen }, bounds) => {
    const display = screen.getDisplayMatching(bounds);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.size });
    const source = sources.find(item => item.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new Error('Native tray screenshot unavailable');
    const size = source.thumbnail.getSize(), sx = size.width / display.bounds.width, sy = size.height / display.bounds.height;
    const width = Math.min(size.width, Math.round(600 * sx)), height = Math.min(size.height, Math.round(800 * sy));
    const x = Math.round(Math.max(0, Math.min(size.width - width, (bounds.x - display.bounds.x - 100) * sx)));
    return source.thumbnail.crop({ x, y: 0, width, height }).toPNG().toString('base64');
  }, tray.trayBounds), 'Native tray screen capture');
  await writeFile(join(profile, 'native-tray-proof.png'), Buffer.from(png, 'base64'));
  await electronApp.evaluate(() => globalThis.__gvoiceTest.closeTray());
  await bounded(menu, 'Native menu dismissal');
  log(JSON.stringify({ result: 'passed', profile, proof: ['output-profiles-proof.png', 'benchmark-proof.png', 'native-tray-proof.png'],
    verified: ['real settings UI and same-profile restart', 'external process native identity mapping', 'mapped and fallback profiles reach the cleanup pipeline with offline responses', 'active utterance profile immutability', 'fixture audio import and reference approval UI', 'two fixture scores and explicit review UI persisted on restart', 'actual local Whisper run from UI with pending review and restart persistence', 'no secret settings files created'],
    limitations: ['Native tray screenshot requires visual inspection.', 'Fixture scores are not model accuracy measurements or human-reviewed personal results.', 'Physical microphone, native paste and general editor compatibility are outside this focused run.'] }, null, 2));
} finally {
  await close(electronApp); await close(targetApp); clearTimeout(deadline);
}
