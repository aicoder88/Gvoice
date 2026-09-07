#!/usr/bin/env node
// Runs only an explicitly selected, already installed whisper.cpp CLI/model.
// No download, cloud transport, relay, cleanup service, or app-setting changes.
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createCorpusStore, atomicJson } from '../../src/benchmark-corpus.js';
import { runPersonalLocalBenchmark } from '../../src/benchmark-local.js';

try {
  const [directory, binary, modelFile, outputFile] = process.argv.slice(2);
  if (!directory || !binary || !modelFile || !outputFile) throw new Error('Usage: node scripts/benchmark/run-local.mjs <benchmark-store-directory> <whisper-cli> <local-model.bin> <new-results.json>');
  const output = resolve(outputFile);
  if (!output.endsWith('.json') || /(?:^|[/\\])(?:\.env[^/\\]*|credentials\.json|service-account[^/\\]*\.json)$/i.test(output) || existsSync(output)) throw new Error('Output must be a new benchmark .json file, never an existing or secret file.');
  statSync(join(resolve(directory), 'corpus.json'));
  const store = createCorpusStore(resolve(directory));
  const report = await runPersonalLocalBenchmark({ store, binary, modelFile, onProgress: (done, total) => process.stderr.write(`Processed ${done}/${total}\n`) });
  atomicJson(output, report);
  process.stdout.write(`Saved ${report.results.length} results. Import this JSON into GVoice for comparison and human review.\n`);
} catch (error) { process.stderr.write((error.code ? `Local benchmark failed (${error.code}). Check your installed binary, model and audio format.` : error.message) + '\n'); process.exitCode = 1; }
