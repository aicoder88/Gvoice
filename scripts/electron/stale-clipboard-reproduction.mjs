// Execute the installed artifact's typing code with a virtual OS transport and
// delayed consumer. This proves its timer behavior without typing into any app.
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const archive = process.argv[2] || '/Applications/GVoice.app/Contents/Resources/app.asar';
const source = require('@electron/asar').extractFile(archive, 'src/typing.js').toString();
const old = 'OLD-CLIPBOARD-' + randomUUID();
const dictation = 'DICTATION-' + randomUUID();
let text = old, changes = 0, dispatches = 0;
const restorations = [];
const context = {
  clipboard: { readText: () => text, readImage: () => ({ isEmpty: () => true }), writeText: value => { text = value; changes++; } },
  execFile: (_bin, _args, _options, callback) => { dispatches++; callback(null); },
  sendPasteShortcut: () => false,
  process: { platform: 'darwin', env: { TYPE_VIA_CLIPBOARD: 'true' } },
  setTimeout: (fn, ms) => { if (ms === 250) restorations.push(fn); else if (ms === 80) queueMicrotask(fn); return ms; },
  clearTimeout: () => {},
};
runInNewContext(source.replace(/^import .*;$/mg, '').replace(/export /g, '') + '\nglobalThis.invoke = typeText;', context);
await context.invoke(dictation);
assert.ok(text.trim() === dictation, 'Installed transport acquired dictation');
for (const restore of restorations) restore();
assert.ok(text === old, 'Installed 250 ms restore must reproduce previous clipboard insertion');
console.log(JSON.stringify({ archive, typingSha256: createHash('sha256').update(source).digest('hex'),
  installedArtifactReproduction: true, observedAt: new Date().toISOString(), simulatedConsumerDelayMs: 400,
  restoreDelayMs: 250, dispatches, clipboardChanges: changes, oldClipboardInserted: text === old,
  dictationLostFromClipboard: text.trim() !== dictation, nativeTarget: false }));
