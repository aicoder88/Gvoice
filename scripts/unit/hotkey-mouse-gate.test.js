// Unit tests for the mouse-back-button gate (step 12): while a companion
// (Better Options) owns the button, the raw uiohook toggle must not also
// fire presses of its own.
// Run: node --test scripts/unit/hotkey-mouse-gate.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMouseBackGate } from "../../src/hotkey-logic.js";

test("mouse gate: down/down toggles press then release when enabled", () => {
  const events = [];
  const gate = createMouseBackGate({
    onPress: () => events.push("press"),
    onRelease: () => events.push("release")
  });
  gate.down();
  gate.down();
  assert.deepEqual(events, ["press", "release"]);
});

test("mouse gate: with the gate off, button 4 events produce no press", () => {
  const events = [];
  const gate = createMouseBackGate({
    onPress: () => events.push("press"),
    onRelease: () => events.push("release")
  });
  gate.setEnabled(false);
  gate.down();
  gate.down();
  gate.up();
  assert.deepEqual(events, []);
  assert.equal(gate.isHeld(), false);
});

test("mouse gate: disabling mid-hold releases so dictation can't get stuck open", () => {
  const events = [];
  const gate = createMouseBackGate({
    onPress: () => events.push("press"),
    onRelease: () => events.push("release")
  });
  gate.down(); // held open
  assert.equal(gate.isHeld(), true);
  gate.setEnabled(false);
  assert.deepEqual(events, ["press", "release"]);
  assert.equal(gate.isHeld(), false);
});

test("mouse gate: re-enabling starts fresh, no phantom press", () => {
  const events = [];
  const gate = createMouseBackGate({
    onPress: () => events.push("press"),
    onRelease: () => events.push("release")
  });
  gate.setEnabled(true);
  assert.deepEqual(events, []);
  gate.down();
  assert.deepEqual(events, ["press"]);
});

test("mouse gate: after a cancel, the next click talks instead of doing nothing", () => {
  // The bug this closes: start a dictation with the mouse button, give up on it
  // with Escape or a click on the pill, then press the button again. The gate
  // still thought the button was held, so that press was read as a release of a
  // dictation that no longer existed — nothing happened at all and the user had
  // to press twice.
  const events = [];
  const gate = createMouseBackGate({
    onPress: () => events.push("press"),
    onRelease: () => events.push("release")
  });
  gate.down();
  assert.deepEqual(events, ["press"]);
  gate.reset(); // cancelDictation: the press is over, by another route
  assert.equal(gate.isHeld(), false);
  assert.deepEqual(events, ["press"], "reset itself must not end anything");
  gate.down();
  assert.deepEqual(events, ["press", "press"], "the next click starts a new dictation");
});

test("mouse gate: the physical up edge after a reset is ignored, not a phantom release", () => {
  const events = [];
  const gate = createMouseBackGate({
    onPress: () => events.push("press"),
    onRelease: () => events.push("release")
  });
  gate.down();
  gate.reset();
  gate.up(); // the user was still physically holding it when they cancelled
  assert.deepEqual(events, ["press"]);
});
