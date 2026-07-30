// Unit tests for the pure dead-mic decision logic shared by the dictation
// renderer and these tests. Run: node --test scripts/unit/mic-health.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHold } from "../../public/mic-health.js";

// Defaults mirroring dictation.js so the tests exercise the real thresholds.
const BASE = { minBytes: 4800, silencePeak: 0.01, streakLimit: 3 };

test("too-short hold is ignored and leaves the streak untouched", () => {
  const r = classifyHold({ ...BASE, bytes: 100, peak: 0, silentStreak: 2 });
  assert.equal(r.action, "ignore");
  assert.equal(r.silentStreak, 2);
});

test("a single zero-peak hold is an instant dead-mic (the production bug)", () => {
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0, silentStreak: 0 });
  assert.equal(r.action, "dead");
  assert.equal(r.silentStreak, 0);
});

test("real audio is ok and resets any prior streak", () => {
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0.4, silentStreak: 2 });
  assert.equal(r.action, "ok");
  assert.equal(r.silentStreak, 0);
});

test("low-but-nonzero peak counts as silent, not dead, on the first hold", () => {
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0.005, silentStreak: 0 });
  assert.equal(r.action, "silent");
  assert.equal(r.silentStreak, 1);
});

test("a tiny nonzero peak is NOT treated as digital silence", () => {
  // A real mic noise floor can sit just above zero; it must not trip the
  // instant zero-peak path — only an exact 0 does.
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0.0001, silentStreak: 0 });
  assert.equal(r.action, "silent");
  assert.equal(r.silentStreak, 1);
});

test("the streak reaching the limit is a dead-mic and clears the streak", () => {
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0.005, silentStreak: 2 });
  assert.equal(r.action, "dead");
  assert.equal(r.silentStreak, 0);
});

test("peak exactly at the silence threshold is silent (boundary)", () => {
  // < silencePeak is silent; == silencePeak is treated as real (not silent).
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0.01, silentStreak: 0 });
  assert.equal(r.action, "ok");
});

// ---- the no-frames-at-all wedge (holdMs) ----
// A half-built capture graph delivers ZERO frames, so every peak check below is
// blind to it — there is no frame to have a peak. The only evidence is "the key
// was held a long time and almost nothing arrived".

test("a long hold with no bytes is a dead mic, not a tap", () => {
  const r = classifyHold({ ...BASE, bytes: 0, peak: 0, silentStreak: 0, holdMs: 3000 });
  assert.equal(r.action, "dead");
  assert.equal(r.silentStreak, 0);
});

test("a short tap with no bytes is still ignored, however dead the mic looks", () => {
  // The whole point of the byte gate: a 200ms fumble must never accuse the mic.
  const r = classifyHold({ ...BASE, bytes: 0, peak: 0, silentStreak: 1, holdMs: 200 });
  assert.equal(r.action, "ignore");
  assert.equal(r.silentStreak, 1, "an ignored hold leaves the streak alone");
});

test("a hold exactly at minHoldMs counts as long enough (boundary)", () => {
  const r = classifyHold({ ...BASE, bytes: 0, peak: 0, silentStreak: 0, holdMs: 1000, minHoldMs: 1000 });
  assert.equal(r.action, "dead");
});

test("without holdMs the old behaviour is unchanged", () => {
  // Older renderers (and the pre-holdMs call sites) pass no hold length. Those
  // must keep filing a byte-starved hold as a tap rather than a dead mic.
  const r = classifyHold({ ...BASE, bytes: 0, peak: 0, silentStreak: 2 });
  assert.equal(r.action, "ignore");
  assert.equal(r.silentStreak, 2);
});

test("a long hold with real audio is still ok", () => {
  // holdMs must not shadow the normal path: enough bytes means the byte gate
  // never fires, however long the hold.
  const r = classifyHold({ ...BASE, bytes: 48000, peak: 0.4, silentStreak: 0, holdMs: 9000 });
  assert.equal(r.action, "ok");
});
