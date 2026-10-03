// Smoke-test the signed bundle with synthetic audio and separate, empty data.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const profile = await mkdtemp(join(tmpdir(), 'gvoice-files-packaged-'));
const home = join(profile, 'home'), userData = join(profile, 'userdata');
await mkdir(home); await mkdir(userData);
const source = join(profile, 'synthetic.wav');
execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '150', '-o', source, '--data-format=LEI16@16000', 'The green folder contains three useful documents.']);
const base = Object.fromEntries(['PATH','HOME','USER','LOGNAME','SHELL','LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const env = { ...base, GVOICE_NO_ENV: '1', GVOICE_HOME: home, GVOICE_USER_DATA: userData,
  STT_PROVIDER: process.env.GVOICE_TEST_PROVIDER || 'whisper-local', WHISPER_MODEL: join(root, 'models/ggml-small.en-q5_1.bin'), CLEANUP_ENABLED: 'false' };
let app;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(100); }
  throw new Error(label);
}
try {
  app = await _electron.launch({ executablePath: join(root, 'dist/mac-arm64/GVoice.app/Contents/MacOS/GVoice'),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], cwd: home, env, timeout: 45000 });
  const settings = await until(() => app.windows().find(p => p.url().endsWith('/settings.html')), 'Packaged settings did not open');
  await settings.locator('[data-sec="activity"]').click();
  await settings.getByRole('button', { name: 'Open file transcription', exact: true }).click();
  const page = await until(() => app.windows().find(p => p.url().endsWith('/transcribe.html')), 'Packaged file window missing');
  await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, source);
  await page.locator('#pickFiles').click();
  const result = await until(async () => {
    const job = (await page.evaluate(() => window.fileTranscription.get())).jobs[0];
    if (job?.status === 'failed') throw new Error(job.error);
    return job?.status === 'completed' && job;
  }, 'Packaged speech did not complete');
  const detail = await page.evaluate(id => window.fileTranscription.read(id), result.id);
  assert.match(detail.segments.map(s => s.text).join(' '), /green folder contains three useful documents/i);
  assert.equal(await app.evaluate(() => typeof globalThis.__gvoiceTest), 'undefined');
  const files = await readdir(profile, { recursive: true });
  assert.equal(files.some(f => /(?:^|[/\\])\.env/.test(f)), false);
  await page.screenshot({ path: join(root, '.verification/file-transcription/packaged.png') });
  await writeFile(join(root, '.verification/file-transcription/packaged-result.json'), JSON.stringify({ passed: true, profile, source: 'synthetic', testHookAbsent: true }, null, 2));
  console.log('PASS: signed packaged app opens file transcription from Settings and transcribes real synthetic speech, without secret files or test hooks');
} finally { if (app) await app.close(); }
