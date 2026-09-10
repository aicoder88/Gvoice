// @ts-check
// Transcript history: the last MAX_ENTRIES dictations, persisted to a JSON
// file in userData so a missed paste is never lost — even across restarts.
// Newest first. Reads happen once at boot; writes are serialized so rapid
// dictations can't interleave and corrupt the file.
import { app } from "electron";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

const MAX_ENTRIES = 50;

/**
 * `recovered` marks text that reached history instead of the user's cursor: a
 * transcript that came back after the press it belonged to was over, or one the
 * batch retry pulled out of a saved clip. It is never pasted, so the tray has to
 * say where it came from.
 *
 * `cancelled` marks text whose press the user stopped on purpose (Escape, or a
 * click on the pill) while it was still being transcribed. It is never pasted
 * either, but it is not a mishap the way `recovered` is — the tray says
 * "cancelled" so the user knows their own key did it.
 *
 * `sessionId` names the press that produced the entry (see
 * src/dictation-session.js), so a line in history can be matched to a line in
 * the debug log.
 *
 * @typedef {{ ts: number, text: string, pasted: boolean, recordingPath?: string | null, recovered?: boolean, cancelled?: boolean, sessionId?: string | null }} HistoryEntry
 */

/** @type {HistoryEntry[]} */
let entries = [];
/** @type {string | null} */
let historyPath = null;
/** @type {Promise<void>} */
let writeChain = Promise.resolve();

/** Load existing history from disk. Call once after app is ready. */
export async function initHistory() {
  historyPath = join(app.getPath("userData"), "history.json");
  try {
    const raw = JSON.parse(await readFile(historyPath, "utf8"));
    if (Array.isArray(raw)) {
      entries = raw
        .filter((e) => e && typeof e.text === "string" && typeof e.ts === "number")
        .map((e) => ({
          ts: e.ts,
          text: e.text,
          pasted: !!e.pasted,
          recordingPath: typeof e.recordingPath === "string" ? e.recordingPath : null,
          recovered: !!e.recovered,
          cancelled: !!e.cancelled,
          sessionId: typeof e.sessionId === "string" ? e.sessionId : null
        }))
        .slice(0, MAX_ENTRIES);
    }
  } catch {
    // Missing or unreadable file — start fresh.
    entries = [];
  }
}

/** @returns {string | null} absolute path of the history file (after init) */
export function getHistoryPath() {
  return historyPath;
}

/** @returns {HistoryEntry[]} newest-first copy */
export function getHistory() {
  return entries.slice();
}

/**
 * Record a finished dictation and persist. Fire-and-forget: failures are
 * logged, never thrown into the dictation path. An entry is worth keeping if it
 * has text OR a recording to listen to (a failed/empty attempt has only audio).
 * @param {string} text
 * @param {boolean} pasted
 * @param {string | null} [recordingPath]
 * @param {{ recovered?: boolean, cancelled?: boolean, sessionId?: string | null }} [meta]
 */
export function recordTranscript(text, pasted, recordingPath = null, meta = {}) {
  if ((!text || !text.trim()) && !recordingPath) return;
  entries.unshift({
    ts: Date.now(),
    text: text || "",
    pasted,
    recordingPath: recordingPath || null,
    recovered: !!meta.recovered,
    cancelled: !!meta.cancelled,
    sessionId: typeof meta.sessionId === "string" ? meta.sessionId : null
  });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  const snapshot = JSON.stringify(entries, null, 2);
  // Atomic write (tmp + rename): a crash mid-write must not leave a truncated
  // file — initHistory's catch would then silently start fresh, wiping the
  // very history that exists so "a missed paste is never lost".
  writeChain = writeChain
    .then(async () => {
      if (!historyPath) return;
      await writeFile(historyPath + ".tmp", snapshot, "utf8");
      await rename(historyPath + ".tmp", historyPath);
    })
    .catch((err) => console.error("[history] write failed:", err && err.message));
}
