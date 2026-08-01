// The flush-timing math behind "words go missing on a slow connect".
//
// Deepgram's Finalize flushes what it has ALREADY heard and discards the rest,
// so the relay must not ask for it while audio is still queued upstream. These
// cases are the ones that were wrong in the field on 2026-08-01.
import test from "node:test";
import assert from "node:assert/strict";
import { unheardMs } from "../../src/providers/deepgram.js";

test("nothing has reached the engine yet: no wait to compute", () => {
  assert.equal(unheardMs({ audioMs: 9000, streamStartedAt: 0, processedMs: 0, now: 1000 }), 0);
});

test("healthy press: audio streamed in real time, engine keeping up", () => {
  // 9.5s of speech, sent over 9.5s of wall clock, engine reports 9.4s heard.
  const wait = unheardMs({ audioMs: 9500, streamStartedAt: 1000, processedMs: 9400, now: 10500 });
  assert.ok(wait <= 100, `expected a negligible wait, got ${wait}`);
});

test("slow connect: the whole hold is dumped at once and must be waited out", () => {
  // 6s of speech queued during the handshake, handed over the instant it opened.
  // The engine has said nothing yet, so the wall clock is the only reading.
  assert.equal(unheardMs({ audioMs: 6000, streamStartedAt: 10000, processedMs: 0, now: 10000 }), 6000);
});

test("engine catching up faster than real time shortens the wait", () => {
  // Wall clock says 5s of backlog; Deepgram says it has already heard all but
  // 800ms of it. Trust the engine — waiting the full 5s would just stall the
  // paste.
  assert.equal(unheardMs({ audioMs: 9000, streamStartedAt: 1000, processedMs: 8200, now: 5000 }), 800);
});

test("silent hold: engine stops reporting, wall clock keeps the wait honest", () => {
  // No Results frames at all (processedMs never moves), but the audio was
  // streamed in real time — this must NOT read as a 9s backlog.
  assert.equal(unheardMs({ audioMs: 9000, streamStartedAt: 1000, processedMs: 0, now: 10000 }), 0);
});

test("auto-language: the slow leg is the one that decides the wait", () => {
  // Two legs on the same audio (hr + en). One opened at once and is caught up;
  // the other opened 8s late and is still holding the whole hold. The relay
  // takes the max — Finalizing on the fast leg's reading would flush the slow
  // leg right on top of its backlog, which is the bug this file is about.
  const now = 10000;
  const audioMs = 9500;
  const fast = unheardMs({ audioMs, streamStartedAt: 1000, processedMs: 9000, now });
  const slow = unheardMs({ audioMs, streamStartedAt: 9000, processedMs: 0, now });
  assert.equal(fast, 500);
  assert.equal(slow, 8500);
  assert.equal(Math.max(fast, slow), 8500);
});

test("never negative", () => {
  assert.equal(unheardMs({ audioMs: 1000, streamStartedAt: 1000, processedMs: 5000, now: 9000 }), 0);
});
