import { test } from 'node:test';
import assert from 'node:assert/strict';

test('one cleanup deadline bounds retries and late failures cannot contaminate next call', async () => {
  const env = { ...process.env }, savedFetch = globalThis.fetch;
  process.env.CLEANUP_PROVIDER = 'groq';
  process.env.GROQ_API_KEY = 'test-only';
  process.env.CLEANUP_TIMEOUT_MS = '40';
  const { polishTranscript, takeCleanupError } = await import('../../src/cleanup.js?deadline-test');
  let rejectOld;
  try {
    globalThis.fetch = () => new Promise((_, reject) => { rejectOld = reject; });
    const start = performance.now();
    assert.equal(await polishTranscript('Keep the original words.'), 'Keep the original words.');
    assert.ok(performance.now() - start < 1000, 'fetch ignoring abort must still be bounded');
    assert.match(takeCleanupError(), /took too long/);
    globalThis.fetch = async () => new Response(JSON.stringify({choices:[{message:{content:'Next call.'}}]}), {status:200});
    assert.equal(await polishTranscript('next call'), 'Next call.');
    rejectOld(new Error('late network failure'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(takeCleanupError(), null, 'old deadline must not attach a warning to next call');
  } finally { globalThis.fetch = savedFetch; process.env = env; }
});
