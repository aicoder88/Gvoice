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

// main.js snapshots `generation` when a transcript arrives and compares before
// it touches the pill, the saved foreground window, or done(). Those handlers
// run for seconds — long past the 500ms safety timer — so a press can legally
// start a new dictation underneath one, and everything shared belongs to the
// new press from that moment.
test("an accepted press bumps the generation; a refused one must NOT", () => {
  const s = new DictationSession({ log: quiet });
  const start = s.generation;
  s.tryStart();
  const mine = s.generation;
  assert.equal(mine, start + 1, "an accepted press is a new dictation");

  // The refused press is the dangerous case. If it bumped, the in-flight
  // handler would see a changed generation, skip done(), and leave busy stuck
  // true with the safety timer already cleared by finalize() — a deaf app.
  assert.equal(s.tryStart(), false);
  assert.equal(s.generation, mine, "a press that was ignored is not a dictation");
});

test("a press underneath an unfinished dictation changes the generation", async () => {
  const s = new DictationSession({ safetyTimeoutMs: 20, log: quiet });
  s.tryStart();
  const mine = s.generation;
  s.release();
  await sleep(50); // safety timer clears busy while the transcript is still in flight
  assert.equal(s.tryStart(), true, "the user can start a new dictation now");
  assert.notEqual(s.generation, mine, "the late transcript no longer owns the session");
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

test("owns() tells an overtaken press's event from the live one", async () => {
  const s = new DictationSession({ safetyTimeoutMs: 20, log: quiet });
  s.tryStart();
  const firstPress = s.id;
  assert.equal(s.owns(firstPress), true, "its own error still ends its own session");
  s.release();
  await sleep(50); // safety timer clears busy; the user presses again
  s.tryStart();
  assert.equal(s.owns(firstPress), false, "the old press must not kill the live one");
  assert.equal(s.isStale(firstPress), true, "isStale is the inverse of owns");
  assert.equal(s.owns(s.id), true, "the live press still owns the session");
  assert.equal(s.owns(undefined), true, "an unstamped event is never dropped");
  // The renderer reloads on the escalate-recovery path, resetting its stamp
  // while this session keeps its own name. Whatever it sends before the next
  // press must still get through — that path is when the user most needs the
  // message.
  assert.equal(s.owns(null), true, "a renderer that has not seen a press yet must not be muted");
  assert.equal(s.owns(""), true, "an empty stamp is 'never stamped', not stale");
});

test("every accepted press gets its own name, and no name is ever reused", () => {
  const s = new DictationSession({ log: quiet });
  const seen = new Set();
  assert.equal(s.id, null, "no name before the first press");
  for (let i = 0; i < 25; i += 1) {
    assert.equal(s.tryStart(), true);
    assert.equal(typeof s.id, "string");
    assert.match(/** @type {string} */ (s.id), /^\d+-[0-9a-f]{8}$/, "monotonic count plus a random suffix");
    assert.equal(seen.has(s.id), false, "a reused name would let an old press claim the live session");
    seen.add(s.id);
    s.done();
  }

  // A refused press must not mint a name: the in-flight handler would then see
  // a changed name, skip done(), and leave busy stuck true — a deaf app.
  s.tryStart();
  const mine = s.id;
  assert.equal(s.tryStart(), false);
  assert.equal(s.id, mine, "a press that was ignored is not a dictation");
});

test("done() keeps the name, so the batch rescue can still ask who owns the session", async () => {
  const s = new DictationSession({ safetyTimeoutMs: 20, log: quiet });
  s.tryStart();
  const mine = s.id;
  s.release();
  // The empty-transcript path re-opens the session BEFORE the slow batch
  // rescue, then keeps checking ownership for seconds afterwards.
  s.done();
  assert.equal(s.owns(mine), true, "re-opening the session does not orphan the press that is finishing");
  s.tryStart();
  assert.equal(s.owns(mine), false, "a real new press does");
});

// The delivery rule this whole id exists for: a transcript that arrives after a
// newer press must be parked in history, never pasted. This is the main.js
// dictation:transcript handler in miniature — same ownership question, same two
// outcomes.
test("start A, start B: A's transcript is parked, B's is pasted", async () => {
  const s = new DictationSession({ safetyTimeoutMs: 20, log: quiet });
  /** @type {string[]} */
  const pasted = [];
  /** @type {{ text: string, recovered: boolean }[]} */
  const history = [];

  // Stand-in for the handler: it snapshots the name the event carried, then
  // asks the session who owns it before touching anything shared.
  const deliver = (/** @type {string | null} */ sessionId, /** @type {string} */ text) => {
    const mine = s.owns(sessionId);
    if (!mine) {
      history.push({ text, recovered: true });
      return;
    }
    pasted.push(text);
    history.push({ text, recovered: false });
  };

  s.tryStart();
  const a = s.id;
  s.release();
  await sleep(50); // A's answer is still out; the safety timer re-opens the session
  s.tryStart();
  const b = s.id;
  assert.notEqual(a, b);

  deliver(a, "hello from A");
  assert.deepEqual(pasted, [], "A's late transcript must never reach the cursor");
  assert.deepEqual(history, [{ text: "hello from A", recovered: true }]);

  s.release();
  deliver(b, "hello from B");
  assert.deepEqual(pasted, ["hello from B"], "the live press still pastes");
  assert.equal(history[1].recovered, false);
});

test("an unstamped transcript is treated as the live press, not dropped", () => {
  const s = new DictationSession({ log: quiet });
  s.tryStart();
  // What main.js does on entry: pin the event's own name, or the live one when
  // the renderer reloaded and lost its stamp.
  const sessionOf = (/** @type {unknown} */ id) =>
    typeof id === "string" && id.length > 0 ? id : s.id;
  assert.equal(s.owns(sessionOf(null)), true);
  assert.equal(s.owns(sessionOf("")), true);
  assert.equal(s.owns(sessionOf(undefined)), true);
});

// ---------------------------------------------------------------------------
// The state machine: idle -> recording -> processing -> (completed | cancelled
// | failed) -> idle. One transition function, one table, and no path that can
// leave the session refusing every press forever.
// ---------------------------------------------------------------------------

const ALL_STATES = ["idle", "recording", "processing", "completed", "cancelled", "failed"];
// The same table src/dictation-session.js keeps, written out by hand so a
// change to it has to be a deliberate change to this test too.
const LEGAL = {
  idle: ["recording"],
  recording: ["processing", "completed", "cancelled", "failed"],
  processing: ["completed", "cancelled", "failed"],
  completed: ["idle"],
  cancelled: ["idle"],
  failed: ["idle"]
};

test("every legal transition is taken, and every illegal one is refused and logged", () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      /** @type {string[]} */
      const logged = [];
      const s = new DictationSession({ log: (/** @type {unknown} */ m) => logged.push(String(m)) });
      s.state = from;
      const legal = LEGAL[from].includes(to);
      assert.equal(s._transition(to), legal, `${from} -> ${to} should be ${legal ? "legal" : "refused"}`);
      assert.equal(s.state, legal ? to : from, `a refused transition must not move the session`);
      if (legal) {
        assert.deepEqual(logged, [], `${from} -> ${to} is legal and must not log`);
      } else {
        assert.equal(logged.length, 1, `${from} -> ${to} must say so in the log`);
        assert.match(logged[0], /illegal transition/);
      }
    }
  }
});

test("the public methods walk the states in order", () => {
  const s = new DictationSession({ safetyTimeoutMs: 1000, log: quiet });
  assert.equal(s.state, "idle", "a fresh session is idle");
  s.tryStart();
  assert.equal(s.state, "recording");
  assert.equal(s.busy, true, "busy is derived from the state, never stored beside it");
  s.release();
  assert.equal(s.state, "processing");
  assert.equal(s.busy, true, "still busy while the words are out");
  s.done();
  assert.equal(s.state, "idle", "a finished press leaves the session open for the next one");
  assert.equal(s.busy, false);
});

test("a press that errors before release still ends the session", () => {
  const s = new DictationSession({ log: quiet });
  s.tryStart();
  assert.equal(s.state, "recording");
  s.fail();
  assert.equal(s.state, "idle");
  assert.equal(s.tryStart(), true, "the next press is heard");
});

test("a transcript that arrives with no release still completes the press", () => {
  const s = new DictationSession({ log: quiet });
  s.tryStart();
  assert.equal(s.done(), true, "recording -> completed is legal on purpose");
  assert.equal(s.state, "idle", "otherwise the session records forever and goes deaf");
});

test("stop twice is a no-op: no restamp, no second timer, no complaint", async () => {
  /** @type {string[]} */
  const logged = [];
  const s = new DictationSession({ safetyTimeoutMs: 1000, log: (m) => logged.push(String(m)) });
  s.tryStart();
  assert.equal(s.release(), true);
  const firstStamp = s.releaseAt;
  await sleep(20);
  assert.equal(s.release(), false, "the max-hold watchdog racing a real key-up must change nothing");
  assert.equal(s.releaseAt, firstStamp, "the second stop must not restamp the release time");
  assert.equal(s.state, "processing");
  assert.deepEqual(logged, [], "a duplicate stop is expected, not an error");
});

test("done twice is a no-op", () => {
  /** @type {string[]} */
  const logged = [];
  const s = new DictationSession({ log: (m) => logged.push(String(m)) });
  s.tryStart();
  s.release();
  assert.equal(s.done(), true);
  assert.equal(s.done(), false, "the rescue path's early done() plus the finally's done()");
  assert.equal(s.state, "idle");
  assert.deepEqual(logged, [], "the second one is by design and must not log");
});

test("the safety timer ends the press as failed, not with a bare flag flip", async () => {
  const s = new DictationSession({ safetyTimeoutMs: 20, log: quiet });
  s.tryStart();
  const mine = s.id;
  s.release();
  await sleep(50);
  assert.equal(s.state, "idle", "the press is over and the session is open again");
  assert.equal(s.busy, false);
  // It timed out; it was not cancelled. A transcript that finally shows up
  // still belongs to the user and still gets delivered.
  assert.equal(s.owns(mine), true);
  assert.equal(s.canDeliver(mine), true, "a slow transcript is late, not unwanted");
});

test("cancel from recording, and from processing, both end the press", () => {
  const fromRecording = new DictationSession({ log: quiet });
  fromRecording.tryStart();
  assert.equal(fromRecording.cancel("escape"), true);
  assert.equal(fromRecording.state, "idle");

  const fromProcessing = new DictationSession({ safetyTimeoutMs: 1000, log: quiet });
  fromProcessing.tryStart();
  fromProcessing.release();
  assert.equal(fromProcessing.cancel("pill click"), true);
  assert.equal(fromProcessing.state, "idle");
});

test("cancel is idempotent, and cancelling nothing changes nothing", () => {
  const s = new DictationSession({ log: quiet });
  assert.equal(s.cancel(), false, "no press to cancel");
  assert.equal(s.state, "idle");
  s.tryStart();
  assert.equal(s.cancel(), true);
  assert.equal(s.cancel(), false, "a second Escape must not cancel the next press");
  assert.equal(s.tryStart(), true, "and the next press still starts");
  assert.equal(s.state, "recording", "the new press is live, not cancelled");
});

test("a cancelled press can never deliver, however late its words arrive", async () => {
  const s = new DictationSession({ safetyTimeoutMs: 1000, log: quiet });
  s.tryStart();
  const mine = s.id;
  s.release();
  s.cancel("escape");
  await sleep(20); // cleanup, the batch rescue, a slow paste — seconds in real life
  assert.equal(s.owns(mine), true, "no newer press has taken the session");
  assert.equal(s.wasCancelled(mine), true);
  assert.equal(s.canDeliver(mine), false, "cancel means cancel");
});

test("cancel frees the mic for the very next press, and that one delivers", () => {
  const s = new DictationSession({ safetyTimeoutMs: 1000, log: quiet });
  s.tryStart();
  const cancelled = s.id;
  s.cancel();
  assert.equal(s.tryStart(), true, "Escape must not cost the user their next press");
  const live = s.id;
  assert.equal(s.canDeliver(live), true);
  assert.equal(s.canDeliver(cancelled), false);
});

test("the cancelled list stays small", () => {
  const s = new DictationSession({ log: quiet });
  const first = [];
  for (let i = 0; i < 40; i += 1) {
    s.tryStart();
    first.push(s.id);
    s.cancel();
  }
  assert.ok(s._cancelled.length <= 20, `expected at most 20 remembered, got ${s._cancelled.length}`);
  assert.equal(s.wasCancelled(first[39]), true, "the recent ones are what matter");
});

// The delivery rule cancel exists for, as the main.js dictation:transcript
// handler in miniature: the user hits Escape while the words are still out, the
// transcript lands afterwards, nothing is pasted and the entry says why.
test("cancel during cleanup: the transcript is parked as cancelled, never pasted", async () => {
  const s = new DictationSession({ safetyTimeoutMs: 1000, log: quiet });
  /** @type {string[]} */
  const pasted = [];
  /** @type {{ text: string, cancelled: boolean, recovered: boolean }[]} */
  const history = [];

  const deliver = (/** @type {string | null} */ sessionId, /** @type {string} */ text) => {
    if (s.wasCancelled(sessionId)) {
      history.push({ text, cancelled: true, recovered: false });
      return;
    }
    if (!s.owns(sessionId)) {
      history.push({ text, cancelled: false, recovered: true });
      return;
    }
    pasted.push(text);
    history.push({ text, cancelled: false, recovered: false });
  };

  s.tryStart();
  const a = s.id;
  s.release();
  s.cancel("escape during cleanup");
  await sleep(20);
  deliver(a, "words the user gave up on");
  assert.deepEqual(pasted, [], "a cancelled press must never reach the cursor");
  assert.deepEqual(history, [{ text: "words the user gave up on", cancelled: true, recovered: false }]);

  // The next press is unaffected: it pastes like any other.
  s.tryStart();
  const b = s.id;
  s.release();
  deliver(b, "the next thing they said");
  assert.deepEqual(pasted, ["the next thing they said"]);
  assert.equal(history[1].cancelled, false);
});

// The paste window: done() runs the moment the words arrive so the next press
// isn't kept waiting, and cleanup plus the paste then run for another second or
// two with the session idle. The pill still offers "click to cancel" for all of
// it, and this is what makes that click mean something.
test("a press can still be cancelled after the session has let go of it", () => {
  const s = new DictationSession({ log: quiet });
  s.tryStart();
  const mine = s.id;
  s.release();
  s.done();
  assert.equal(s.busy, false, "the session is free for the next press");
  assert.equal(s.cancel("escape"), false, "cancel() has nothing live to end");
  assert.equal(s.markCancelled(mine), true);
  assert.equal(s.wasCancelled(mine), true);
  assert.equal(s.canDeliver(mine), false, "so the paste is dropped");
  assert.equal(s.markCancelled(mine), true, "asking twice is fine");
  assert.equal(s._cancelled.filter((id) => id === mine).length, 1, "and remembers it once");
});

test("marking nothing cancelled changes nothing, so a stray Escape stays free", () => {
  const s = new DictationSession({ log: quiet });
  s.tryStart();
  const live = s.id;
  assert.equal(s.markCancelled(null), false);
  assert.equal(s.markCancelled(""), false);
  assert.equal(s.markCancelled(undefined), false);
  assert.equal(s.canDeliver(live), true, "the live press is untouched");
});

test("an unstamped event follows the live press's cancellation", () => {
  const s = new DictationSession({ log: quiet });
  s.tryStart();
  assert.equal(s.wasCancelled(null), false, "nothing cancelled yet");
  s.cancel();
  // The renderer reloaded and lost its stamp. The live press is the cancelled
  // one, so its words are still not wanted.
  assert.equal(s.wasCancelled(null), true);
  assert.equal(s.canDeliver(""), false);
  s.tryStart();
  assert.equal(s.wasCancelled(undefined), false, "a fresh press starts clean");
});
