// Unit tests for the clipboard as ONE transaction (src/typing.js and
// src/clipboard-lease.js).
// Run: node --test scripts/unit/clipboard-transaction.test.js
//
// No Electron and no real pasteboard: a fake clipboard records every read and
// write. The rule these pin down: the dictation holds the clipboard as a lease,
// and the user's own clipboard comes back whole (text, html, rtf, image) only
// when the paste is VERIFIED. An unconfirmed paste keeps the words where the
// user can still paste them by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTextTyper } from "../../src/typing.js";

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
  let changeCount = 1;
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
    writeText(/** @type {string} */ t) { state = { text: t }; changeCount += 1; writes.push({ text: t }); },
    writeImage(/** @type {any} */ i) { state = { image: i }; changeCount += 1; writes.push({ image: i }); },
    write(/** @type {any} */ data) { state = { ...data }; changeCount += 1; writes.push({ ...data }); },
    clear() { state = {}; changeCount += 1; writes.push({ cleared: true }); },
    changeCount: () => changeCount
  };
}

/** An image object shaped like Electron's NativeImage, enough for these tests. */
function fakeImage(name) {
  return { name, isEmpty: () => false };
}

/** A typer on this fake, pasting instantly into the window the user is still in. */
function typerOn(clipboard, sendShortcut = async () => ({ refused: false })) {
  return createTextTyper({
    clipboardTarget: clipboard,
    getChangeCount: () => clipboard.changeCount(),
    readTarget: here,
    releaseDelayMs: 0,
    sendShortcut
  });
}

test("(a) the user's clipboard comes back after a verified paste", async () => {
  const clipboard = fakeClipboard({ text: "my own copy" });
  const lease = await typerOn(clipboard)("hello there", { target: NOTES });
  assert.equal(lease.finish("verified"), "verified");
  assert.equal(clipboard.readText(), "my own copy");
});

test("(a2) rich flavours survive: html and rtf are put back with the text", async () => {
  const clipboard = fakeClipboard({ text: "bold", html: "<b>bold</b>", rtf: "{\\rtf1 bold}" });
  const lease = await typerOn(clipboard)("hello there", { target: NOTES });
  lease.finish("verified");
  assert.deepEqual(clipboard.current(), { text: "bold", html: "<b>bold</b>", rtf: "{\\rtf1 bold}" },
    "text copied from a web page or a document keeps its formatting");
});

// Both machines logged this bug separately: a timer that restores the user's
// clipboard after a paste nobody confirmed wipes the only copy of words that
// may never have landed. An unconfirmed paste keeps them.
test("an unconfirmed paste keeps the words on the clipboard", async () => {
  const clipboard = fakeClipboard({ text: "my own copy" });
  const lease = await typerOn(clipboard)("hello there", { target: NOTES });
  lease.finish("sent-unverified");
  assert.equal(clipboard.readText(), " hello there", "the words stay pasteable by hand");
});

test("(b) a copy the user made mid-paste wins and is never overwritten", async () => {
  const clipboard = fakeClipboard({ text: "before" });
  const lease = await typerOn(clipboard, async () => {
    clipboard.writeText("copied while the paste was settling");
    return { refused: false };
  })("hello there", { target: NOTES });
  lease.finish("verified");
  assert.equal(clipboard.readText(), "copied while the paste was settling");
});

test("(c) a copied screenshot survives a dictation", async () => {
  const shot = fakeImage("screenshot");
  const clipboard = fakeClipboard({ image: shot });
  const lease = await typerOn(clipboard)("hello there", { target: NOTES });
  lease.finish("verified");
  assert.equal(clipboard.current().image, shot);
});

test("an empty clipboard is left empty, not filled with our text", async () => {
  const clipboard = fakeClipboard({});
  const lease = await typerOn(clipboard)("hello there", { target: NOTES });
  lease.finish("verified");
  assert.deepEqual(clipboard.current(), {});
});

test("two deliveries never interleave – each finishes its own transaction", async () => {
  const clipboard = fakeClipboard({ text: "mine" });
  /** @type {string[]} */
  const order = [];
  const typeText = typerOn(clipboard, async () => { order.push(clipboard.readText()); return { refused: false }; });
  const first = typeText("first", { target: NOTES });
  const second = typeText("second", { target: NOTES });
  (await first).finish("verified");
  (await second).finish("verified");
  assert.deepEqual(order, [" first", " second"], "each paste sees its own text, never the other's");
});

test("a paste that throws is reported, and the words are not thrown away", async () => {
  const clipboard = fakeClipboard({ text: "mine" });
  const lease = await typerOn(clipboard, async () => { throw new Error("osascript hung"); })("hello there", { target: NOTES });
  assert.equal(lease.dispatched, false);
  assert.ok(lease.dispatchError, "the caller must be able to say the paste failed");
  lease.finish("failed");
  assert.equal(clipboard.readText(), " hello there", "a failed paste keeps the words to paste by hand");
});

test("a failed delivery does not wedge the queue for the next one", async () => {
  const clipboard = fakeClipboard({ text: "mine" });
  let calls = 0;
  const typeText = typerOn(clipboard, async () => {
    calls += 1;
    if (calls === 1) throw new Error("first paste fails");
    return { refused: false };
  });
  (await typeText("one", { target: NOTES })).finish("failed");
  const next = await typeText("two", { target: NOTES });
  assert.equal(next.dispatched, true, "the next dictation still goes through");
  next.finish("verified");
});
