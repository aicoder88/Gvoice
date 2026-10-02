import assert from 'node:assert/strict';
import { checkPlan } from './check-tags.mjs';

const full = ['fable', 'opus', 'sonnet', 'haiku', 'gpt-6.1-sol', 'gpt-6-sol',
  'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
const capped = ['gpt-5.5', 'gpt-5.3-codex-spark'];
let accepted = 0;
for (const model of [...full, ...capped]) {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const result = checkPlan(`1. Work [${model}/${effort}]`);
    if (capped.includes(model) && effort === 'max') assert.equal(result.errors.length, 1);
    else { assert.deepEqual(result.errors, []); assert.equal(result.steps[0].tag, `${model}/${effort}`); accepted++; }
  }
  const legacy = checkPlan(`1. Work [${model}/med]`);
  assert.deepEqual(legacy.errors, []);
  assert.equal(legacy.steps[0].tag, `${model}/medium`);
}
for (const effort of ['low', 'medium']) assert.deepEqual(checkPlan(`1. Work [deepseek/${effort}]`).errors, []);
for (const tag of ['gpt-6-terra/low', 'gpt-6.1-sol/ultra', 'gpt-6-luna/none', 'sonnet/minimal', 'deepseek/high'])
  assert.ok(checkPlan(`1. Work [${tag}]`).errors.length, tag);
assert.ok(checkPlan('## Background [sonnet/medium]').errors.length);
assert.ok(checkPlan('1. Work [sonnet/medium] [opus/high]').errors.length);
const wrapped = checkPlan('1. Work\n   continued [gpt-6.1-sol/medium]\n\n2. GATED release\n3. DONE prior work');
assert.deepEqual(wrapped.errors, []);
assert.equal(wrapped.steps[1].gated, true);
assert.equal(wrapped.steps[2].done, true);
console.log(`${accepted} current/historical model-effort pairs, legacy aliases, invalid tags, placement and completion gates passed`);
