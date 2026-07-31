// The on-device engine panel lives as inline <script> in public/settings.html,
// so there is nothing to import. These tests run the REAL script text against a
// DOM stub — the shipped code, not a copy that can drift away from it.
//
// What's guarded here has all bitten before or was one edit away from biting:
// the model dropdown is now built from the main process's list (not hand-written
// <option>s), a hand-edited off-list model must be visible but never SENT, and
// the model that gets applied must be the one the box is showing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "..", "public", "settings.html"), "utf8");
const SCRIPT = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

const MODELS = {
  "ggml-base-q5_1.bin": { sizeMB: 57, label: "Base — smallest and fastest" },
  "ggml-small-q5_1.bin": { sizeMB: 182, label: "Small — more accurate" },
  "ggml-large-v3-q5_0.bin": { sizeMB: 1031, label: "Large — the most accurate, the slowest" }
};

/**
 * Boot the panel's script against a fresh stub DOM.
 * @param {object} info what engine:probe returns
 * @param {object|null} bench what engine:benchmark returns
 */
async function boot(info, bench) {
  /** @type {Record<string, Record<string, Function>>} */
  const on = {};
  /** @type {Map<string, any>} */
  const els = new Map();
  /** @type {any[]} */
  const applied = [];

  const makeEl = (id) => {
    const options = [];
    return {
      id, _value: "", style: {}, dataset: {}, classList: { add() {}, remove() {} },
      textContent: "", className: "", checked: false, disabled: false, type: "text",
      options,
      add(o) { options.push(o); },
      get value() { return this._value; },
      set value(v) {
        // Real <select>: assigning a value with no matching option blanks the box.
        if (this.id === "localModel") { this._value = options.some((o) => o.value === v) ? v : ""; return; }
        this._value = v;
      },
      addEventListener(ev, fn) { (on[id] ||= {})[ev] = fn; },
      focus() {}
    };
  };
  const el = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };

  // Left installed on purpose: the click handlers below run after boot() returns
  // and still reach through document/window. Each boot() replaces them wholesale,
  // so tests don't leak into each other.
  globalThis.Option = class { constructor(text, value) { this.textContent = text; this.value = value; } };
  globalThis.document = { getElementById: el, querySelectorAll: () => [], addEventListener() {} };
  const noop = () => Promise.resolve({});
  globalThis.window = {
    location: { search: "" },
    // Proxy so any bridge method these tests don't exercise is a no-op.
    settingsBridge: new Proxy({
      get: () => Promise.resolve({ provider: "deepgram", retentionDays: 7 }),
      engineProbe: () => Promise.resolve(info),
      engineBenchmark: () => Promise.resolve(bench),
      engineApply: (payload) => { applied.push(payload); return Promise.resolve({ provider: "whisper-local" }); },
      dictGet: () => Promise.resolve({ terms: [] })
    }, { get: (t, k) => (k in t ? t[k] : noop) })
  };

  new Function(SCRIPT)();
  // Let initEnginePanel's awaits settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  return { el, on, applied };
}

const ready = (extra) => ({
  localEngine: "ready", suggestion: { text: "ok" }, models: MODELS,
  recommendedModel: "ggml-base-q5_1.bin", currentModel: "", ...extra
});

test("settings: the model dropdown is built from the main process's list", async () => {
  const { el } = await boot(ready(), null);
  const sel = el("localModel");
  assert.equal(sel.options.length, 3, "one option per model — no hand-written <option>s left");
  assert.equal(sel.options[2].textContent, "Large — the most accurate, the slowest (1031 MB)");
  assert.equal(sel.value, "ggml-base-q5_1.bin", "the hardware recommendation is preselected");
});

test("settings: a hand-edited off-list model is shown but never sent", async () => {
  const { el, on, applied } = await boot(ready({ currentModel: "ggml-small.en.bin" }), null);
  assert.equal(el("localModel").options.length, 4, "the off-list model is appended…");
  assert.equal(el("localModel").value, "ggml-small.en.bin", "…and selected, not silently swapped");
  await on.useLocalBtn.click();
  // Sending it would fail the main process's allow-list and lose the whole
  // apply; omitting it keeps whatever model is already configured.
  assert.equal(applied[0].modelName, undefined, "an off-list name is never sent");
});

test("settings: a speed test result sticks to the model it measured", async () => {
  const bench = { ok: true, modelName: "ggml-base-q5_1.bin", verdict: { fastEnough: true, elapsedMs: 830, reason: "fast" } };
  const { el, on } = await boot(ready(), bench);
  await on.benchBtn.click();
  const sel = el("localModel");
  assert.equal(sel.options[0].textContent, "Base — smallest and fastest (57 MB) — 0.8s here");
  assert.equal(sel.options[1].textContent, "Small — more accurate (182 MB)", "an untested model gains no number");
});

test("settings: applies the model the box is SHOWING, not the last one tested", async () => {
  const bench = { ok: true, modelName: "ggml-base-q5_1.bin", verdict: { fastEnough: true, elapsedMs: 830, reason: "fast" } };
  const { el, on, applied } = await boot(ready(), bench);
  await on.benchBtn.click();
  el("localModel").value = "ggml-small-q5_1.bin"; // the user changes their mind
  await on.useLocalBtn.click();
  assert.equal(applied.at(-1).modelName, "ggml-small-q5_1.bin",
    "preferring the tested model applied a different one than the user could see");
});
