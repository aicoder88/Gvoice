import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { polishTranscript, preservesSpeakerWords, takeCleanupError } from "../src/cleanup.js";
import { CLEANUP_QUALITY_CASES as ALL_CASES } from "./fixtures/cleanup-quality-cases.js";

const RUNS = Number(process.env.CLEANUP_QUALITY_RUNS || 3);
const TARGET_MS = Number(process.env.CLEANUP_QUALITY_TARGET_MS || 1200);
// GPT-OSS 120B's free allowance is 8,000 input/output tokens per minute. Each
// call uses roughly 400, so spacing calls avoids grading raw fallback text as
// if it came from the model. Override with 0 only for a deliberate burst check.
const PAUSE_MS = Number(process.env.CLEANUP_QUALITY_PAUSE_MS ?? 3500);
const ONLY_ARG = process.argv.find((arg) => arg.startsWith("--only="));
const ONLY = new Set((ONLY_ARG?.slice("--only=".length) || "").split(",").filter(Boolean));
const CASES = ONLY.size ? ALL_CASES.filter((item) => ONLY.has(item.name)) : ALL_CASES;

function words(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || [];
}

function normalized(text) {
  return words(text).join(" ");
}

function percentile(values, amount) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * amount) - 1)] || 0;
}

function evaluate(spec, output) {
  const reasons = [];
  const outputWords = new Set(words(output));
  if (!preservesSpeakerWords(spec.input, output, true)) reasons.push("changed spoken wording");
  if (/[;—–]/.test(output)) reasons.push("used heavy punctuation");
  if (/```|here is|finished transcript/i.test(output)) reasons.push("added framing");
  if (spec.category !== "list" && /^\s*(?:[-*•]|\d+[.)])\s+/m.test(output)) reasons.push("made an unwanted list");
  if (["prose", "question-command", "croatian", "mixed"].includes(spec.category) && !/[.!?]$/.test(output.trim())) reasons.push("missing final punctuation");
  if (spec.ending && !output.trim().endsWith(spec.ending)) reasons.push(`expected ${spec.ending} ending`);
  if (spec.removed?.some((word) => outputWords.has(word))) reasons.push("kept a clear filler");
  if (spec.kept?.some((word) => !outputWords.has(word))) reasons.push("removed ordinary speech");
  if (spec.corrected && normalized(output) !== spec.corrected) reasons.push("missed spoken correction");
  if (spec.category === "list" && !/1\.\s[\s\S]*2\.\s[\s\S]*3\.\s/.test(output)) reasons.push("missed numbered list");
  return reasons;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const categoryCounts = Object.groupBy(ALL_CASES, (item) => item.category);
const expectedCounts = { prose: 15, "question-command": 8, correction: 6, list: 5, croatian: 3, mixed: 3 };
for (const [category, count] of Object.entries(expectedCounts)) {
  if ((categoryCounts[category] || []).length !== count) throw new Error(`${category} must have ${count} cases`);
}
if (ALL_CASES.length !== 40) throw new Error("Quality set must contain exactly 40 cases");
if (ONLY.size && CASES.length !== ONLY.size) throw new Error("Unknown name in --only list");

const results = [];
for (let index = 0; index < CASES.length; index += 1) {
  const spec = CASES[index];
  const attempts = [];
  for (let run = 0; run < RUNS; run += 1) {
    if (results.length || run) await new Promise((done) => setTimeout(done, PAUSE_MS));
    const started = performance.now();
    const output = await polishTranscript(spec.input);
    const elapsedMs = Math.round(performance.now() - started);
    const reasons = evaluate(spec, output);
    const serviceFailure = takeCleanupError();
    if (serviceFailure) reasons.push(serviceFailure);
    attempts.push({ output, elapsedMs, reasons });
  }
  const stable = new Set(attempts.map((attempt) => attempt.output)).size === 1;
  const passed = stable && attempts.every((attempt) => !attempt.reasons.length);
  results.push({ ...spec, attempts, stable, passed });
  process.stdout.write(`${index + 1}/${CASES.length} ${spec.name}: ${passed ? "PASS" : "REVIEW"}\n`);
}

const times = results.flatMap((result) => result.attempts.map((attempt) => attempt.elapsedMs));
const p95Ms = percentile(times, 0.95);
const summary = {
  cases: results.length,
  runsPerCase: RUNS,
  passingCases: results.filter((result) => result.passed).length,
  stableCases: results.filter((result) => result.stable).length,
  p95Ms,
  speedTargetMs: TARGET_MS,
  speedTargetMet: p95Ms <= TARGET_MS
};

const rows = results.map((result) => `<section class="${result.passed ? "pass" : "review"}">
<h2>${escapeHtml(result.name)} - ${result.passed ? "Pass" : "Review"}</h2>
<p><strong>Category:</strong> ${escapeHtml(result.category)}</p>
<p><strong>Spoken:</strong> ${escapeHtml(result.input)}</p>
${result.attempts.map((attempt, index) => `<h3>Try ${index + 1} - ${attempt.elapsedMs} ms</h3><p>${escapeHtml(attempt.output)}</p>${attempt.reasons.length ? `<p class="reason">${escapeHtml(attempt.reasons.join("; "))}</p>` : ""}`).join("\n")}
${result.stable ? "" : '<p class="reason">Punctuation changed between tries.</p>'}
</section>`).join("\n");

const outputPath = resolve("docs", `cleanup-quality-results-${new Date().toISOString().slice(0, 10)}.html`);
writeFileSync(outputPath, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GVoice cleanup quality results</title>
<style>body{font:16px/1.5 system-ui;max-width:900px;margin:40px auto;padding:0 20px;color:#1c1c1c}section{border-top:1px solid #ccc;padding:22px 0}.pass h2{color:#1f6f43}.review h2,.reason{color:#9b2c2c}h1,h2,h3{line-height:1.2}h3{margin-bottom:4px}p{white-space:pre-wrap}</style></head><body>
<h1>GVoice cleanup quality results</h1>
<p>${summary.passingCases} of ${summary.cases} cases passed all ${RUNS} tries. ${summary.stableCases} were identical every time. The slowest 5% took ${summary.p95Ms} ms. Target: ${TARGET_MS} ms.</p>
<p><strong>Approval needed:</strong> These examples are synthetic. Review the proposed punctuation below before calling them owner-approved.</p>
${rows}</body></html>`, "utf8");

console.log(JSON.stringify({ ...summary, outputPath }, null, 2));
if (summary.passingCases !== summary.cases || !summary.speedTargetMet) process.exitCode = 1;
