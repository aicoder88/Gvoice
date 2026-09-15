// Runs real Electron clipboard + DOM consumers. No native keystrokes, speech,
// providers, or production profile. Four simulated target accessibility modes.
import { app, BrowserWindow, clipboard } from 'electron';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createTextTyper } from '../../src/typing.js';
import { getClipboardChangeCount } from '../../src/clipboard-sequence.js';
import { assessPasteOutcome } from '../../src/paste-confidence.js';
import { initHistory, recordTranscript, getHistory } from '../../src/history.js';

async function run() {
const profile = mkdtempSync(join(tmpdir(), 'gvoice-clipboard-stress-'));
app.setPath('userData', profile);
await app.whenReady();
console.log(JSON.stringify({ phase: 'ready', profile }));
await initHistory();
const target = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
await target.loadURL('data:text/html,<title>GVoice delayed paste fixture</title><textarea id="target"></textarea>');
const oldText = clipboard.readText();
let finalCount = null;
const workers = Array.from({ length: 2 }, () => new Worker(`const { parentPort } = require('node:worker_threads'); let x=0; for (;;) { for(let i=0;i<1000000;i++) x=Math.sin(x+i); }`, { eval: true }));
const records = [];
let consumer;
let delay = 350;
const type = createTextTyper({ releaseDelayMs: 0, sendShortcut: async () => {
  // Clipboard contents are read AFTER the delay, never cached on dispatch.
  consumer = target.webContents.executeJavaScript(`new Promise(resolve => {
    const field = document.querySelector('#target'); field.value = ''; let events = 0;
    setTimeout(() => { field.value += require('electron').clipboard.readText(); events++;
      resolve({ value: field.value, events, consumedAt: Date.now() }); }, ${delay});
  })`);
} });
try {
  assert.ok(getClipboardChangeCount() != null, 'Native clipboard sequence support is required, not skipped');
  for (const mode of ['readable-editor', 'chromium-field', 'terminal-unreadable', 'cmux-unreadable']) {
    for (let index = 0; index < 100; index++) {
      const text = 'DICTATION-' + randomUUID();
      const old = 'OLD-CLIPBOARD-' + randomUUID();
      clipboard.writeText(old);
      const startedAt = Date.now();
      const beforeCount = getClipboardChangeCount();
      delay = 300 + index % 4 * 35;
      const lease = await type(text, { exact: true });
      const acquiredCount = getClipboardChangeCount();
      const dispatchedAt = Date.now();
      // Match production's one early read-back: delayed targets are unverified.
      await new Promise(resolve => setTimeout(resolve, 150));
      const outcome = assessPasteOutcome({ typed: true, restoreRequired: false,
        fieldFocused: !mode.includes('unreadable'), isTerminal: mode.includes('unreadable'),
        fieldValue: mode.includes('unreadable') ? null : '', beforeValue: '', sameField: true, text });
      const state = lease.finish(outcome.deliveryState);
      recordTranscript(text, true, null, { deliveryState: state });
      const observed = await consumer;
      assert.ok(observed.value === text, 'Delayed consumer lost dictation or received previous clipboard (values withheld)');
      assert.equal(observed.events, 1, 'Target must consume exactly once');
      assert.ok(clipboard.readText() === text, 'Unverified payload must remain recoverable from clipboard');
      assert.ok(getHistory()[0].text === text && getHistory()[0].deliveryState === 'sent-unverified', 'History must retain exact text and state');
      finalCount = getClipboardChangeCount();
      records.push({ mode, index, startedAt, dispatchedAt, consumedAt: observed.consumedAt,
        beforeCount, acquiredCount, afterCount: finalCount, state, events: observed.events,
        oldClipboardInserted: observed.value === old, exactDelivery: observed.value === text, clipboardRecoverable: true, historyRecoverable: true });
      if ((index + 1) % 25 === 0) console.log(JSON.stringify({ mode, attempts: index + 1, oldClipboardInsertions: 0, lostDictations: 0 }));
    }
  }
  const report = { observedAt: new Date().toISOString(), result: 'passed', total: records.length,
    fixtureTargets: 4, attemptsPerTarget: 100, cpuPressureWorkers: workers.length,
    coverage: 'Production typing queue and clipboard lease, real OS clipboard, delayed Electron DOM consumer; simulated AX modes, no native keystrokes',
    profile, records };
  writeFileSync(join(profile, 'clipboard-stress.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: 'passed', total: records.length, report: join(profile, 'clipboard-stress.json') }));
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', completed: records.length, message: error.message }));
  process.exitCode = 1;
} finally {
  for (const worker of workers) await worker.terminate();
  // Preserve a clipboard changed externally while the stress run was ending.
  if (finalCount != null && getClipboardChangeCount() === finalCount) clipboard.writeText(oldText);
  target.destroy();
  app.exit(process.exitCode || 0);
}

}
void run().catch(error => { console.error(JSON.stringify({ result: "failed", message: error.message })); app.exit(1); });
