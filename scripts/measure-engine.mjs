// Baseline timing for the local speech engine leg of a dictation.
//
// What it measures: the time from "the audio is committed" to "the transcript is
// back" — the dominant part of release-to-result — by pushing the deterministic
// parity fixture (scripts/parity/fixtures/tone-1500ms.pcm16) through the same
// warm whisper-server the app uses, ten times.
//
// It runs its own engine in its own data folder, so the installed app's engine
// is never touched. Nothing leaves the machine.
//
// Run: node scripts/measure-engine.mjs [runs]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { wrapWav } from "../src/providers/_shared.js";
import { ensureWhisperServer, stopWhisperServer } from "../src/providers/whisper-local.js";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = Number(process.argv[2] || 10);
const FIXTURE = join(here, "parity", "fixtures", "tone-1500ms.pcm16");
const FIXTURE_RATE = 24000; // see fixtures/build-fixture.js

const wav = wrapWav(readFileSync(FIXTURE), FIXTURE_RATE);

async function post(url) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "fixture.wav");
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error("whisper-server HTTP " + res.status);
  return res.json().catch(() => ({}));
}

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const bin = process.env.WHISPER_BIN || "whisper-server";
const model = process.env.WHISPER_MODEL;
if (!model) throw new Error("set WHISPER_MODEL to the .bin to measure");

const bootStart = Date.now();
await ensureWhisperServer(bin, model);
const url = process.env.WHISPER_SERVER_URL;
if (!url) throw new Error("engine did not report a url");
console.log(`engine ready in ${Date.now() - bootStart}ms at ${url}`);

await post(url); // throwaway: settle caches, mirror the app's warm steady state

const times = [];
for (let i = 0; i < RUNS; i++) {
  const t = Date.now();
  const out = await post(url);
  const ms = Date.now() - t;
  times.push(ms);
  console.log(`run ${i + 1}: ${ms}ms  ${JSON.stringify(out.text ?? "")}`);
}

console.log(`\nruns: ${RUNS}`);
console.log(`each: ${times.join(", ")}`);
console.log(`median commit-to-transcript: ${median(times)}ms`);
console.log(`min ${Math.min(...times)}ms  max ${Math.max(...times)}ms`);

stopWhisperServer();
process.exit(0);
