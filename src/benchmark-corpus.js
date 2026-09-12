import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, copyFileSync, statSync, lstatSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TAGS, MAX_TEXT, validateResults, compareResults, words } from './benchmark-evaluate.js';

export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.webm']);
export function atomicJson(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function createCorpusStore(directory) {
  mkdirSync(join(directory, 'audio'), { recursive: true, mode: 0o700 });
  const manifest = join(directory, 'corpus.json');
  let state = { version: 1, clips: [], results: [] };
  if (existsSync(manifest)) {
    if (statSync(manifest).size > 8 * MAX_JSON_BYTES) throw new Error('Benchmark corpus is too large.');
    state = JSON.parse(readFileSync(manifest, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.clips) || !Array.isArray(state.results)) throw new Error('Unsupported benchmark corpus.');
  }
  let committed = structuredClone(state);
  // Scores for rows already compared, keyed by row id and clip revision. Owned
  // by this store so a second store in the same process never reads them.
  const scoreCache = new Map();
  const save = () => {
    try { atomicJson(manifest, state); committed = structuredClone(state); }
    catch (error) { state = structuredClone(committed); throw error; }
  };
  const clipFor = id => { const clip = state.clips.find(x => x.id === id); if (!clip) throw new Error('Unknown clip.'); return clip; };
  const audioPath = id => {
    const clip = clipFor(id);
    if (!/^[a-f0-9-]+\.(wav|mp3|m4a|ogg|webm)$/.test(clip.audioFile)) throw new Error('Invalid stored audio filename.');
    const path = join(directory, 'audio', clip.audioFile);
    if (lstatSync(path).isSymbolicLink()) throw new Error('Audio links are not allowed.');
    return path;
  };
  return {
    snapshot: () => ({ ...structuredClone(state), tags: TAGS, comparison: compareResults(state.clips, state.results, scoreCache) }),
    importAudio(path, consent) {
      if (consent !== true) throw new Error('Explicit per-file consent is required.');
      if (state.clips.length >= 100) throw new Error('Corpus limit is 100 clips.');
      const ext = extname(path).toLowerCase(), size = statSync(path).size;
      if (!EXTENSIONS.has(ext) || !statSync(path).isFile() || size === 0 || size > MAX_AUDIO_BYTES) throw new Error('Choose a supported audio file between 1 byte and 20 MB.');
      const id = randomUUID(), audioFile = `${id}${ext}`;
      copyFileSync(path, join(directory, 'audio', audioFile));
      const clip = { id, audioFile, name: basename(path).slice(0, 180), consentAt: new Date().toISOString(), reference: '', translation: '', tags: [], protectedTerms: [], revision: 1, approvedAt: null };
      state.clips.push(clip);
      try { save(); } catch (error) { unlinkSync(join(directory, 'audio', audioFile)); throw error; }
      return clip;
    },
    update(id, patch) {
      const clip = clipFor(id);
      if (!patch || typeof patch.reference !== 'string' || patch.reference.length > MAX_TEXT || typeof patch.translation !== 'string' || patch.translation.length > MAX_TEXT || !Array.isArray(patch.tags) || patch.tags.some(t => !TAGS.includes(t)) || !Array.isArray(patch.protectedTerms) || patch.protectedTerms.length > 30 || patch.protectedTerms.some(t => typeof t !== 'string' || !t.trim() || t.length > 80)) throw new Error('Invalid reference, tags or protected terms.');
      Object.assign(clip, { reference: patch.reference, translation: patch.translation, tags: [...new Set(patch.tags)], protectedTerms: [...new Set(patch.protectedTerms)], approvedAt: null, revision: clip.revision + 1 });
      state.results = state.results.filter(r => r.clipId !== id); save(); return clip;
    },
    approve(id, revision, humanConfirmed) {
      const clip = clipFor(id);
      if (humanConfirmed !== true || revision !== clip.revision || !words(clip.reference).length || !clip.tags.length) throw new Error('Listen, enter a reference and tags, then explicitly approve the current revision.');
      clip.approvedAt = new Date().toISOString(); save();
    },
    importResults(data) {
      const rows = validateResults(data, state.clips);
      const keys = new Set(rows.map(r => r.id));
      const next = [...state.results.filter(r => !keys.has(r.id)), ...rows];
      if (next.length > 1000) throw new Error('Saved results limit is 1000 rows.');
      state.results = next; save();
    },
    review(id, verdict, note) {
      const result = state.results.find(r => r.id === id);
      if (!result || !['pending', 'preserved', 'changed'].includes(verdict) || typeof note !== 'string' || note.length > MAX_TEXT) throw new Error('Invalid human review.');
      result.humanReview = verdict; result.reviewNote = note; result.reviewedAt = verdict === 'pending' ? null : new Date().toISOString(); save();
    },
    remove(id) {
      clipFor(id); // still throws for an unknown clip
      // A clip whose audio file was deleted by hand, or whose name no longer
      // passes the safety checks, must still be removable: audioPath() throws in
      // both cases, and letting that through stranded the clip and its scores in
      // the list forever. Drop the record either way; only delete a file we could
      // safely resolve.
      let path = null;
      try { path = audioPath(id); } catch (error) { console.error('[benchmark] audio file not removable:', error.message); }
      state.clips = state.clips.filter(c => c.id !== id); state.results = state.results.filter(r => r.clipId !== id); save();
      if (path && existsSync(path)) unlinkSync(path);
    },
    audioPath,
    audio(id) {
      const path = audioPath(id);
      if (statSync(path).size > MAX_AUDIO_BYTES) throw new Error('Audio exceeds limit.');
      const mime = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.webm': 'audio/webm' }[extname(path)];
      return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
    },
  };
}
