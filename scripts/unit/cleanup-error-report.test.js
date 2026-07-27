// Unit tests for the cleanup failure report (takeCleanupError).
//
// polishTranscript deliberately never throws — it logs and returns the raw
// transcript, so a broken cleanup engine can't cost you the dictation. The cost
// of that is invisibility: when Groq retired the configured model, every call
// 404'd and the app pasted unformatted text for weeks with no user-facing sign.
// takeCleanupError is how main.js learns to say so once. These tests stub fetch
// so nothing here touches the network.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { polishTranscript, takeCleanupError, resetCleanupFailureStreak } from "../../src/cleanup.js";

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

// A transcript long enough to be worth cleaning; content is irrelevant since
// fetch is stubbed.
const SAMPLE = "so um like I think we should uh ship this thing tomorrow";

function stubFetch(status, body = "{}") {
  globalThis.fetch = async () =>
    new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function useGroq() {
  process.env.CLEANUP_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key-not-real";
}

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
  takeCleanupError(); // drain, so one test can't leak state into the next
  resetCleanupFailureStreak();
});

test("a 404 (model retired) is reported, and the raw text still comes back", async () => {
  useGroq();
  stubFetch(404, '{"error":{"message":"model_not_found"}}');

  const out = await polishTranscript(SAMPLE);
  assert.equal(out, SAMPLE, "dictation must survive a dead cleanup engine");

  const reported = takeCleanupError();
  assert.match(String(reported), /404/, "the status the user needs to see");
  assert.match(String(reported), /unformatted/, "says what it means for them");
});

test("the report is consumed once, so one outage isn't announced every utterance", async () => {
  useGroq();
  stubFetch(404);

  await polishTranscript(SAMPLE);
  assert.notEqual(takeCleanupError(), null);
  assert.equal(takeCleanupError(), null, "second read is empty until it fails again");
});

test("a 429 is NOT reported — the free tier's per-minute limit clears itself", async () => {
  useGroq();
  stubFetch(429, '{"error":{"message":"Rate limit reached"}}');

  const out = await polishTranscript(SAMPLE);
  assert.equal(out, SAMPLE);
  assert.equal(takeCleanupError(), null, "a self-clearing limit is not worth interrupting anyone");
});

// The free tier is 12k tokens/minute. One 429 is noise, but a run of them means
// a whole session of silently unformatted text — say it once.
test("a run of 429s IS reported — the limit isn't clearing", async () => {
  useGroq();
  stubFetch(429, '{"error":{"message":"Rate limit reached"}}');

  await polishTranscript(SAMPLE);
  await polishTranscript(SAMPLE);
  assert.equal(takeCleanupError(), null);

  await polishTranscript(SAMPLE);
  assert.match(String(takeCleanupError()), /rate-limiting/i);
});

// A single blip must stay quiet. main.js announces the first error it is handed
// and then latches for the rest of the run, so spending that one warning on a
// 2.5s timeout would leave the app silent weeks later when the engine is really
// down — the exact outage this whole feature exists to catch.
test("one network blip is NOT reported; a streak of them is", async () => {
  useGroq();
  globalThis.fetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.groq.com");
  };

  const out = await polishTranscript(SAMPLE);
  assert.equal(out, SAMPLE, "dictation must survive a blip");
  assert.equal(takeCleanupError(), null, "one blip is not an outage");

  await polishTranscript(SAMPLE);
  assert.equal(takeCleanupError(), null, "two is still not an outage");

  await polishTranscript(SAMPLE);
  assert.match(String(takeCleanupError()), /couldn't reach groq/i, "three in a row is");
});

test("a success in between clears the streak, so scattered blips stay quiet", async () => {
  useGroq();
  const fail = async () => { throw new Error("getaddrinfo ENOTFOUND api.groq.com"); };
  const ok = JSON.stringify({ choices: [{ message: { content: "Cleaned." } }] });

  globalThis.fetch = fail;
  await polishTranscript(SAMPLE);
  await polishTranscript(SAMPLE);
  stubFetch(200, ok);
  await polishTranscript(SAMPLE);
  globalThis.fetch = fail;
  await polishTranscript(SAMPLE);

  assert.equal(takeCleanupError(), null, "2 + success + 1 is not a streak of 3");
});

test("a successful pass reports nothing", async () => {
  useGroq();
  stubFetch(200, JSON.stringify({ choices: [{ message: { content: "So I think we should ship this tomorrow." } }] }));

  const out = await polishTranscript(SAMPLE);
  assert.equal(out, "So I think we should ship this tomorrow.");
  assert.equal(takeCleanupError(), null);
});
