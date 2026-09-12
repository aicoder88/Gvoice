// @ts-check
// The local control socket: how a companion app (Better Options) asks GVoice to
// dictate, instead of faking a keyboard chord.
//
// Why this exists: the companion used to press Ctrl+Cmd for the user by posting
// synthetic modifier events. Anything that swallowed the release — a crash, a
// permission loss, a Space switch — left the modifiers stuck down and the mic
// open with no way to close it. Here the companion says "start" and "stop" in
// words, and if it stops saying anything at all this file ends the recording
// itself. A dead companion can no longer hold the microphone open.
//
// Shape of the thing:
//   * a unix socket at <userData>/control/gvoice.sock, in a 0700 directory, so
//     only this user's own processes can reach it (no port, nothing on the
//     network, nothing another account can open),
//   * newline-delimited JSON, one message per line, protocol v1,
//   * one owner at a time — a second companion is refused, not queued, because
//     two things driving one microphone is how a stuck recording starts,
//   * a heartbeat every 2s from the client; six seconds of silence ends any
//     recording that companion started, as a normal release. The words the user
//     already spoke are still transcribed and delivered — losing the companion
//     is not a reason to throw away a sentence.
//
// Recording length limits are NOT re-implemented here. main.js's max-hold
// watchdog owns that, and it applies to a companion-started press exactly as it
// does to a key-held one.
//
// This module knows nothing about Electron so it can be tested over a real
// socket in a temp folder. Everything it does to a dictation goes through the
// injected hooks.

import net from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** Protocol version. A client that asks for anything else is refused. */
export const PROTOCOL_VERSION = 1;

/**
 * Longest line we will ever read. Real messages are a few dozen bytes; anything
 * bigger is a broken client or someone probing, and both get the connection
 * closed rather than an ever-growing buffer in the middle of the dictation app.
 */
export const MAX_FRAME_BYTES = 4096;

/**
 * Silence that ends a companion-owned recording. Three missed heartbeats at the
 * client's 2s cadence, so one late beat on a busy machine costs nothing.
 */
export const HEARTBEAT_TIMEOUT_MS = 6000;

/**
 * The folder holding the socket. Inside userData, so an isolated dev launch
 * (GVOICE_USER_DATA) gets its own socket and can never be driven by — or steal
 * the companion from — the copy in /Applications.
 * @param {string} userDataDir
 * @returns {string}
 */
export function controlDirPath(userDataDir) {
  return join(userDataDir, "control");
}

/**
 * @param {string} userDataDir
 * @returns {string}
 */
export function controlSocketPath(userDataDir) {
  return join(controlDirPath(userDataDir), "gvoice.sock");
}

/**
 * @typedef {object} ControlHooks
 * @property {() => { ready?: boolean, micMode?: string, session?: string|null }} [status]
 *   What to tell a companion about right now: can a press start, which
 *   microphone mode is in force, and the name of the press already running.
 * @property {() => { ok: boolean, sessionId?: string|null, reason?: string }} [start]
 *   Begin a dictation. `ok: false` with a reason is a normal answer, not an
 *   error — the button was pressed at a moment GVoice could not listen.
 * @property {(sessionId: string|null, reason: string) => void} [stop]
 *   End the recording normally: transcribe and deliver, same as a key release.
 * @property {(sessionId: string|null, reason: string) => void} [cancel]
 *   Throw the press away, same as Escape.
 * @property {(connected: boolean) => void} [onCompanion]
 *   Called when a companion finishes the handshake, and again when it goes.
 */

/**
 * @param {object} options
 * @param {string} options.socketPath
 * @param {ControlHooks} [options.hooks]
 * @param {number} [options.heartbeatTimeoutMs]
 * @param {(...args: unknown[]) => void} [options.log]
 */
export function createControlServer({
  socketPath,
  hooks = {},
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  log = () => {}
}) {
  /** @type {import("node:net").Server | null} */
  let server = null;
  /** @type {Set<Conn>} */
  const conns = new Set();
  /** @type {Conn | null} */
  let owner = null;

  /**
   * @typedef {object} Conn
   * @property {import("node:net").Socket} socket
   * @property {string} buffer
   * @property {ReturnType<typeof setTimeout> | null} idleTimer
   * @property {boolean} isOwner
   * @property {boolean} closing  we have decided to hang up; ignore the rest
   * @property {string|null} sessionId  the press this companion started, if any
   */

  /**
   * @param {Conn} conn
   * @param {Record<string, unknown>} message
   */
  function send(conn, message) {
    try {
      conn.socket.write(JSON.stringify(message) + "\n");
    } catch (error) {
      log("[control-socket] write failed:", error && /** @type {Error} */ (error).message);
    }
  }

  /** The status frame, built fresh every time it is asked for. */
  function statusFrame() {
    let live = {};
    try {
      live = hooks.status?.() || {};
    } catch (error) {
      log("[control-socket] status hook threw:", error);
    }
    return {
      type: "status",
      version: PROTOCOL_VERSION,
      ready: live.ready === true,
      micMode: typeof live.micMode === "string" ? live.micMode : "unknown",
      session: typeof live.session === "string" ? live.session : null
    };
  }

  /**
   * End a recording this companion started, as a normal release. Used when the
   * heartbeat stops and when the connection drops: the microphone must not stay
   * open, and the sentence already spoken must still be transcribed.
   * @param {Conn} conn
   * @param {string} reason
   */
  function releaseOwnedRecording(conn, reason) {
    const sessionId = conn.sessionId;
    if (!sessionId) return;
    conn.sessionId = null;
    try {
      hooks.stop?.(sessionId, reason);
    } catch (error) {
      log("[control-socket] stop hook threw:", error);
    }
  }

  /** @param {Conn} conn */
  function armIdle(conn) {
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.idleTimer = setTimeout(() => {
      log(`[control-socket] no heartbeat for ${heartbeatTimeoutMs}ms — dropping the companion`);
      releaseOwnedRecording(conn, "heartbeat-timeout");
      conn.socket.destroy();
    }, heartbeatTimeoutMs);
    conn.idleTimer.unref?.();
  }

  /**
   * @param {Conn} conn
   * @param {string} reason
   */
  function refuseAndClose(conn, reason) {
    send(conn, { type: "refuse", reason });
    // Nothing else this client already sent gets acted on. end() takes a moment
    // to land, and without this flag the rest of the chunk it arrived in would
    // still be obeyed after we decided to hang up.
    conn.closing = true;
    conn.socket.end();
  }

  /**
   * One decoded message.
   * @param {Conn} conn
   * @param {string} line
   */
  function handleFrame(conn, line) {
    if (conn.closing) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // A newline-delimited stream that has gone wrong once is not trustworthy
      // afterwards — the next "line" may be the tail of this one. Say so and
      // close; step 11's client reconnects with backoff.
      log("[control-socket] malformed frame — closing");
      refuseAndClose(conn, "malformed");
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.type !== "string") {
      refuseAndClose(conn, "malformed");
      return;
    }
    const requestId = typeof msg.requestId === "string" ? msg.requestId : null;

    if (msg.type === "hello") {
      if (conn.isOwner) return refuseAndClose(conn, "handshake");
      if (msg.version !== PROTOCOL_VERSION) {
        log(`[control-socket] refused a client speaking version ${String(msg.version)}`);
        return refuseAndClose(conn, "version");
      }
      if (owner && owner !== conn) {
        // Two companions would fight over one microphone. The first one keeps it.
        return refuseAndClose(conn, "busy");
      }
      conn.isOwner = true;
      owner = conn;
      log(`[control-socket] companion connected: ${typeof msg.client === "string" ? msg.client : "unnamed"}`);
      try {
        hooks.onCompanion?.(true);
      } catch (error) {
        log("[control-socket] onCompanion hook threw:", error);
      }
      send(conn, statusFrame());
      return;
    }

    // Everything below is only for the companion that said hello.
    if (!conn.isOwner) return refuseAndClose(conn, "handshake");

    if (msg.type === "heartbeat") {
      // Answering with a fresh status is how the companion learns that the
      // microphone came back, or went away, without polling for it.
      send(conn, statusFrame());
      return;
    }

    if (msg.type === "start") {
      if (conn.sessionId) {
        send(conn, { type: "refuse", requestId, reason: "busy" });
        return;
      }
      let result;
      try {
        result = hooks.start?.() || { ok: false, reason: "unavailable" };
      } catch (error) {
        log("[control-socket] start hook threw:", error);
        result = { ok: false, reason: "error" };
      }
      if (!result.ok) {
        send(conn, { type: "refuse", requestId, reason: result.reason || "refused" });
        return;
      }
      conn.sessionId = typeof result.sessionId === "string" ? result.sessionId : null;
      send(conn, { type: "ack", requestId, sessionId: conn.sessionId });
      return;
    }

    if (msg.type === "stop" || msg.type === "cancel") {
      const asked = typeof msg.sessionId === "string" ? msg.sessionId : null;
      // A stop naming a press this companion never started is refused rather
      // than obeyed: a late retry must not end the press that came after it.
      if (asked && conn.sessionId && asked !== conn.sessionId) {
        send(conn, { type: "refuse", requestId, reason: "session" });
        return;
      }
      const sessionId = conn.sessionId || asked;
      // Neither side can name a press: this companion never got an ack (its
      // start was refused as "busy", most likely because the user is holding
      // the key right now) and the frame carries no id either. An unnamed stop
      // must NOT be obeyed — main.js reads an unstamped id as "whatever is live",
      // so it would cut off the keyboard hold the companion never owned. There
      // is nothing of ours to end, so say so.
      if (!sessionId) {
        send(conn, { type: "refuse", requestId, reason: "session" });
        return;
      }
      conn.sessionId = null;
      try {
        if (msg.type === "stop") hooks.stop?.(sessionId, "companion");
        else hooks.cancel?.(sessionId, "companion");
      } catch (error) {
        log(`[control-socket] ${msg.type} hook threw:`, error);
      }
      send(conn, { type: "ack", requestId, sessionId });
      return;
    }

    send(conn, { type: "refuse", requestId, reason: "unknown" });
  }

  /** @param {import("node:net").Socket} socket */
  function onConnection(socket) {
    /** @type {Conn} */
    const conn = { socket, buffer: "", idleTimer: null, isOwner: false, closing: false, sessionId: null };
    conns.add(conn);
    socket.setEncoding("utf8");
    // The clock starts at connect, not at hello: a client that opens the socket
    // and then says nothing at all is dropped too.
    armIdle(conn);

    const tooBig = () => {
      log("[control-socket] frame over the size limit — closing");
      conn.buffer = "";
      conn.closing = true;
      send(conn, { type: "refuse", reason: "oversize" });
      socket.destroy();
    };

    socket.on("data", (chunk) => {
      armIdle(conn);
      conn.buffer += chunk;
      // Whole messages first, THEN the leftover tail. The limit is per message,
      // never per read: a burst of small heartbeats arriving in one chunk can
      // add up past 4096 bytes, and killing that companion mid-recording for
      // being talkative would be the exact stuck microphone this file prevents.
      let cut;
      while ((cut = conn.buffer.indexOf("\n")) !== -1) {
        const line = conn.buffer.slice(0, cut);
        conn.buffer = conn.buffer.slice(cut + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) return tooBig();
        if (line.trim().length > 0) handleFrame(conn, line);
        if (socket.destroyed || conn.closing) return;
      }
      // An un-terminated tail is capped too, or a client that never sends a
      // newline grows this buffer without limit.
      if (Buffer.byteLength(conn.buffer, "utf8") > MAX_FRAME_BYTES) tooBig();
    });

    socket.on("error", () => {
      // A companion that vanishes mid-write is ordinary, not an app error. The
      // close handler below does the cleaning up.
    });

    socket.on("close", () => {
      if (conn.idleTimer) { clearTimeout(conn.idleTimer); conn.idleTimer = null; }
      conns.delete(conn);
      releaseOwnedRecording(conn, "companion-gone");
      if (owner === conn) {
        owner = null;
        log("[control-socket] companion disconnected");
        try {
          hooks.onCompanion?.(false);
        } catch (error) {
          log("[control-socket] onCompanion hook threw:", error);
        }
      }
    });
  }

  return {
    socketPath,

    /** Is a companion connected and handshaked right now? */
    hasCompanion() {
      return owner !== null;
    },

    /**
     * Create the folder, clear any socket left behind by a crash, and listen.
     * @returns {Promise<string>} the path being served
     */
    start() {
      return new Promise((resolve, reject) => {
        try {
          const dir = dirname(socketPath);
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          // mkdir's mode is filtered through the process umask, so say it again
          // outright: this folder is the only thing standing between the
          // microphone and every other account on the machine.
          chmodSync(dir, 0o700);
          // A crash leaves the socket file behind and listen() would fail on it.
          rmSync(socketPath, { force: true });
        } catch (error) {
          reject(error);
          return;
        }
        server = net.createServer(onConnection);
        server.on("error", (error) => {
          log("[control-socket] server error:", error && error.message);
          reject(error);
        });
        server.listen(socketPath, () => {
          try { chmodSync(socketPath, 0o600); } catch {}
          log(`[control-socket] listening on ${socketPath}`);
          resolve(socketPath);
        });
      });
    },

    /** Close every connection, stop listening, remove the socket file. */
    stop() {
      for (const conn of [...conns]) {
        if (conn.idleTimer) { clearTimeout(conn.idleTimer); conn.idleTimer = null; }
        try { conn.socket.destroy(); } catch {}
      }
      conns.clear();
      owner = null;
      const closing = server;
      server = null;
      if (closing) {
        try { closing.close(); } catch {}
      }
      try { rmSync(socketPath, { force: true }); } catch {}
    }
  };
}
