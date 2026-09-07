import { createHash } from 'node:crypto';

export const TAGS = ['Croatian', 'English', 'mixed', 'brand', 'numbers', 'negation', 'self-correction', 'noise'];
export const MAX_TEXT = 2000;
export const words = text => String(text).normalize('NFC').replaceAll('’', "'").toLocaleLowerCase('en').match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) || [];
const normalized = text => words(text).join(' ');
export function distance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < b.length; j++) row.push(Math.min(row[j] + 1, previous[j + 1] + 1, previous[j] + (a[i] === b[j] ? 0 : 1)));
    previous = row;
  }
  return previous[b.length];
}
function counts(values) { const map = new Map(); for (const value of values) map.set(value, (map.get(value) || 0) + 1); return [...map].sort((a,b) => a[0].localeCompare(b[0])); }
const numberWords = new Set(('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion first second third nula jedan jedna jedno jednu dva dvije dvoje tri četiri pet šest sedam osam devet deset jedanaest dvanaest trinaest četrnaest petnaest šesnaest sedamnaest osamnaest devetnaest dvadeset trideset četrdeset pedeset šezdeset sedamdeset osamdeset devedeset sto stotinu dvjesto tristo četiristo petsto šeststo sedamsto osamsto devetsto tisuća tisuće tisuću milijun milijuna prvi prva prvo drugi druga drugo treći treća treće').split(' '));
const negations = new Set(['no', 'not', 'never', 'neither', 'without', "don't", "doesn't", "didn't", "can't", "cannot", "won't", "isn't", "aren't", 'ne', 'nije', 'nisu', 'nisam', 'nismo', 'nemoj', 'nemojte', 'nikad', 'nikada', 'bez', 'neću', 'neće']);
export function scoreText(reference, output, protectedTerms = []) {
  if (typeof reference !== 'string' || typeof output !== 'string' || !reference.trim() || reference.length > MAX_TEXT || output.length > MAX_TEXT) throw new Error('Reference/output must be text of at most 2000 characters; reference cannot be empty.');
  const refWords = words(reference), outWords = words(output);
  if (!refWords.length) throw new Error('Reference needs at least one word or number.');
  const refChars = [...normalized(reference)], outChars = [...normalized(output)];
  const wordEdits = distance(refWords, outWords), charEdits = distance(refChars, outChars);
  const flags = [];
  const numbers = text => [...(text.match(/\d+(?:[.,:/-]\d+)*/g) || []), ...words(text).filter(word => numberWords.has(word))];
  if (JSON.stringify(counts(numbers(reference))) !== JSON.stringify(counts(numbers(output)))) flags.push('numbers changed');
  if (JSON.stringify(counts(refWords.filter(x => negations.has(x)))) !== JSON.stringify(counts(outWords.filter(x => negations.has(x))))) flags.push('negation changed');
  for (const term of protectedTerms) {
    const tokens = words(term);
    const count = text => words(text).reduce((total, _, index, source) => total + Number(tokens.every((token, offset) => source[index + offset] === token)), 0);
    if (normalized(term) && count(reference) !== count(output)) flags.push(`protected term changed: ${term}`);
  }
  return { wer: wordEdits / refWords.length, cer: charEdits / refChars.length, wordEdits, referenceWords: refWords.length, charEdits, referenceChars: refChars.length, flags };
}
export function resultId(row) {
  return createHash('sha256').update(JSON.stringify([row.clipId, row.referenceRevision, row.engine, row.cleanupModel, row.runLabel, row.output, row.elapsedMs])).digest('hex').slice(0, 24);
}
export function validateResults(input, corpus) {
  const rows = Array.isArray(input) ? input : input?.results;
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new Error('Import requires 1-500 result rows.');
  const seen = new Set();
  return rows.map(row => {
    const clip = corpus.find(item => item.id === row?.clipId);
    if (!clip?.approvedAt || row.referenceRevision !== clip.revision) throw new Error('Every result must name a human-approved clip and its current referenceRevision.');
    const short = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120;
    if (!short(row.engine) || !short(row.cleanupModel) || !short(row.runLabel) || typeof row.output !== 'string' || row.output.length > MAX_TEXT || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0 || row.elapsedMs > 86400000) throw new Error('Invalid result: engine, cleanupModel, runLabel, output and elapsedMs are required.');
    const clean = { clipId: clip.id, referenceRevision: clip.revision, engine: row.engine, cleanupModel: row.cleanupModel, runLabel: row.runLabel, output: row.output, elapsedMs: row.elapsedMs };
    const id = resultId(clean);
    if (seen.has(id)) throw new Error('Duplicate result row. Use distinct run labels for separate trials.');
    seen.add(id);
    return { ...clean, id, humanReview: 'pending', reviewNote: '' };
  });
}
/**
 * Score one row, reusing the answer when the same row is compared again.
 * scoreText runs two Levenshtein passes, the character one over texts of up to
 * 2000 characters — milliseconds each, but this runs on the same thread as the
 * tray and the dictation hotkey, once per saved row, every time the benchmark
 * data is read. With a few dozen rows that was a visible freeze; with a 500-row
 * import it was seconds. `cache` is owned by the corpus store, so two stores in
 * one process can never read each other's scores.
 */
function scoreRow(clip, row, cache) {
  if (!cache || !row.id) return scoreText(clip.reference, row.output, clip.protectedTerms);
  const key = `${row.id}|${clip.revision}`;
  let cached = cache.get(key);
  if (!cached) {
    cached = scoreText(clip.reference, row.output, clip.protectedTerms);
    if (cache.size >= 4000) cache.clear();
    cache.set(key, cached);
  }
  return cached;
}
export function compareResults(corpus, results, cache = null) {
  const groups = new Map(), details = [];
  const clips = new Map(corpus.map(item => [item.id, item]));
  for (const row of results) {
    const clip = clips.get(row.clipId);
    if (!clip?.approvedAt || clip.revision !== row.referenceRevision) continue;
    const score = scoreRow(clip, row, cache);
    const key = JSON.stringify([row.engine, row.cleanupModel, row.runLabel]);
    if (!groups.has(key)) groups.set(key, { engine: row.engine, cleanupModel: row.cleanupModel, runLabel: row.runLabel, clips: new Set(), count: 0, elapsedMs: 0, wordEdits: 0, referenceWords: 0, charEdits: 0, referenceChars: 0, flagged: 0, reviewed: 0, meaningChanged: 0 });
    const group = groups.get(key); group.count++; group.clips.add(clip.id); group.elapsedMs += row.elapsedMs;
    for (const field of ['wordEdits', 'referenceWords', 'charEdits', 'referenceChars']) group[field] += score[field];
    group.flagged += Number(score.flags.length > 0); group.reviewed += Number(['preserved', 'changed'].includes(row.humanReview)); group.meaningChanged += Number(row.humanReview === 'changed');
    details.push({ ...row, ...score, reference: clip.reference, translation: clip.translation, tags: clip.tags });
  }
  const coverages = [...groups.values()].map(group => JSON.stringify([...group.clips].sort()));
  const equalClipCoverage = new Set(coverages).size <= 1;
  return { equalClipCoverage, comparisonNote: equalClipCoverage ? 'Check repetition counts and timing conditions before comparing. No winner is selected.' : 'Unequal clip sets: aggregate scores do not support a fair ranking. No winner is selected.', groups: [...groups.values()].map(({ clips, ...g }) => ({ ...g, clipIds: [...clips].sort(), uniqueClips: clips.size, meanMs: g.elapsedMs / g.count, wer: g.wordEdits / g.referenceWords, cer: g.charEdits / g.referenceChars })), details };
}
