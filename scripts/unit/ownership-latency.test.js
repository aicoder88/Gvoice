import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DictationSession } from '../../src/dictation-session.js';
import { createClipboardLease } from '../../src/clipboard-lease.js';
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
