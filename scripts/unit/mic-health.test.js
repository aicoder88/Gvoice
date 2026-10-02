// Unit tests for the pure dead-mic decision logic shared by the dictation
// renderer and these tests. Run: node --test scripts/unit/mic-health.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHold, idleMsForMode, MIC_IDLE_BY_MODE, chooseCaptureDevice, resolvePreferredMicId } from "../../public/mic-health.js";

test("a saved microphone reconnects by its unique label when origin IDs change", () => {
  assert.equal(resolvePreferredMicId("old-port-id", "Anker", [
    { id: "new-port-id", label: "Anker" }, { id: "built-in", label: "Built-in" }
  ]), "new-port-id");
});

test("a present device ID takes precedence over a changed label", () => {
  assert.equal(resolvePreferredMicId("saved", "Anker", [
    { id: "saved", label: "Renamed microphone" }, { id: "other", label: "Anker" }
  ]), "saved");
});

test("missing, ambiguous and anonymous inputs never replace a saved microphone", () => {
  for (const devices of [[], [{ id: "new", label: "" }],
    [{ id: "one", label: "Anker" }, { id: "two", label: "Anker" }],
    [{ id: "default", label: "Anker" }, { id: "communications", label: "Anker" }]]) {
    assert.equal(resolvePreferredMicId("saved", "Anker", devices), "saved");
  }
  assert.equal(resolvePreferredMicId("", "Anker", [{ id: "new", label: "Anker" }]), "");
  assert.equal(resolvePreferredMicId("saved", "", [{ id: "new", label: "" }]), "saved");
});

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

// ---- why a hold is dead --------------------------------------------------
// Three very different problems used to arrive as one verdict, so the renderer
// answered all three the same way: hunt for another microphone, and ask main to
// reload the window if that fails. Quiet speech does not deserve either.

test("digital silence and a no-frames wedge are named apart from quiet speech", () => {
  assert.equal(classifyHold({ ...BASE, bytes: 48000, peak: 0, silentStreak: 0 }).cause, "silence");
  assert.equal(classifyHold({ ...BASE, bytes: 0, peak: 0, silentStreak: 0, holdMs: 3000 }).cause, "no-frames");
  assert.equal(classifyHold({ ...BASE, bytes: 48000, peak: 0.005, silentStreak: 2 }).cause, "quiet");
});

test("a hold that is fine carries no cause", () => {
  assert.equal(classifyHold({ ...BASE, bytes: 48000, peak: 0.4, silentStreak: 0 }).cause, "");
  assert.equal(classifyHold({ ...BASE, bytes: 48000, peak: 0.005, silentStreak: 0 }).cause, "");
  assert.equal(classifyHold({ ...BASE, bytes: 100, peak: 0, silentStreak: 0 }).cause, "");
});

// ---- the three microphone modes -----------------------------------------
// "Always ready" keeps the capture graph alive so the pre-roll ring already
// holds the half-second before the key went down. "Balanced" is the old fixed
// two minutes. "Hold" builds per press and drops on release.

test("always ready never drops the microphone", () => {
  assert.equal(idleMsForMode("always"), Infinity);
  assert.equal(MIC_IDLE_BY_MODE.always, Infinity);
});

test("balanced keeps the old two minutes", () => {
  assert.equal(idleMsForMode("balanced"), 120000);
});

test("hold-only closes the microphone the moment the key comes up", () => {
  assert.equal(idleMsForMode("hold"), 0);
});

test("an unknown or missing mode is always-ready, never cold", () => {
  // Guessing "cold" would clip the first word of every dictation after a launch
  // where the saved mode could not be read.
  assert.equal(idleMsForMode("banana"), Infinity);
  assert.equal(idleMsForMode(""), Infinity);
  assert.equal(idleMsForMode(undefined), Infinity);
  assert.equal(idleMsForMode(null), Infinity);
  assert.equal(idleMsForMode(7), Infinity);
});

test("the mode name is read case-insensitively", () => {
  assert.equal(idleMsForMode("Balanced"), 120000);
  assert.equal(idleMsForMode("HOLD"), 0);
});

// ---- preferred microphone: fall back, then come back --------------------
const ANKER = "anker-1234";
const BUILTIN = "builtin-5678";

test("no preference means the system default and nothing to return to", () => {
  const r = chooseCaptureDevice({ preferredId: "", fallbackId: null, availableIds: [BUILTIN], captureReady: false });
  assert.equal(r.deviceId, null);
  assert.equal(r.source, "default");
  assert.equal(r.rebuild, true, "nothing is live yet, so something must be built");
});

test("with no preference a live graph is left alone", () => {
  const r = chooseCaptureDevice({ preferredId: "", currentId: BUILTIN, availableIds: [BUILTIN], captureReady: true });
  assert.equal(r.rebuild, false);
  assert.equal(r.deviceId, BUILTIN);
});

test("the preferred microphone is used when it is plugged in", () => {
  const r = chooseCaptureDevice({ preferredId: ANKER, availableIds: [BUILTIN, ANKER], captureReady: false });
  assert.equal(r.deviceId, ANKER);
  assert.equal(r.source, "preferred");
  assert.equal(r.rebuild, true);
});

test("already on the preferred microphone: no rebuild", () => {
  const r = chooseCaptureDevice({ preferredId: ANKER, currentId: ANKER, availableIds: [BUILTIN, ANKER], captureReady: true });
  assert.equal(r.source, "preferred");
  assert.equal(r.rebuild, false, "rebinding a working mic to itself would clip a press for nothing");
});

test("the preferred microphone coming back pulls us off the fallback", () => {
  const r = chooseCaptureDevice({ preferredId: ANKER, currentId: BUILTIN, availableIds: [BUILTIN, ANKER], captureReady: true });
  assert.equal(r.deviceId, ANKER);
  assert.equal(r.source, "preferred");
  assert.equal(r.rebuild, true);
});

test("an unplugged preferred microphone falls back to the system default", () => {
  const r = chooseCaptureDevice({ preferredId: ANKER, fallbackId: null, availableIds: [BUILTIN], captureReady: false });
  assert.equal(r.deviceId, null);
  assert.equal(r.source, "fallback", "the user did choose one – it just isn't here");
  assert.equal(r.rebuild, true);
});

test("sitting on the fallback does not churn while the preferred one is away", () => {
  const r = chooseCaptureDevice({ preferredId: ANKER, currentId: BUILTIN, availableIds: [BUILTIN], captureReady: true });
  assert.equal(r.rebuild, false);
  assert.equal(r.source, "fallback");
  assert.equal(r.deviceId, BUILTIN, "stay where we are rather than reopening the same device");
});

test("the id we pinned counts as being on the preferred microphone", () => {
  // getSettings() names the CONCRETE device, which is not always the string we
  // asked for – the OS resolves some ids to others. Judging on that alone, the
  // live graph never looked like the preferred one, so every between-dictations
  // check asked for another rebuild: the mic was torn down and reopened after
  // every single dictation, forever, and Settings kept saying the chosen mic
  // wasn't plugged in.
  const r = chooseCaptureDevice({
    preferredId: ANKER,
    currentId: BUILTIN,
    requestedId: ANKER,
    availableIds: [BUILTIN, ANKER],
    captureReady: true
  });
  assert.equal(r.source, "preferred");
  assert.equal(r.rebuild, false, "this comparison has to converge or the mic churns forever");
});

test("a graph opened for something else still gets pulled onto the preferred mic", () => {
  const r = chooseCaptureDevice({
    preferredId: ANKER,
    currentId: BUILTIN,
    requestedId: null,
    availableIds: [BUILTIN, ANKER],
    captureReady: true
  });
  assert.equal(r.deviceId, ANKER);
  assert.equal(r.rebuild, true);
});

test("an unreadable device list never throws the preference away", () => {
  // enumerateDevices can fail or return nothing before labels are allowed. That
  // is not proof the Anker was unplugged, and treating it as proof would drop
  // the user's choice at the worst moment.
  const r = chooseCaptureDevice({ preferredId: ANKER, availableIds: [], captureReady: false });
  assert.equal(r.deviceId, ANKER);
  assert.equal(r.source, "preferred");
});

test("called with nothing at all it still answers", () => {
  const r = chooseCaptureDevice();
  assert.equal(r.deviceId, null);
  assert.equal(r.source, "default");
});
