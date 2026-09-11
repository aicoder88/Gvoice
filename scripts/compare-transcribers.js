// Compare the two speech engines this installation can use today against the
// same saved recordings. The saved history is shown as a review aid, never
// treated as ground truth: it came from the old pipeline and may itself be
// wrong. Private transcripts are written only to GVoice's local data folder.

import "dotenv/config";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { startServer } from "../server.js";
import { findInstalledWhisperCli } from "../src/model-download.js";
import { stopWhisperServer } from "../src/providers/whisper-local.js";
import { transcribeWavFile } from "../src/providers/deepgram.js";
import { resolveDeepgramKey } from "../realtime-relay.js";

const APP_HOME = process.env.GVOICE_HOME
  || join(process.env.HOME || "", "Library", "Application Support", "GVoice");
const RECORDINGS_DIR = join(APP_HOME, "temp-recordings");
const HISTORY_FILE = join(APP_HOME, "history.json");
const MODEL = process.env.WHISPER_MODEL
  || ["ggml-small-q5_1.bin", "ggml-base-q5_1.bin", "ggml-small.en-q5_1.bin"]
    .map((name) => resolve("models", name))
    .find(existsSync);
const BIN = process.env.WHISPER_BIN || process.env.WHISPER_CLI || findInstalledWhisperCli();
const LIMIT_ARG = process.argv.find((arg) => arg.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split("=")[1]) : Infinity;

if (!existsSync(RECORDINGS_DIR)) throw new Error(`Recording folder not found: ${RECORDINGS_DIR}`);
if (!existsSync(HISTORY_FILE)) throw new Error(`History not found: ${HISTORY_FILE}`);
if (!MODEL) throw new Error("No local Whisper model found.");
if (!BIN) throw new Error("No local Whisper program found.");

process.env.WHISPER_MODEL = MODEL;
process.env.WHISPER_BIN = BIN;
process.env.WHISPER_LANGUAGE = "en";

// Provider diagnostics include the full transcript. Keep this comparison's
// terminal output private-safe; the review page in GVoice's data folder is the
// only place where speech text is written.
const originalConsoleError = console.error;
console.error = (...args) => {
  const line = String(args[0] || "");
  if (line.includes("whisper-local (server)") || line.includes("whisper-local (cli)")) return;
  originalConsoleError(...args);
};

const history = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
const historyByRecording = new Map(
  history
    .filter((entry) => entry?.recordingPath)
    .map((entry) => [resolve(entry.recordingPath), entry])
);
const files = readdirSync(RECORDINGS_DIR)
  .filter((name) => name.endsWith(".wav"))
  .map((name) => join(RECORDINGS_DIR, name))
  .filter((path) => historyByRecording.has(resolve(path)))
  .sort((a, b) => (historyByRecording.get(resolve(a))?.ts || 0) - (historyByRecording.get(resolve(b))?.ts || 0))
  .slice(0, LIMIT);

if (!files.length) throw new Error("No saved recordings match the history.");

function wavInfo(path) {
  const wav = readFileSync(path);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Unsupported WAV: ${basename(path)}`);
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let pcm = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt " && size >= 16) {
      channels = wav.readUInt16LE(start + 2);
      sampleRate = wav.readUInt32LE(start + 4);
      bits = wav.readUInt16LE(start + 14);
    }
    if (id === "data") pcm = wav.subarray(start, Math.min(start + size, wav.length));
    offset = start + size + (size % 2);
  }
  if (!pcm || channels !== 1 || bits !== 16 || sampleRate !== 24000) {
    throw new Error(`Expected mono 24 kHz PCM16: ${basename(path)}`);
  }
  return { pcm, seconds: pcm.length / (sampleRate * 2) };
}

function transcribeLocal(port, pcm) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?provider=whisper-local`);
    let sent = false;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("local transcription timed out"));
    }, 90000);
    const finish = (fn, value) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn(value);
    };
    ws.on("error", (error) => finish(reject, error));
    const sendAudio = () => {
      if (sent) return;
      sent = true;
      for (let offset = 0; offset < pcm.length; offset += 8192) {
        ws.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm.subarray(offset, Math.min(offset + 8192, pcm.length)).toString("base64")
        }));
      }
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    };
    ws.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (frame.type === "local.status" && frame.status === "connected") sendAudio();
      if (frame.type === "local.error") finish(reject, new Error(frame.message));
      if (frame.type === "conversation.item.input_audio_transcription.completed") {
        finish(resolvePromise, String(frame.transcript || "").trim());
      }
    });
  });
}

function normalizedWords(text) {
  return String(text || "")
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) || [];
}

function similarity(a, b) {
  const x = normalizedWords(a);
  const y = normalizedWords(b);
  if (!x.length && !y.length) return 1;
  let prior = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= y.length; j += 1) {
      next[j] = x[i - 1] === y[j - 1]
        ? prior[j - 1]
        : 1 + Math.min(prior[j - 1], prior[j], next[j - 1]);
    }
    prior = next;
  }
  return 1 - prior[y.length] / Math.max(x.length, y.length, 1);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function percentile(values, amount) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * amount) - 1)] || 0;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const deepgramKey = resolveDeepgramKey();
if (!deepgramKey) throw new Error("No Deepgram credential found.");

const { server, port } = await startServer({ port: 0 });
const results = [];
try {
  for (let index = 0; index < files.length; index += 1) {
    const path = files[index];
    const { pcm, seconds } = wavInfo(path);
    const reference = String(historyByRecording.get(resolve(path))?.text || "").trim();
    const row = { path, seconds, reference, local: "", deepgram: "", localMs: 0, deepgramMs: 0, errors: [] };

    let started = performance.now();
    try { row.local = await transcribeLocal(port, pcm); }
    catch (error) { row.errors.push(`Local: ${error.message}`); }
    row.localMs = Math.round(performance.now() - started);

    started = performance.now();
    try {
      row.deepgram = await transcribeWavFile(path, {
        apiKey: deepgramKey,
        model: process.env.DEEPGRAM_MODEL || "nova-3",
        language: "en"
      });
    } catch (error) { row.errors.push(`Deepgram: ${error.message}`); }
    row.deepgramMs = Math.round(performance.now() - started);

    row.localHistory = similarity(row.local, reference);
    row.deepgramHistory = similarity(row.deepgram, reference);
    row.engineAgreement = similarity(row.local, row.deepgram);
    results.push(row);
    process.stdout.write(`${index + 1}/${files.length} compared\n`);
  }
} finally {
  stopWhisperServer();
  await new Promise((done) => server.close(done));
}

const localTimes = results.map((row) => row.localMs);
const deepgramTimes = results.map((row) => row.deepgramMs);
const totalMinutes = results.reduce((sum, row) => sum + row.seconds, 0) / 60;
const summary = {
  recordings: results.length,
  audioMinutes: Number(totalMinutes.toFixed(2)),
  model: basename(MODEL),
  localMedianMs: median(localTimes),
  localP95Ms: percentile(localTimes, 0.95),
  deepgramMedianMs: median(deepgramTimes),
  deepgramP95Ms: percentile(deepgramTimes, 0.95),
  localHistorySimilarity: Number(average(results.map((row) => row.localHistory)).toFixed(3)),
  deepgramHistorySimilarity: Number(average(results.map((row) => row.deepgramHistory)).toFixed(3)),
  engineAgreement: Number(average(results.map((row) => row.engineAgreement)).toFixed(3)),
  errors: results.reduce((sum, row) => sum + row.errors.length, 0)
};

const rows = results.map((row, index) => `
  <section>
    <h2>Recording ${index + 1} - ${row.seconds.toFixed(1)} seconds</h2>
    <audio controls preload="none" src="file://${encodeURI(row.path)}"></audio>
    <h3>Saved history</h3><p>${escapeHtml(row.reference) || "<em>Empty</em>"}</p>
    <h3>Current on-device choice - ${row.localMs} ms</h3><p>${escapeHtml(row.local) || "<em>Empty</em>"}</p>
    <h3>Deepgram Nova 3 - ${row.deepgramMs} ms</h3><p>${escapeHtml(row.deepgram) || "<em>Empty</em>"}</p>
    ${row.errors.length ? `<p class="error">${escapeHtml(row.errors.join(" | "))}</p>` : ""}
  </section>`).join("\n");

const outputPath = join(APP_HOME, `transcription-comparison-${new Date().toISOString().slice(0, 10)}.html`);
writeFileSync(outputPath, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>GVoice speech comparison</title>
<style>body{font:16px/1.5 system-ui;max-width:900px;margin:40px auto;padding:0 20px;color:#1c1c1c}section{border-top:1px solid #ccc;padding:24px 0}audio{width:100%}h1,h2,h3{line-height:1.2}h3{margin-bottom:4px}.warning,.error{color:#9b2c2c}code{background:#eee;padding:2px 5px}</style></head><body>
<h1>GVoice speech comparison</h1>
<p class="warning"><strong>Private:</strong> This file contains your saved speech. It stays in GVoice's local data folder.</p>
<p>The saved history is a review aid, not a correct answer. It came from the earlier pipeline and may contain mistakes. Listen to each recording before choosing a winner.</p>
<ul><li>${summary.recordings} recordings, ${summary.audioMinutes} audio minutes</li><li>On-device median: ${summary.localMedianMs} ms; slowest 5%: ${summary.localP95Ms} ms</li><li>Deepgram median: ${summary.deepgramMedianMs} ms; slowest 5%: ${summary.deepgramP95Ms} ms</li><li>Average agreement between engines: ${(summary.engineAgreement * 100).toFixed(1)}%</li><li>Errors: ${summary.errors}</li></ul>
${rows}
</body></html>`, "utf8");

console.log(JSON.stringify({ ...summary, outputPath }, null, 2));
