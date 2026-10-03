// Synthetic speech only. Run after pnpm build:parakeet.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { transcribeParakeet, stopParakeet } from '../../src/providers/parakeet-local.js';
const root = resolve(import.meta.dirname, '../..');
const directory = join(root, '.verification/parakeet');
mkdirSync(directory, { recursive: true });
const path = join(directory, 'synthetic.wav');
execFileSync('/usr/bin/say', ['-v', 'Samantha', '-r', '150', '-o', path, '--data-format=LEI16@16000',
  'The green folder contains three useful documents. Tomorrow I will review the notes and send the final version.']);
const wav = readFileSync(path);
let pcm;
for (let offset = 12; offset + 8 < wav.length;) {
  const length = wav.readUInt32LE(offset + 4);
  if (wav.toString('ascii', offset, offset + 4) === 'data') { pcm = wav.subarray(offset + 8, offset + 8 + length); break; }
  offset += 8 + length + length % 2;
}
assert.ok(pcm);
try {
  for (const phase of ['cold', 'warm']) {
    const start = Date.now();
    const text = await transcribeParakeet(pcm);
    assert.match(text, /green folder contains three useful documents/i);
    assert.match(text, /review the notes and send the final version/i);
    console.log(`PASS ${phase}: ${Date.now() - start}ms for ${(pcm.length / 32000).toFixed(2)}s of synthetic speech: ${text}`);
  }
} finally { stopParakeet(); }
