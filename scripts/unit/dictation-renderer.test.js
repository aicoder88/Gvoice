import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { resolvePreferredInput } from '../../public/mic-health.js';

const SOURCE = readFileSync(new URL("../../public/dictation.js", import.meta.url), "utf8")
  .replace(
    'import { classifyHold, idleMsForMode, chooseCaptureDevice, resolvePreferredInput } from "/mic-health.js";',
    "const classifyHold = () => ({ action: 'ok', cause: '', silentStreak: 0 });"
      + " const idleMsForMode = () => Infinity;"
      + " const chooseCaptureDevice = () => ({ deviceId: null, source: 'default', rebuild: true });"
      + ` const resolvePreferredInput = ${resolvePreferredInput.toString()};`
  );

// The stub above only works while the renderer's import line looks exactly like
// that. Fail loudly here rather than at the confusing "Cannot use import
// statement outside a module" the vm throws three tests later.
if (SOURCE.includes("mic-health.js\"")) {
  throw new Error("public/dictation.js changed its mic-health import – update the stub in this test");
}

test("a rejected socket handshake closes a mic opened for that press", async () => {
  let onStart;
  let trackStopped = false;
  let getUserMediaCalls = 0;
  const listeners = new Map();

  class RejectingWebSocket {
    static OPEN = 1;

    constructor() {
      this.readyState = 0;
      queueMicrotask(() => listeners.get("error")?.({ type: "error" }));
    }

    addEventListener(type, listener) {
      listeners.set(type, listener);
    }

    close() {}
  }

  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }

    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }

    createGain() {
      return { connect() {}, disconnect() {}, gain: { value: 1 } };
    }

    async resume() { this.state = "running"; }
    async suspend() { this.state = "suspended"; }
    async close() { this.state = "closed"; }
  }

  class FakeAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null };
    }

    connect() {}
    disconnect() {}
  }

  const elements = {
    status: { textContent: "" },
    log: { textContent: "" }
  };
  const window = {
    location: { search: "", host: "127.0.0.1:3000" },
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    dictationBridge: {
      onStart(callback) { onStart = callback; },
      onStop() {},
      onRebuildCapture() {},
      sendError() {},
      sendMicWarning() {},
      sendMicRecovered() {},
      requestEscalation() {}
    }
  };
  const track = {
    label: "Test microphone",
    muted: false,
    readyState: "live",
    getSettings: () => ({ deviceId: "test-mic" }),
    stop() { trackStopped = true; }
  };
  const context = vm.createContext({
    window,
    document: { getElementById: (id) => elements[id] },
    navigator: {
      onLine: true,
      mediaDevices: {
        getUserMedia: async () => {
          getUserMediaCalls++;
          return { getAudioTracks: () => [track], getTracks: () => [track] };
        },
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "builtin-1", label: "Built-in Microphone" }
        ],
        addEventListener() {}
      }
    },
    WebSocket: RejectingWebSocket,
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    URLSearchParams,
    Uint8Array,
    Buffer,
    console: { log() {} },
    setTimeout,
    clearTimeout,
    queueMicrotask
  });

  new vm.Script(SOURCE, { filename: "public/dictation.js" }).runInContext(context);
  assert.equal(typeof onStart, "function");

  await onStart();

  assert.equal(trackStopped, true, "failed startup must release the acquired microphone track");
  assert.equal(elements.status.textContent, "WS failed");
  assert.match(elements.log.textContent, /Mic released \(socket startup failed\)/);

  // A remembered Anker is a deliberate user choice. If it disappears, the
  // renderer must tell the user rather than call getUserMedia without an exact
  // device and silently capture the built-in microphone.
  vm.runInContext("applyMicPrefs({ preferredMicId: 'old-anker', preferredMicLabel: 'Anker PowerConf C200' })", context);
  const callsBeforeMissingAnker = getUserMediaCalls;
  await assert.rejects(
    vm.runInContext("getMicStream()", context),
    /selected microphone \(Anker PowerConf C200\) is unavailable/i
  );
  assert.equal(getUserMediaCalls, callsBeforeMissingAnker, "a missing selected microphone must not fall back to another input");
});

// ---------------------------------------------------------------------------
// The renderer's side of the session name. preload.cjs is the only place that
// stamps it, so no send site in public/dictation.js can forget to — these tests
// load that file with a fake Electron and check every channel it opens.

/**
 * Load preload.cjs with a stub Electron and return the exposed bridge plus the
 * list of everything it sent.
 */
function loadPreload() {
  const source = readFileSync(new URL("../../preload.cjs", import.meta.url), "utf8");
  /** @type {{ channel: string, args: unknown[] }[]} */
  const sent = [];
  /** @type {Map<string, (event: unknown, ...args: unknown[]) => void>} */
  const handlers = new Map();
  /** @type {Record<string, any>} */
  let bridge = {};
  const electron = {
    contextBridge: {
      exposeInMainWorld(_name, api) { bridge = api; }
    },
    ipcRenderer: {
      send(channel, ...args) { sent.push({ channel, args }); },
      on(channel, handler) { handlers.set(channel, handler); }
    }
  };
  const context = vm.createContext({
    require: (name) => {
      if (name === "electron") return electron;
      throw new Error("unexpected require: " + name);
    },
    module: { exports: {} },
    exports: {},
    console
  });
  new vm.Script(source, { filename: "preload.cjs" }).runInContext(context);
  // The dictation:start listener is only wired when dictation.js subscribes.
  bridge.onStart(() => {});
  return {
    bridge,
    sent,
    start: (sessionId) => handlers.get("dictation:start")?.({}, { sessionId })
  };
}

test("every event the renderer sends carries the session name", () => {
  const { bridge, sent, start } = loadPreload();
  start("7-abcdef01");

  bridge.sendTranscript({ text: "hello" });
  bridge.sendError("boom");
  bridge.sendMicWarning("mic gone");
  bridge.reportFailure({ reason: "timeout" });
  bridge.sendMicRecovered();
  bridge.requestEscalation("recovery");
  bridge.reportSuperseded({ chunks: [] });

  assert.equal(sent.length, 7);
  for (const { channel, args } of sent) {
    const stamp = args[args.length - 1];
    assert.equal(
      typeof stamp === "string" || stamp === null,
      true,
      channel + " must carry a session name"
    );
  }
  const stamps = new Map(sent.map((s) => [s.channel, s.args[s.args.length - 1]]));
  assert.equal(stamps.get("dictation:transcript"), "7-abcdef01");
  assert.equal(stamps.get("dictation:error"), "7-abcdef01");
  assert.equal(stamps.get("dictation:mic-warning"), "7-abcdef01");
  assert.equal(stamps.get("dictation:failure"), "7-abcdef01");
  assert.equal(stamps.get("dictation:mic-recovered"), "7-abcdef01");
  assert.equal(stamps.get("dictation:escalate-recovery"), "7-abcdef01");
});

test("a superseded dictation is stamped with the press it belonged to, not the one that replaced it", () => {
  const { bridge, sent, start } = loadPreload();
  start("1-aaaaaaaa");
  start("2-bbbbbbbb"); // the new press lands before the first was answered

  bridge.reportSuperseded({ chunks: [] });
  bridge.sendTranscript({ text: "live" });

  assert.equal(sent[0].channel, "dictation:superseded");
  assert.equal(sent[0].args[1], "1-aaaaaaaa", "the abandoned dictation keeps its own name");
  assert.equal(sent[1].args[1], "2-bbbbbbbb", "the live press is unaffected");
});

test("before any press, events go out unstamped so nothing is muted", () => {
  const { bridge, sent } = loadPreload();
  bridge.sendMicWarning("mic gone before any dictation");
  assert.equal(sent[0].args[1], null, "an unstamped event is delivered, never dropped");
});
