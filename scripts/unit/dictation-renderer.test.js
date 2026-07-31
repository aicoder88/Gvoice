import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../../public/dictation.js", import.meta.url), "utf8")
  .replace(
    'import { classifyHold } from "/mic-health.js";',
    "const classifyHold = () => ({ action: 'ok', silentStreak: 0 });"
  );

test("a rejected socket handshake closes a mic opened for that press", async () => {
  let onStart;
  let trackStopped = false;
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
        getUserMedia: async () => ({
          getAudioTracks: () => [track],
          getTracks: () => [track]
        }),
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
});
