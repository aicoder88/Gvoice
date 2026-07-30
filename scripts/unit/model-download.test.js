// Unit tests for the on-demand downloader's pure helpers (no network).
// Run: node --test scripts/unit/model-download.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, basename } from "node:path";
import {
  findInstalledWhisperCli,
  hasWhisperServer,
  modelUrl,
  windowsBinaryUrl,
  progressFraction,
  MODELS,
  WINDOWS_BINARY_ZIPS,
  WHISPER_VERSION
} from "../../src/model-download.js";

test("modelUrl builds a HuggingFace resolve URL for a known model", () => {
  assert.equal(
    modelUrl("ggml-base-q5_1.bin"),
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin"
  );
});

test("modelUrl rejects an unknown model", () => {
  assert.throws(() => modelUrl("ggml-made-up.bin"), /Unknown model/);
});

test("windowsBinaryUrl points at the pinned release for each variant", () => {
  assert.equal(
    windowsBinaryUrl("cpu"),
    `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`
  );
  assert.match(windowsBinaryUrl("cuda"), /whisper-cublas-12\.4\.0-bin-x64\.zip$/);
});

test("windowsBinaryUrl rejects an unknown variant", () => {
  assert.throws(() => windowsBinaryUrl("rocm"), /Unknown variant/);
});

test("progressFraction is a clamped 0..1 ratio", () => {
  assert.equal(progressFraction(0, 100), 0);
  assert.equal(progressFraction(50, 100), 0.5);
  assert.equal(progressFraction(150, 100), 1); // clamped
});

test("progressFraction returns null when the total is unknown", () => {
  assert.equal(progressFraction(50, 0), null);
  assert.equal(progressFraction(50, undefined), null);
});

test("the model + variant tables stay in sync with the recommender's names", () => {
  // recommendedAssets (src/hardware.js) returns exactly these keys — guard against
  // a rename on one side silently breaking the download.
  assert.ok(MODELS["ggml-base-q5_1.bin"], "base model present");
  assert.ok(MODELS["ggml-small-q5_1.bin"], "small model present");
  assert.ok(WINDOWS_BINARY_ZIPS.cpu && WINDOWS_BINARY_ZIPS.cuda, "both variants present");
});

// ---- locating an already-installed whisper-cli (macOS/Linux) ----
// The contract that matters: whatever comes back is ABSOLUTE. A Finder-launched
// .app inherits none of the shell's PATH, so a relative path works in dev and
// dies in the installed app.

test("findInstalledWhisperCli honours an absolute WHISPER_BIN that exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "gvoice-bin-"));
  const cli = join(dir, "whisper-cli");
  writeFileSync(cli, "");
  const saved = { bin: process.env.WHISPER_BIN, cli: process.env.WHISPER_CLI };
  process.env.WHISPER_BIN = cli;
  delete process.env.WHISPER_CLI;
  try {
    assert.equal(findInstalledWhisperCli(), cli);
  } finally {
    restoreEnv(saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findInstalledWhisperCli finds one on PATH and never returns a relative path", () => {
  const dir = mkdtempSync(join(tmpdir(), "gvoice-bin-"));
  writeFileSync(join(dir, "whisper-cli"), "");
  const saved = { bin: process.env.WHISPER_BIN, cli: process.env.WHISPER_CLI, path: process.env.PATH };
  delete process.env.WHISPER_BIN;
  delete process.env.WHISPER_CLI;
  process.env.PATH = dir;
  try {
    const found = findInstalledWhisperCli();
    // A machine with Homebrew's whisper-cpp installed answers with the brew copy
    // (it's searched first, because that's the one a packaged app can't see);
    // a machine without it answers with the temp dir. Either way: absolute.
    assert.ok(found, "expected to find a whisper-cli");
    assert.ok(isAbsolute(found), `expected an absolute path, got ${found}`);
    assert.equal(basename(found), "whisper-cli");
  } finally {
    restoreEnv(saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findInstalledWhisperCli ignores a relative WHISPER_BIN", () => {
  const saved = { bin: process.env.WHISPER_BIN, cli: process.env.WHISPER_CLI, path: process.env.PATH };
  process.env.WHISPER_BIN = "whisper-cli";
  delete process.env.WHISPER_CLI;
  process.env.PATH = "";
  try {
    // Either null (nothing installed) or the brew copy — never the bare name it
    // was handed, which is the Finder PATH trap.
    const found = findInstalledWhisperCli();
    assert.ok(found === null || isAbsolute(found), `expected null or an absolute path, got ${found}`);
  } finally {
    restoreEnv(saved);
  }
});

function restoreEnv({ bin, cli, path }) {
  if (bin === undefined) delete process.env.WHISPER_BIN; else process.env.WHISPER_BIN = bin;
  if (cli === undefined) delete process.env.WHISPER_CLI; else process.env.WHISPER_CLI = cli;
  if (path !== undefined) process.env.PATH = path;
}

test("findInstalledWhisperCli prefers an install that has whisper-server too", () => {
  const cliOnly = mkdtempSync(join(tmpdir(), "gvoice-cli-only-"));
  const complete = mkdtempSync(join(tmpdir(), "gvoice-complete-"));
  writeFileSync(join(cliOnly, "whisper-cli"), "");
  writeFileSync(join(complete, "whisper-cli"), "");
  writeFileSync(join(complete, "whisper-server"), "");
  const saved = { bin: process.env.WHISPER_BIN, cli: process.env.WHISPER_CLI, path: process.env.PATH };
  // The cli-only dir is FIRST on PATH: without the server preference, the
  // benchmark would time the slow reload-per-clip path and fail a fast machine.
  delete process.env.WHISPER_BIN;
  delete process.env.WHISPER_CLI;
  process.env.PATH = [cliOnly, complete].join(":");
  try {
    const found = findInstalledWhisperCli();
    assert.ok(hasWhisperServer(found), `expected a complete install, got ${found}`);
    assert.equal(hasWhisperServer(join(cliOnly, "whisper-cli")), false);
  } finally {
    restoreEnv(saved);
    rmSync(cliOnly, { recursive: true, force: true });
    rmSync(complete, { recursive: true, force: true });
  }
});

test("a stale WHISPER_BIN pointing at nothing is never returned", () => {
  const saved = { bin: process.env.WHISPER_BIN, cli: process.env.WHISPER_CLI, path: process.env.PATH };
  process.env.WHISPER_BIN = "/nowhere/at/all/whisper-cli";
  delete process.env.WHISPER_CLI;
  process.env.PATH = "";
  try {
    const found = findInstalledWhisperCli();
    assert.notEqual(found, "/nowhere/at/all/whisper-cli", "an uninstalled binary must re-probe, not stick");
    assert.ok(found === null || existsSync(found));
  } finally {
    restoreEnv(saved);
  }
});
