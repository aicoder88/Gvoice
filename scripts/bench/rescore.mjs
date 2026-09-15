// Re-scores a bench JSON, counting only words whose MEANING is wrong.
//
// The raw scorer in engine-compare.mjs compares words literally, so an engine
// that writes "90 seconds" when the sentence said "ninety seconds" is charged a
// full error. That is a formatting choice, not a mistake: the pasted text says
// the same thing. Left alone it buries the real differences, because the big
// models normalise numbers far more aggressively than the small one.
//
// This pass canonicalises both sides - spelled numbers to digits, "$68" to
// "68 dollars", "2%" to "2 percent", runs of single digits joined ("7 7 3" ->
// "773") - and reports the literal rate beside the meaning rate.
//
// Usage: node scripts/bench/rescore.mjs <bench.json> [--truth sentences.txt]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2];
if (!FILE) { console.error("usage: rescore.mjs <bench.json>"); process.exit(2); }
const i = process.argv.indexOf("--truth");
const TRUTH_FILE = i > -1 ? process.argv[i + 1] : join(HERE, "sentences.txt");

const WORDS = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50,
  sixty:60, seventy:70, eighty:80, ninety:90, hundred:100,
  first:1, second:2, third:3, fourth:4, fifth:5, sixth:6, seventh:7, eighth:8,
  ninth:9, tenth:10, twelfth:12, fourteenth:14, twentieth:20, thirtieth:30,
  // Croatian
  nula:0, jedan:1, jedna:1, dva:2, dvije:2, tri:3, cetiri:4, pet:5, sest:6,
  sedam:7, osam:8, devet:9, deset:10, dvadeset:20, trideset:30, stotinu:100,
};

// "14th" / "9th" / "1st" -> the number. Ordinal suffix carries no extra meaning.
const stripOrdinal = (w) => w.replace(/^(\d+)(st|nd|rd|th)$/, "$1");

function canon(s) {
  let t = (s || "").toLowerCase().normalize("NFKC");
  // Symbols to the words they are read as, before punctuation is stripped.
  t = t.replace(/\$\s*([\d.,]+)/g, "$1 dollars").replace(/([\d.,]+)\s*%/g, "$1 percent");
  t = t.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  let out = [];
  for (let w of t.split(" ").filter(Boolean)) {
    w = stripOrdinal(w);
    // Accent-fold only for the number lookup, so Croatian words still match.
    const key = w.normalize("NFD").replace(/\p{M}/gu, "");
    if (Object.prototype.hasOwnProperty.call(WORDS, key)) out.push(String(WORDS[key]));
    else out.push(w);
  }
  // "ninety" + nothing vs "90": already equal. Now join runs of single digits,
  // so a tracking number read out digit by digit matches the written form.
  const joined = [];
  for (const w of out) {
    if (/^\d$/.test(w) && joined.length && /^\d+$/.test(joined[joined.length - 1])
        && joined[joined.length - 1].length <= 3 && /^\d$/.test(joined[joined.length - 1].slice(-1))
        && joined[joined.length - 1].length < 4) {
      joined[joined.length - 1] += w;
    } else joined.push(w);
  }
  return joined;
}

const literal = (s) => (s || "").toLowerCase().normalize("NFKC")
  .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

function errs(r, h) {
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (r[i-1] === h[j-1] ? 0 : 1));
  return d[r.length][h.length];
}

const truth = new Map();
let n = 0;
for (const line of readFileSync(TRUTH_FILE, "utf8").split("\n")) {
  const [lang, text] = line.split("|");
  if (!lang || !text) continue;
  truth.set(String(++n).padStart(2, "0"), text.trim());
}

const data = JSON.parse(readFileSync(FILE, "utf8"));
const rows = [];
for (const [engine, clips] of Object.entries(data.results)) {
  const per = {};
  for (const c of clips) {
    const k = (c.clip.match(/clip-(\d+)/) || [])[1];
    const said = k && truth.get(k);
    if (!said) continue;
    const p = (per[c.lang] ||= { lit: 0, mean: 0, words: 0, ms: [], clips: 0 });
    p.lit += errs(literal(said), literal(c.text));
    p.mean += errs(canon(said), canon(c.text));
    p.words += literal(said).length;
    p.ms.push(c.ms);
    p.clips++;
  }
  for (const [lang, p] of Object.entries(per)) {
    p.ms.sort((a, b) => a - b);
    rows.push({ engine, lang, clips: p.clips, words: p.words, lit: p.lit, mean: p.mean,
      median: p.ms[Math.floor(p.ms.length / 2)], worst: p.ms[p.ms.length - 1] });
  }
}

const pct = (e, w) => `${((e / w) * 100).toFixed(1)}%`;
console.log("engine                         lang clips  literal        meaning        median  slowest");
for (const r of rows.sort((a, b) => a.lang.localeCompare(b.lang) || a.mean - b.mean)) {
  console.log(
    `${r.engine.padEnd(30)} ${r.lang}  ${String(r.clips).padStart(3)}  ` +
    `${(pct(r.lit, r.words) + ` (${r.lit}/${r.words})`).padEnd(14)} ` +
    `${(pct(r.mean, r.words) + ` (${r.mean}/${r.words})`).padEnd(14)} ` +
    `${String(r.median).padStart(6)}ms ${String(r.worst).padStart(6)}ms`
  );
}
