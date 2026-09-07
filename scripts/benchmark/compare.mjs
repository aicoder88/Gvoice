#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createCorpusStore, MAX_JSON_BYTES } from '../../src/benchmark-corpus.js';
import { validateResults, compareResults } from '../../src/benchmark-evaluate.js';

try {
  const [directory, resultsFile] = process.argv.slice(2);
  if (!directory || !resultsFile) throw new Error('Usage: node scripts/benchmark/compare.mjs <benchmark-store-directory> <results.json>');
  statSync(join(resolve(directory), 'corpus.json'));
  if (statSync(resultsFile).size > MAX_JSON_BYTES) throw new Error('Results file exceeds 2 MB.');
  const corpus = createCorpusStore(resolve(directory)).snapshot();
  const results = validateResults(JSON.parse(readFileSync(resultsFile, 'utf8')), corpus.clips);
  const report = compareResults(corpus.clips, results);
  process.stdout.write(JSON.stringify({ note: 'Read-only comparison. WER/CER and risk flags are not semantic verdicts. External humanReview values are ignored; review imported results in GVoice.', ...report }, null, 2) + '\n');
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
