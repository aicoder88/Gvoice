// Unit tests for the .env settings reader/writer.
// Run: node --test scripts/unit/settings.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEnv,
  applyEnv,
  readEnvFile,
  writeEnvFile,
  settingsView,
  patchFromView,
  micIdleMinutes
} from "../../src/settings.js";

function tmpEnv(contents) {
  const dir = mkdtempSync(join(tmpdir(), "gvoice-settings-"));
  const path = join(dir, ".env");
  if (contents != null) writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("parseEnv: reads simple assignments, ignores comments/blanks", () => {
  const { index } = parseEnv("# comment\nA=1\n\nB = two \nnotakey\n");
  assert.equal(index.get("A").value, "1");
  assert.equal(index.get("B").value, "two");
  assert.equal(index.has("notakey"), false);
});

test("parseEnv: strips surrounding quotes from values", () => {
  const { index } = parseEnv('A="hello world"\nB=\'x\'');
  assert.equal(index.get("A").value, "hello world");
  assert.equal(index.get("B").value, "x");
});

test("applyEnv: updates an existing key in place, preserves comments", () => {
  const before = "# header\nSTT_PROVIDER=openai\nPORT=3000\n";
  const after = applyEnv(before, { STT_PROVIDER: "deepgram" });
  assert.ok(after.includes("# header"));
  assert.ok(after.includes("STT_PROVIDER=deepgram"));
  assert.ok(after.includes("PORT=3000"));
  // Only the one line changed — original openai gone.
  assert.ok(!after.includes("STT_PROVIDER=openai"));
});

test("applyEnv: appends a missing key", () => {
  const after = applyEnv("A=1\n", { B: "2" });
  assert.ok(after.includes("A=1"));
  assert.ok(after.includes("B=2"));
});

test("applyEnv: quotes values with spaces or # (single quotes — dotenv reads them literally)", () => {
  const after = applyEnv("", { OPENAI_API_KEY: "a b", NOTE: "x#y" });
  assert.ok(after.includes("OPENAI_API_KEY='a b'"));
  assert.ok(after.includes("NOTE='x#y'"));
});

test("applyEnv: a Windows path with spaces round-trips without escape mangling", () => {
  // Double quotes would make dotenv expand the \n in "\new" into a newline;
  // JSON.stringify used to double the backslashes instead. Single quotes are
  // read literally, so the path survives a restart byte-for-byte.
  const path = "C:\\Users\\Mark Dev\\new models\\ggml.bin";
  const after = applyEnv("", { WHISPER_MODEL: path });
  assert.ok(after.includes(`WHISPER_MODEL='${path}'`));
  assert.equal(parseEnv(after).index.get("WHISPER_MODEL").value, path);
});

test("applyEnv: a spaced value containing a single quote falls back to double quotes", () => {
  const after = applyEnv("", { NOTE: "it's fine" });
  assert.ok(after.includes('NOTE="it\'s fine"'));
});

test("applyEnv: rejects newlines and unstorable quote/backslash mixes", () => {
  assert.throws(() => applyEnv("", { X: "a\nb" }), /newline/);
  assert.throws(() => applyEnv("", { X: "a 'b' \\c" }), /can't be stored/);
});

test("applyEnv: does not grow trailing blank lines on repeated appends", () => {
  let text = "A=1\n";
  text = applyEnv(text, { B: "2" });
  text = applyEnv(text, { C: "3" });
  assert.ok(!/\n\n$/.test(text), "no double trailing newline");
});

test("writeEnvFile + readEnvFile round-trips and preserves unmanaged keys", () => {
  const { path, cleanup } = tmpEnv("# mine\nPORT=3000\nSTT_PROVIDER=openai\n");
  try {
    writeEnvFile(path, { STT_PROVIDER: "deepgram", DEEPGRAM_API_KEY: "dg-key" });
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes("# mine"));
    assert.ok(text.includes("PORT=3000"));
    assert.ok(text.includes("STT_PROVIDER=deepgram"));
    assert.ok(text.includes("DEEPGRAM_API_KEY=dg-key"));
  } finally {
    cleanup();
  }
});

test("readEnvFile: missing file yields empty string (no throw)", () => {
  assert.equal(readEnvFile(join(tmpdir(), "definitely-not-here-gvoice.env")), "");
});

test("settingsView: defaults when env is empty", () => {
  const v = settingsView({});
  assert.equal(v.provider, "openai");
  // Mirrors main.js's runtime check (cleanup runs unless explicitly "false") —
  // the view must agree or Save would silently flip cleanup off on fresh installs.
  assert.equal(v.cleanupEnabled, true);
  assert.equal(v.recordingsEnabled, true);
  assert.equal(v.retentionDays, 7);
});

test("micIdleMinutes: defaults to 30, clamps junk, keeps 'never'", () => {
  assert.equal(micIdleMinutes({}), 30);
  assert.equal(micIdleMinutes({ MIC_IDLE_MINUTES: "" }), 30);
  assert.equal(micIdleMinutes({ MIC_IDLE_MINUTES: "15" }), 15);
  assert.equal(micIdleMinutes({ MIC_IDLE_MINUTES: "0" }), 0);
  assert.equal(micIdleMinutes({ MIC_IDLE_MINUTES: " NEVER " }), "never");
  // Junk and negatives fall back rather than corrupting the timer.
  assert.equal(micIdleMinutes({ MIC_IDLE_MINUTES: "banana" }), 30);
  assert.equal(micIdleMinutes({ MIC_IDLE_MINUTES: "-3" }), 30);
  // Clamped at a day so a fat-fingered value can't become an effectively
  // infinite timer that silently means "never".
  assert.equal(micIdleMinutes({ MIC_IDLE_MINUTES: "99999" }), 1440);
});

test("micIdleMinutes: an existing MIC_ALWAYS_ON keeps its old meaning", () => {
  // Nobody's .env changes behavior on upgrade: always-on was "never close",
  // and the off switch was "close after every hold".
  assert.equal(micIdleMinutes({ MIC_ALWAYS_ON: "true" }), "never");
  assert.equal(micIdleMinutes({ MIC_ALWAYS_ON: "false" }), 0);
  assert.equal(micIdleMinutes({ MIC_ALWAYS_ON: " OFF " }), 0);
  assert.equal(micIdleMinutes({ MIC_ALWAYS_ON: "0" }), 0);
  // The new key wins once it's written.
  assert.equal(micIdleMinutes({ MIC_ALWAYS_ON: "false", MIC_IDLE_MINUTES: "5" }), 5);
});

test("settingsView: reads + coerces values, falls back on invalid enums", () => {
  const v = settingsView({
    STT_PROVIDER: "deepgram",
    CLEANUP_ENABLED: "true",
    RECORDINGS_ENABLED: "false",
    RECORDING_RETENTION_DAYS: "14",
    OPENAI_API_KEY: "k"
  });
  assert.equal(v.provider, "deepgram");
  assert.equal(v.cleanupEnabled, true);
  assert.equal(v.recordingsEnabled, false);
  assert.equal(v.retentionDays, 14);
  assert.equal(v.openaiKey, "k");

  assert.equal(settingsView({ STT_PROVIDER: "bogus" }).provider, "openai");
});

test("patchFromView: maps fields to env keys and drops unknowns/invalids", () => {
  const patch = patchFromView({
    provider: "whisper-local",
    cleanupEnabled: true,
    openaiKey: "  trimmed  ",
    recordingsEnabled: false,
    retentionDays: 30,
    bogus: "ignored"
  });
  assert.equal(patch.STT_PROVIDER, "whisper-local");
  assert.equal(patch.CLEANUP_ENABLED, "true");
  assert.equal(patch.OPENAI_API_KEY, "trimmed");
  assert.equal(patch.RECORDINGS_ENABLED, "false");
  assert.equal(patch.RECORDING_RETENTION_DAYS, "30");
  assert.equal("bogus" in patch, false);
});

test("micIdleMinutes: round-trips through the settings window", () => {
  // The dropdown hands back strings, including the non-numeric "never".
  for (const chosen of ["0", "1", "5", "15", "30", "never"]) {
    const patch = patchFromView({ micIdleMinutes: chosen });
    assert.equal(patch.MIC_IDLE_MINUTES, chosen);
    assert.equal(String(settingsView(patch).micIdleMinutes), chosen);
  }
  // Nothing selected yet must not write a value (which would clobber the .env).
  assert.equal("MIC_IDLE_MINUTES" in patchFromView({ micIdleMinutes: "" }), false);
  assert.equal(patchFromView({ micIdleMinutes: "banana" }).MIC_IDLE_MINUTES, "30");
});

test("patchFromView: invalid provider is omitted (not corrupted)", () => {
  const patch = patchFromView({ provider: "hax" });
  assert.equal("STT_PROVIDER" in patch, false);
});

test("patchFromView: retentionDays clamps to [0,365] and rounds", () => {
  assert.equal(patchFromView({ retentionDays: 999 }).RECORDING_RETENTION_DAYS, "365");
  assert.equal(patchFromView({ retentionDays: -5 }).RECORDING_RETENTION_DAYS, "7");
  assert.equal(patchFromView({ retentionDays: 2.6 }).RECORDING_RETENTION_DAYS, "3");
});
