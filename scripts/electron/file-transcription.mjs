// Real local inference, synthetic speech only, isolated application data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findMediaBinary } from '../../src/file-media.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'package.json'));
const { _electron } = require('playwright');
const profile = await mkdtemp(join(tmpdir(), 'gvoice-files-desktop-'));
const evidence = join(root, '.verification/file-transcription');
await mkdir(evidence, { recursive: true });
const source = join(profile, 'synthetic-speech.wav');
execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '150', '-o', source, '--data-format=LEI16@16000',
  Array(6).fill('This is a local speech test. The green folder contains three useful documents. Please save the recording for tomorrow.').join(' ') ]);
const video = join(profile, 'longer-video.mp4');
const ffmpeg = await findMediaBinary('ffmpeg');
assert.ok(ffmpeg, 'FFmpeg is required for this integration check');
execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=10:duration=12',
  '-t', '8', '-i', source, '-c:v', 'mpeg4', '-c:a', 'aac', video]);
const model = join(root, 'models/ggml-small.en-q5_1.bin');
const desktop = Object.fromEntries(['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','DISPLAY','XAUTHORITY'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const env = { ...desktop, GVOICE_TEST_MODE: '1', GVOICE_TEST_PROFILE: profile, GVOICE_TEST_MAIN: join(root, 'main.js'),
  GVOICE_HOME: profile, GVOICE_NO_ENV: '1', TMPDIR: profile, STT_PROVIDER: 'whisper-local', WHISPER_MODEL: model, CLEANUP_ENABLED: 'false' };
let owned;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(100); }
  throw new Error(label);
}
const deadline = setTimeout(() => { owned?.process()?.kill('SIGKILL'); process.exit(1); }, 240000);
deadline.unref();
async function launch() {
  owned = await _electron.launch({ executablePath: require('electron'), args: [join(root, 'scripts/electron/entry.mjs')], cwd: profile, env, timeout: 45000 });
  owned.context().setDefaultTimeout(10000);
  await until(() => owned.evaluate(() => globalThis.__gvoiceTest?.ready), 'App did not start');
}
async function open() {
  await owned.evaluate(() => globalThis.__gvoiceTest.openFiles());
  const page = await until(() => owned.windows().find(p => p.url().endsWith('/transcribe.html')), 'File window missing');
  await page.waitForFunction(() => !!window.fileTranscription);
  return page;
}
const snapshot = page => page.evaluate(() => window.fileTranscription.get());
try {
  await launch();
  let page = await open();
  assert.equal((await snapshot(page)).engine.available, true);
  assert.equal(await owned.evaluate(() => globalThis.__gvoiceTest.startSynthetic()), true);
  await owned.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
  await page.locator('#pickFiles').click();
  const job = await until(async () => (await snapshot(page)).jobs[0], 'Import did not enqueue');
  await until(async () => (await snapshot(page)).jobs[0].status === 'running', 'Job did not start');
  await delay(400);
  assert.equal((await snapshot(page)).jobs[0].processedSeconds, 0, 'File inference must wait for dictation');
  await owned.evaluate(() => globalThis.__gvoiceTest.openSettings());
  const settings = await until(() => owned.windows().find(p => p.url().endsWith('/settings.html')), 'Settings missing');
  const speed = await settings.evaluate(() => window.settingsBridge.engineBenchmark({ model: 'ggml-small.en-q5_1.bin' }));
  assert.equal(speed.ok, false);
  assert.match(speed.error, /Pause file transcription/);
  await settings.close();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await until(async () => (await snapshot(page)).jobs[0].status === 'paused', 'Pause failed');
  await owned.evaluate(() => globalThis.__gvoiceTest.expire());
  console.log('PASS: file work waits for dictation and can be paused while waiting');
  await owned.close(); owned = null;
  await launch(); page = await open();
  assert.equal((await snapshot(page)).jobs[0].status, 'paused');
  const blockedSave = join(profile, 'file-transcriptions', `${job.id}.json.tmp`);
  await mkdir(blockedSave);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await until(async () => (await page.locator('#liveStatus').innerText()).includes('EISDIR'), 'Save failure not shown');
  await delay(1000);
  assert.equal((await snapshot(page)).jobs[0].status, 'paused');
  assert.equal(await page.getByRole('button', { name: 'Resume', exact: true }).count(), 1);
  await rm(blockedSave, { recursive: true });
  console.log('PASS: failed Resume save stays paused with Resume available');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  const completed = await until(async () => {
    const job = (await snapshot(page)).jobs[0];
    if (job.status === 'failed') throw new Error(job.error);
    return job.status === 'completed' && job;
  }, 'Real transcription did not finish', 100000);
  const detail = await page.evaluate(id => window.fileTranscription.read(id), job.id);
  assert.ok(detail.segments.length >= 3, 'Fixture must exercise multiple section boundaries');
  const text = detail.segments.map(s => s.text).join(' ');
  assert.match(text, /green folder/i);
  assert.match(text, /three useful documents/i);
  assert.equal((text.match(/green folder/gi) || []).length, 6, 'Repeated fixture sentence lost or duplicated at boundaries');
  await until(async () => (await page.locator('.transcript').innerText()).includes('green folder'), 'Transcript did not render');
  console.log(`PASS: real local speech completed ${completed.durationSeconds.toFixed(1)} seconds in ${detail.segments.length} saved sections`);
  for (const format of ['txt','srt','json']) {
    const output = join(profile, `transcript.${format}`);
    await owned.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, output);
    await page.getByRole('button', { name: format.toUpperCase(), exact: true }).click();
    await until(async () => readFile(output, 'utf8').catch(() => ''), 'Output not saved');
    const saved = await readFile(output, 'utf8');
    assert.match(saved, /green folder/i);
    if (format === 'json') assert.equal(JSON.parse(saved).complete, true);
    if (format === 'srt') assert.match(saved, /00:00:00,000 -->/);
    await until(async () => (await page.locator('#liveStatus').innerText()) === 'Saved.', 'Save action pending');
  }
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await until(async () => (await page.locator('#liveStatus').innerText()).includes('already exists'), 'Existing file must not be overwritten');
  console.log('PASS: TXT/SRT/JSON saved, existing destination protected');
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: join(evidence, `${colorScheme}.png`), fullPage: true });
  }
  await page.close(); page = await open();
  assert.equal((await snapshot(page)).jobs[0].status, 'completed');
  await until(async () => (await page.locator('.transcript').innerText()).includes('green folder'), 'Reopened transcript missing');
  // Add a second job and switch back to exercise detail caching.
  await owned.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
  await page.locator('#pickFiles').click();
  await until(async () => (await snapshot(page)).jobs.length === 2, 'Second import missing');
  const second = (await snapshot(page)).jobs.find(j => j.id !== job.id);
  await page.evaluate(id => window.fileTranscription.action('pause', { id }), second.id);
  await until(async () => (await snapshot(page)).jobs.find(j => j.id === second.id).status === 'paused', 'Second job pause missing');
  await page.locator('.job').first().click();
  await page.locator('.job').last().click();
  await until(async () => (await page.locator('.transcript').innerText()).includes('green folder'), 'Switching back lost cached transcript');
  await owned.evaluate(({ dialog }, video) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [video] }); }, video);
  await page.locator('#pickFiles').click();
  const videoJob = await until(async () => (await snapshot(page)).jobs.find(j => j.name === 'longer-video.mp4'), 'Video import missing');
  await page.locator('.job').filter({ hasText: 'longer-video.mp4' }).click();
  await until(async () => {
    const current = (await snapshot(page)).jobs.find(j => j.id === videoJob.id);
    if (current.status === 'failed') throw new Error(current.error);
    return current.status === 'completed';
  }, 'Video transcription did not finish', 30000);
  assert.ok(Math.abs(videoJob.durationSeconds - 8) < 0.05);
  await until(async () => (await page.locator('.transcript').innerText()).includes('green folder'), 'Video transcript not rendered');
  console.log('PASS: 12-second video with 8-second audio completes and displays its transcript');
  const tray = await owned.evaluate(() => globalThis.__gvoiceTest.snapshot());
  assert.ok(tray.tray && tray.trayBounds.width > 0 && tray.trayBounds.height > 0);
  await owned.evaluate(() => globalThis.__gvoiceTest.openTray());
  await delay(500);
  // Screen capture is deliberately outside this harness; review the native menu
  // while this optional pause is enabled on the owned test application.
  if (process.env.GVOICE_REVIEW_TRAY === '1') await delay(20000);
  await owned.evaluate(() => globalThis.__gvoiceTest.closeTray());
  const files = await readdir(profile, { recursive: true });
  assert.equal(files.some(f => /(?:^|[/\\])(?:\.env[^/\\]*|credentials\.json)$/.test(f)), false);
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ passed: true, duration: completed.durationSeconds, sections: detail.segments.length, profile, syntheticOnly: true }, null, 2));
  console.log('PASS: reopened history, tray present, no secret file created');
} finally {
  if (owned) { try { await owned.close(); } catch { owned.process()?.kill('SIGKILL'); } }
  clearTimeout(deadline);
}
