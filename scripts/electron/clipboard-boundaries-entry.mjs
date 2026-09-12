import { app, clipboard } from 'electron';
import assert from 'node:assert/strict';
import { createTextTyper } from '../../src/typing.js';
import { createClipboardLease } from '../../src/clipboard-lease.js';
import { getClipboardChangeCount } from '../../src/clipboard-sequence.js';
import { decidePasteOwnership } from '../../src/paste-confidence.js';

async function run() {
  await app.whenReady();
  assert.ok(getClipboardChangeCount() != null, 'Native clipboard counter required');
  const original = clipboard.readText();
  const options = { getChangeCount: getClipboardChangeCount };
  const checks = [];
  let count;
  try {
    for (const sameValue of [false, true]) {
      const lease = createClipboardLease(clipboard, 'DICTATION-fixture', options);
      const user = sameValue ? 'DICTATION-fixture' : 'USER-COPY-fixture';
      clipboard.writeText(user);
      assert.equal(lease.finish('verified'), 'superseded');
      assert.ok(clipboard.readText() === user, 'New user clipboard must win');
      checks.push({ name: sameValue ? 'same-value-user-copy' : 'user-copy', passed: true, changeCount: getClipboardChangeCount() });
    }
    let dispatches = 0;
    const type = createTextTyper({ releaseDelayMs: 10, sendShortcut: async () => { dispatches++; } });
    const refused = await type('DICTATION-refused', { canPaste: () => decidePasteOwnership(100, 200) === 'same' });
    assert.equal(refused, null);
    assert.equal(dispatches, 0);
    checks.push({ name: 'focus-change-refuses-transport', passed: true, dispatches });
    const first = await type('DICTATION-first');
    first.finish('sent-unverified');
    const second = await type('DICTATION-second');
    first.finish('verified');
    second.finish('verified');
    assert.ok(clipboard.readText().trim() === 'DICTATION-second', 'Consecutive deliveries must not restore one another');
    checks.push({ name: 'consecutive-clipboard-leases', passed: true, dispatches });
    let currentPid = 100;
    const lateFocusType = createTextTyper({ releaseDelayMs: 0, sendShortcut: async ({ expectedPid }) => {
      // Model a switch after the initial guard while the OS helper launches.
      currentPid = 200;
      return { refused: currentPid !== expectedPid };
    } });
    const lateFocus = await lateFocusType('DICTATION-focus-change', { expectedPid: 100, canPaste: () => currentPid === 100 });
    assert.equal(lateFocus.dispatched, false);
    assert.equal(lateFocus.refused, true);
    lateFocus.finish('refused');
    assert.ok(clipboard.readText().trim() === 'DICTATION-focus-change', 'Dispatch-time refusal retains recovery');
    checks.push({ name: 'focus-change-during-helper-launch', passed: true });
    const failedType = createTextTyper({ releaseDelayMs: 0, sendShortcut: async () => { throw new Error('fixture transport failure'); } });
    const failed = await failedType('DICTATION-failure');
    assert.equal(failed.dispatched, false);
    failed.finish('failed');
    assert.ok(clipboard.readText().trim() === 'DICTATION-failure', 'Failure must preserve recovery');
    checks.push({ name: 'transport-failure-recovery', passed: true });
    clipboard.writeText('OLD-CLIPBOARD-readable');
    const verified = createClipboardLease(clipboard, 'DICTATION-verified', options);
    verified.finish('verified');
    assert.ok(clipboard.readText() === 'OLD-CLIPBOARD-readable', 'Verified delivery restores owned clipboard');
    checks.push({ name: 'verified-restore', passed: true });
    count = getClipboardChangeCount();
    console.log(JSON.stringify({ result: 'passed', observedAt: new Date().toISOString(), coverage: 'Running Electron native clipboard and production typing queue; no native target UI', checks }));
  } finally {
    if (count != null && getClipboardChangeCount() === count) clipboard.writeText(original);
  }
  app.exit(0);
}
void run().catch(error => { console.error(JSON.stringify({ result: 'failed', message: error.message })); app.exit(1); });
