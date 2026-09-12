import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPasteOutcome, isTerminalApp, decidePasteOwnership } from "../../src/paste-confidence.js";

const BASE = {
  typed: true,
  restoreRequired: false,
  restored: false,
  fieldFocused: true,
  isTerminal: false,
  fieldValue: null,
  text: "Hello world.",
  beforeValue: "Draft: ",
  sameField: true
};

test("a terminal target overrides a false pre-paste editor probe", () => {
  assert.deepEqual(
    assessPasteOutcome({ ...BASE, fieldFocused: false, isTerminal: true }),
    { pasted: true, verified: null, likelyMissed: false, deliveryState: "sent-unverified" }
  );
});

test("cmux is recognized exactly as a terminal target", () => {
  assert.equal(isTerminalApp("cmux", ""), true);
  assert.equal(isTerminalApp("", "cmux"), true);
  assert.equal(isTerminalApp("cmux-notes", ""), false);
});

test("a readable field can prove the paste landed despite a false preflight", () => {
  assert.deepEqual(
    assessPasteOutcome({ ...BASE, fieldFocused: false, fieldValue: "Draft: Hello world." }),
    { pasted: true, verified: true, likelyMissed: false, deliveryState: "verified" }
  );
});

// No editable field before the paste and nothing readable after it is what ⌘V
// into the Finder desktop looks like. It still can't fail the paste (custom
// editors look the same), but it must keep the text on the clipboard instead of
// letting typing.js's 250ms restore wipe the only copy behind a bare "Success".
test("no target before or after the paste keeps the text recoverable", () => {
  assert.deepEqual(
    assessPasteOutcome({ ...BASE, fieldFocused: false }),
    { pasted: true, verified: null, likelyMissed: true, deliveryState: "sent-unverified" }
  );
});

test("an unreadable field cannot cost the clipboard when AX couldn't tell", () => {
  // fieldFocused null = Windows, or macOS without Accessibility permission.
  assert.deepEqual(
    assessPasteOutcome({ ...BASE, fieldFocused: null }),
    { pasted: true, verified: null, likelyMissed: false, deliveryState: "sent-unverified" }
  );
});

test("a focused editor that just won't expose its text keeps the clipboard", () => {
  assert.deepEqual(
    assessPasteOutcome({ ...BASE, fieldFocused: true }),
    { pasted: true, verified: null, likelyMissed: false, deliveryState: "sent-unverified" }
  );
});

test("a terminal is never treated as a missing target", () => {
  assert.deepEqual(
    assessPasteOutcome({ ...BASE, fieldFocused: false, isTerminal: true, fieldValue: null }),
    { pasted: true, verified: null, likelyMissed: false, deliveryState: "sent-unverified" }
  );
});

test("an empty field read-back is not a miss — it's an app hiding its composer", () => {
  assert.deepEqual(
    assessPasteOutcome({ ...BASE, fieldFocused: false, fieldValue: "" }),
    { pasted: true, verified: false, likelyMissed: false, deliveryState: "sent-unverified" }
  );
});

test("a failed paste shortcut can never be promoted by target signals", () => {
  assert.deepEqual(
    assessPasteOutcome({ ...BASE, typed: false, fieldFocused: false, isTerminal: true }),
    { pasted: false, verified: null, likelyMissed: false, deliveryState: "failed" }
  );
});

test("existing non-terminal uncertainty leaves the text recoverable", () => {
  assert.deepEqual(
    assessPasteOutcome({ ...BASE, fieldValue: "Existing draft" }),
    { pasted: true, verified: false, likelyMissed: true, deliveryState: "sent-unverified" }
  );
});

// The paste must never land in an app the user has moved to. The three arms
// below are the whole guard; the middle one is the one that matters.
test("a paste into the app that started the dictation is allowed", () => {
  assert.equal(decidePasteOwnership(1234, 1234), "same");
});
test("no app recorded at press time means the guard has no opinion", () => {
  assert.equal(decidePasteOwnership(null, 4321), "same");
  assert.equal(decidePasteOwnership(undefined, null), "same");
});
test("a different app is refused", () => {
  assert.equal(decidePasteOwnership(1234, 4321), "different");
});
test("an unreadable foreground is refused, not waved through", () => {
  // Chrome answers a system-wide focused-element read with nothing, so "we
  // couldn't tell" and "another app is in front" are the same situation far
  // more often than they are different. Pasting on unknown put a test sentence
  // into a browser window on 2026-09-07.
  assert.equal(decidePasteOwnership(1234, null), "unknown");
  assert.equal(decidePasteOwnership(1234, undefined), "unknown");
});
