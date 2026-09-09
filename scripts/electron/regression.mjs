// Run explicitly on a desktop with Accessibility permission. Never skips failures.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'package.json'));
const progress = message => console.log(`[gvoice-regression ${new Date().toISOString()}] ${message}`);
const bounded = async (operation, label, milliseconds = 30000) => {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
};
let electronApp;
let targetApp;
const deadline = setTimeout(() => {
  console.error('[gvoice-regression] Overall 240 second deadline exceeded');
  electronApp?.process()?.kill('SIGKILL');
  targetApp?.process()?.kill('SIGKILL');
  process.exit(1);
}, 240000);
deadline.unref();
const playwrightPath = process.env.GVOICE_PLAYWRIGHT_PATH || require.resolve('playwright');
const playwright = await import(pathToFileURL(playwrightPath).href);
const { _electron } = playwright.default || playwright;
const model = process.env.GVOICE_TEST_MODEL || join(root, 'models/ggml-base-q5_1.bin');
await access(model); // An unavailable local engine is a failure, never a passing skip.
const profile = await mkdtemp(join(tmpdir(), 'gvoice-regression-'));
const pcm = await readFile(join(root, 'scripts/smoke/fixtures/quick-fox.pcm16'));
const fixtureDurationMs = 1000 + pcm.length / 48000 * 1000;
const trayOnly = process.env.GVOICE_TEST_TRAY_ONLY === '1';
const editOnly = trayOnly || process.env.GVOICE_TEST_EDIT_ONLY === '1';
const spokenEdit = !trayOnly && process.env.GVOICE_TEST_SPOKEN_EDIT === '1';
let releaseToPasteMs = null;
let warmReleaseToPasteMs = null;
try {
  progress(`Launching isolated Electron; profile ${profile}`);
  electronApp = await _electron.launch({
    executablePath: require('electron'),
    args: [join(root, 'scripts/electron/entry.mjs')],
    cwd: profile,
    env: { ...process.env, GVOICE_TEST_MODE: '1', GVOICE_TEST_PROFILE: profile,
      GVOICE_TEST_MAIN: join(root, 'main.js'), GVOICE_HOME: profile, DOTENV_CONFIG_PATH: join(profile, 'absent-config'),
      TMPDIR: profile,
      STT_PROVIDER: 'whisper-local', WHISPER_MODEL: model, CLEANUP_ENABLED: 'false', MIC_DEVICE_ID: '',
      RECORDING_RETENTION_DAYS: '1' },
    timeout: 60000,
  });
  progress(`Electron launched (PID ${electronApp.process().pid})`);
  electronApp.process().stderr?.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      if (line.includes('[main] typeText failed:') || line.includes('osascript paste helper')) progress(`Native paste error: ${line.slice(0, 500)}`);
    }
  });
  const observeRenderer = page => page.on('console', message => {
    if (page.url().includes('/dictation.html')) progress(`Renderer: ${message.text().slice(0, 500)}`);
  });
  for (const page of electronApp.windows()) observeRenderer(page);
  electronApp.on('window', observeRenderer);
  electronApp.context().setDefaultTimeout(12000);
  const evaluate = electronApp.evaluate.bind(electronApp);
  electronApp.evaluate = (...args) => bounded(evaluate(...args), 'Electron main-process operation');
  const poll = async (fn, message, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = await bounded(Promise.resolve().then(fn), message, Math.min(30000, Math.max(1, end - Date.now())));
      if (result) return result;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(message);
  };
  await poll(() => electronApp.evaluate(() => globalThis.__gvoiceTest?.ready), 'Test bridge did not become ready');
  progress('Application and renderer ready');
  const dictationPage = electronApp.windows().find(page => page.url().includes('/dictation.html'));
  assert.ok(dictationPage, 'Capture renderer must exist');
  if (!editOnly || spokenEdit) {
  await dictationPage.addInitScript(({ pcmBase64 }) => {
    // Controlled audio fixture only: retain the application's real AudioWorklet,
    // WebSocket, relay, speech recognition and native paste code paths.
    const bytes = Uint8Array.from(atob(pcmBase64), char => char.charCodeAt(0));
    const samples = new DataView(bytes.buffer);
    window.__prepareFixture = async () => {
      const context = new AudioContext({ sampleRate: 24000 });
      const buffer = context.createBuffer(1, bytes.length / 2 + 24000, 24000);
      const floats = buffer.getChannelData(0);
      for (let i = 0; i < bytes.length / 2; i++) floats[i + 12000] = samples.getInt16(i * 2, true) / 32768;
      const output = context.createMediaStreamDestination();
      await context.resume();
      window.__fixtureAudio = { context, output, buffer, peak: Math.max(...floats.map(Math.abs)), play() {
        const source = context.createBufferSource();
        source.buffer = this.buffer; source.connect(output); source.start();
      } };
      return output.stream;
    };
    navigator.mediaDevices.getUserMedia = async () => {
      if (!window.__fixtureAudio) throw new Error('Fixture must be prepared before dictation starts');
      return window.__fixtureAudio.output.stream.clone();
    };
  }, { pcmBase64: pcm.toString('base64') });
  await dictationPage.reload();
  await dictationPage.locator('#status').waitFor({ state: 'attached' });
  await bounded(dictationPage.evaluate(() => window.__prepareFixture().then(() => true)), 'Preparing fixture media source');
  progress('Renderer reloaded with synthetic fixture MediaStream');
  }
  for (const page of electronApp.windows()) {
    if (page.url().includes('/dictation.html')) {
      progress(`Renderer status: ${await page.locator('body').innerText()}`);
    }
  }
  const state = await electronApp.evaluate(() => globalThis.__gvoiceTest.snapshot());
  assert.equal(state.tray, true, 'Real Electron tray must exist');
  assert.ok(state.trayBounds?.width > 0, 'Tray must have screen bounds');
  progress('Launching a separate process for the native editable target');
  targetApp = await _electron.launch({
    executablePath: require('electron'), args: [join(root, 'scripts/electron/target.mjs')], cwd: profile,
    env: { ...process.env, GVOICE_TEST_MODE: '1', GVOICE_TEST_PROFILE: profile, TMPDIR: profile }, timeout: 60000,
  });
  targetApp.context().setDefaultTimeout(12000);
  const targetEvaluate = targetApp.evaluate.bind(targetApp);
  targetApp.evaluate = (...args) => bounded(targetEvaluate(...args), 'External target operation');
  progress(`External target launched (PID ${targetApp.process().pid})`);
  const target = await poll(async () => {
    for (const page of targetApp.windows()) if ((await page.title()) === 'GVoice Regression Target') return page;
  }, 'Editable target window missing');
  await target.evaluate(() => {
    window.__pasteEvents = [];
    document.querySelector('#target').addEventListener('paste', event => {
      const text = event.clipboardData?.getData('text/plain') || '';
      window.__pasteEvents.push({ time: Date.now(), length: text.length });
    });
  });
  await target.locator('#target').focus();
  await targetApp.evaluate(({ app }) => {
    app.focus({ steal: true }); globalThis.__gvoiceRegressionTarget.focus();
  });
  await target.locator('#target').focus();
  const nativeTarget = await electronApp.evaluate(({ systemPreferences }) => {
    return { accessibility: systemPreferences.isTrustedAccessibilityClient(false), editable: globalThis.__gvoiceHarnessFocus(), pid: globalThis.__gvoiceHarnessTargetPid() };
  });
  progress(`Native target: ${JSON.stringify(nativeTarget)}`);
  assert.equal(nativeTarget.accessibility, true, 'Stop before paste: Electron lacks Accessibility permission');
  const focusTarget = async () => {
    await poll(async () => {
      await targetApp.evaluate(({ app }) => { app.focus({ steal: true }); globalThis.__gvoiceRegressionTarget.focus(); });
      await target.locator('#target').focus();
      const actual = await electronApp.evaluate(() => ({ pid: globalThis.__gvoiceHarnessTargetPid(), editable: globalThis.__gvoiceHarnessFocus() }));
      return actual.pid === targetApp.process().pid && actual.editable === true;
    }, 'Stop before paste: native focus does not match the editable target process', 15000);
  };
  try {
    await focusTarget();
  } catch (error) {
    progress('NATIVE FOCUS FAILED: leaving only the test target open for 60 seconds of manual inspection; no paste will occur');
    await new Promise(resolve => setTimeout(resolve, 60000));
    throw error;
  }
  if (!editOnly) {
  progress('Editable target focused; capturing recurring fixture through synthetic MediaStream');
  const originalClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.start()), true);
  assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.start()), false, 'Repeated press during hold must be rejected');
  await poll(async () => {
    const status = await dictationPage.locator('#status').innerText();
    if (/timed out|blocked|failed|lost/i.test(status)) throw new Error(`Capture could not start: ${status}`);
    return status === 'Listening';
  }, 'Capture never reached Listening', 20000);
  progress('Microphone capture reached Listening');
  progress(`Synthetic source: ${JSON.stringify(await dictationPage.evaluate(() => ({ state: window.__fixtureAudio?.context.state, peak: window.__fixtureAudio?.peak })))}`);
  await dictationPage.evaluate(() => window.__fixtureAudio.play());
  await new Promise(r => setTimeout(r, fixtureDurationMs + 250));
  const releaseAt = Date.now();
  await electronApp.evaluate(() => globalThis.__gvoiceTest.release());
  progress('Released dictation; waiting for real Whisper and native paste');
  const pasted = await poll(async () => {
    const value = await target.locator('#target').inputValue();
    if (!value.trim()) {
      const failed = await electronApp.evaluate(({}, released) => {
        const latest = globalThis.__gvoiceTest.snapshot().history[0];
        return latest && latest.ts >= released && latest.pasted === false;
      }, releaseAt);
      if (failed) throw new Error('Native paste failed; dictation was preserved in recoverable history');
    }
    return value.trim() && value;
  }, 'Speech did not paste into the real editable target', 90000);
  const normalized = pasted.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  if (normalized !== 'the quick brown fox jumps over the lazy dog') {
    progress(`Paste mismatch diagnostics: ${JSON.stringify({ events: await target.evaluate(() => window.__pasteEvents), matchesPreviousClipboard: pasted.trim() === originalClipboard.trim(), observedLength: pasted.length })}`);
    throw new Error('Exactly one fixture must survive real capture, relay, speech recognition and paste (contents withheld)');
  }
  releaseToPasteMs = Date.now() - releaseAt;
  progress(`Speech pasted in ${releaseToPasteMs}ms after release`);
  await new Promise(r => setTimeout(r, 1000));
  assert.equal(await target.locator('#target').inputValue(), pasted, 'One utterance must be delivered once');
  const delivery = await electronApp.evaluate(({ clipboard }) => ({ current: clipboard.readText(), state: globalThis.__gvoiceTest.snapshot().history[0]?.deliveryState }));
  assert.ok(delivery.state === 'verified' ? delivery.current === originalClipboard : delivery.current.trim() === pasted.trim(), 'Only verified delivery may restore the clipboard');
  await poll(() => electronApp.evaluate(() => !globalThis.__gvoiceTest.snapshot().busy), 'Speech session did not finish');
  await target.screenshot({ path: join(profile, 'paste-proof.png') });
  progress('Checking a second dictation with warm capture');
  await target.locator('#target').fill('');
  await focusTarget();
  assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.start()), true);
  await poll(async () => (await dictationPage.locator('#status').innerText()) === 'Listening', 'Warm capture did not start');
  await dictationPage.evaluate(() => window.__fixtureAudio.play());
  await new Promise(resolve => setTimeout(resolve, fixtureDurationMs + 250));
  const warmRelease = Date.now();
  await electronApp.evaluate(() => globalThis.__gvoiceTest.release());
  await poll(async () => /quick brown fox/i.test(await target.locator('#target').inputValue()), 'Warm dictation did not paste real speech', 30000);
  warmReleaseToPasteMs = Date.now() - warmRelease;
  await poll(() => electronApp.evaluate(() => !globalThis.__gvoiceTest.snapshot().busy), 'Warm dictation did not finish');
  progress(`Warm speech pasted in ${warmReleaseToPasteMs}ms after release`);
  // These exercise the real preload and main IPC handlers, independently of STT timing.
  progress('Checking duplicate transcript IPC');
  await target.locator('#target').fill('');
  await target.locator('#target').focus();
  assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.startSynthetic()), true);
  const firstGen = await electronApp.evaluate(() => globalThis.__gvoiceTest.snapshot().generation);
  const synthetic = { text: 'Regression duplicate sentinel.', chunks: [], sampleRate: 24000 };
  await electronApp.evaluate(async ({}, { payload, gen }) => {
    await globalThis.__gvoiceTest.injectTranscript(payload, gen);
    await globalThis.__gvoiceTest.injectTranscript(payload, gen);
  }, { payload: synthetic, gen: firstGen });
  await poll(async () => (await target.locator('#target').inputValue()).includes('Regression duplicate sentinel.'), 'Injected terminal event did not paste');
  await poll(() => electronApp.evaluate(() => !globalThis.__gvoiceTest.snapshot().busy), 'Injected session did not finish');
  await new Promise(r => setTimeout(r, 500));
  assert.equal((await target.locator('#target').inputValue()).match(/Regression duplicate sentinel\./g)?.length, 1, 'Duplicate terminal events must deliver once');
  progress('Checking stale transcript IPC against a newer session');
  await target.locator('#target').fill('');
  await target.locator('#target').focus();
  assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.startSynthetic()), true);
  const staleGen = await electronApp.evaluate(() => globalThis.__gvoiceTest.snapshot().generation);
  await electronApp.evaluate(() => globalThis.__gvoiceTest.expire());
  assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.startSynthetic()), true);
  const currentGen = await electronApp.evaluate(() => globalThis.__gvoiceTest.snapshot().generation);
  await electronApp.evaluate(async ({}, gen) => {
    await globalThis.__gvoiceTest.injectTranscript({ text: 'STALE MUST NOT PASTE', chunks: [] }, gen);
  }, staleGen);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await target.locator('#target').inputValue(), '', 'Late event must not paste into a newer session');
  const stillActive = await electronApp.evaluate(() => globalThis.__gvoiceTest.snapshot());
  assert.equal(stillActive.generation, currentGen);
  assert.equal(stillActive.busy, true, 'Late event must not finish the newer session');
  await electronApp.evaluate(() => globalThis.__gvoiceTest.expire());
  }
  if (!trayOnly) {
  progress('Checking native selected-text capture');
  const selectedText = 'Please make this sentence shorter without changing its meaning.';
  const prefix = 'Before. ';
  const suffix = ' After.';
  const fieldText = prefix + selectedText + suffix;
  const selectedRange = { start: prefix.length, end: prefix.length + selectedText.length };
  await target.locator('#target').fill(fieldText);
  await focusTarget();
  await target.locator('#target').evaluate((element, range) => element.setSelectionRange(range.start, range.end), selectedRange);
  await electronApp.evaluate(() => globalThis.__gvoiceTest.openEdit());
  const edit = await poll(async () => {
    const current = await electronApp.evaluate(() => globalThis.__gvoiceTest.editSnapshot());
    return current?.phase === 'ready' && current;
  }, 'Native selected-text capture did not become ready', 15000);
  assert.equal(edit.original, selectedText, 'Editor must capture the actual selected range');
  progress('Native selected-text capture passed');
  const editor = await poll(async () => {
    for (const page of electronApp.windows()) if ((await page.title()) === 'GVoice - Edit selection') return page;
  }, 'Selection editor window missing');
  const replacement = 'Shorten this sentence while preserving its meaning.';
  const replacedField = prefix + replacement + suffix;
  await electronApp.evaluate(({}, text) => globalThis.__gvoiceTest.setEditResponse(text), replacement);
  await editor.locator('#instruction').fill('Make this shorter without changing its meaning.');
  await editor.locator('#generate').click();
  await poll(() => electronApp.evaluate(() => globalThis.__gvoiceTest.editSnapshot().phase === 'preview'), 'Edit preview did not finish');
  assert.equal(await target.locator('#target').inputValue(), fieldText, 'Preview must not change the source');
  await editor.screenshot({ path: join(profile, 'edit-preview-proof.png') });
  await editor.locator('#apply').click();
  progress(`After native Apply: ${JSON.stringify({ edit: await electronApp.evaluate(() => {
    const { phase, status } = globalThis.__gvoiceTest.editSnapshot(); return { phase, status };
  }), target: await target.locator('#target').inputValue(), selection: await target.locator('#target').evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd })) })}`);
  try {
    await poll(async () => (await target.locator('#target').inputValue()) === replacedField, 'Native Apply did not replace only the selected text');
  } catch (error) {
    progress(`Edit failure state: ${JSON.stringify(await electronApp.evaluate(() => {
      const { phase, status } = globalThis.__gvoiceTest.editSnapshot(); return { phase, status };
    }))}`);
    await editor.screenshot({ path: join(profile, 'edit-failure-proof.png') });
    await target.screenshot({ path: join(profile, 'edit-target-failure-proof.png') });
    throw error;
  }
  await target.screenshot({ path: join(profile, 'edit-apply-proof.png') });
  await poll(() => electronApp.evaluate(() => globalThis.__gvoiceTest.editSnapshot().phase === 'applied'), 'Native Apply did not finish verification');
  await editor.locator('#undo').click();
  await poll(async () => (await target.locator('#target').inputValue()) === fieldText, 'Native Undo did not restore the original text');
  await poll(() => electronApp.evaluate(() => globalThis.__gvoiceTest.editSnapshot().phase === 'undone'), 'Native Undo did not finish verification');
  progress('Offline edit preview, native Apply, and native Undo passed');
  if (spokenEdit) {
    progress('Checking actual spoken editing instruction through local Whisper');
    const instructionPcm = await readFile(join(root, 'scripts/electron/fixtures/edit-instruction.pcm16'));
    await dictationPage.evaluate(({ pcmBase64 }) => {
      const bytes = Uint8Array.from(atob(pcmBase64), char => char.charCodeAt(0));
      const samples = new DataView(bytes.buffer);
      const fixture = window.__fixtureAudio;
      const buffer = fixture.context.createBuffer(1, bytes.length / 2 + 24000, 24000);
      const floats = buffer.getChannelData(0);
      for (let i = 0; i < bytes.length / 2; i++) floats[i + 12000] = samples.getInt16(i * 2, true) / 32768;
      fixture.buffer = buffer;
    }, { pcmBase64: instructionPcm.toString('base64') });
    await focusTarget();
    await target.locator('#target').evaluate((el, range) => el.setSelectionRange(range.start, range.end), selectedRange);
    assert.equal(await electronApp.evaluate(() => globalThis.__gvoiceTest.openEdit()), true, 'Spoken edit source recapture must succeed');
    await poll(() => electronApp.evaluate(() => globalThis.__gvoiceTest.editSnapshot().phase === 'ready'), 'Spoken editor did not become ready');
    await editor.locator('#speak').click();
    await poll(async () => (await dictationPage.locator('#status').innerText()) === 'Listening', 'Spoken edit capture did not start', 20000);
    await dictationPage.evaluate(() => window.__fixtureAudio.play());
    await new Promise(resolve => setTimeout(resolve, 1250 + instructionPcm.length / 48000 * 1000));
    await editor.locator('#speak').click();
    const spokenPreview = await poll(async () => {
      const view = await electronApp.evaluate(() => globalThis.__gvoiceTest.editSnapshot());
      if (view.phase === 'error') throw new Error(`Spoken edit failed: ${view.status}`);
      return view.phase === 'preview' && view;
    }, 'Spoken instruction did not produce an edit preview', 30000);
    const spokenInstruction = spokenPreview.instruction.toLowerCase();
    assert.ok(/rewrite/.test(spokenInstruction) && /text/.test(spokenInstruction) && /fewer words/.test(spokenInstruction), 'Spoken instruction must preserve rewrite/text/fewer words intent');
    assert.ok((await target.locator('#target').inputValue()) === fieldText, 'Spoken preview must not paste instruction into source');
    await editor.screenshot({ path: join(profile, 'spoken-edit-proof.png') });
    await editor.locator('#apply').click();
    await poll(async () => (await target.locator('#target').inputValue()) === replacedField, 'Spoken edit Apply did not preserve surrounding text');
    await poll(() => electronApp.evaluate(() => globalThis.__gvoiceTest.editSnapshot().phase === 'applied'), 'Spoken Apply did not finish verification');
    await editor.locator('#undo').click();
    await poll(async () => (await target.locator('#target').inputValue()) === fieldText, 'Spoken edit Undo did not restore source');
    await poll(() => electronApp.evaluate(() => globalThis.__gvoiceTest.editSnapshot().phase === 'undone'), 'Spoken Undo did not finish verification');
    progress('Actual spoken instruction, offline preview, native Apply, and Undo passed');
  }
  }
  const latency = await electronApp.evaluate(() => globalThis.__gvoiceTest.snapshot().latency);
  if (process.env.GVOICE_TEST_TRAY_PROOF === '1') {
    const trayBounds = await electronApp.evaluate(() => globalThis.__gvoiceTest.snapshot().trayBounds);
    // Native popup can hold the GVoice process in a modal loop. Capture from the
    // independent target process while the menu is still open.
    void electronApp.evaluate(() => globalThis.__gvoiceTest.openTray()).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 800));
    const cropped = await targetApp.evaluate(async ({ desktopCapturer, screen }, bounds) => {
      const display = screen.getDisplayMatching(bounds);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.size });
      const source = sources.find(item => item.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('Screen capture unavailable for tray proof');
      const size = source.thumbnail.getSize();
      const scaleX = size.width / display.bounds.width;
      const scaleY = size.height / display.bounds.height;
      const x = Math.max(0, Math.min(size.width - 360 * scaleX, (bounds.x - display.bounds.x - 40) * scaleX));
      return source.thumbnail.crop({ x: Math.round(x), y: 0, width: Math.min(size.width, Math.round(360 * scaleX)), height: Math.min(size.height, Math.round(320 * scaleY)) }).toPNG().toString('base64');
    }, trayBounds);
    await writeFile(join(profile, 'native-tray-proof.png'), Buffer.from(cropped, 'base64'));
    progress(`Native tray/menu crop saved: ${join(profile, 'native-tray-proof.png')}`);
  }
  console.log(JSON.stringify({ result: trayOnly ? 'captured' : 'passed', coverage: trayOnly ? 'native tray region capture requiring visual review' : editOnly ? 'cross-process native selection capture + offline edit preview/native apply/undo' : 'real Electron + synthetic fixture MediaStream + local Whisper + native paste into external textarea + native selection capture + offline edit preview/native apply/undo', spokenEditVerified: spokenEdit, releaseToPasteMs, warmReleaseToPasteMs, latency, proof: editOnly ? null : join(profile, 'paste-proof.png'), editProof: trayOnly ? null : join(profile, 'edit-preview-proof.png'), limitations: ['Physical microphone selection, global hotkey hardware, compatibility with other editors, and visible tray menu require separate desktop verification.'] }, null, 2));
  if (process.env.GVOICE_TEST_INSPECT === '1') {
    progress('Checks complete: test instance retained for 60 seconds for native tray/menu inspection');
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
} finally {
  progress('Closing only the isolated test instance');
  if (targetApp && process.env.GVOICE_TEST_TRAY_PROOF === '1') {
    try { await targetApp.evaluate(({ app }) => app.focus({ steal: true })); } catch {}
  }
  for (const owned of [electronApp, targetApp]) {
    if (!owned) continue;
    try { await bounded(owned.close(), 'Electron close', 8000); }
    catch (error) {
      owned.process()?.kill('SIGKILL');
      console.error(`[gvoice-regression] ${error.message}; killed test child`);
    }
  }
  // Isolated fixture-only logs remain for diagnostics.
  clearTimeout(deadline);
}
