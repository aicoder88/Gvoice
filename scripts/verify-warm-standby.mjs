// Does the relay hand the next press an already-open Deepgram connection?
//
// Boots the real relay, runs two dictations back to back through it with a
// recorded clip, and prints what each one paid for the handshake. The second
// must report "(warm)" and connect in single-digit ms — that is the whole point
// of the standby in src/providers/deepgram.js.
//
// Run: node scripts/verify-warm-standby.mjs [path-to.wav]
// Needs network; spends a few seconds of Deepgram audio per run.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { startServer } from "../server.js";
import { prewarm, standbySockets } from "../src/providers/deepgram.js";
import { resolveDeepgramKey } from "../realtime-relay.js";

const wavPath = process.argv[2] || new URL("./parity/fixtures/tone-1500ms.pcm16", import.meta.url).pathname;
const raw = readFileSync(wavPath);
const pcm = raw.subarray(raw.subarray(0, 4).toString() === "RIFF" ? 44 : 0);

// The relay talks to the console; that is where "(warm)" shows up.
const lines = [];
const realError = console.error;
console.error = (...args) => { lines.push(args.join(" ")); realError(...args); };

const { server, port } = await startServer({ port: 0 });

async function dictate(label) {
  const openedAt = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime?provider=deepgram&language=en&model=nova-3`);
  let connectedAt = 0;
  const done = new Promise((resolve) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "local.status" && msg.status === "connected") connectedAt = Date.now();
      if (msg.type === "conversation.item.input_audio_transcription.completed") resolve(msg.transcript);
    });
  });
  await new Promise((r) => ws.on("open", r));
  // Stream it the way the renderer does: 4096-sample frames, in real time.
  const frame = 8192;
  for (let off = 0; off < pcm.length; off += frame) {
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.subarray(off, off + frame).toString("base64") }));
    await new Promise((r) => setTimeout(r, Math.round(frame / 48)));
  }
  const committedAt = Date.now();
  ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  // A dictation that dies must not hang the caller — the app's renderer would
  // sit on its 20s watchdog. Resolve on the socket closing too.
  const closed = new Promise((resolve) => ws.on("close", () => resolve(null)));
  const transcript = await Promise.race([done, closed]);
  console.log(`${label}: connect ${connectedAt - openedAt}ms, commit→transcript ${Date.now() - committedAt}ms, ${transcript === null ? "SOCKET DIED (renderer falls back to the saved-clip retry)" : `"${transcript}"`}`);
  ws.close();
  return { connect: connectedAt - openedAt, answer: Date.now() - committedAt, transcript };
}

// What main.js does at launch, so the FIRST press is warm too.
prewarm({ apiKey: resolveDeepgramKey(), model: "nova-3", language: "en" });
await new Promise((r) => setTimeout(r, 3000));

const first = await dictate("press 1 (prewarmed at launch)");
await new Promise((r) => setTimeout(r, 3000)); // the standby opens while nobody waits
const second = await dictate("press 2 (should be warm)");

// Worst case: the parked connection is dead and nothing has noticed yet — the
// network dropped, or the machine slept. Kill the TCP underneath it so ws still
// reports OPEN, then press. The press must still produce a transcript.
await new Promise((r) => setTimeout(r, 3000));
for (const socket of standbySockets()) socket._socket?.destroy();
const third = await dictate("press 3 (standby killed underneath)");

const warm = lines.some((l) => l.includes("deepgram connected") && l.includes("(warm)"));
console.log(`\nwarm connection reused: ${warm}`);
console.log(`handshake saved on press 2: ${first.connect - second.connect}ms`);
console.log(`press 3 survived a dead standby: ${third.transcript !== null}`);
server.close();
process.exit(warm && second.connect < 100 && third.transcript ? 0 : 1);
