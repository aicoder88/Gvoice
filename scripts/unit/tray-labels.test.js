// What a "Recent dictations" row says about each outcome (src/history.js).
// Run: node --test scripts/unit/tray-labels.test.js
//
// The join of the two machines' versions replaced four separate flags with one
// outcome field, and the tray went on reading the old flags: every cancelled or
// copied dictation grew a false warning. These pin the words and the warning to
// the outcome, including for history written before the field existed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trayLabelFor, DELIVERY_STATES } from "../../src/history.js";

const text = "hello there";

test("a delivered dictation says nothing and carries no warning", () => {
  assert.deepEqual(trayLabelFor({ deliveryState: "verified", text }), { note: null, warn: false });
  assert.deepEqual(trayLabelFor({ deliveryState: "sent-unverified", text }), { note: null, warn: false });
});

test("only a genuinely failed paste earns the warning", () => {
  for (const state of DELIVERY_STATES) {
    assert.equal(trayLabelFor({ deliveryState: state, text }).warn, state === "failed", state);
  }
});

test("cancelled, copied, overtaken and recovered each say what happened", () => {
  assert.match(trayLabelFor({ deliveryState: "cancelled", text }).note, /Cancelled/);
  assert.match(trayLabelFor({ deliveryState: "refused", text }).note, /copied instead/);
  assert.match(trayLabelFor({ deliveryState: "superseded", text }).note, /newer dictation/);
  assert.match(trayLabelFor({ deliveryState: "recovered", text }).note, /Recovered/);
});

test("history written before the outcome field still reads correctly", () => {
  assert.equal(trayLabelFor({ cancelled: true, pasted: false, text }).warn, false);
  assert.match(trayLabelFor({ cancelled: true, pasted: false, text }).note, /Cancelled/);
  assert.match(trayLabelFor({ copy: true, pasted: false, text }).note, /copied instead/);
  assert.equal(trayLabelFor({ pasted: true, text }).warn, false);
  assert.equal(trayLabelFor({ pasted: false, text }).warn, true);
});

test("a clip with no words gets no misleading note", () => {
  assert.equal(trayLabelFor({ deliveryState: "cancelled", text: "" }).note, null);
});
