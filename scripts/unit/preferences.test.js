// Unit tests for the microphone preferences file (preferences.json in the app's
// data folder). Run: node --test scripts/unit/preferences.test.js
//
// The one rule this file is here to defend: these settings live in their own
// JSON file and NEVER in .env, which holds the API keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  DEFAULT_PREFERENCES,
  MIC_MODES,
  normalizePreferences,
  preferencesPath,
  readPreferences,
  writePreferences
} from "../../src/preferences.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "gvoice-prefs-"));
}

test("the file is preferences.json inside the app's data folder", () => {
  const dir = tempDir();
  assert.equal(preferencesPath(dir), join(dir, "preferences.json"));
  assert.equal(basename(preferencesPath(dir)), "preferences.json");
  assert.ok(!preferencesPath(dir).includes(".env"), "must never be an env file");
});

test("a fresh install is always-ready on the system microphone", () => {
  assert.deepEqual(DEFAULT_PREFERENCES, { micMode: "always", preferredMicId: "", preferredMicLabel: "" });
  assert.deepEqual(MIC_MODES, ["always", "balanced", "hold"]);
});

test("a missing file reads back as the defaults", () => {
  const p = preferencesPath(tempDir());
  assert.ok(!existsSync(p));
  assert.deepEqual(readPreferences(p), DEFAULT_PREFERENCES);
});

test("a corrupt file reads back as the defaults instead of breaking dictation", () => {
  const p = preferencesPath(tempDir());
  writeFileSync(p, "{ this is not json");
  assert.deepEqual(readPreferences(p), DEFAULT_PREFERENCES);
});

test("a file holding the wrong shape is repaired, not trusted", () => {
  const p = preferencesPath(tempDir());
  writeFileSync(p, JSON.stringify({ micMode: 12, preferredMicId: { nope: true }, extra: "ignored" }));
  const got = readPreferences(p);
  assert.deepEqual(got, DEFAULT_PREFERENCES);
  assert.equal(got.extra, undefined, "unknown keys never reach the renderer");
});

test("an unknown mode falls back to always-ready, never to cold", () => {
  assert.equal(normalizePreferences({ micMode: "sometimes" }).micMode, "always");
  assert.equal(normalizePreferences({ micMode: "HOLD" }).micMode, "hold");
});

test("saving a choice and reading it back gives the same thing", () => {
  const p = preferencesPath(tempDir());
  const saved = writePreferences(p, { micMode: "balanced", preferredMicId: "anker-1", preferredMicLabel: "Anker PowerConf" });
  assert.deepEqual(saved, { micMode: "balanced", preferredMicId: "anker-1", preferredMicLabel: "Anker PowerConf" });
  assert.deepEqual(readPreferences(p), saved);
  assert.ok(JSON.parse(readFileSync(p, "utf8")), "the file on disk is plain JSON");
});

test("a save touches only the fields it was given", () => {
  const p = preferencesPath(tempDir());
  writePreferences(p, { micMode: "hold", preferredMicId: "anker-1", preferredMicLabel: "Anker PowerConf" });
  const after = writePreferences(p, { micMode: "always" });
  assert.equal(after.micMode, "always");
  assert.equal(after.preferredMicId, "anker-1", "changing the mode must not forget the microphone");
  assert.equal(after.preferredMicLabel, "Anker PowerConf");
});

test("clearing the microphone clears its remembered name too", () => {
  const p = preferencesPath(tempDir());
  writePreferences(p, { preferredMicId: "anker-1", preferredMicLabel: "Anker PowerConf" });
  const after = writePreferences(p, { preferredMicId: "" });
  assert.equal(after.preferredMicId, "");
  assert.equal(after.preferredMicLabel, "", "otherwise Settings shows a name next to no choice");
});

test("the browser's \"default\" is no choice at all, not a microphone", () => {
  // "default" and "communications" are the browser's words for whatever the
  // computer is set to — which is exactly what an empty preference means. Kept
  // as a device they read as a choice the app then chases: the live capture
  // reports the concrete device it resolved to, the two never match, and every
  // between-dictations check asks for another rebuild while Settings insists the
  // chosen microphone isn't plugged in.
  const p = preferencesPath(tempDir());
  const after = writePreferences(p, { preferredMicId: "default", preferredMicLabel: "Default" });
  assert.equal(after.preferredMicId, "");
  assert.equal(after.preferredMicLabel, "", "and no name beside a choice that isn't one");
  assert.equal(normalizePreferences({ preferredMicId: "communications" }).preferredMicId, "");
  assert.equal(readPreferences(p).preferredMicId, "", "including on the way back in");
});

test("a real device id that merely looks ordinary is kept", () => {
  const after = normalizePreferences({ preferredMicId: "  anker-1  ", preferredMicLabel: " Anker " });
  assert.equal(after.preferredMicId, "anker-1");
  assert.equal(after.preferredMicLabel, "Anker");
});

test("a folder that cannot be written throws, so the user can be told", () => {
  const dir = join(tempDir(), "locked");
  mkdirSync(dir);
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => writePreferences(preferencesPath(dir), { micMode: "hold" }));
  } finally {
    chmodSync(dir, 0o700);
  }
});
