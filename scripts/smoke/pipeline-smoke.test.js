// Pipeline smoke test: fixture speech audio -> real whisper-local
// transcription -> paste buffer. This is the one check that proves the whole
// chain still works end to end, not just each unit in isolation.
//
// Skips (not fails) when whisper-cli or a model aren't installed locally —
// same convention as scripts/parity/dictation-flow.test.js — so a fresh clone
// without the on-device speech engine doesn't get blocked at push time. Run
// `./scripts/setup-whisper-mac.sh` once to get both.
//
// Kept OUT of scripts/unit/ (and off the plain `test:unit` glob) on purpose:
// it spawns a real whisper-server + model and needs
// --experimental-test-module-mocks (Node 22+) to fake the Electron clipboard
// outside the Electron runtime. Run:
//   pnpm run test:pipeline-smoke

import "dotenv/config";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";
import { startServer } from "../../server.js";
import { findInstalledWhisperCli } from "../../src/model-download.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "fixtures", "quick-fox.pcm16");
const EXPECTED_TEXT = "the quick brown fox jumps over the lazy dog";
const CHUNK_SAMPLES = 4096; // matches public/dictation.js ScriptProcessorNode buffer
const MIN_SIMILARITY = 0.9;

function loadFixtureChunks() {
  const pcm = readFileSync(FIXTURE_PATH);
  const chunkBytes = CHUNK_SAMPLES * 2;
  const chunks = [];
  for (let off = 0; off < pcm.length; off += chunkBytes) {
    chunks.push(pcm.subarray(off, Math.min(off + chunkBytes, pcm.length)));
  }
  return chunks;
}

// Case/punctuation-insensitive Levenshtein similarity, 0..1.
function similarity(a, b) {
  const x = a.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const y = b.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (!x && !y) return 1;
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 0; j <= y.length; j++) dp[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      dp[i][j] = x[i - 1] === y[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const dist = dp[x.length][y.length];
  const maxLen = Math.max(x.length, y.length, 1);
  return 1 - dist / maxLen;
}

// Generous: the fixture streams instantly (no real recording time), so it can
// race whisper-server's warm-up and fall back to the slow whisper-cli path
// (tens of seconds cold) instead of the fast server. A real dictation session
// never hits this — the user's speech gives the server time to warm up first.
function waitForTranscript(frames, { timeoutMs = 60000, intervalMs = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const done = frames.find(
        (f) => f.type === "conversation.item.input_audio_transcription.completed"
      );
      if (done) return resolve(done.transcript || "");
      const errored = frames.find((f) => f.type === "local.error");
      if (errored) return reject(new Error(errored.message));
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for transcript"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

async function transcribeFixture() {
  const { server, port } = await startServer({ port: 0 });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?provider=whisper-local`);
    /** @type {any[]} */
    const frames = [];
    ws.on("message", (raw) => {
      try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    for (const chunk of loadFixtureChunks()) {
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
    }
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    const transcript = await waitForTranscript(frames);
    ws.close();
    return transcript;
  } finally {
    await new Promise((resolve) => {
      try { server.closeAllConnections?.(); } catch {}
      server.close(() => resolve());
      setTimeout(resolve, 1000).unref();
    });
  }
}

const whisperBin = findInstalledWhisperCli();
const modelPath = process.env.WHISPER_MODEL || join(HERE, "..", "..", "models", "ggml-small.en-q5_1.bin");
const canRun = whisperBin && existsSync(modelPath);

test(
  "fixture speech -> whisper-local transcription -> paste buffer",
  { skip: canRun ? false : "whisper-cli or a model isn't installed — run ./scripts/setup-whisper-mac.sh" },
  async () => {
    const transcript = await transcribeFixture();

    assert.notStrictEqual(transcript.trim(), "", "transcription must be non-empty");
    const score = similarity(transcript, EXPECTED_TEXT);
    assert.ok(
      score >= MIN_SIMILARITY,
      `transcript "${transcript}" only ${(score * 100).toFixed(1)}% similar to expected "${EXPECTED_TEXT}"`
    );

    // Paste-buffer step. typing.js talks to the real Electron clipboard, which
    // only exists inside the Electron runtime — fake it here so the plain
    // `node --test` process can still exercise the real typeText() logic.
    const writes = [];
    mock.module("electron", {
      namedExports: {
        clipboard: {
          readText: () => "",
          readImage: () => ({ isEmpty: () => true }),
          writeText: (t) => writes.push(t),
          writeImage: () => {}
        }
      }
    });
    mock.module(new URL("../../src/foreground.js", import.meta.url).href, {
      namedExports: { sendPasteShortcut: async () => {} }
    });
    const { typeText } = await import("../../src/typing.js");
    await typeText(transcript);

    assert.ok(
      writes.some((w) => w.trim() === transcript.trim()),
      `paste buffer never received the transcript (got: ${JSON.stringify(writes)})`
    );
  }
);
