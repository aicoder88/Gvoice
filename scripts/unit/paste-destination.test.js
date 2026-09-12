// Unit tests for the "is the text still going where the user was looking?"
// check (src/paste-guard.js, and the way src/typing.js acts on it).
// Run: node --test scripts/unit/paste-destination.test.js
//
// No Electron, no Accessibility permission, no window on screen: the
// destination reader and the clipboard are both injected, so the whole rule is
// exercised as plain data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameDestination, checkDestination } from "../../src/paste-guard.js";
import { typeText } from "../../src/typing.js";
import { recordTranscript, getHistory } from "../../src/history.js";

/** The window the user started dictating into. */
const NOTES = { pid: 501, app: "notes", windowNumber: 42, role: "AXTextArea", editable: true };

/** @param {Partial<typeof NOTES>} [changes] */
function like(changes = {}) {
  return { ...NOTES, ...changes };
}

// A clipboard that remembers everything written to it, in order.
function fakeClipboard() {
  let text = "";
  /** @type {string[]} */
  const writes = [];
  return {
    writes,
    readText: () => text,
    writeText: (/** @type {string} */ t) => { text = t; writes.push(t); },
    readImage: () => ({ isEmpty: () => true }),
    writeImage: () => {}
  };
}

test("same app, same window, editable field → paste", () => {
  assert.deepEqual(sameDestination(NOTES, like()), { ok: true, reason: "match" });
});

test("a different app is never pasted into", () => {
  assert.equal(sameDestination(NOTES, like({ pid: 777, app: "slack" })).ok, false);
  // A recycled pid with a different app name is caught too.
  assert.equal(sameDestination(NOTES, like({ app: "slack" })).reason, "app-changed");
});

test("another window of the same app is a different destination", () => {
  assert.deepEqual(sameDestination(NOTES, like({ windowNumber: 43 })), {
    ok: false,
    reason: "window-changed"
  });
});

test("caret no longer in something that takes typing → no paste", () => {
  assert.deepEqual(sameDestination(NOTES, like({ editable: false, role: "AXGroup" })), {
    ok: false,
    reason: "no-editable-field"
  });
});

// The other half of that rule, and the one that matters most day to day.
// Terminals and custom Electron editors expose no editable AX element at any
// point, so BOTH readings say editable:false. Judging the second reading alone
// refused every dictation into iTerm, Ghostty and Claude Code and left the
// words on the clipboard. Nothing changed here, so the paste goes ahead.
const TERMINAL = { pid: 620, app: "ghostty", windowNumber: 9, role: "AXGroup", editable: false };

test("an app that never looked editable still gets its paste", () => {
  assert.deepEqual(sameDestination(TERMINAL, { ...TERMINAL }), { ok: true, reason: "match" });
});

test("a never-editable app that the user switched away from is still refused", () => {
  assert.equal(sameDestination(TERMINAL, { ...TERMINAL, pid: 777, app: "slack" }).reason, "app-changed");
  assert.equal(sameDestination(TERMINAL, { ...TERMINAL, windowNumber: 10 }).reason, "window-changed");
  assert.equal(sameDestination(TERMINAL, null).reason, "unreadable");
});

test("a never-editable app that gained a text field is fine too", () => {
  assert.equal(sameDestination(TERMINAL, { ...TERMINAL, role: "AXTextArea", editable: true }).ok, true);
});

test("a destination we can no longer read is treated as changed", () => {
  assert.deepEqual(sameDestination(NOTES, null), { ok: false, reason: "unreadable" });
});

test("no press-time snapshot means no check — Windows and machines without Accessibility paste as before", () => {
  assert.deepEqual(sameDestination(null, null), { ok: true, reason: "unchecked" });
  assert.deepEqual(sameDestination(null, like({ pid: 999 })), { ok: true, reason: "unchecked" });
});

test("window numbers are only compared when both readings have one", () => {
  assert.equal(sameDestination(NOTES, like({ windowNumber: null })).ok, true);
  assert.equal(sameDestination(like({ windowNumber: null }), like()).ok, true);
});

test("a reader that throws counts as unreadable, not as a match", async () => {
  const decision = await checkDestination(NOTES, () => { throw new Error("AX timed out"); });
  assert.deepEqual(decision, { ok: false, reason: "unreadable" });
});

test("match: the text is pasted", async () => {
  const clipboard = fakeClipboard();
  let pastes = 0;
  const out = await typeText("hello there", {
    target: NOTES,
    readTarget: () => like(),
    clipboard,
    paste: async () => { pastes += 1; }
  });
  assert.deepEqual(out, { pasted: true, reason: "match" });
  assert.equal(pastes, 1, "the paste keystroke must fire on a match");
  assert.ok(clipboard.writes.includes(" hello there"), "the text goes to the clipboard to be pasted");
});

test("mismatch: clipboard holds the text, nothing is pasted", async () => {
  const clipboard = fakeClipboard();
  let pastes = 0;
  const out = await typeText("hello there", {
    target: NOTES,
    readTarget: () => like({ pid: 777, app: "slack" }),
    clipboard,
    paste: async () => { pastes += 1; }
  });
  assert.equal(out.pasted, false);
  assert.equal(out.reason, "app-changed");
  assert.equal(pastes, 0, "no keystroke may be fired at a window the user moved to");
  assert.equal(clipboard.readText(), "hello there", "the words wait on the clipboard");
  assert.deepEqual(clipboard.writes, ["hello there"], "and nothing overwrites them");
});

test("no press-time snapshot still pastes, whatever the reader says", async () => {
  const clipboard = fakeClipboard();
  let pastes = 0;
  const out = await typeText("hello there", {
    target: null,
    readTarget: () => like({ pid: 777, app: "slack" }),
    clipboard,
    paste: async () => { pastes += 1; }
  });
  assert.deepEqual(out, { pasted: true, reason: "unchecked" });
  assert.equal(pastes, 1);
});

test("a copied dictation is in history, marked copied rather than pasted", () => {
  recordTranscript("hello there", false, null, { sessionId: "3-abcd1234", copy: true });
  const newest = getHistory()[0];
  assert.equal(newest.text, "hello there");
  assert.equal(newest.pasted, false);
  assert.equal(newest.copy, true, "the tray has to say why this one never landed in an app");
  assert.equal(newest.cancelled, false, "copied is not the same as cancelled");
  assert.equal(newest.recovered, false, "copied is not the same as recovered");
});
