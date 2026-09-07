import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DictationSession } from '../../src/dictation-session.js';
import { createClipboardLease, RESTORE_DELAY_MS, VERIFY_HOLD_MS } from '../../src/clipboard-lease.js';
import { LatencyTracker, summarizeLatency } from '../../src/latency.js';

test('one terminal claimant per generation, stale claim cannot become current', () => {
  const s = new DictationSession(); s.tryStart(); const first = s.generation;
  assert.equal(s.claimTerminal(first), true);
  assert.equal(s.claimTerminal(first), false);
  s.fail(); s.tryStart();
  assert.equal(s.isStale(first), true);
  assert.equal(s.claimTerminal(first), false);
  assert.equal(s.claimTerminal(s.generation + 1), false);
  assert.equal(s.busy, true); s.fail();
});
test('release is idempotent and does not extend the completion budget', () => {
  const s = new DictationSession(); s.tryStart(); assert.equal(s.release(), true);
  const releaseAt = s.releaseAt;
  assert.equal(s.release(), false); assert.equal(s.releaseAt, releaseAt); s.fail();
});
function fakeClipboard() {
  let text = 'original';
  return { readText: () => text, writeText: t => { text = t; },
    availableFormats: () => ['text/plain'], readImage: () => ({isEmpty: () => true}) };
}
test('delayed restoration preserves newer user copy', () => {
  const c = fakeClipboard(); let restore;
  createClipboardLease(c, 'dictation', { schedule: fn => {restore = fn;}, cancel: () => {} });
  c.writeText('user copied this'); restore(); assert.equal(c.readText(), 'user copied this');
});
test('kept recovery text is never replaced by stale restore', () => {
  const c = fakeClipboard(); let restore;
  const lease = createClipboardLease(c, 'dictation', { schedule: fn => {restore = fn;}, cancel: () => {} });
  lease.keep(); restore(); assert.equal(c.readText(), 'dictation');
});
test('a file-only clipboard is cleared, never left holding the dictation', () => {
  // The user had files (or rich content) on the clipboard: no text, and formats
  // we cannot rebuild. Writing our dictation already destroyed them, so there
  // is nothing to hand back — but leaving GVoice's text sitting there forever
  // is worse than an empty clipboard.
  let text = '', formats = ['public.file-url'];
  const c = { readText: () => text, writeText: t => { text = t; formats = ['public.utf8-plain-text']; },
    availableFormats: () => formats, readImage: () => ({ isEmpty: () => true }) };
  let restore;
  createClipboardLease(c, 'dictation', { schedule: fn => { restore = fn; }, cancel: () => {} });
  assert.equal(c.readText(), 'dictation');
  restore();
  assert.equal(c.readText(), '');
});

function fakeTimers() {
  const timers = []; let seq = 0;
  return { timers,
    schedule: (fn, ms) => { const id = ++seq; timers.push({ id, fn, ms }); return id; },
    cancel: id => { const at = timers.findIndex(t => t.id === id); if (at >= 0) timers.splice(at, 1); } };
}
test('a slow paste check cannot let the restore win the race', () => {
  const c = fakeClipboard(); const clock = fakeTimers();
  const lease = createClipboardLease(c, 'dictation', { schedule: clock.schedule, cancel: clock.cancel, defer: true });
  lease.armRestore();
  assert.equal(clock.timers.at(-1).ms, RESTORE_DELAY_MS);
  // main.js holds the clipboard while it checks whether the paste landed. The
  // hold replaces the pending restore rather than racing it.
  lease.armRestore(VERIFY_HOLD_MS);
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, VERIFY_HOLD_MS);
  // A check that took 400ms — well past the old 250ms window — still keeps the
  // dictation on the clipboard for ⌘V.
  assert.equal(lease.keep(), true);
  assert.equal(c.readText(), 'dictation');
});
test('a landed paste hands the clipboard back on the original schedule', () => {
  const c = fakeClipboard(); const clock = fakeTimers();
  const lease = createClipboardLease(c, 'dictation', { schedule: clock.schedule, cancel: clock.cancel, defer: true });
  lease.armRestore(VERIFY_HOLD_MS);
  lease.armRestore(RESTORE_DELAY_MS - 170); // 170ms of the window already spent
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, 80);
  clock.timers[0].fn();
  assert.equal(c.readText(), 'original');
});
test('a check that outran the whole window restores immediately, never at a negative delay', () => {
  const c = fakeClipboard(); const clock = fakeTimers();
  const lease = createClipboardLease(c, 'dictation', { schedule: clock.schedule, cancel: clock.cancel, defer: true });
  lease.armRestore(-500);
  assert.equal(clock.timers[0].ms, 0);
});
test('superseded clipboard lease cannot undo next paste', () => {
  const c = fakeClipboard(); const old = createClipboardLease(c, 'first', { defer: true });
  old.restore(); const next = createClipboardLease(c, 'second', { defer: true });
  old.restore(); assert.equal(c.readText(), 'second'); next.restore(); assert.equal(c.readText(), 'original');
});
test('latency stages measure release, exclude failed deliveries and stay bounded', () => {
  let now = 0; const t = new LatencyTracker({now: () => now, limit: 2});
  t.start(1, 'local'); t.mark(1, 'captureReady', {capture:'cold'});
  now=100; t.mark(1, 'released'); now=550; t.mark(1, 'committed');
  now=700; t.mark(1, 'transcript'); t.mark(1, 'cleanupStart');
  now=750; t.mark(1, 'cleanupEnd'); t.mark(1, 'pasteStart');
  now=800; t.mark(1, 'pasteEnd'); const sample=t.finish(1, 'pasted');
  assert.equal(sample.releaseToPasteMs, 700); assert.equal(sample.tailMs, 450);
  assert.equal(sample.transcriptionMs, 150); assert.equal(sample.cleanupMs, 50);
  assert.equal(t.finish(1,'pasted'), undefined);
  const summary=summarizeLatency([sample, {...sample, releaseToPasteMs:900, outcome:'failed'}])[0];
  assert.equal(summary.releaseToPasteMs.median, 700); assert.equal(summary.attempts,2);
  assert.equal(summary.delivered,1); assert.equal(summary.releaseToPasteMs.count,1);
});
