// Unit tests for the push-to-talk session state machine (src/dictation-session.js).
// Run: node --test scripts/unit/dictation-session.test.js
//
// The module is pure state + one timer, and the timeout is injectable, so the
// whole lifecycle is testable without Electron.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { DictationSession } from "../../src/dictation-session.js";

// Silent logger: these tests exercise the ignored-press and safety-timeout
// paths, which both log by design.
const quiet = () => {};

test("a second press is refused while the first dictation is still processing", () => {
  const s = new DictationSession({ log: quiet });
  assert.equal(s.tryStart(), true);
  assert.equal(s.tryStart(), false, "second press must be ignored, not queued");
  s.done();
  assert.equal(s.tryStart(), true, "done() re-opens the session");
});

test("release before any press does nothing", () => {
  const s = new DictationSession({ log: quiet });
  assert.equal(s.release(), false);
  assert.equal(s.releaseAt, null, "no stamp from a release that never happened");
});

test("the safety timer clears busy when no transcript ever arrives", async () => {
  const s = new DictationSession({ safetyTimeoutMs: 20, log: quiet });
  s.tryStart();
  s.release();
  assert.equal(s.busy, true, "still busy right after release");
  await sleep(50);
  assert.equal(s.busy, false, "a missing transcript must not jam the session forever");
  assert.equal(s.tryStart(), true);
});

test("finalize stops the safety timer, so it can't clear a later press", async () => {
  const s = new DictationSession({ safetyTimeoutMs: 20, log: quiet });
  s.tryStart();
  s.release();
  s.finalize();
  s.done();
  s.tryStart(); // the NEXT dictation
  await sleep(50);
  assert.equal(s.busy, true, "the previous session's timer must not touch this press");
});

test("finalize reports timing from THIS session, not the previous one", async () => {
  const s = new DictationSession({ safetyTimeoutMs: 1000, log: quiet });
  s.tryStart();
  s.release();
  const first = s.finalize();
  assert.ok(first.releaseAt > 0);
  s.done();

  // Second dictation errors out before the key is ever released. Without the
  // releaseAt reset in tryStart(), sinceRelease would be measured from the
  // FIRST dictation and report a wildly inflated delay.
  await sleep(30);
  s.tryStart();
  const second = s.finalize();
  assert.ok(
    second.releaseAt >= first.releaseAt + 25,
    "an un-released session stamps now, not the last release"
  );
  assert.ok(second.sinceRelease < 25, `expected ~0ms, got ${second.sinceRelease}ms`);
});

test("fail() finalizes and re-opens in one step", async () => {
  const s = new DictationSession({ safetyTimeoutMs: 20, log: quiet });
  s.tryStart();
  s.release();
  s.fail();
  assert.equal(s.busy, false);
  assert.equal(s.tryStart(), true, "error path re-opens the session");
  await sleep(50);
  assert.equal(s.busy, true, "fail() also killed the old safety timer");
});
