import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardLease } from '../../src/clipboard-lease.js';

test('an unreadable target consuming after 250 ms must receive its dictation', () => {
  let text = 'OLD-CLIPBOARD-fixture', changes = 0;
  const callbacks = [];
  const clipboard = { readText: () => text, writeText: value => { text = value; changes++; },
    readImage: () => ({ isEmpty: () => true }), availableFormats: () => ['text/plain'] };
  const lease = createClipboardLease(clipboard, 'DICTATION-fixture', {
    getChangeCount: () => changes, schedule: callback => callbacks.push(callback), cancel: () => {} });
  // Simulate the delayed target only consuming after all restore timers fire.
  for (const callback of callbacks) callback();
  assert.ok(clipboard.readText() === 'DICTATION-fixture', 'Delayed paste inserted old clipboard; sentinel contents withheld');
  lease.keep();
});

function fixture(initial = 'previous') {
  let text = initial, count = 0;
  const clipboard = { readText: () => text, writeText: value => { text = value; count++; },
    availableFormats: () => ['text/plain'], readImage: () => ({ isEmpty: () => true }) };
  return { clipboard, options: { getChangeCount: () => count } };
}
for (const state of ['sent-unverified', 'refused', 'failed', 'superseded']) {
  test(`${state} retains the acquired dictation without any restore timer`, async () => {
    const { clipboard, options } = fixture();
    const lease = createClipboardLease(clipboard, 'dictation', options);
    assert.equal(lease.finish(state), state);
    assert.equal(await lease.settled, state);
    assert.ok(clipboard.readText() === 'dictation');
  });
}
test('verified delivery restores only the lease it still owns', () => {
  const { clipboard, options } = fixture();
  const lease = createClipboardLease(clipboard, 'dictation', options);
  assert.equal(lease.finish('verified'), 'verified');
  assert.ok(clipboard.readText() === 'previous');
});
test('same-value user copy revokes restoration ownership', () => {
  const { clipboard, options } = fixture();
  const lease = createClipboardLease(clipboard, 'dictation', options);
  clipboard.writeText('dictation');
  assert.equal(lease.finish('verified'), 'superseded');
  assert.ok(clipboard.readText() === 'dictation');
});
test('a newer user copy wins on verification failure too', () => {
  const { clipboard, options } = fixture();
  const lease = createClipboardLease(clipboard, 'dictation', options);
  clipboard.writeText('user');
  assert.equal(lease.finish('failed'), 'superseded');
  assert.ok(clipboard.readText() === 'user');
});
test('consecutive leases cannot restore each others payloads', () => {
  const { clipboard, options } = fixture();
  const first = createClipboardLease(clipboard, 'first', options);
  first.finish('sent-unverified');
  const next = createClipboardLease(clipboard, 'next', options);
  first.finish('verified');
  assert.ok(clipboard.readText() === 'next');
  next.finish('verified');
  assert.ok(clipboard.readText() === 'next');
});
test('missing clipboard sequence support fails closed on restoration', () => {
  const { clipboard } = fixture();
  createClipboardLease(clipboard, 'dictation').finish('verified');
  assert.ok(clipboard.readText() === 'dictation');
});

const { assessPasteOutcome, exactInsertionConfirmed } = await import('../../src/paste-confidence.js');
test('only an exact new insertion is delivery proof', () => {
  for (const [before, text, after] of [['', 'test', 'test'], ['before after', 'new ', 'before new after'], ['aaaa', 'aa', 'aaaaaa'], ['Notes\n', 'čćžšđ', 'Notes\nčćžšđ']]) {
    assert.equal(exactInsertionConfirmed(before, after, text), true);
  }
  for (const [before, text, after] of [['test', 'test', 'test'], ['', 'two words', 'two  words'], ['', "it's", 'it’s'], ['', 'once', 'onceonce']]) {
    assert.equal(exactInsertionConfirmed(before, after, text), false);
  }
  assert.equal(assessPasteOutcome({ typed: true, beforeValue: '', fieldValue: 'dictation', text: 'dictation', sameField: false }).deliveryState, 'sent-unverified');
});
test('restore failure cannot throw away the delivery result or block the next dictation', async () => {
  const { clipboard, options } = fixture();
  const lease = createClipboardLease(clipboard, 'dictation', options);
  clipboard.writeText = () => { throw new Error('simulated OS clipboard failure'); };
  assert.equal(lease.finish('verified'), 'verified');
  assert.equal(await lease.settled, 'verified');
  assert.ok(clipboard.readText() === 'dictation');
});
