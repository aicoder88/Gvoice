// Unit tests for the control socket a companion app talks to.
// Run: node --test scripts/unit/control-socket.test.js
//
// These run against a REAL unix socket in a temp folder, because the things
// most likely to go wrong here are stream-shaped: a half line, a giant line, a
// client that goes quiet in the middle of a recording. A stubbed transport
// would test the switch statement and miss all three.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createControlServer,
  controlSocketPath,
  controlDirPath,
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES
} from "../../src/control-socket.js";

/** A recording of what the socket asked the dictation app to do. */
function spyHooks(over = {}) {
  const calls = [];
  let counter = 0;
  return {
    calls,
    hooks: {
      status: () => ({ ready: true, micMode: "balanced", session: null }),
      start: () => {
        counter += 1;
        const sessionId = `s${counter}`;
        calls.push(["start", sessionId]);
        return { ok: true, sessionId };
      },
      stop: (sessionId, reason) => calls.push(["stop", sessionId, reason]),
      cancel: (sessionId, reason) => calls.push(["cancel", sessionId, reason]),
      ...over
    }
  };
}

/**
 * Start a server in its own temp userData folder. Returns the server, the
 * socket path, and a cleanup that always runs.
 */
async function startServer({ hooks, heartbeatTimeoutMs = 5000 } = {}) {
  const userData = mkdtempSync(join(tmpdir(), "gvoice-control-"));
  const socketPath = controlSocketPath(userData);
  const server = createControlServer({ socketPath, hooks, heartbeatTimeoutMs });
  await server.start();
  return {
    server,
    userData,
    socketPath,
    cleanup() {
      server.stop();
      rmSync(userData, { recursive: true, force: true });
    }
  };
}

/** A test client: sends lines, collects the frames that come back. */
function connect(socketPath) {
  const socket = net.createConnection(socketPath);
  socket.setEncoding("utf8");
  const frames = [];
  // Frames are read in order, one per next() call — asking twice must not hand
  // back the same answer twice, or a test can pass on the previous message.
  let read = 0;
  const waiters = [];
  let closed = false;
  const closeWaiters = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      if (!line.trim()) continue;
      frames.push(JSON.parse(line));
      waiters.shift()?.();
    }
  });
  socket.on("close", () => {
    closed = true;
    while (closeWaiters.length) closeWaiters.shift()();
  });
  socket.on("error", () => {});
  return {
    socket,
    frames,
    send: (obj) => socket.write(JSON.stringify(obj) + "\n"),
    raw: (text) => socket.write(text),
    /** The next frame not yet read, waiting for it if it has not arrived. */
    next() {
      if (read < frames.length) return Promise.resolve(frames[read++]);
      return new Promise((resolve) => waiters.push(() => resolve(frames[read++])));
    },
    get closed() { return closed; },
    closedSoon() {
      if (closed) return Promise.resolve();
      return new Promise((resolve) => closeWaiters.push(resolve));
    },
    end: () => socket.destroy()
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- The folder ------------------------------------------------------------

test("the socket lives under the instance's own userData folder", () => {
  assert.equal(
    controlSocketPath("/Users/someone/Library/Application Support/GVoice"),
    "/Users/someone/Library/Application Support/GVoice/control/gvoice.sock"
  );
  assert.equal(controlDirPath("/data"), "/data/control");
});

test("the control folder is readable only by its owner", async () => {
  const { userData, cleanup } = await startServer({ hooks: spyHooks().hooks });
  try {
    const mode = statSync(controlDirPath(userData)).mode & 0o777;
    assert.equal(mode.toString(8), "700", "anyone else on the Mac could drive the microphone");
  } finally {
    cleanup();
  }
});

// --- Handshake -------------------------------------------------------------

test("hello gets the status back", async () => {
  const spy = spyHooks();
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: PROTOCOL_VERSION, client: "BetterOptions" });
    const frame = await client.next();
    assert.deepEqual(frame, {
      type: "status",
      version: PROTOCOL_VERSION,
      ready: true,
      micMode: "balanced",
      session: null
    });
  } finally {
    client.end();
    cleanup();
  }
});

test("a client speaking another version is refused and closed", async () => {
  const { socketPath, cleanup } = await startServer({ hooks: spyHooks().hooks });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: 99, client: "old-companion" });
    const frame = await client.next();
    assert.deepEqual(frame, { type: "refuse", reason: "version" });
    await client.closedSoon();
    assert.equal(client.closed, true);
  } finally {
    client.end();
    cleanup();
  }
});

test("a second companion is refused as busy and the first keeps the microphone", async () => {
  const spy = spyHooks();
  const { server, socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const first = connect(socketPath);
  const second = connect(socketPath);
  try {
    first.send({ type: "hello", version: PROTOCOL_VERSION, client: "first" });
    await first.next();
    second.send({ type: "hello", version: PROTOCOL_VERSION, client: "second" });
    assert.deepEqual(await second.next(), { type: "refuse", reason: "busy" });
    await second.closedSoon();
    assert.equal(server.hasCompanion(), true, "the first companion is still the owner");

    // And the refused one cannot drive anything on its way out.
    first.send({ type: "start", requestId: "r1" });
    const ack = await first.next();
    assert.equal(ack.type, "ack");
    assert.deepEqual(spy.calls, [["start", "s1"]]);
  } finally {
    first.end();
    second.end();
    cleanup();
  }
});

test("start before hello is refused and closed", async () => {
  const spy = spyHooks();
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.send({ type: "start", requestId: "r1" });
    assert.deepEqual(await client.next(), { type: "refuse", reason: "handshake" });
    await client.closedSoon();
    assert.deepEqual(spy.calls, [], "nothing reached the dictation app");
  } finally {
    client.end();
    cleanup();
  }
});

// --- Start / stop / cancel -------------------------------------------------

test("start hands back a session name, and stop names it again", async () => {
  const spy = spyHooks();
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: PROTOCOL_VERSION });
    await client.next();
    client.send({ type: "start", requestId: "r1" });
    const ack = await client.next();
    assert.deepEqual(ack, { type: "ack", requestId: "r1", sessionId: "s1" });

    client.send({ type: "stop", requestId: "r2", sessionId: ack.sessionId });
    assert.deepEqual(await client.next(), { type: "ack", requestId: "r2", sessionId: "s1" });
    assert.deepEqual(spy.calls, [["start", "s1"], ["stop", "s1", "companion"]]);
  } finally {
    client.end();
    cleanup();
  }
});

test("a stop naming an older press is refused, not obeyed", async () => {
  // The failure this prevents: a retried stop for a press that already ended
  // cutting off the press the user has only just started.
  const spy = spyHooks();
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: PROTOCOL_VERSION });
    await client.next();
    client.send({ type: "start", requestId: "r1" });
    await client.next();
    client.send({ type: "stop", requestId: "r2", sessionId: "s-old" });
    assert.deepEqual(await client.next(), { type: "refuse", requestId: "r2", reason: "session" });
    assert.deepEqual(spy.calls, [["start", "s1"]], "the live press was left alone");
  } finally {
    client.end();
    cleanup();
  }
});

test("cancel throws the press away", async () => {
  const spy = spyHooks();
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: PROTOCOL_VERSION });
    await client.next();
    client.send({ type: "start", requestId: "r1" });
    await client.next();
    client.send({ type: "cancel", requestId: "r2", sessionId: "s1" });
    assert.deepEqual(await client.next(), { type: "ack", requestId: "r2", sessionId: "s1" });
    assert.deepEqual(spy.calls, [["start", "s1"], ["cancel", "s1", "companion"]]);
  } finally {
    client.end();
    cleanup();
  }
});

test("a refused start is an answer, not a broken connection", async () => {
  const spy = spyHooks({ start: () => ({ ok: false, reason: "not-ready" }) });
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: PROTOCOL_VERSION });
    await client.next();
    client.send({ type: "start", requestId: "r1" });
    assert.deepEqual(await client.next(), { type: "refuse", requestId: "r1", reason: "not-ready" });
    assert.equal(client.closed, false, "the companion stays connected and can try again");
  } finally {
    client.end();
    cleanup();
  }
});

test("an unknown message is refused without dropping the companion", async () => {
  const { socketPath, cleanup } = await startServer({ hooks: spyHooks().hooks });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: PROTOCOL_VERSION });
    await client.next();
    client.send({ type: "levitate", requestId: "r1" });
    assert.deepEqual(await client.next(), { type: "refuse", requestId: "r1", reason: "unknown" });
    assert.equal(client.closed, false);
  } finally {
    client.end();
    cleanup();
  }
});

// --- Bad input -------------------------------------------------------------

test("a malformed frame closes the connection", async () => {
  const spy = spyHooks();
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.raw("{not json at all}\n");
    assert.deepEqual(await client.next(), { type: "refuse", reason: "malformed" });
    await client.closedSoon();
    assert.deepEqual(spy.calls, []);
  } finally {
    client.end();
    cleanup();
  }
});

test("a frame that is valid JSON but not a message is malformed too", async () => {
  const { socketPath, cleanup } = await startServer({ hooks: spyHooks().hooks });
  const client = connect(socketPath);
  try {
    client.raw('["start"]\n');
    assert.deepEqual(await client.next(), { type: "refuse", reason: "malformed" });
    await client.closedSoon();
  } finally {
    client.end();
    cleanup();
  }
});

test("an oversize frame closes the connection instead of buffering it", async () => {
  const { socketPath, cleanup } = await startServer({ hooks: spyHooks().hooks });
  const client = connect(socketPath);
  try {
    // No newline anywhere in it: the tail has to be capped as well as whole
    // lines, or a client that never sends one grows this buffer forever.
    client.raw("x".repeat(MAX_FRAME_BYTES + 1));
    await client.closedSoon();
    assert.equal(client.closed, true);
    assert.deepEqual(client.frames, [{ type: "refuse", reason: "oversize" }]);
  } finally {
    client.end();
    cleanup();
  }
});

test("a burst of small messages in one read is not mistaken for one big frame", async () => {
  // The size limit is per message. A companion beating every 2s can land
  // several beats in one read, and adding them up would hang up on it — with
  // the microphone open, which is the whole failure this file exists to stop.
  const spy = spyHooks();
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: PROTOCOL_VERSION });
    await client.next();
    const beat = JSON.stringify({ type: "heartbeat" }) + "\n";
    const burst = Math.ceil((MAX_FRAME_BYTES * 2) / beat.length);
    client.raw(beat.repeat(burst));
    for (let i = 0; i < burst; i++) {
      const frame = await client.next();
      assert.equal(frame.type, "status");
    }
    assert.equal(client.closed, false, `${burst} beats in one read must not close the connection`);
  } finally {
    client.end();
    cleanup();
  }
});

test("a frame is ignored once we have decided to hang up", async () => {
  // Everything the client crammed in behind a refused hello dies with it.
  const spy = spyHooks();
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.raw(
      JSON.stringify({ type: "hello", version: 99 }) + "\n" +
      JSON.stringify({ type: "start", requestId: "r1" }) + "\n"
    );
    assert.deepEqual(await client.next(), { type: "refuse", reason: "version" });
    await client.closedSoon();
    assert.deepEqual(spy.calls, [], "the queued start never reached the dictation app");
    assert.equal(client.frames.length, 1, "and it got no second answer");
  } finally {
    client.end();
    cleanup();
  }
});

test("a message split across two writes still arrives whole", async () => {
  const spy = spyHooks();
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.raw('{"type":"hello","ver');
    await wait(20);
    client.raw(`sion":${PROTOCOL_VERSION}}\n`);
    const frame = await client.next();
    assert.equal(frame.type, "status");
  } finally {
    client.end();
    cleanup();
  }
});

// --- Losing the companion --------------------------------------------------

test("silence for longer than the heartbeat window ends the recording", async () => {
  const spy = spyHooks();
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks, heartbeatTimeoutMs: 120 });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: PROTOCOL_VERSION });
    await client.next();
    client.send({ type: "start", requestId: "r1" });
    await client.next();
    await client.closedSoon();
    assert.deepEqual(
      spy.calls,
      [["start", "s1"], ["stop", "s1", "heartbeat-timeout"]],
      "the words already spoken are still transcribed — this is a release, not a cancel"
    );
  } finally {
    client.end();
    cleanup();
  }
});

test("a heartbeat keeps the recording alive and reports fresh status", async () => {
  const spy = spyHooks();
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks, heartbeatTimeoutMs: 150 });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: PROTOCOL_VERSION });
    await client.next();
    client.send({ type: "start", requestId: "r1" });
    await client.next();
    for (let i = 0; i < 4; i++) {
      await wait(50);
      client.send({ type: "heartbeat" });
      const frame = await client.next();
      assert.equal(frame.type, "status");
    }
    assert.deepEqual(spy.calls, [["start", "s1"]], "still recording after 200ms of beats");
  } finally {
    client.end();
    cleanup();
  }
});

test("a companion that disappears mid-hold ends the recording normally", async () => {
  const spy = spyHooks();
  const { server, socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: PROTOCOL_VERSION });
    await client.next();
    client.send({ type: "start", requestId: "r1" });
    await client.next();
    client.end();
    await wait(60);
    assert.deepEqual(spy.calls, [["start", "s1"], ["stop", "s1", "companion-gone"]]);
    assert.equal(server.hasCompanion(), false);
  } finally {
    cleanup();
  }
});

test("the companion coming and going is announced once each way", async () => {
  const seen = [];
  const spy = spyHooks({ onCompanion: (connected) => seen.push(connected) });
  const { socketPath, cleanup } = await startServer({ hooks: spy.hooks });
  const client = connect(socketPath);
  try {
    client.send({ type: "hello", version: PROTOCOL_VERSION });
    await client.next();
    assert.deepEqual(seen, [true]);
    client.end();
    await wait(60);
    assert.deepEqual(seen, [true, false]);
  } finally {
    cleanup();
  }
});

// --- Start and stop of the server itself -----------------------------------

test("a socket file left behind by a crash does not block the next start", async () => {
  const userData = mkdtempSync(join(tmpdir(), "gvoice-control-"));
  const socketPath = controlSocketPath(userData);
  const first = createControlServer({ socketPath, hooks: spyHooks().hooks });
  await first.start();
  // Stop listening WITHOUT the tidy-up, the way a kill -9 leaves things.
  first.stop();
  const second = createControlServer({ socketPath, hooks: spyHooks().hooks });
  try {
    await second.start();
    assert.equal(statSync(socketPath).isSocket(), true);
  } finally {
    second.stop();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("stopping the server removes the socket file", async () => {
  const { socketPath, cleanup, server } = await startServer({ hooks: spyHooks().hooks });
  server.stop();
  assert.throws(() => statSync(socketPath), /ENOENT/);
  cleanup();
});
