import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorpusStore } from '../../src/benchmark-corpus.js';
import { scoreText, validateResults, compareResults } from '../../src/benchmark-evaluate.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'gvoice-benchmark-test-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'synthetic.wav'); writeFileSync(path, Buffer.from('RIFF synthetic test audio; not user speech'));
  return { directory, path, store: createCorpusStore(join(directory, 'store')) };
}
const patch = { reference: 'Do not send 15 Purrify bags', translation: '', tags: ['English', 'brand', 'numbers', 'negation'], protectedTerms: ['Purrify'] };
function approved(t) {
  const f = fixture(t), clip = f.store.importAudio(f.path, true); f.store.update(clip.id, patch); f.store.approve(clip.id, 2, true);
  const row = { clipId: clip.id, referenceRevision: 2, engine: 'fixture', cleanupModel: 'none', runLabel: 'test only', output: patch.reference, elapsedMs: 25 };
  return { ...f, clip, row };
}
test('known edit distances, Croatian diacritics and empty hypotheses', () => {
  assert.equal(scoreText('send three bags', 'send two bags').wer, 1 / 3);
  assert.equal(scoreText('čaj', 'caj').cer, 1 / 3);
  assert.equal(scoreText('hello', '').wer, 1);
  assert.equal(scoreText('HELLO, WORLD!', 'hello world').wer, 0);
  assert.throws(() => scoreText('', 'hello'));
});
test('meaning-risk flags catch protected names, numeral and negation changes without issuing semantic verdicts', () => {
  const score = scoreText('Do not send 15 Purrify bags', 'Send 50 Purify bags', ['Purrify']);
  assert.deepEqual(score.flags, ['numbers changed', 'negation changed', 'protected term changed: Purrify']);
  assert.equal(score.meaningChanged, undefined);
  assert.deepEqual(scoreText('Nemoj poslati 12 vrećica', 'Pošalji 12 vrećica').flags, ['negation changed']);
});
test('fresh corpus stays empty and importing requires explicit per-file consent', t => {
  const f = fixture(t); assert.deepEqual(f.store.snapshot().clips, []);
  assert.throws(() => f.store.importAudio(f.path, false), /consent/);
  assert.equal(f.store.snapshot().clips.length, 0);
  const clip = f.store.importAudio(f.path, true); assert.equal(clip.approvedAt, null);
  assert.ok(existsSync(f.store.audioPath(clip.id)));
  assert.throws(() => f.store.approve(clip.id, 1, true));
});
test('explicit human approval and matching revision are required before accepting results', t => {
  const f = fixture(t), clip = f.store.importAudio(f.path, true); f.store.update(clip.id, patch);
  const row = { clipId: clip.id, referenceRevision: 2, engine: 'fixture', cleanupModel: 'none', runLabel: 'test', output: patch.reference, elapsedMs: 1 };
  assert.throws(() => f.store.importResults([row]), /human-approved/);
  assert.throws(() => f.store.approve(clip.id, 2, false));
  assert.throws(() => f.store.approve(clip.id, 1, true));
  f.store.approve(clip.id, 2, true); f.store.importResults([row]); assert.equal(f.store.snapshot().comparison.details.length, 1);
});
test('reimport cannot forge a human review; human review persists on reopen; edits invalidate scores', t => {
  const f = approved(t); f.store.importResults([{ ...f.row, humanReview: 'preserved', reviewedAt: 'forged' }]);
  let result = f.store.snapshot().results[0]; assert.equal(result.humanReview, 'pending');
  f.store.review(result.id, 'changed', 'Manual test judgment.');
  const reopened = createCorpusStore(join(f.directory, 'store')); assert.equal(reopened.snapshot().comparison.groups[0].meaningChanged, 1);
  reopened.importResults([f.row]); assert.equal(reopened.snapshot().results[0].humanReview, 'pending');
  reopened.update(f.clip.id, { ...patch, reference: 'Send 15 bags' }); assert.equal(reopened.snapshot().clips[0].approvedAt, null); assert.equal(reopened.snapshot().results.length, 0);
  reopened.approve(f.clip.id, 3, true); assert.throws(() => reopened.importResults([f.row]), /referenceRevision/);
});
test('deletion removes only local corpus copy, while unknown IDs cannot read arbitrary files', t => {
  const f = approved(t), path = f.store.audioPath(f.clip.id);
  assert.throws(() => f.store.audio('../../anything'), /Unknown clip/);
  f.store.remove(f.clip.id); assert.equal(existsSync(path), false); assert.equal(existsSync(f.path), true);
});
test('a row is scored once and reused, and two stores never share scores', t => {
  const f = approved(t), corpus = f.store.snapshot().clips;
  const rows = validateResults([f.row, { ...f.row, output: 'Send bags', elapsedMs: 75 }], corpus);
  const cache = new Map();
  const first = compareResults(corpus, rows, cache);
  assert.equal(cache.size, 2);
  const again = compareResults(corpus, rows, cache);
  assert.equal(cache.size, 2);
  assert.deepEqual(again.groups, first.groups);
  assert.deepEqual(again.groups, compareResults(corpus, rows).groups); // same answer uncached
  // A revised reference gets its own key rather than the old score.
  const revised = corpus.map(clip => ({ ...clip, revision: clip.revision + 1 }));
  compareResults(revised, rows.map(row => ({ ...row, referenceRevision: row.referenceRevision + 1 })), cache);
  assert.equal(cache.size, 4);
});
test('a clip whose audio file is already gone can still be deleted', t => {
  const f = approved(t), path = f.store.audioPath(f.clip.id);
  unlinkSync(path); // deleted by hand, or by an external cleanup
  f.store.remove(f.clip.id);
  assert.deepEqual(f.store.snapshot().clips, []);
  assert.deepEqual(f.store.snapshot().results, []);
  assert.throws(() => f.store.remove(f.clip.id), /Unknown clip/);
});
test('comparison reports weighted rates, coverage and pending human review separately', t => {
  const f = approved(t), corpus = f.store.snapshot().clips;
  const rows = validateResults([f.row, { ...f.row, output: 'Send bags', elapsedMs: 75 }], corpus);
  const result = compareResults(corpus, rows), group = result.groups[0];
  assert.equal(group.uniqueClips, 1); assert.equal(group.count, 2); assert.equal(group.meanMs, 50); assert.equal(group.reviewed, 0); assert.equal(group.meaningChanged, 0); assert.equal(group.flagged, 1);
  assert.equal(result.details.length, 2); assert.deepEqual(group.clipIds, [f.clip.id]);
  assert.throws(() => validateResults([{ ...f.row, elapsedMs: -1 }], corpus));
  assert.throws(() => validateResults([{ ...f.row, output: 'x'.repeat(2001) }], corpus));
});
test('English and Croatian number words flag differences; curly apostrophes retain negation', () => {
  assert.ok(scoreText('send fifteen bags', 'send fifty bags').flags.includes('numbers changed'));
  assert.ok(scoreText('pošalji petnaest vrećica', 'pošalji pedeset vrećica').flags.includes('numbers changed'));
  assert.ok(scoreText('send two bags', 'send 2 bags').flags.includes('numbers changed'));
  assert.ok(scoreText('I can’t send it', 'I can send it').flags.includes('negation changed'));
  assert.deepEqual(scoreText('I don’t send it', "I don't send it").flags, []);
});
test('offline runner processes only approved WAV clips and never sends reference hints', async t => {
  const { runPersonalLocalBenchmark } = await import('../../src/benchmark-local.js');
  const f = approved(t); const audio = f.store.audioPath(f.clip.id);
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8); writeFileSync(audio, wav);
  f.store.importAudio(f.path, true); // Unapproved fixture must never be processed.
  const bin = join(f.directory, 'whisper-cli'), model = join(f.directory, 'model.bin'); writeFileSync(bin, 'fixture'); writeFileSync(model, 'fixture');
  const calls = [];
  const report = await runPersonalLocalBenchmark({ store: f.store, binary: bin, modelFile: model, run: async (...args) => { calls.push(args); return { stdout: 'actual fixture output' }; } });
  assert.equal(calls.length, 1); assert.equal(report.results[0].output, 'actual fixture output'); assert.equal(report.results[0].cleanupModel, 'none');
  assert.ok(!calls[0][1].includes(patch.reference)); assert.ok(!calls[0][1].includes('--prompt')); assert.equal(calls[0][2].timeout, 180000);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(runPersonalLocalBenchmark({ store: f.store, binary: bin, modelFile: model, signal: abort.signal, run: () => { throw new Error('must not run'); } }), /abort/i);
});
test('offline runner fails before invoking engine when an approved clip is not WAV', async t => {
  const { runPersonalLocalBenchmark } = await import('../../src/benchmark-local.js');
  const f = approved(t); // This fixture has deliberately invalid WAV bytes.
  await assert.rejects(runPersonalLocalBenchmark({ store: f.store, binary: f.path, modelFile: f.path, run: () => { throw new Error('must not run'); } }), /WAV/);
});
test('repeated protected terms and duplicate result rows are handled without inflating coverage', t => {
  assert.ok(scoreText('Purrify Purrify bags', 'Purrify bags', ['Purrify']).flags.includes('protected term changed: Purrify'));
  const f = approved(t);
  assert.throws(() => validateResults([f.row, f.row], f.store.snapshot().clips), /Duplicate/);
});
