// @ts-check
// Push-to-talk dictation session state. One instance per Electron main
// process; replaces the ad-hoc globalThis.__dictation* slots that used to live
// in main.js.
//
// Lifecycle:
//   tryStart() -> release() -> finalize() -> done()
//
// `tryStart` rejects a second press while a previous dictation is still
// processing. `release` arms a safety timer so a missing transcript can't
// permanently jam the session (busy clears after safetyTimeoutMs even if no
// transcript ever arrives). `finalize` is called on the terminal event
// (transcript or error) and stops the safety timer. `done` is the last
// transition that re-opens the session for the next press.

import { randomUUID } from "node:crypto";

/**
 * @typedef {object} DictationSessionOptions
 * @property {number} [safetyTimeoutMs]
 * @property {(...args: unknown[]) => void} [log]
 */

export class DictationSession {
  /** @param {DictationSessionOptions} [options] */
  constructor({ safetyTimeoutMs = 500, log = console.error } = {}) {
    /** @type {boolean} */
    this.busy = false;
    // Bumped once per ACCEPTED press. A handler that takes seconds (cleanup +
    // paste, or the batch rescue) snapshots this on entry and compares before it
    // touches shared state — the pill, the saved foreground window, done(). By
    // then the press it belongs to may be long gone: release() arms a 500ms
    // safety timer that clears `busy`, so a new dictation can legally start
    // while the old one is still finishing.
    //
    // A REJECTED press must not bump it. If it did, the in-flight handler would
    // see a changed generation, skip done(), and leave `busy` stuck true with
    // the safety timer already cleared by finalize() — permanently deaf app.
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
    /** @type {number | null} */
    this.releaseAt = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._safetyTimer = null;
    this._safetyTimeoutMs = safetyTimeoutMs;
    this._log = log;
  }

  /**
   * Try to start a new dictation. Returns false if a previous dictation is
   * still in flight (caller should ignore the press in that case).
   *
   * @returns {boolean}
   */
  tryStart() {
    if (this.busy) {
      this._log("[dictation-session] PRESS ignored — previous dictation still processing");
      return false;
    }
    this._clearSafetyTimer();
    this.busy = true;
    this.generation += 1;
    // Issued here and nowhere else. done() deliberately leaves it alone: the
    // empty-transcript rescue re-opens the session early and then keeps asking
    // owns() for seconds afterwards, so the name has to outlive the busy flag
    // and change only when a real new press arrives.
    this.id = `${this.generation}-${randomUUID().slice(0, 8)}`;
    // Forget the previous session's release stamp, or finalize() on a session
    // that errors before release would report timings from the LAST dictation.
    this.releaseAt = null;
    return true;
  }

  /**
   * Accept the hotkey release. Arms the safety timer so a missing transcript
   * can't permanently jam the session.
   *
   * @returns {boolean} false if no dictation was active to release
   */
  release() {
    if (!this.busy) return false;
    this.releaseAt = Date.now();
    this._clearSafetyTimer();
    this._safetyTimer = setTimeout(() => {
      if (this.busy) {
        this._log("[dictation-session] safety timeout — clearing busy");
        this.busy = false;
      }
    }, this._safetyTimeoutMs);
    return true;
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

  // Final transition: re-open the session for the next press. Call once the
  // transcript has been typed (or on error).
  done() {
    this.busy = false;
  }

  // Abandon the current dictation on an error path: stop the safety timer and
  // re-open the session in one step. The success path keeps calling finalize()
  // then done() separately because it needs finalize()'s timing return.
  fail() {
    this.finalize();
    this.done();
  }

  _clearSafetyTimer() {
    if (this._safetyTimer) {
      clearTimeout(this._safetyTimer);
      this._safetyTimer = null;
    }
  }
}
