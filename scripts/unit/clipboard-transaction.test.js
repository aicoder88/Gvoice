// Unit tests for the clipboard as ONE transaction (src/typing.js).
// Run: node --test scripts/unit/clipboard-transaction.test.js
//
// No Electron and no real pasteboard: a fake clipboard records every read and
// write, so the whole rule — snapshot, write, paste, put back only what we
// still own — is exercised as plain data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { typeText } from "../../src/typing.js";

/** The window the user started dictating into, and is still in. */
const NOTES = { pid: 501, app: "notes", windowNumber: 42, role: "AXTextArea", editable: true };
const here = () => ({ ...NOTES });

/**
 * A clipboard with the flavours Electron's has: text, html, rtf, image.
 * @param {{ text?: string, html?: string, rtf?: string, image?: any }} [initial]
 */
function fakeClipboard(initial = {}) {
  /** @type {{ text?: string, html?: string, rtf?: string, image?: any }} */
  let state = { ...initial };
  /** @type {any[]} */
  const writes = [];
  return {
    writes,
    current: () => state,
    availableFormats() {
      const formats = [];
      if (state.text) formats.push("text/plain");
      if (state.html) formats.push("text/html");
      if (state.rtf) formats.push("text/rtf");
      if (state.image) formats.push("image/png");
      return formats;
    },
    readText: () => state.text || "",
    readHTML: () => state.html || "",
    readRTF: () => state.rtf || "",
    readImage: () => state.image || { isEmpty: () => true },
    writeText(/** @type {string} */ t) { state = { text: t }; writes.push({ text: t }); },
    writeImage(/** @type {any} */ i) { state = { image: i }; writes.push({ image: i }); },
    write(/** @type {any} */ data) { state = { ...data }; writes.push({ ...data }); },
    clear() { state = {}; writes.push({ cleared: true }); }
  };
}

/** An image object shaped like Electron's NativeImage, enough for these tests. */
function fakeImage(name) {
  return { name, isEmpty: () => false };
}

test("(a) the user's clipboard comes back when nothing touched it mid-paste", async () => {
  const clipboard = fakeClipboard({ text: "the user's own copy" });
  let pastes = 0;
  const out = await typeText("hello there", {
    target: NOTES,
    readTarget: here,
    clipboard,
    settleMs: 0,
    paste: async () => { pastes += 1; }
  });
  assert.deepEqual(out, { pasted: true, reason: "match" });
  assert.equal(pastes, 1);
  assert.equal(clipboard.readText(), "the user's own copy", "the user gets their clipboard back");
  assert.deepEqual(
    clipboard.writes.map((w) => w.text),
    [" hello there", "the user's own copy"],
    "we write our text, then put theirs back"
  );
});

test("(a2) rich flavours survive: html and rtf are put back with the text", async () => {
  const clipboard = fakeClipboard({ text: "Quarterly notes", html: "<b>Quarterly notes</b>", rtf: "{\\rtf1 Quarterly notes}" });
  await typeText("hello there", {
    target: NOTES,
    readTarget: here,
    clipboard,
    settleMs: 0,
    paste: async () => {}
  });
  assert.deepEqual(clipboard.current(), {
    text: "Quarterly notes",
    html: "<b>Quarterly notes</b>",
    rtf: "{\\rtf1 Quarterly notes}"
  });
});

test("(b) a copy the user made mid-paste wins and is never overwritten", async () => {
  const clipboard = fakeClipboard({ text: "the user's own copy" });
  const out = await typeText("hello there", {
    target: NOTES,
    readTarget: here,
    clipboard,
    settleMs: 0,
    // The user hits ⌘C on something else while the paste is settling.
    paste: async () => { clipboard.writeText("other"); }
  });
  assert.equal(out.pasted, true);
  assert.equal(clipboard.readText(), "other", "their copy stays on the clipboard");
  assert.deepEqual(
    clipboard.writes.map((w) => w.text),
    [" hello there", "other"],
    "no restore write happened after theirs"
  );
});

test("(c) a copied screenshot survives a dictation", async () => {
  const shot = fakeImage("screenshot");
  const clipboard = fakeClipboard({ image: shot });
  await typeText("hello there", {
    target: NOTES,
    readTarget: here,
    clipboard,
    settleMs: 0,
    paste: async () => {}
  });
  assert.equal(clipboard.current().image, shot, "the screenshot is back on the clipboard");
  assert.equal(clipboard.current().text, undefined, "and no empty text was written over it");
});

test("an empty clipboard is left empty, not filled with our text", async () => {
  const clipboard = fakeClipboard();
  await typeText("hello there", {
    target: NOTES,
    readTarget: here,
    clipboard,
    settleMs: 0,
    paste: async () => {}
  });
  assert.deepEqual(clipboard.current(), {});
});

test("two deliveries never interleave — each finishes its own transaction", async () => {
  const clipboard = fakeClipboard({ text: "original" });
  /** @type {string[]} */
  const order = [];
  const slowPaste = (/** @type {string} */ tag) => async () => {
    order.push("paste:" + tag);
    // Whatever our text is, it must still be the one on the clipboard here.
    assert.equal(clipboard.readText(), " " + tag, tag + " must own the clipboard during its own paste");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(clipboard.readText(), " " + tag, tag + " still owns the clipboard when its paste ends");
  };
  const first = typeText("first", { target: NOTES, readTarget: here, clipboard, settleMs: 5, paste: slowPaste("first") });
  const second = typeText("second", { target: NOTES, readTarget: here, clipboard, settleMs: 5, paste: slowPaste("second") });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["paste:first", "paste:second"], "the second delivery waits for the first");
  assert.equal(clipboard.readText(), "original", "and the user's clipboard is back at the end");
});

test("a paste that throws still hands the clipboard back", async () => {
  const clipboard = fakeClipboard({ text: "original" });
  await assert.rejects(
    typeText("hello there", {
      target: NOTES,
      readTarget: here,
      clipboard,
      settleMs: 0,
      paste: async () => { throw new Error("System Events hung"); }
    }),
    /System Events hung/
  );
  assert.equal(clipboard.readText(), "original", "a failed paste must not keep the user's clipboard");
});

test("a failed delivery does not wedge the queue for the next one", async () => {
  const clipboard = fakeClipboard({ text: "original" });
  await typeText("boom", {
    target: NOTES,
    readTarget: here,
    clipboard,
    settleMs: 0,
    paste: async () => { throw new Error("nope"); }
  }).catch(() => {});
  const out = await typeText("hello there", {
    target: NOTES,
    readTarget: here,
    clipboard,
    settleMs: 0,
    paste: async () => {}
  });
  assert.equal(out.pasted, true);
  assert.equal(clipboard.readText(), "original");
});
