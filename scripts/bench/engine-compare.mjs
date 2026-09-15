// Compares speech engines on identical audio: how fast, and how many words wrong.
//
// Every whisper model gets its own whisper-server, spawned with the SAME flags a
// real dictation uses (-t 4 --no-fallback -fa), warmed on one clip before the
// clock starts. That matters: a cold server pays its model load once, and
// counting it would make the big models look far worse than they are in an app
// that keeps one server warm all day.
//
// Usage:
//   node scripts/bench/engine-compare.mjs --clips <dir> [options]
//
//   --clips <dir>       WAVs named clip-<nn>-<lang>.wav (see make-clips.sh)
//   --models a,b,c      whisper model FILES in the models dir (default: whatever is installed)
//   --models-dir <dir>  where those files live (default: <repo>/models)
//   --truth <file>      sentences.txt, to score word errors (default: the one beside this script)
//   --deepgram          also run the cloud engine, using the app's own key
//   --parakeet <dir>    also run parakeet through scripts/bench/parakeet.py in <venv>
//   --venv <dir>        python environment that has onnx-asr (for --parakeet)
//   --out <file>        write the raw per-clip results as JSON
//
// With no --truth match for a clip the transcript is printed but not scored, so
// the same script works on real recordings, where nobody knows the exact words.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const CLIPS_DIR = arg("clips");
if (!CLIPS_DIR || CLIPS_DIR === true) {
  console.error("need --clips <dir>; make one with: sh scripts/bench/make-clips.sh <dir>");
  process.exit(2);
}
const MODELS_DIR = arg("models-dir", join(REPO, "models"));
const TRUTH_FILE = arg("truth", join(HERE, "sentences.txt"));
const WANT_DEEPGRAM = arg("deepgram") === true;
const PARAKEET_DIR = arg("parakeet");
const VENV = arg("venv");
const OUT_FILE = arg("out");

// --- ground truth ----------------------------------------------------------
// clip-04-en.wav is the 4th line of sentences.txt. Keyed by that number so a
// clip with no matching line simply goes unscored.
const truth = new Map();
if (existsSync(TRUTH_FILE)) {
  let n = 0;
  for (const line of readFileSync(TRUTH_FILE, "utf8").split("\n")) {
    const [lang, text] = line.split("|");
    if (!lang || !text) continue;
    n += 1;
    truth.set(String(n).padStart(2, "0"), { lang: lang.trim(), text: text.trim() });
  }
}

const norm = (s) => (s || "").toLowerCase().normalize("NFKC")
  .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Word-level edit distance: substitutions + insertions + deletions. */
function wordErrors(reference, hypothesis) {
  const r = norm(reference).split(" ").filter(Boolean);
  const h = norm(hypothesis).split(" ").filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)
      );
    }
  }
  return { errors: d[r.length][h.length], words: r.length };
}

// --- a warm whisper-server per model ---------------------------------------
const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});

async function withWhisperServer(modelPath, run) {
  const port = await freePort();
  const proc = spawn("whisper-server", [
    "-m", modelPath, "--host", "127.0.0.1", "--port", String(port),
    "-t", "4", "--no-fallback", "-fa"
  ]);
  // Readiness by knocking on the port, not by reading the log. Which stream
  // the "listening" line lands on differs between whisper.cpp builds (1.8.6
  // puts it on stdout), and a port that answers is the thing we actually need.
  let ready = false;
  let output = "";
  const keep = (d) => { output = (output + String(d)).slice(-2000); };
  proc.stderr.on("data", keep);
  proc.stdout.on("data", keep);
  proc.on("error", (e) => { keep(e.message); });
  const deadline = Date.now() + 180000; // a 1 GB model takes a while to load
  while (!ready && Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`whisper-server died: ${output.slice(-400)}`);
    await new Promise((r) => setTimeout(r, 250));
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      ready = true;
    } catch (e) {
      // Anything that is not "nobody is listening" means somebody is.
      if (!/ECONNREFUSED|fetch failed|socket hang up/i.test(String(e.message))) ready = true;
    }
  }
  const stderr = output;
  if (!ready) { proc.kill("SIGKILL"); throw new Error(`whisper-server never listened: ${stderr.slice(-400)}`); }
  try {
    return await run(`http://127.0.0.1:${port}/inference`);
  } finally {
    proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}

async function askWhisper(url, wav, language) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(wav)], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0.0");
  form.append("language", language);
  const t0 = Date.now();
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`whisper HTTP ${res.status}`);
  const body = await res.json();
  return { ms: Date.now() - t0, text: (body.text || "").replace(/\s+/g, " ").trim() };
}

// --- the cloud engine, exactly as the app calls it --------------------------
async function askDeepgram(wav, language) {
  const { transcribeWavFile } = await import(join(REPO, "src", "providers", "deepgram.js"));
  const { resolveDeepgramKey } = await import(join(REPO, "realtime-relay.js"));
  const t0 = Date.now();
  const text = await transcribeWavFile(wav, {
    apiKey: resolveDeepgramKey(),
    model: "nova-3",
    language
  });
  return { ms: Date.now() - t0, text: (text || "").trim() };
}

// --- parakeet, through its own python runtime ------------------------------
function askParakeet(clipsDir) {
  if (!VENV || VENV === true) throw new Error("--parakeet needs --venv <dir>");
  const python = join(String(VENV), "bin", "python");
  const out = spawn(python, [join(HERE, "parakeet.py"), String(PARAKEET_DIR), clipsDir, "--json"]);
  let stdout = "", stderr = "";
  out.stdout.on("data", (d) => { stdout += d; });
  out.stderr.on("data", (d) => { stderr += d; });
  return new Promise((res, rej) => {
    out.on("close", (code) => {
      if (code !== 0) return rej(new Error(`parakeet.py exited ${code}: ${stderr.slice(-400)}`));
      try { res(JSON.parse(stdout)); } catch (e) { rej(new Error(`parakeet.py output unreadable: ${e.message}`)); }
    });
  });
}

// --- run -------------------------------------------------------------------
const clips = readdirSync(CLIPS_DIR).filter((f) => f.endsWith(".wav")).sort();
if (!clips.length) { console.error(`no .wav files in ${CLIPS_DIR}`); process.exit(2); }

const clipInfo = clips.map((file) => {
  const m = /^clip-(\d+)-([a-z]{2})\.wav$/.exec(file);
  const key = m ? m[1] : null;
  const known = key ? truth.get(key) : null;
  return {
    file,
    path: join(CLIPS_DIR, file),
    lang: m ? m[2] : (known ? known.lang : "en"),
    text: known ? known.text : null
  };
});

const models = (() => {
  const asked = arg("models");
  if (asked && asked !== true) return String(asked).split(",").map((s) => s.trim()).filter(Boolean);
  return readdirSync(MODELS_DIR).filter((f) => f.startsWith("ggml-") && f.endsWith(".bin")).sort();
})();

/** engine name -> [{clip, ms, text, errors, words}] */
const results = {};
const record = (engine, clip, r) => {
  const scored = clip.text ? wordErrors(clip.text, r.text) : { errors: null, words: null };
  (results[engine] ||= []).push({ clip: clip.file, lang: clip.lang, ms: r.ms, text: r.text, ...scored });
  const score = scored.words ? `${String(Math.round((scored.errors / scored.words) * 100)).padStart(3)}%` : "  - ";
  console.log(`${clip.file} ${clip.lang}  ${engine.padEnd(28)} ${String(r.ms).padStart(5)}ms  ${score}  ${JSON.stringify(r.text)}`);
};

for (const model of models) {
  const modelPath = join(MODELS_DIR, model);
  if (!existsSync(modelPath)) { console.error(`skip ${model}: not in ${MODELS_DIR}`); continue; }
  const engine = model.replace(/^ggml-|\.bin$/g, "");
  try {
    await withWhisperServer(modelPath, async (url) => {
      // Warm-up, not measured: the first request after a load pays for lazy
      // graph setup, and a real app has already paid it.
      await askWhisper(url, clipInfo[0].path, "auto").catch(() => {});
      for (const clip of clipInfo) {
        // "auto" on purpose: that is what the app sends, and an English-only
        // model's failure on Croatian is part of what is being measured.
        record(engine, clip, await askWhisper(url, clip.path, "auto"));
      }
    });
  } catch (e) {
    console.error(`${model}: ${e.message}`);
  }
}

if (WANT_DEEPGRAM) {
  for (const clip of clipInfo) {
    try { record("deepgram nova-3", clip, await askDeepgram(clip.path, clip.lang)); }
    catch (e) { console.error(`deepgram ${clip.file}: ${e.message}`); }
  }
}

if (PARAKEET_DIR && PARAKEET_DIR !== true) {
  try {
    const rows = await askParakeet(CLIPS_DIR);
    for (const row of rows) {
      const clip = clipInfo.find((c) => c.file === row.clip);
      if (clip) record("parakeet tdt 0.6b v3", clip, { ms: row.ms, text: row.text });
    }
  } catch (e) {
    console.error(`parakeet: ${e.message}`);
  }
}

// --- summary ---------------------------------------------------------------
console.log("\nengine                          clips   word errors        median   slowest");
for (const [engine, rows] of Object.entries(results)) {
  for (const lang of [...new Set(rows.map((r) => r.lang))].sort()) {
    const sub = rows.filter((r) => r.lang === lang);
    const scored = sub.filter((r) => r.words);
    const errs = scored.reduce((a, r) => a + r.errors, 0);
    const words = scored.reduce((a, r) => a + r.words, 0);
    const ms = sub.map((r) => r.ms).sort((a, b) => a - b);
    const rate = words ? `${((errs / words) * 100).toFixed(1)}% (${errs}/${words} words)` : "not scored";
    console.log(
      `${engine.padEnd(30)} ${lang} ${String(sub.length).padStart(3)}   ${rate.padEnd(18)} ${String(ms[Math.floor(ms.length / 2)]).padStart(5)}ms ${String(ms[ms.length - 1]).padStart(7)}ms`
    );
  }
}
console.log("\nA few clips is a few clips: one wrong word moves these percentages several points.");

if (OUT_FILE && OUT_FILE !== true) {
  writeFileSync(String(OUT_FILE), JSON.stringify({ when: new Date().toISOString(), clipsDir: CLIPS_DIR, results }, null, 2));
  console.log(`raw results: ${OUT_FILE}`);
}
