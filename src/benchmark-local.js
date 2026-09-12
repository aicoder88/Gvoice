import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync, readFileSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { performance } from 'node:perf_hooks';
const execute = promisify(execFile);

// Intentionally bypasses provider server URLs, downloads, cleanup and app settings.
export async function runPersonalLocalBenchmark({ store, binary, modelFile, signal, onProgress = () => {}, run = execute }) {
  if (!binary || !modelFile) throw new Error('Install the local Whisper engine and a model in Settings before running this benchmark.');
  const budget = AbortSignal.timeout(10 * 60 * 1000);
  signal = signal ? AbortSignal.any([signal, budget]) : budget;
  const bin = resolve(binary), model = resolve(modelFile);
  if (!statSync(bin).isFile() || !statSync(model).isFile()) throw new Error('The local engine or model file is missing.');
  const clips = store.snapshot().clips.filter(c => c.approvedAt);
  if (!clips.length) throw new Error('Approve at least one reference before running the local benchmark.');
  for (const clip of clips) {
    const path = store.audioPath(clip.id), wav = readFileSync(path);
    if (wav.length > 20 * 1024 * 1024 || extname(path) !== '.wav' || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Local runs require WAV recordings. Convert other audio to WAV locally and re-import it.');
  }
  const results = [];
  for (const clip of clips) {
    signal?.throwIfAborted();
    const language = clip.tags.includes('mixed') ? 'auto' : clip.tags.includes('Croatian') && !clip.tags.includes('English') ? 'hr' : clip.tags.includes('English') && !clip.tags.includes('Croatian') ? 'en' : 'auto';
    const started = performance.now();
    let stdout;
    try {
      ({ stdout } = await run(bin, ['-m', model, '-f', store.audioPath(clip.id), '-nt', '-np', '-l', language, '--no-fallback', '-t', '4'], { timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true, signal }));
    } catch (error) {
      if (signal?.aborted) throw new Error('Local benchmark cancelled.');
      throw new Error(`Local Whisper failed${error.code ? ` (${error.code})` : ''}. Check your installed model and WAV format.`);
    }
    const transcript = stdout.trim();
    if (transcript.length > 2000) throw new Error('Output is too long. Split this recording into shorter clips.');
    results.push({ clipId: clip.id, referenceRevision: clip.revision, engine: `whisper.cpp/${basename(model)}`.slice(0, 120), cleanupModel: 'none', runLabel: 'local CLI cold, includes model loading', output: transcript, elapsedMs: Math.round(performance.now() - started) });
    onProgress(results.length, clips.length);
  }
  signal?.throwIfAborted();
  return { version: 1, createdAt: new Date().toISOString(), timing: 'cold CLI wall time including process startup and model loading; excludes recording time', results };
}
