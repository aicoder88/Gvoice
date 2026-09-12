// @ts-check
// Push-to-talk dictation session state. One instance per Electron main
// process; replaces the ad-hoc globalThis.__dictation* slots that used to live
// in main.js.
//
// Lifecycle (one state, one transition table):
//
//   idle --tryStart--> recording --release--> processing --done--> completed --> idle
//                          |                      |
//                          |                      +--cancel--> cancelled --> idle
//                          |                      +--fail / safety timeout--> failed --> idle
//                          +--cancel--> cancelled --> idle
//                          +--fail--> failed --> idle
//
// `tryStart` rejects a second press while a previous dictation is still
// recording or processing. `release` arms a safety timer so a missing
// transcript can't permanently jam the session: it now ends the press as
// `failed` instead of silently clearing a flag. `finalize` is called on the
// terminal event (transcript or error) and stops the safety timer. `done`,
// `fail` and `cancel` are the three terminal transitions, and each of them
// re-opens the session for the next press.
//
// Every terminal transition is idempotent: a second release, a second done, a
// second cancel changes nothing and returns false. Nothing here can leave the
// session stuck in a state where a press is refused forever — that is a deaf
// app, and it is the one failure this module exists to prevent.

import { randomUUID } from "node:crypto";

/** The only states a press can be in. */
export const IDLE = "idle";
export const RECORDING = "recording";
export const PROCESSING = "processing";
export const COMPLETED = "completed";
export const CANCELLED = "cancelled";
export const FAILED = "failed";

/**
 * The transition table. Anything not listed here is illegal: it logs and
 * returns false rather than moving the session.
 *
 * `recording -> completed` is legal on purpose. A transcript can arrive
 * without a release (the renderer's own end-of-speech, the parity harness), and
 * refusing to complete it would leave the session recording forever with every
 * later press refused.
 *
 * @type {Record<string, string[]>}
 */
const ALLOWED = {
  [IDLE]: [RECORDING],
  [RECORDING]: [PROCESSING, COMPLETED, CANCELLED, FAILED],
  [PROCESSING]: [COMPLETED, CANCELLED, FAILED],
  [COMPLETED]: [IDLE],
  [CANCELLED]: [IDLE],
  [FAILED]: [IDLE]
};

// How many cancelled press names to remember. A transcript that arrives after
// its press was cancelled must never be pasted, and the round trip can take
// seconds — but the list can't grow forever either.
const CANCELLED_MEMORY = 20;

/**
 * @typedef {object} DictationSessionOptions
 * @property {number} [safetyTimeoutMs]
 * @property {(...args: unknown[]) => void} [log]
 */

export class DictationSession {
  /** @param {DictationSessionOptions} [options] */
  constructor({ safetyTimeoutMs = 500, log = console.error } = {}) {
    /**
     * The one piece of lifecycle state. `busy` below is derived from it, so the
     * two can never disagree — they used to be separate, and a path that
     * cleared one without the other is exactly how a session got stuck.
     * @type {string}
     */
    this.state = IDLE;
    // Bumped once per ACCEPTED press. A handler that takes seconds (cleanup +
    // paste, or the batch rescue) snapshots this on entry and compares before it
    // touches shared state — the pill, the saved foreground window, done(). By
    // then the press it belongs to may be long gone: release() arms a 500ms
    // safety timer that ends the press, so a new dictation can legally start
    // while the old one is still finishing.
    //
    // A REJECTED press must not bump it. If it did, the in-flight handler would
    // see a changed generation, skip done(), and leave the session stuck busy
    // with the safety timer already cleared by finalize() — permanently deaf app.
    /** @type {number} */
    this.generation = 0;
    // The name of the press that is live right now, issued by tryStart() and
    // never reused: "<generation>-<random>". Everything that travels away from
    // this process and comes back later — the renderer's transcript, error and
    // mic-warning events, and every slow continuation in main.js (cleanup, the
    // batch rescue, saving the clip, delivery) — carries this string, and
    // owns() is the single question asked before any of them touches shared
    // state. The random half matters because the renderer reloads: a stamp
    // minted before a reload must never collide with a counter that restarted.
    /** @type {string | null} */
    this.id = null;
    // Where the words are meant to go: the app, window and focused element that
    // were in front of the user when this press started (src/foreground.js
    // captureForegroundTarget). Set by main.js right after tryStart(), read
    // again immediately before the paste. Cleared on every new press so a stale
    // destination can never authorise a paste for the press after it.
    /** @type {import("./foreground.js").ForegroundTarget | null} */
    this.target = null;
    /** @type {number | null} */
    this.releaseAt = null;
    // Names of presses the user cancelled. Kept AFTER the session re-opens,
    // because the whole point of cancel is to stop a transcript that is still
    // out there — it can come back long after the state machine has moved on.
    /** @type {string[]} */
    this._cancelled = [];
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._safetyTimer = null;
    this._safetyTimeoutMs = safetyTimeoutMs;
    this._log = log;
  }

  /**
   * True while a press is recording or waiting for its transcript. Derived, not
   * stored: main.js reads it to decide whether the pill is free.
   * @returns {boolean}
   */
  get busy() {
    return this.state === RECORDING || this.state === PROCESSING;
  }

  /** @returns {boolean} true while the mic is open for this press. */
  get isRecording() {
    return this.state === RECORDING;
  }

  /**
   * The one place `state` ever changes. Illegal transitions log and return
   * false; they never move the session and never throw into the dictation path.
   *
   * @param {string} next
   * @param {string} [via] the method that asked, for the log line
   * @returns {boolean}
   */
  _transition(next, via = "") {
    const allowed = ALLOWED[this.state] || [];
    if (!allowed.includes(next)) {
      this._log(
        `[dictation-session] illegal transition ${this.state} -> ${next}${via ? ` (${via})` : ""}`
      );
      return false;
    }
    this.state = next;
    return true;
  }

  /**
   * End the press: move to a terminal state and re-open for the next one. The
   * session never rests in `completed`, `cancelled` or `failed` — those are
   * recorded and left behind in the same call, so a press can always follow.
   *
   * @param {string} terminal
   * @param {string} via
   * @returns {boolean}
   */
  _end(terminal, via) {
    if (!this._transition(terminal, via)) return false;
    this._transition(IDLE, via);
    return true;
  }

  /**
   * Try to start a new dictation. Returns false if a previous dictation is
   * still in flight (caller should ignore the press in that case).
   *
   * @returns {boolean}
   */
  tryStart() {
    if (this.state !== IDLE) {
      this._log("[dictation-session] PRESS ignored — previous dictation still processing");
      return false;
    }
    this._clearSafetyTimer();
    this._transition(RECORDING, "tryStart");
    this.generation += 1;
    // Issued here and nowhere else. done() deliberately leaves it alone: the
    // empty-transcript rescue re-opens the session early and then keeps asking
    // owns() for seconds afterwards, so the name has to outlive the busy flag
    // and change only when a real new press arrives.
    this.id = `${this.generation}-${randomUUID().slice(0, 8)}`;
    // Forget the previous session's release stamp, or finalize() on a session
    // that errors before release would report timings from the LAST dictation.
    this.releaseAt = null;
    // Same reasoning for the destination: the caller sets it a line later, and
    // an unset one must never look like the previous press's window.
    this.target = null;
    return true;
  }

  /**
   * Accept the hotkey release. Arms the safety timer so a missing transcript
   * can't permanently jam the session.
   *
   * A second release is a no-op, not an error: the same hold can be ended twice
   * (a real key-up racing the max-hold watchdog, a tray click racing the key),
   * and the second one must not re-arm the timer or restamp releaseAt.
   *
   * @returns {boolean} false if there was no open recording to release
   */
  release() {
    if (this.state !== RECORDING) return false;
    this._transition(PROCESSING, "release");
    this.releaseAt = Date.now();
    this._clearSafetyTimer();
    this._safetyTimer = setTimeout(() => {
      // The press ran out of time waiting for a transcript. That is a failure,
      // not a quiet flag flip: it ends the press properly, so the next one
      // starts from idle like any other.
      if (this.busy) {
        this._log("[dictation-session] safety timeout — ending the press as failed");
        this._end(FAILED, "safety-timeout");
      }
    }, this._safetyTimeoutMs);
    return true;
  }

  /**
   * The user gave up on this press (Escape, or a click on the pill). Marks the
   * press cancelled, re-opens the session immediately so the next press is
   * heard, and remembers the name so a transcript that arrives afterwards is
   * never pasted.
   *
   * Idempotent: a second cancel, or a cancel with nothing running, returns
   * false and changes nothing.
   *
   * Whoever calls this while the mic is open must also tell the renderer to
   * stop capturing. The ordinary key-up won't: release() from a cancelled
   * press is a no-op, so main.js's fireRelease() returns before it sends
   * `dictation:stop`.
   *
   * @param {string} [reason] written to the log line only
   * @returns {boolean}
   */
  cancel(reason = "") {
    if (!this.busy) return false;
    const id = this.id;
    this._clearSafetyTimer();
    if (!this._end(CANCELLED, "cancel")) return false;
    if (typeof id === "string" && id.length > 0) {
      this._cancelled.push(id);
      if (this._cancelled.length > CANCELLED_MEMORY) this._cancelled.shift();
    }
    this._log(`[dictation-session] cancelled ${id || "(unnamed)"}${reason ? ` — ${reason}` : ""}`);
    return true;
  }

  /**
   * Mark a press cancelled that the session is no longer holding. One caller:
   * the user gives up while the words are already out of the state machine's
   * hands — done() runs the moment a transcript arrives, so cleanup and the
   * paste run for another second or two with the session sitting idle. cancel()
   * refuses that (nothing is busy), but the user's "no" still has to be obeyed,
   * and the delivery path asks wasCancelled() right before it types.
   *
   * Returns false when there is no such press to mark, so the caller can tell a
   * real cancel from a stray Escape.
   *
   * @param {unknown} id name of the press, as the delivery path knows it
   * @returns {boolean}
   */
  markCancelled(id) {
    if (typeof id !== "string" || id.length === 0) return false;
    if (!this._cancelled.includes(id)) {
      this._cancelled.push(id);
      if (this._cancelled.length > CANCELLED_MEMORY) this._cancelled.shift();
    }
    this._log(`[dictation-session] cancelled ${id} — after the words arrived`);
    return true;
  }

  /**
   * Was this press cancelled? Asked right before anything is pasted. An
   * unstamped id means "the press that is live now", the same reading owns()
   * gives it.
   *
   * @param {unknown} id
   * @returns {boolean}
   */
  wasCancelled(id) {
    const name = typeof id === "string" && id.length > 0 ? id : this.id;
    if (typeof name !== "string" || name.length === 0) return false;
    return this._cancelled.includes(name);
  }

  /**
   * The one question the delivery path asks: may this text reach the user's
   * cursor? Only if the press still owns the session AND was not cancelled.
   *
   * @param {unknown} id
   * @returns {boolean}
   */
  canDeliver(id) {
    return this.owns(id) && !this.wasCancelled(id);
  }

  /**
   * Called on the terminal event (transcript or error). Stops the safety
   * timer.
   *
   * @returns {{ releaseAt: number, sinceRelease: number }}
   */
  finalize() {
    this._clearSafetyTimer();
    const releaseAt = this.releaseAt || Date.now();
    return { releaseAt, sinceRelease: Date.now() - releaseAt };
  }

  /**
   * Does `id` name the press that owns the session right now? The one question
   * every late arrival asks — a renderer event that took the scenic route, or a
   * main-process continuation that has been away in cleanup, the batch rescue
   * or a disk write while the user pressed again.
   *
   * An unstamped id (null, "", anything that isn't a string) counts as the live
   * press, so nothing is ever silently dropped: that covers a background mic
   * warning raised outside any press, and a renderer that reloaded
   * (escalate-recovery) and lost its stamp. It also covers the very first
   * events of a run, before any press has been accepted and `this.id` is still
   * null.
   *
   * @param {unknown} id
   * @returns {boolean}
   */
  owns(id) {
    if (typeof id !== "string" || id.length === 0) return true;
    return id === this.id;
  }

  /**
   * The inverse of owns(), for the handlers that only want to bail out early.
   *
   * @param {unknown} id
   * @returns {boolean}
   */
  isStale(id) {
    return !this.owns(id);
  }

  /**
   * Final transition of a successful press: re-open the session for the next
   * one. Call once the transcript has been typed.
   *
   * A repeat is a no-op, not an error. The empty-transcript rescue re-opens the
   * session early and the normal path's `finally` calls done() again on the way
   * out; both are correct, and neither may complain.
   *
   * @returns {boolean} true only for the call that actually ended the press
   */
  done() {
    if (this.state === IDLE) return false;
    return this._end(COMPLETED, "done");
  }

  /**
   * Abandon the current dictation on an error path: stop the safety timer and
   * re-open the session in one step. The success path keeps calling finalize()
   * then done() separately because it needs finalize()'s timing return.
   *
   * @returns {boolean} true only for the call that actually ended the press
   */
  fail() {
    this.finalize();
    if (this.state === IDLE) return false;
    return this._end(FAILED, "fail");
  }

  _clearSafetyTimer() {
    if (this._safetyTimer) {
      clearTimeout(this._safetyTimer);
      this._safetyTimer = null;
    }
  }
}
