// Unit tests for the give-up path and the tray's "Copy last result".
// Run: node --test scripts/unit/cancel-and-copy.test.js
//
// The wiring itself (Escape, the pill click, the menu item) lives in main.js
// and needs Electron, so what is tested here is the three decisions main.js
// delegates: is this keystroke the cancel key, which history entry does "Copy
// last result" copy, and may a cancelled press still deliver its words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCancelKey } from "../../src/hotkey-logic.js";
import { lastResult } from "../../src/history.js";
import { recordingsEnabledFrom } from "../../src/recordings.js";
import { DictationSession } from "../../src/dictation-session.js";

const quiet = () => {};

// --- Escape ---------------------------------------------------------------

test("Escape is the cancel key, by raw code and by name", () => {
  assert.equal(isCancelKey(1), true, "uiohook reports Escape as keycode 1");
  assert.equal(isCancelKey(27, { Escape: 27 }), true, "a table that says otherwise wins too");
});

test("nothing else is the cancel key", () => {
  // Right Option, left Ctrl, left Cmd and the mouse back button all pass
  // through this check on their way to the hold tracker — if any of them
  // matched, holding to talk would cancel itself.
  for (const code of [3640, 29, 3675, 4, 0, 56]) {
    assert.equal(isCancelKey(code, { Escape: 1 }), false, `keycode ${code} must not cancel`);
  }
  assert.equal(isCancelKey(undefined), false);
  assert.equal(isCancelKey("1"), false, "a string keycode is not a match");
});

// --- Copy last result -----------------------------------------------------

const entry = (text, extra = {}) => ({ ts: 1, text, pasted: false, ...extra });

test("Copy last result takes the newest entry that has words", () => {
  const history = [entry("newest"), entry("older")];
  assert.equal(lastResult(history)?.text, "newest");
});

test("Copy last result skips clip-only entries and blank text", () => {
  // A failed attempt saves the audio with no transcript. Stopping at one would
  // hide the words the user is actually reaching for.
  const history = [
    entry("", { recordingPath: "/tmp/a.wav" }),
    entry("   "),
    entry("the words")
  ];
  assert.equal(lastResult(history)?.text, "the words");
});

test("Copy last result offers a cancelled dictation's words", () => {
  // The whole point: cancel throws the words away from the cursor, not from
  // the user. One menu click has to bring them back.
  const history = [entry("said it then changed my mind", { cancelled: true })];
  assert.equal(lastResult(history)?.text, "said it then changed my mind");
});

test("Copy last result is empty when nothing has been said", () => {
  assert.equal(lastResult([]), null);
  assert.equal(lastResult([entry("", { recordingPath: "/tmp/a.wav" })]), null);
});

// --- Recovery storage follows the recordings preference -------------------

test("clips are saved unless the preference explicitly says off", () => {
  assert.equal(recordingsEnabledFrom({}), true, "unset means on");
  assert.equal(recordingsEnabledFrom({ RECORDINGS_ENABLED: "true" }), true);
  for (const off of ["false", "0", "no", "off", " OFF ", "False"]) {
    assert.equal(
      recordingsEnabledFrom({ RECORDINGS_ENABLED: off }),
      false,
      `"${off}" must turn saving off`
    );
  }
});

// --- Cancel blocks delivery ----------------------------------------------

test("a cancelled press delivers nothing, however late its words arrive", () => {
  const s = new DictationSession({ log: quiet });
  s.tryStart();
  const mine = s.id;
  s.release();
  assert.equal(s.cancel("escape"), true);
  assert.equal(s.wasCancelled(mine), true);
  assert.equal(s.canDeliver(mine), false, "cancel means cancel");
  // And the mic is free again straight away — a cancel that jammed the app
  // would be worse than the stuck hold it exists to end.
  assert.equal(s.busy, false);
  assert.equal(s.tryStart(), true);
});

test("cancelling with nothing running does nothing at all", () => {
  // Escape is watched globally, so most of the ones this ever sees belong to
  // another app. They must cost nothing.
  const s = new DictationSession({ log: quiet });
  assert.equal(s.cancel("escape"), false);
  assert.equal(s.state, "idle");
});
