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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

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

  // The message goes on the pill and into a system notification, so it is
  // written for a person: what happened to their text, not the status code and
  // model name (those stay in the console line).
  const reported = takeCleanupError();
  assert.match(String(reported), /tidy-up isn't working/i, "plain words, not a status code");
  assert.match(String(reported), /exactly as you said it/i, "says what it means for them");
  assert.doesNotMatch(String(reported), /404|llama|groq/i, "no jargon on a user-facing string");
});

test("the report is consumed once, so one outage isn't announced every utterance", async () => {
  useGroq();
  stubFetch(404);

  await polishTranscript(SAMPLE);
  assert.notEqual(takeCleanupError(), null);
  assert.equal(takeCleanupError(), null, "second read is empty until it fails again");
});

// Every 429 is a dictation that went in unformatted. The user asked to be told
// each time, so it is reported on the
// FIRST hit. main.js puts it on that dictation's pill and deliberately does NOT
// raise a system notification for it: the cap clears itself within the minute.
test("a 429 is reported on the first hit — that dictation went in unformatted", async () => {
  useGroq();
  stubFetch(429, '{"error":{"message":"Rate limit reached"}}');

  const out = await polishTranscript(SAMPLE);
  assert.equal(out, SAMPLE, "the dictation still survives");
  assert.match(String(takeCleanupError()), /free tidy-up limit/i);
});

test("a daily 429 identifies the daily reset, not a minute", async () => {
  useGroq();
  stubFetch(429, '{"error":{"message":"Rate limit on tokens per day (TPD)"}}');

  assert.equal(await polishTranscript(SAMPLE), SAMPLE);
  const warning = String(takeCleanupError());
  assert.match(warning, /today's free tidy-up allowance/i);
  assert.match(warning, /daily reset/i);
  assert.doesNotMatch(warning, /minute/i);
});

test("every later 429 is reported too, one per dictation", async () => {
  useGroq();
  stubFetch(429, '{"error":{"message":"Rate limit reached"}}');

  await polishTranscript(SAMPLE);
  takeCleanupError();
  await polishTranscript(SAMPLE);
  assert.match(String(takeCleanupError()), /free tidy-up limit/i);
});

test("100 rapid limit failures all preserve the dictation and report the problem", async () => {
  useGroq();
  stubFetch(429, '{"error":{"message":"Rate limit reached"}}');
  const realError = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 100; i += 1) {
      assert.equal(await polishTranscript(SAMPLE), SAMPLE);
      assert.match(String(takeCleanupError()), /free tidy-up limit/i);
    }
  } finally {
    console.error = realError;
  }
});

// A single blip must stay quiet. A 2.5s timeout is not an outage, and the pill
// it would paint says "tidy-up is broken" about a dictation that was fine.
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
  assert.match(String(takeCleanupError()), /can't reach the tidy-up service/i, "three in a row is");
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
  stubFetch(200, JSON.stringify({ choices: [{ message: { content: "So, like, I think we should ship this thing tomorrow." } }] }));

  const out = await polishTranscript(SAMPLE);
  assert.equal(out, "So, like, I think we should ship this thing tomorrow.");
  assert.equal(takeCleanupError(), null);
});

test("the custom dictionary rides on the system prompt, never the user message", async () => {
  // Measured 2026-07-31: with the dictionary hint sitting in the user message
  // between the instruction and the transcript, llama-3.3-70b stopped building
  // numbered lists and started dropping the speaker's lead-in — a dictionary of
  // one junk term was enough. Rules belong with the rules.
  useGroq();
  const { init: initVocab, addTerm } = await import("../../src/vocab.js");
  const store = join(tmpdir(), `gvoice-vocab-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  initVocab(store);
  addTerm("Debezium");

  let sent = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "cleaned" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  await polishTranscript(SAMPLE);
  rmSync(store, { force: true });

  const [system, user] = sent.messages;
  assert.equal(system.role, "system");
  assert.match(system.content, /Debezium/, "the dictionary belongs in the system prompt");
  assert.doesNotMatch(user.content, /Debezium/, "and nowhere near the transcript");
  assert.match(user.content, /<<<TRANSCRIPT>>>/);
});

test("an approved dictionary spelling can pass the word safety check", async () => {
  useGroq();
  const { init: initVocab, addTerm } = await import("../../src/vocab.js");
  const store = join(tmpdir(), `gvoice-vocab-guard-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  initVocab(store);
  addTerm("Debezium");
  stubFetch(200, JSON.stringify({ choices: [{ message: { content: "Debezium is ready." } }] }));

  const out = await polishTranscript("Debezum is ready");
  rmSync(store, { force: true });
  assert.equal(out, "Debezium is ready.");
});

test("switching cleanup providers never carries the other provider's built-in model", async () => {
  process.env.CLEANUP_PROVIDER = "openai";
  process.env.CLEANUP_MODEL = "openai/gpt-oss-120b";
  process.env.OPENAI_API_KEY = "test-key-not-real";
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ choices: [{ message: { content: "So, like, I think we should ship this thing tomorrow." } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  await polishTranscript(SAMPLE);
  assert.match(sent.url, /api\.openai\.com/);
  assert.equal(sent.body.model, "gpt-4.1-mini");

  process.env.CLEANUP_PROVIDER = "groq";
  process.env.CLEANUP_MODEL = "gpt-4.1-mini";
  await polishTranscript(SAMPLE);
  assert.match(sent.url, /api\.groq\.com/);
  assert.equal(sent.body.model, "openai/gpt-oss-120b");
});
