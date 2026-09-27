import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FILE_CHUNK_SECONDS, FILE_SAMPLE_RATE, sourceIdentity, sectionLength } from './file-media.js';

const MAX_JOBS = 100;
const MAX_JOB_BYTES = 4 * 1024 * 1024;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const interrupted = new Set(['running', 'queued']);
const states = new Set(['queued', 'running', 'paused', 'failed', 'completed']);

export function formatFileTranscript(job, format = 'txt') {
  const text = job.segments.map(segment => segment.text).filter(Boolean).join('\n\n');
  if (format === 'txt') return text + '\n';
  if (format === 'json') return JSON.stringify({ name: job.name, model: job.model, language: 'en', complete: job.status === 'completed', processedSeconds: job.processedSeconds, durationSeconds: job.durationSeconds, timing: 'section-level, not word-aligned', segments: job.segments }, null, 2) + '\n';
  if (format === 'srt') {
    const time = seconds => {
      const ms = Math.round(seconds * 1000);
      return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
    };
    return job.segments.filter(s => s.text.trim()).map((s, i) => `${i + 1}\n${time(s.start)} --> ${time(s.end)}\n${s.text}\n`).join('\n');
  }
  throw new Error('Choose TXT, SRT or JSON.');
}

export function createFileTranscriptionQueue({ directory, engine, probe, decode, transcribe, isInteractiveBusy = () => false, pollMs = 150 }) {
  const jobs = new Map();
  let worker = null;
  let controller = null;
  let activeId = null;
  let closed = false;
  let adding = false;
  let loadWarning = '';
  const pathFor = id => join(directory, `${id}.json`);
  const writes = new Map();
  const resuming = new Set();
  function persist(job) {
    const serialized = JSON.stringify(job);
    if (Buffer.byteLength(serialized) > MAX_JOB_BYTES) return Promise.reject(new Error('This transcript has reached the local size limit. Export the completed sections.'));
    const write = (writes.get(job.id) || Promise.resolve()).catch(() => {}).then(async () => {
    const temp = pathFor(job.id) + '.tmp';
    await writeFile(temp, serialized, { mode: 0o600 });
    await rename(temp, pathFor(job.id));
    });
    writes.set(job.id, write);
    return write;
  }
  const ready = (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(directory)).filter(name => JOB_ID.test(name.replace(/\.json$/, '')) && name.endsWith('.json')).slice(0, MAX_JOBS);
    for (const name of files) {
      try {
        if ((await stat(join(directory, name))).size > MAX_JOB_BYTES) throw new Error('large');
        const job = JSON.parse(await readFile(join(directory, name), 'utf8'));
        if (`${job.id}.json` !== name || !states.has(job.status) || !Array.isArray(job.segments) || typeof job.path !== 'string' || !Number.isFinite(job.durationSeconds) || !Number.isFinite(job.processedSeconds)) throw new Error('invalid');
        if (job.segments.some(s => typeof s.text !== 'string' || !Number.isFinite(s.start) || !Number.isFinite(s.end))) throw new Error('invalid');
        if (interrupted.has(job.status)) { job.status = 'paused'; job.error = 'Interrupted when GVoice closed. Resume when ready.'; job.revision++; }
        jobs.set(job.id, job);
      } catch { loadWarning = 'A saved job could not be read. Its file has been left untouched.'; }
    }
  })();
  // Observed by every public method; prevent a startup directory error from
  // becoming an unhandled rejection before the window is opened.
  ready.catch(() => {});
  const getJob = id => {
    if (typeof id !== 'string' || !JOB_ID.test(id) || !jobs.has(id)) throw new Error('File job not found.');
    return jobs.get(id);
  };
  const summary = job => ({ id: job.id, name: job.name, status: job.status, processedSeconds: job.processedSeconds, durationSeconds: job.durationSeconds, error: job.error, revision: job.revision, model: job.model, hasText: job.segments.some(s => !!s.text) });
  function wake() {
    if (worker || closed) return;
    worker = work().finally(() => { worker = null; if (!closed && [...jobs.values()].some(j => j.status === 'queued')) wake(); });
    worker.catch(() => {});
  }
  async function work() {
    await ready;
    while (!closed) {
      const job = [...jobs.values()].find(item => item.status === 'queued');
      if (!job) return;
      activeId = job.id;
      controller = new AbortController();
      const signal = controller.signal;
      job.status = 'running'; job.error = ''; job.revision++;
      try {
        const currentEngine = await engine();
        if (!currentEngine.available) throw new Error(currentEngine.reason);
        if (currentEngine.modelPath !== job.modelPath) throw new Error('The local model changed. Restore this job’s original model before resuming.');
        await persist(job);
        while (job.processedSeconds < job.durationSeconds - 0.01) {
          signal.throwIfAborted();
          while (isInteractiveBusy()) {
            await new Promise(resolve => setTimeout(resolve, pollMs));
            signal.throwIfAborted();
          }
          const activeEngine = await engine();
          if (!activeEngine.available || activeEngine.modelPath !== job.modelPath) throw new Error('The local model changed or became unavailable. Restore it before resuming.');
          const identity = await sourceIdentity(job.path);
          if (JSON.stringify(identity) !== JSON.stringify(job.source)) throw new Error('The original file changed. Add it again as a new job.');
          const start = job.processedSeconds;
          const remaining = job.durationSeconds - start;
          const wanted = Math.min(FILE_CHUNK_SECONDS, remaining);
          const pcm = await decode(job.path, start, wanted, signal);
          signal.throwIfAborted();
          const seconds = sectionLength(pcm, wanted, remaining <= FILE_CHUNK_SECONDS);
          if (seconds <= 0 || pcm.length / (2 * FILE_SAMPLE_RATE) < wanted - 0.25) throw new Error('The file ended before its reported duration. Completed sections are saved.');
          const section = pcm.subarray(0, Math.floor(seconds * FILE_SAMPLE_RATE) * 2);
          const result = await transcribe(section, { signal, model: job.modelPath });
          signal.throwIfAborted();
          if (typeof result !== 'string') throw new Error('The speech engine returned an invalid result.');
          const end = Math.min(job.durationSeconds, start + seconds);
          // Reserve space for the terminal status before accepting a section.
          // On a limit failure the durable checkpoint still matches memory.
          if (Buffer.byteLength(JSON.stringify(job)) + Buffer.byteLength(JSON.stringify(result)) + 2048 > MAX_JOB_BYTES) {
            throw new Error('Transcript size limit reached. Export the saved sections.');
          }
          job.segments.push({ start, end, text: result.trim() });
          // The final decoder section can be a fraction shorter than the
          // container duration. Do not loop forever on rounding/padding.
          job.processedSeconds = remaining <= FILE_CHUNK_SECONDS ? job.durationSeconds : end;
          job.revision++;
          await persist(job);
        }
        job.status = 'completed'; job.revision++;
        await persist(job);
      } catch (error) {
        job.status = signal.aborted || closed ? 'paused' : 'failed';
        job.error = signal.aborted || closed ? 'Paused. Completed sections are saved.' : error.message || 'File transcription failed.';
        job.revision++;
        try { await persist(job); } catch { job.error += ' Progress could not be saved to disk.'; }
      } finally { controller = null; activeId = null; }
    }
  }
  return {
    ready,
    get active() { return adding || resuming.size > 0 || !!activeId || [...jobs.values()].some(job => job.status === 'queued'); },
    async snapshot() {
      await ready;
      const { available, model, reason } = await engine();
      return { jobs: [...jobs.values()].map(summary).reverse(), engine: { available, model, reason }, dictationBusy: isInteractiveBusy(), warning: loadWarning };
    },
    async read(id) { await ready; const job = getJob(id); return { ...summary(job), segments: structuredClone(job.segments) }; },
    async add(paths) {
      await ready;
      if (closed || adding) throw new Error('Finish adding the current files first.');
      if (!Array.isArray(paths) || !paths.length || paths.length > 20 || jobs.size + paths.length > MAX_JOBS) throw new Error('Add up to 20 files at once, with at most 100 saved file jobs.');
      adding = true;
      try {
        const configured = await engine();
        if (!configured.available) throw new Error(configured.reason);
        // Validate the complete selection before enqueuing any of it.
        const staged = [];
        for (const path of paths) {
          const source = await sourceIdentity(path);
          const durationSeconds = await probe(path);
          if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 21600) throw new Error('Choose a recording up to six hours long.');
          staged.push({ id: randomUUID(), name: basename(path), path, source, durationSeconds, processedSeconds: 0, status: 'queued', error: '', revision: 1, model: configured.model, modelPath: configured.modelPath, segments: [] });
        }
        for (const job of staged) { await persist(job); jobs.set(job.id, job); }
        wake();
      } finally { adding = false; wake(); }
      return this.snapshot();
    },
    async pause(id) {
      await ready;
      const job = getJob(id);
      if (job.status === 'completed' || job.status === 'paused') return;
      if (activeId === id) { controller?.abort(); }
      else { job.status = 'paused'; job.error = ''; job.revision++; await persist(job); }
    },
    async resume(id) {
      await ready;
      if (closed) throw new Error('GVoice is closing.');
      const job = getJob(id);
      if (activeId === id || resuming.has(id) || !['paused', 'failed'].includes(job.status)) return;
      resuming.add(id);
      try {
        // Publish runnable work only after saving succeeds. A failed write
        // must leave Resume available and preserve the existing checkpoint.
        const next = { ...job, status: 'queued', error: '', revision: job.revision + 1 };
        await persist(next);
        if (!closed) { Object.assign(job, next); wake(); }
      } finally { resuming.delete(id); }
    },
    async export(id, format) { await ready; return formatFileTranscript(getJob(id), format); },
    async close() { closed = true; controller?.abort(); await worker; },
  };
}
