import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileTranscriptionQueue, formatFileTranscript } from '../../src/file-transcription.js';
import { createInferenceScheduler } from '../../src/inference-scheduler.js';
import { probeMedia, decodeMediaChunk, sectionLength, findMediaBinary } from '../../src/file-media.js';
import { wrapWav } from '../../src/providers/_shared.js';

const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await delay(5); }
  throw new Error('Condition did not become true');
}
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gvoice-files-unit-'));
  const source = join(directory, 'speech.wav');
  await writeFile(source, 'synthetic fixture');
  const options = { directory: join(directory, 'jobs'), engine: async () => ({ available: true, model: 'small.en', modelPath: '/test/model' }),
    probe: async () => 45, decode: async (_path, _start, seconds) => Buffer.alloc(Math.round(seconds * 16000) * 2),
    transcribe: async () => 'Hello world.', pollMs: 5, ...overrides };
  const queue = createFileTranscriptionQueue(options);
  t.after(async () => { await queue.close(); await rm(directory, { recursive: true, force: true }); });
  await queue.ready;
  return { directory, source, queue, options };
}

test('interactive inference runs before queued file work and files wait while recording', async () => {
  let busy = true;
  const scheduler = createInferenceScheduler({ isInteractiveBusy: () => busy, pollMs: 5 });
  const order = [];
  const background = scheduler.run(() => order.push('file'), { priority: 'background' });
  await scheduler.run(() => order.push('dictation'));
  assert.deepEqual(order, ['dictation']);
  busy = false;
  scheduler.setBusyCheck(() => busy);
  await background;
  assert.deepEqual(order, ['dictation', 'file']);
  let release;
  const active = scheduler.run(() => new Promise(r => { release = r; }), { priority: 'background' });
  await until(() => release);
  const later = scheduler.run(() => order.push('later-file'), { priority: 'background' });
  const urgent = scheduler.run(() => order.push('urgent'));
  const controller = new AbortController();
  const canceled = scheduler.run(() => assert.fail('Canceled work ran'), { priority: 'background', signal: controller.signal });
  const rejection = assert.rejects(canceled, { name: 'AbortError' });
  controller.abort(); release();
  await Promise.all([active, later, urgent, rejection]);
  assert.deepEqual(order.slice(2), ['urgent', 'later-file']);
});

test('file queue saves sections, pauses an active request, resumes without duplicate text, and reloads', async t => {
  let calls = 0, release;
  const f = await fixture(t, { transcribe: async () => { calls++; if (calls === 2) await new Promise(r => { release = r; }); return `Section ${calls}`; } });
  const snapshot = await f.queue.add([f.source]);
  const id = snapshot.jobs[0].id;
  await until(() => release);
  await f.queue.pause(id);
  release();
  await until(async () => (await f.queue.read(id)).status === 'paused');
  const partial = await f.queue.read(id);
  assert.equal(partial.segments.length, 1);
  assert.ok(partial.processedSeconds > 0 && partial.processedSeconds < 20);
  await f.queue.resume(id);
  await until(async () => (await f.queue.read(id)).status === 'completed');
  const full = await f.queue.read(id);
  assert.equal(full.processedSeconds, 45);
  assert.equal(full.segments[0].text, 'Section 1');
  assert.equal(full.segments.some(s => s.text === 'Section 2'), false);
  for (let i = 1; i < full.segments.length; i++) assert.equal(full.segments[i].start, full.segments[i-1].end);
  await f.queue.close();
  const restored = createFileTranscriptionQueue(f.options);
  assert.deepEqual((await restored.read(id)).segments, full.segments);
  await restored.close();
  assert.deepEqual((await readdir(f.directory)).sort(), ['jobs', 'speech.wav']);
});

test('restart pauses queued work; changing a source fails without discarding completed sections', async t => {
  const f = await fixture(t, { isInteractiveBusy: () => true });
  const { jobs } = await f.queue.add([f.source]);
  await until(async () => (await f.queue.read(jobs[0].id)).status === 'running');
  await f.queue.close();
  const restored = createFileTranscriptionQueue({ ...f.options, isInteractiveBusy: () => false });
  t.after(() => restored.close());
  assert.equal((await restored.read(jobs[0].id)).status, 'paused');
  await writeFile(f.source, 'changed synthetic source');
  await restored.resume(jobs[0].id);
  await until(async () => (await restored.read(jobs[0].id)).status === 'failed');
  assert.match((await restored.read(jobs[0].id)).error, /original file changed/);
});

test('a failed resume save leaves the job paused and retryable', async t => {
  let busy = true;
  const f = await fixture(t, { isInteractiveBusy: () => busy });
  const { jobs: [job] } = await f.queue.add([f.source]);
  await f.queue.pause(job.id);
  await until(() => !f.queue.active);
  const before = await f.queue.read(job.id);
  const temporary = join(f.options.directory, `${job.id}.json.tmp`);
  await mkdir(temporary);
  await assert.rejects(f.queue.resume(job.id));
  assert.deepEqual(await f.queue.read(job.id), before);
  assert.equal(f.queue.active, false);
  await rm(temporary, { recursive: true });
  busy = false;
  await Promise.all([f.queue.resume(job.id), f.queue.resume(job.id)]);
  await until(async () => (await f.queue.read(job.id)).status === 'completed');
});

test('video longer than its audio completes at the first audio track duration', async t => {
  const ffmpeg = await findMediaBinary('ffmpeg'), ffprobe = await findMediaBinary('ffprobe');
  if (!ffmpeg || !ffprobe) { t.skip('FFmpeg is not installed'); return; }
  const f = await fixture(t, {
    probe: path => probeMedia(path, { ffprobe }),
    decode: (path, start, duration, signal) => decodeMediaChunk(path, start, duration, { ffmpeg, signal }),
  });
  const video = join(f.directory, 'longer-video.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=32x32:rate=10:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'aac', video]);
  assert.ok(Math.abs(await probeMedia(video, { ffprobe }) - 1) < 0.05);
  const { jobs: [job] } = await f.queue.add([video]);
  await until(async () => ['completed', 'failed'].includes((await f.queue.read(job.id)).status));
  assert.equal((await f.queue.read(job.id)).status, 'completed');
});

test('changed model and short decode fail clearly; invalid additions do not enqueue', async t => {
  let model = '/test/model';
  const f = await fixture(t, { engine: async () => ({ available: true, model: 'small.en', modelPath: model }), isInteractiveBusy: () => true });
  await assert.rejects(f.queue.add([join(f.directory, 'missing.wav')]), /ENOENT/);
  assert.equal((await f.queue.snapshot()).jobs.length, 0);
  const { jobs } = await f.queue.add([f.source]);
  await f.queue.pause(jobs[0].id);
  await until(async () => (await f.queue.read(jobs[0].id)).status === 'paused');
  model = '/another/model';
  await f.queue.resume(jobs[0].id);
  await until(async () => (await f.queue.read(jobs[0].id)).status === 'failed');
  assert.match((await f.queue.read(jobs[0].id)).error, /model changed/);
  await assert.rejects(f.queue.read('../secret'), /not found/);
  const short = await fixture(t, { decode: async () => Buffer.alloc(32000) });
  const first = (await short.queue.add([short.source])).jobs[0];
  await until(async () => (await short.queue.read(first.id)).status === 'failed');
  assert.match((await short.queue.read(first.id)).error, /ended before/);
});

test('outputs mark partial progress and use section timestamps', () => {
  const job = { name: 'test.wav', model: 'small.en', status: 'paused', processedSeconds: 20, durationSeconds: 60, segments: [{ start: 0, end: 20, text: 'Hello.' }] };
  assert.equal(formatFileTranscript(job), 'Hello.\n');
  assert.match(formatFileTranscript(job, 'srt'), /00:00:00,000 --> 00:00:20,000/);
  assert.equal(JSON.parse(formatFileTranscript(job, 'json')).complete, false);
  assert.throws(() => formatFileTranscript(job, 'pdf'), /Choose TXT/);
});

test('an oversized result leaves the durable checkpoint and a readable failure', async t => {
  const f = await fixture(t, { transcribe: async () => 'a'.repeat(4 * 1024 * 1024) });
  const job = (await f.queue.add([f.source])).jobs[0];
  await until(async () => (await f.queue.read(job.id)).status === 'failed');
  await f.queue.close();
  const restored = createFileTranscriptionQueue(f.options);
  const saved = await restored.read(job.id);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.processedSeconds, 0);
  assert.equal(saved.segments.length, 0);
  assert.match(saved.error, /size limit/);
  await restored.close();
});

test('real FFmpeg decodes bounded PCM and rejects files with no valid audio', async t => {
  const f = await fixture(t);
  const pcm = Buffer.alloc(2 * 16000 * 3);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(1000 * Math.sin(i / 10)), i * 2);
  await writeFile(f.source, wrapWav(pcm, 16000));
  const ffprobe = '/opt/homebrew/bin/ffprobe', ffmpeg = '/opt/homebrew/bin/ffmpeg';
  try { await readFile(ffprobe); } catch { t.skip('FFmpeg is not installed at the macOS test path'); return; }
  assert.equal(await probeMedia(f.source, { ffprobe }), 3);
  const section = await decodeMediaChunk(f.source, 1, 1, { ffmpeg });
  assert.equal(section.length, 32000);
  assert.equal(sectionLength(section, 1, true), 1);
  await writeFile(f.source, 'not audio');
  await assert.rejects(probeMedia(f.source, { ffprobe }), /Could not read audio/);
});
