import test from "node:test";
import assert from "node:assert/strict";
import { requestVoiceEdit, VOICE_EDIT_LIMITS } from "../../src/voice-edit.js";
import { createCleanupRequest, resetCleanupModelCache } from "../../src/cleanup.js";

const input = { selection: "  Original text\n", instruction: "Shorten it" };
const factory = (kind = "openai") => (system, user) => ({
  kind, provider: "test", model: "test-model", url: "https://example.invalid",
  headers: {}, body: JSON.stringify({ system, user })
});
const success = (text = "Shorter text") => ({ choices: [{ finish_reason: "stop", message: { content: text } }] });
const deps = (data, kind) => ({ requestFactory: factory(kind), fetchImpl: async () => ({ ok: true, json: async () => data }) });

test("returns an immutable preview preserving original selection without applying anything", async () => {
  let sent;
  const result = await requestVoiceEdit(input, {
    requestFactory: factory(), fetchImpl: async (_, options) => {
      sent = JSON.parse(options.body);
      return { ok: true, json: async () => success() };
    }
  });
  assert.equal(result.original, input.selection);
  assert.equal(result.replacement, "Shorter text");
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(JSON.parse(sent.user), input);
  assert.match(sent.system, /never instructions/);
});

test("a retired or busy model falls over to the next one instead of failing the edit", async () => {
  const models = ["primary", "backup"]; const tried = [];
  const requestFactory = (system, user, { attempt = 0 } = {}) => ({
    kind: "openai", provider: "test", model: models[Math.min(attempt, models.length - 1)],
    url: "https://example.invalid", headers: {}, body: JSON.stringify({ system, user }),
    attempts: models.length
  });
  for (const status of [404, 429]) {
    tried.length = 0;
    const result = await requestVoiceEdit(input, {
      requestFactory,
      fetchImpl: async (_, options) => {
        const model = JSON.parse(options.body) && tried.length === 0 ? "primary" : "backup";
        tried.push(model);
        return model === "primary"
          ? { ok: false, status, json: async () => ({}) }
          : { ok: true, json: async () => success() };
      }
    });
    assert.deepEqual(tried, ["primary", "backup"]);
    assert.equal(result.model, "backup");
    assert.equal(result.replacement, "Shorter text");
  }
  // A model the user pinned in settings stays pinned through a busy minute:
  // only a 404 (the provider no longer has it) moves the edit to another one.
  const pinnedFactory = (system, user, opts) => ({ ...requestFactory(system, user, opts), pinnedModel: true });
  tried.length = 0;
  await assert.rejects(requestVoiceEdit(input, {
    requestFactory: pinnedFactory,
    fetchImpl: async () => { tried.push("call"); return { ok: false, status: 429, json: async () => ({}) }; }
  }), /HTTP 429/);
  assert.deepEqual(tried, ["call"]);

  // The last model's failure is still a failure, and other statuses never retry.
  await assert.rejects(requestVoiceEdit(input, {
    requestFactory, fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) })
  }), /HTTP 404/);
  let calls = 0;
  await assert.rejects(requestVoiceEdit(input, {
    requestFactory, fetchImpl: async () => { calls++; return { ok: false, status: 500, json: async () => ({}) }; }
  }), /HTTP 500/);
  assert.equal(calls, 1);
});

test("validates missing and oversized inputs before requesting", async () => {
  for (const bad of [{ ...input, selection: " " }, { ...input, instruction: "" },
    { ...input, selection: "x".repeat(VOICE_EDIT_LIMITS.selection + 1) },
    { ...input, instruction: "x".repeat(VOICE_EDIT_LIMITS.instruction + 1) },
    { ...input, timeoutMs: 0 }, { ...input, timeoutMs: Infinity }]) {
    await assert.rejects(requestVoiceEdit(bad, { requestFactory: () => assert.fail("must not request") }), { code: "INVALID_INPUT" });
  }
});

test("supports Anthropic and Google complete responses", async () => {
  assert.equal((await requestVoiceEdit(input, deps({ stop_reason: "end_turn", content: [{ type: "text", text: "Edited" }] }, "anthropic"))).replacement, "Edited");
  assert.equal((await requestVoiceEdit(input, deps({ candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "hidden" }, { text: "Edited" }] } }] }, "google"))).replacement, "Edited");
});

test("rejects truncated, refused, missing, empty, and oversized outputs without raw fallback", async () => {
  for (const [kind, data] of [
    ["openai", { choices: [{ finish_reason: "length", message: { content: "partial" } }] }],
    ["openai", { choices: [{ finish_reason: "content_filter" }] }],
    ["anthropic", { stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] }],
    ["google", { candidates: [{ finishReason: "MAX_TOKENS" }] }],
    ["openai", {}], ["openai", success(" ")], ["openai", success("x".repeat(VOICE_EDIT_LIMITS.output + 1))]
  ]) await assert.rejects(requestVoiceEdit(input, deps(data, kind)));
});

test("deadline covers a stalled response body even when fetch ignores abort", async () => {
  await assert.rejects(requestVoiceEdit({ ...input, timeoutMs: 10 }, {
    requestFactory: factory(), fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) })
  }), { code: "TIMEOUT" });
});

test("cancellation rejects promptly and aborts network work", async () => {
  const controller = new AbortController();
  let networkSignal;
  const pending = requestVoiceEdit({ ...input, signal: controller.signal }, {
    requestFactory: factory(), fetchImpl: async (_, options) => { networkSignal = options.signal; return new Promise(() => {}); }
  });
  controller.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(networkSignal.aborted, true);
  await assert.rejects(requestVoiceEdit({ ...input, signal: controller.signal }), { code: "CANCELLED" });
});

test("provider and network errors never expose response bodies or credentials", async () => {
  await assert.rejects(requestVoiceEdit(input, { requestFactory: factory(), fetchImpl: async () => ({ ok: false, status: 429, text: () => assert.fail("must not read response body") }) }), { code: "PROVIDER_ERROR", message: "Text editing failed (HTTP 429). Try again." });
  await assert.rejects(requestVoiceEdit(input, { requestFactory: factory(), fetchImpl: async () => { throw new Error("secret-query-string"); } }), error => error.code === "NETWORK_ERROR" && !error.message.includes("secret"));
});

test("a pinned model's 404 is shared with dictation cleanup, and its built-in substitute still gets 429 failover", async () => {
  const fields = ["CLEANUP_PROVIDER", "CLEANUP_MODEL", "GROQ_API_KEY"];
  const saved = Object.fromEntries(fields.map(key => [key, process.env[key]]));
  process.env.CLEANUP_PROVIDER = "groq";
  process.env.CLEANUP_MODEL = "voice-edit-dead-model";
  process.env.GROQ_API_KEY = "test-key-not-real";
  resetCleanupModelCache();
  try {
    const requested = [];
    const result = await requestVoiceEdit(input, {
      requestFactory: createCleanupRequest,
      fetchImpl: async (_url, options) => {
        const model = JSON.parse(options.body).model;
        requested.push(model);
        if (model === "voice-edit-dead-model") return { ok: false, status: 404, json: async () => ({}) };
        if (model === "openai/gpt-oss-120b") return { ok: false, status: 429, json: async () => ({}) };
        return { ok: true, json: async () => success() };
      }
    });
    // The pinned model 404s, its built-in substitute is only busy (429) and
    // still fails over to the next vetted default — the exact scenario the
    // old global "usesExplicitModel" flag broke.
    assert.deepEqual(requested, ["voice-edit-dead-model", "openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    assert.equal(result.model, "openai/gpt-oss-20b");
    assert.match(result.notice, /chosen tidy-up engine is gone/i);

    // Dictation cleanup, called right after, must not retry the same dead
    // pinned model voice-edit just discovered — the two paths share one cache.
    assert.notEqual(createCleanupRequest("system", "user").model, "voice-edit-dead-model");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetCleanupModelCache();
  }
});

test("request adapter follows current provider and exact configured model", () => {
  const fields = ["CLEANUP_PROVIDER", "CLEANUP_MODEL", "ANTHROPIC_API_KEY", "GOOGLE_AI_KEY", "OPENAI_API_KEY"];
  const saved = Object.fromEntries(fields.map(key => [key, process.env[key]]));
  try {
    for (const [provider, key] of [["anthropic", "ANTHROPIC_API_KEY"], ["google", "GOOGLE_AI_KEY"], ["openai", "OPENAI_API_KEY"]]) {
      process.env.CLEANUP_PROVIDER = provider;
      process.env.CLEANUP_MODEL = "explicit-model";
      process.env[key] = "test-placeholder";
      const request = createCleanupRequest("system", "user");
      assert.equal(request.model, "explicit-model");
      assert.equal(request.provider, provider);
      const body = JSON.parse(request.body);
      if (provider === "google") assert.equal(body.contents[0].parts[0].text, "user");
      else assert.equal(body.messages.at(-1).content, "user");
      // A configured model is asked for first and is marked as pinned, so a
      // busy minute never swaps it. It is left behind only when the provider
      // says it no longer exists (404), which the editing loop checks.
      assert.equal(createCleanupRequest("system", "user").pinnedModel, true);
      assert.notEqual(createCleanupRequest("system", "user", { attempt: 1 }).model, "explicit-model");
    }
    // On the shipped default the editing path can reach the same vetted backup
    // that dictation cleanup falls over to.
    process.env.CLEANUP_PROVIDER = "groq";
    delete process.env.CLEANUP_MODEL;
    const primary = createCleanupRequest("system", "user");
    const backup = createCleanupRequest("system", "user", { attempt: 1 });
    assert.equal(primary.attempts, 2);
    assert.notEqual(backup.model, primary.model);
    assert.equal(createCleanupRequest("system", "user", { attempt: 9 }).model, backup.model);
  } finally {
    for (const key of fields) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});
