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
import {
  polishTranscript,
  takeCleanupError,
  resetCleanupFailureStreak,
  resetCleanupModelCache
} from "../../src/cleanup.js";
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
  resetCleanupModelCache();
});

test("a retired default model falls back once and remembers the working model", async () => {
  useGroq();
  const requestedModels = [];
  const responses = [
    new Response('{"error":{"message":"model_not_found"}}', { status: 404 }),
    new Response('{"choices":[{"message":{"content":"Cleaned once."}}]}', { status: 200 }),
    new Response('{"choices":[{"message":{"content":"Cleaned twice."}}]}', { status: 200 })
  ];
  globalThis.fetch = async (_url, init) => {
    requestedModels.push(JSON.parse(String(init.body)).model);
    return responses.shift();
  };

  assert.equal(await polishTranscript(SAMPLE), "Cleaned once.");
  assert.equal(await polishTranscript(SAMPLE), "Cleaned twice.");
  assert.deepEqual(requestedModels, [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-20b"
  ]);
  assert.equal(takeCleanupError(), null, "successful fallback is invisible to the user");
});

// The other half of the rule above: a 429 is this minute's token bucket, not a
// retirement. Remembering the backup after one would leave every later
// dictation on the weaker model until the app restarts, for a blip that clears
// itself inside a minute.
test("a rate-limited fallback is NOT remembered — the next dictation retries the primary", async () => {
  useGroq();
  const requestedModels = [];
  const responses = [
    new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 }),
    new Response('{"choices":[{"message":{"content":"Cleaned once."}}]}', { status: 200 }),
    new Response('{"choices":[{"message":{"content":"Cleaned twice."}}]}', { status: 200 })
  ];
  globalThis.fetch = async (_url, init) => {
    requestedModels.push(JSON.parse(String(init.body)).model);
    return responses.shift();
  };

  assert.equal(await polishTranscript(SAMPLE), "Cleaned once.");
  assert.equal(await polishTranscript(SAMPLE), "Cleaned twice.");
  assert.deepEqual(requestedModels, [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b"
  ]);
});

test("an explicit cleanup model never silently falls back", async () => {
  useGroq();
  process.env.CLEANUP_MODEL = "my-pinned-model";
  const requestedModels = [];
  globalThis.fetch = async (_url, init) => {
    requestedModels.push(JSON.parse(String(init.body)).model);
    return new Response('{"error":{"message":"model_not_found"}}', { status: 404 });
  };

  assert.equal(await polishTranscript(SAMPLE), SAMPLE);
  assert.deepEqual(requestedModels, ["my-pinned-model"]);
  assert.match(String(takeCleanupError()), /tidy-up isn't working/i);
});

test("a rate-limited default model uses the backup model's separate quota", async () => {
  useGroq();
  const requestedModels = [];
  const responses = [
    new Response('{"error":{"message":"rate limit"}}', { status: 429 }),
    new Response('{"choices":[{"message":{"content":"Cleaned by backup."}}]}', { status: 200 })
  ];
  globalThis.fetch = async (_url, init) => {
    requestedModels.push(JSON.parse(String(init.body)).model);
    return responses.shift();
  };

  assert.equal(await polishTranscript(SAMPLE), "Cleaned by backup.");
  assert.deepEqual(requestedModels, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  assert.equal(takeCleanupError(), null);
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

// The free tier is 8k tokens/minute per model and one cleanup costs ~2.2k, so
// three or four dictations a minute on the primary before the backup model's
// own bucket takes over. Every 429 past that is a dictation that went in
// unformatted — the user asked to be told each time, so it is reported on the
// FIRST hit. main.js puts it on that dictation's pill and deliberately does NOT
// raise a system notification for it: the cap clears itself within the minute.
test("a 429 is reported on the first hit — that dictation went in unformatted", async () => {
  useGroq();
  stubFetch(429, '{"error":{"message":"Rate limit reached"}}');

  const out = await polishTranscript(SAMPLE);
  assert.equal(out, SAMPLE, "the dictation still survives");
  assert.match(String(takeCleanupError()), /free tidy-up limit/i);
});

test("every later 429 is reported too, one per dictation", async () => {
  useGroq();
  stubFetch(429, '{"error":{"message":"Rate limit reached"}}');

  await polishTranscript(SAMPLE);
  takeCleanupError();
  await polishTranscript(SAMPLE);
  assert.match(String(takeCleanupError()), /free tidy-up limit/i);
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
  stubFetch(200, JSON.stringify({ choices: [{ message: { content: "So I think we should ship this tomorrow." } }] }));

  const out = await polishTranscript(SAMPLE);
  assert.equal(out, "So I think we should ship this tomorrow.");
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
