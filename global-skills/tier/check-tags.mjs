#!/usr/bin/env node
// Checks where the model tags sit in a /tier plan, and lists the steps /tier will run.
//
//   node check-tags.mjs <plan.md>            human report, exit 1 on any error
//   node check-tags.mjs --json <plan.md>     { steps, errors, warnings } for dispatch
//
// Why this exists (2026-09-17, purr): a plan put [opus/high] on three briefing
// sections ("## 2. Twenty copywriters", "## 3. The journey", "## 4. Persuasion") and
// the real tags on the numbered steps inside section 5. The skill allowed a tag "on
// the step or the section", so /tier would have started workers on reading material.
// The rule this enforces: tags sit on step lines only, all at one level, one per line.
//
// A step line is a heading that starts with a number or "Step N"
// ("### 4. Title", "## Step 2 – Title"), or a numbered list item at column 0
// ("3. Do the thing [sonnet/medium]"). Code fences and inline code are ignored, so a
// plan can still talk about tags.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PORTABLE = new Set(['fable', 'opus', 'sonnet', 'haiku']);
const CODEX = new Set(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.3-codex-spark']);
const EFFORTS = new Set(['low', 'med', 'medium', 'high', 'xhigh', 'max']);
const CAP_XHIGH = new Set(['gpt-5.5', 'gpt-5.3-codex-spark']);

// Anything shaped like a model tag, valid or not, so a typo is reported, not ignored.
const TAG_RE = /\[((?:fable|opus|sonnet|haiku|deepseek|gpt-[a-z0-9.-]+))\/([a-z]+)\]/gi;
const HEADING_STEP_RE = /^(#{1,6})\s+(?:\*\*)?(?:step\s+)?(\d+[a-z]?)(?:[.):]|\s+[–-]|\s)/i;
const LIST_STEP_RE = /^(\d+)[.)]\s+/;
const HEADING_RE = /^(#{1,6})\s/;
const LEGACY_RE = /^\s*model\/effort:/i;
const DONE_RE = /\b(COMPLETE|DONE|ANSWERED|SKIPPED|CONSUMED|CLOSED|OBSOLETE)\b|\bObsolete\b|^\s*[-*]?\s*\[x\]/;
const GATED_RE = /\bGATED\b/;

function validate(model, effort) {
    const m = model.toLowerCase();
    const e = effort.toLowerCase();
    if (!EFFORTS.has(e)) return `effort "${effort}" is not one of low, medium, high, xhigh, max`;
    if (m === 'deepseek') return e === 'low' || e === 'medium' ? null : 'deepseek takes low or medium only';
    if (PORTABLE.has(m)) return null;
    if (CODEX.has(m)) return CAP_XHIGH.has(m) && e === 'max' ? `${m} takes no effort above xhigh` : null;
    return `unknown model "${model}"`;
}

export function checkPlan(text) {
    const lines = text.split('\n');
    const errors = [];
    const warnings = [];
    const stepLines = []; // every step-shaped line, tagged or not
    let inFence = false;
    let heading = { level: 0, line: 0 }; // nearest heading above, for list-item grouping
    let openItem = null; // a numbered list step whose wrapped lines are still running

    lines.forEach((raw, i) => {
        const n = i + 1;
        if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; return; }
        if (inFence) return;
        const line = raw.replace(/`[^`]*`/g, '');
        const h = line.match(HEADING_RE);
        if (h) heading = { level: h[1].length, line: n };
        if (h || !line.trim()) openItem = null;

        let kind = null;
        let num = null;
        const hs = line.match(HEADING_STEP_RE);
        const ls = !h && line.match(LIST_STEP_RE);
        // "## Step 2" and "## 2." are different kinds, so numbered briefing sections
        // never count as siblings of the Step headings beside them.
        if (hs) { kind = `h${hs[1].length}${/^#+\s+(\*\*)?step\s/i.test(line) ? 'step' : ''}`; num = hs[2]; }
        else if (ls) { kind = 'item'; num = ls[1]; }

        const tags = [...line.matchAll(TAG_RE)];
        if (LEGACY_RE.test(line)) warnings.push({ line: n, msg: 'old "Model/effort:" line; put a [model/effort] tag at the end of the step line instead' });

        if (kind) {
            const step = { n, kind, num, parent: kind === 'item' ? heading.line : 0, level: kind === 'item' ? 99 : parseInt(kind.slice(1), 10), text: raw.trim(), tags };
            stepLines.push(step);
            openItem = kind === 'item' ? step : null;
        } else if (openItem && tags.length && !/^\s*->\s*verify/i.test(line)) {
            // A tag at the end of a step's wrapped paragraph belongs to that step.
            openItem.tags.push(...tags);
            if (openItem.tags.length > 1) errors.push({ line: n, msg: `${openItem.tags.length} model tags on step ${openItem.num}; keep exactly one` });
            for (const t of tags) {
                const bad = validate(t[1], t[2]);
                if (bad) errors.push({ line: n, msg: `${t[0]}: ${bad}` });
            }
            return;
        }
        if (tags.length === 0) return;
        if (tags.length > 1) errors.push({ line: n, msg: `${tags.length} model tags on one line; keep exactly one` });
        for (const t of tags) {
            const bad = validate(t[1], t[2]);
            if (bad) errors.push({ line: n, msg: `${t[0]}: ${bad}` });
        }
        if (!kind) {
            // Headings and table rows look like work to a dispatcher: error. A tag
            // mentioned in running prose ("step 6 [opus/high] needs approval") is a note.
            if (h || line.trim().startsWith('|')) {
                errors.push({ line: n, msg: `tag on ${h ? 'a heading that is not a numbered step' : 'a table row'}; tags go only at the end of a numbered step line` });
            } else {
                warnings.push({ line: n, msg: 'tag inside prose, not on a step line; /tier ignores it' });
            }
        }
    });

    // All tags at one level. The level with the most tags is the step level; tags at any
    // other level are briefing sections or sub-points, and /tier would dispatch them.
    const tagged = stepLines.filter((s) => s.tags.length > 0);
    const byKind = new Map();
    for (const s of tagged) byKind.set(s.kind, (byKind.get(s.kind) || 0) + 1);
    let stepKind = null;
    for (const [k, c] of byKind) {
        if (!stepKind || c > byKind.get(stepKind) || (c === byKind.get(stepKind) && k === 'item')) stepKind = k;
    }
    if (byKind.size > 1) {
        for (const s of tagged.filter((x) => x.kind !== stepKind)) {
            errors.push({ line: s.n, msg: `tag at a second level ("${s.text.slice(0, 60)}"); the plan's steps are tagged elsewhere, so take this tag off` });
        }
    }

    // A tagged step must not contain tagged sub-steps.
    for (const s of tagged) {
        if (s.kind === 'item') continue;
        const after = lines.slice(s.n).findIndex((l) => { const m = l.match(HEADING_RE); return m && m[1].length <= s.level; });
        const stop = after >= 0 ? s.n + after + 1 : Infinity;
        const inner = tagged.filter((x) => x.n > s.n && x.n < stop && x !== s);
        if (inner.length) errors.push({ line: s.n, msg: `tagged section holds ${inner.length} tagged step(s) (line ${inner[0].n}); tag the steps, not the section` });
    }

    // Untagged siblings of tagged steps.
    const steps = stepKind ? stepLines.filter((s) => s.kind === stepKind) : [];
    const taggedParents = new Set(steps.filter((s) => s.tags.length).map((s) => s.parent));
    const runnable = steps.filter((s) => stepKind !== 'item' || taggedParents.has(s.parent));
    for (const s of runnable) {
        if (s.tags.length === 0 && (DONE_RE.test(s.text) || GATED_RE.test(s.text))) {
            warnings.push({ line: s.n, msg: `step ${s.num} has no tag; fine while it is gated or finished, tag it before it runs` });
        } else if (s.tags.length === 0) {
            errors.push({ line: s.n, msg: `step ${s.num} has no tag ("${s.text.slice(0, 60)}"); every step gets one` });
        }
    }
    if (tagged.length === 0) warnings.push({ line: 0, msg: 'no tagged steps; /tier will run every step at sonnet/medium' });

    errors.sort((a, b) => a.line - b.line);
    return {
        steps: runnable.map((s) => {
            const t = s.tags[0];
            return {
                line: s.n,
                n: s.num,
                title: s.text.replace(TAG_RE, '').replace(/^#+\s*/, '').trim(),
                tag: t ? `${t[1].toLowerCase()}/${t[2].toLowerCase() === 'med' ? 'medium' : t[2].toLowerCase()}` : null,
                done: DONE_RE.test(s.text),
                gated: GATED_RE.test(s.text),
            };
        }),
        errors,
        warnings,
    };
}

// Run through a skills symlink (~/.claude-ulix/skills/tier -> hub), argv[1] is the link
// path but import.meta.url is the real one; compare real paths or the script prints nothing.
const invokedAs = (() => { try { return realpathSync(process.argv[1] || ''); } catch { return ''; } })();
if (invokedAs && import.meta.url === pathToFileURL(invokedAs).href) {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) { console.error('usage: check-tags.mjs [--json] <plan.md>'); process.exit(2); }
    const result = checkPlan(readFileSync(file, 'utf8'));
    if (json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        for (const e of result.errors) console.log(`ERROR line ${e.line}: ${e.msg}`);
        for (const w of result.warnings) console.log(`warn  line ${w.line}: ${w.msg}`);
        console.log(`${result.steps.length} step(s) /tier will run, ${result.errors.length} error(s)`);
    }
    process.exit(result.errors.length ? 1 : 0);
}
