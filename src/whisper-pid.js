// @ts-check
// Ownership record for the whisper-server child process.
//
// Why this file exists: the PID marker used to be a bare number in a single
// shared file under $TMPDIR, so every GVoice on the Mac pointed at the same
// marker. Start a dev copy while the installed app is running and the dev copy
// read the installed app's PID, saw "whisper-server" in `ps`, and killed it —
// the person dictating lost their speech engine mid-sentence.
//
// The marker now lives inside the instance's own userData folder AND carries a
// three-field identity: the pid, that pid's start time as the OS reports it,
// and the userData folder of the instance that wrote it. A server is reaped
// only when all three still match. Different userData → never a match, so a dev
// launch can no longer touch the installed app's engine even if the two files
// were somehow pointed at each other.

import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Marker version. Bump if the record shape changes. */
export const PID_RECORD_VERSION = 1;

/**
 * The userData folder this process belongs to, normalised. Runs with no
 * Electron app behind them (the parity harness, `node server.js`) have none, so
 * they share one stand-in identity and keep using the historical $TMPDIR marker
 * between themselves. That stand-in can never equal a real userData path, so an
 * Electron instance's engine is still out of their reach.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function ownerUserData(env = process.env) {
  const raw = env.GVOICE_USER_DATA_RESOLVED || "";
  return raw ? resolve(raw) : resolve(join(tmpdir(), "gvoice-no-userdata"));
}

/**
 * Where the marker lives for this process.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function pidFilePath(env = process.env) {
  const raw = env.GVOICE_USER_DATA_RESOLVED || "";
  return raw
    ? join(resolve(raw), "whisper-server.pid")
    : join(tmpdir(), "gvoice-whisper-server.pid");
}

/**
 * The OS's start time for a pid, as an opaque string. Two processes that reuse
 * the same pid number cannot share it. Empty string when the pid is gone or the
 * platform won't say (Windows `wmic` is not assumed present) — an empty value
 * never matches, so an unreadable start time means "don't kill".
 * @param {number} pid
 * @returns {string}
 */
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.Ticks`],
        { encoding: "utf8" }
      );
      return out.trim();
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
    return out.trim();
  } catch {
    return "";
  }
}

/**
 * Build the record to write after a successful spawn.
 * @param {{ pid: number, port: number|string, env?: NodeJS.ProcessEnv, startTime?: string }} args
 */
export function buildPidRecord({ pid, port, env = process.env, startTime }) {
  return {
    v: PID_RECORD_VERSION,
    pid,
    startTime: startTime === undefined ? processStartTime(pid) : startTime,
    userData: ownerUserData(env),
    port: Number(port) || 0
  };
}

/**
 * Parse a marker file's contents. Returns null for anything that is not a
 * well-formed record of this version — including the legacy bare-number file
 * written by older builds, which carries no identity and must never authorise
 * a kill.
 * @param {string} text
 * @returns {{ v: number, pid: number, startTime: string, userData: string, port: number } | null}
 */
export function parsePidRecord(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.v !== PID_RECORD_VERSION) return null;
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
  if (typeof parsed.startTime !== "string") return null;
  if (typeof parsed.userData !== "string") return null;
  return {
    v: parsed.v,
    pid: parsed.pid,
    startTime: parsed.startTime,
    userData: parsed.userData,
    port: Number(parsed.port) || 0
  };
}

/**
 * The three-field ownership match. All three must line up:
 *   pid       — the marker names the process we are about to kill,
 *   startTime — that pid is still the same process the marker was written for,
 *   userData  — the marker was written by an instance sharing our data folder.
 * A blank startTime or userData on either side is a mismatch, never a pass.
 *
 * @param {unknown} record   parsed marker
 * @param {{ pid: number, startTime: string, userData: string }} self  live facts
 * @returns {boolean}
 */
export function ownsRecord(record, self) {
  if (!record || typeof record !== "object") return false;
  const r = /** @type {{ pid?: unknown, startTime?: unknown, userData?: unknown }} */ (record);
  if (!Number.isInteger(r.pid) || Number(r.pid) <= 0) return false;
  if (!Number.isInteger(self?.pid) || self.pid <= 0) return false;
  if (r.pid !== self.pid) return false;
  if (typeof r.startTime !== "string" || !r.startTime) return false;
  if (!self.startTime) return false;
  if (r.startTime !== self.startTime) return false;
  if (typeof r.userData !== "string" || !r.userData) return false;
  if (!self.userData) return false;
  return resolve(r.userData) === resolve(self.userData);
}
