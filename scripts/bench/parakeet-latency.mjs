// Bounded synthetic-only latency measurement; never prints or saves transcripts.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, statfsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createParakeetRuntime, parakeetPaths } from '../../src/providers/parakeet-local.js';
const root = resolve(import.meta.dirname, '../..');
const disk = statfsSync(root);
if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw new Error('Preserve 2 GiB disk reserve.');
const dir = join(root, '.verification/parakeet-latency'); mkdirSync(dir, { recursive: true });
const phrases = { 3: 'The green folder is ready.', 10: 'The green folder contains three useful documents. Tomorrow I will review the notes and send the final version.', 30: 'The green folder contains three useful documents. Tomorrow I will review the notes and send the final version. Please check the blue notebook before the meeting begins. The delivery contains seven small boxes and one large envelope. Keep the last page with the original report.' };
const clips = {};
for (const duration of [3, 10, 30]) {
  const path = join(dir, `${duration}.wav`);
  execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '150', '-o', path, '--data-format=LEI16@16000', phrases[duration]]);
  const wav = readFileSync(path); let pcm;
  for (let off = 12; off + 8 <= wav.length;) { const size = wav.readUInt32LE(off + 4); if (wav.toString('ascii', off, off + 4) === 'data') { pcm = wav.subarray(off + 8, off + 8 + size); break; } off += 8 + size + size % 2; }
  if (!pcm || pcm.length > duration * 32000) throw new Error('Synthetic phrase must fit without truncation.');
  const padded = Buffer.alloc(duration * 32000); pcm.copy(padded); clips[duration] = padded;
}
const rows = [];
for (let launch = 1; launch <= 3; launch++) {
  let timings = [];
  const runtime = createParakeetRuntime({ onTiming: sample => timings.push(sample), runTimeoutMs: 45000 });
  try {
    const start = performance.now();
    const paths = parakeetPaths();
    await runtime.ensure(process.env.STABLE_PATH_ORDER ? { model: paths.model, bin: paths.bin } : paths);
    const readyMs = performance.now() - start;
    for (let trial = 0; trial < (launch === 3 ? 24 : 1); trial++) {
      const seconds = trial < 21 ? 3 : trial === 21 ? 10 : 30;
      const begin = performance.now(); const text = await runtime.run(clips[seconds]);
      const row = { launch, trial, phase: trial === 0 ? 'first_after_ready' : 'warm', seconds, readyMs: trial === 0 ? readyMs : null, requestMs: performance.now() - begin, nonempty: !!text, referencePass: /green folder/i.test(text), timings };
      rows.push(row); timings = []; console.log(JSON.stringify(row));
    }
  } finally { runtime.stop(); }
}
const output = process.argv[2] || join(root, 'docs/reports/parakeet-latency-baseline.json');
writeFileSync(output, JSON.stringify({ conditions: { synthetic: true, voice: 'Samantha', rate: 150, monoHz: 16000, threads: 4, freshWorkerCount: 3, osCachesFlushed: false, cleanup: 'not in direct-worker path', paste: 'not in direct-worker path' }, rows }, null, 2) + '\n');
