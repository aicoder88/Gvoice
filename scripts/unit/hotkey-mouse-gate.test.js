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
