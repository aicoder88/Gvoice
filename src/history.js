// @ts-check
// Transcript history: the last MAX_ENTRIES dictations, persisted to a JSON
// file in userData so a missed paste is never lost — even across restarts.
// Newest first. Reads happen once at boot; writes are serialized so rapid
// dictations can't interleave and corrupt the file.
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { DELIVERY_STATES as LEASE_DELIVERY_STATES } from "./clipboard-lease.js";

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
 * `copy` marks text that was never pasted because the user had moved to a
 * different app or window by the time it was ready. It is on the clipboard
 * instead, and the tray says "copied" so the entry doesn't read as a failure.
 *
 * `sessionId` names the press that produced the entry (see
 * src/dictation-session.js), so a line in history can be matched to a line in
 * the debug log.
 *
 * @typedef {{ ts: number, text: string, pasted: boolean, recordingPath?: string | null, recovered?: boolean, cancelled?: boolean, copy?: boolean, sessionId?: string | null }} HistoryEntry
 */

/** @type {HistoryEntry[]} */
let entries = [];

// What actually became of a dictation. One field instead of the four booleans
// the two machines grew separately, so the tray has one thing to read and a
// new outcome cannot be half-added.
//
//   verified        pasted, and read back out of the field afterwards
//   sent-unverified pasted, but nothing readable to confirm it with
//   refused         the destination changed, so it waits on the clipboard
//   cancelled       the user gave up, before or after the words arrived
//   superseded      a newer press took over before this one was delivered
//   recovered       transcribed again later from the saved clip
//   failed          the paste itself threw
// The first five are a paste's own outcomes and belong to the clipboard lease;
// history adds the two that happen without a paste at all.
export const DELIVERY_STATES = [...LEASE_DELIVERY_STATES, "cancelled", "recovered"];

// History written before this field existed, read back without losing meaning.
function legacyState(entry) {
  if (entry.cancelled) return "cancelled";
  if (entry.copy) return "refused";
  if (entry.recovered) return "recovered";
  return entry.pasted ? "sent-unverified" : "failed";
}

// The one place an outcome is decided. Callers pass what they know; an explicit
// deliveryState always wins, and the older flags still map cleanly so no call
// site has to change on the same day as the merge.
function resolveDeliveryState(pasted, meta = {}) {
  if (DELIVERY_STATES.includes(meta.deliveryState)) return meta.deliveryState;
  return legacyState({ ...meta, pasted });
}

/**
 * What the tray's "Recent dictations" row says about an entry. The one place an
 * outcome becomes words, so a new outcome cannot show up with the wrong label
 * or a warning it does not deserve. Only a paste that genuinely failed earns the
 * ⚠: the user cancelling, moving on, or being overtaken by a newer dictation
 * are all things that happened on purpose.
 *
 * @param {{ deliveryState?: string, text?: string, pasted?: boolean }} entry
 * @returns {{ note: string | null, warn: boolean }}
 */
export function trayLabelFor(entry) {
  const state = DELIVERY_STATES.includes(entry.deliveryState) ? entry.deliveryState : legacyState(entry);
  const hasText = !!(entry.text || "").trim();
  switch (state) {
    case "verified":
    case "sent-unverified":
      return { note: null, warn: false };
    case "cancelled":
      return { note: hasText ? "Cancelled – never pasted" : null, warn: false };
    case "refused":
      return { note: hasText ? "Not pasted – copied instead" : null, warn: false };
    case "superseded":
      return { note: hasText ? "A newer dictation took over – never pasted" : null, warn: false };
    case "recovered":
      return { note: hasText ? "Recovered later – never pasted" : null, warn: false };
    default:
      return { note: "⚠ Wasn't pasted into any app", warn: true };
  }
}

/** @type {string | null} */
let historyPath = null;
/** @type {Promise<void>} */
let writeChain = Promise.resolve();

/** Load existing history from disk. Call once after app is ready. */
export async function initHistory() {
  // Electron is imported here rather than at the top of the file so the rest of
  // this module (recordTranscript, getHistory) can be exercised by a plain
  // `node --test` run, which has no Electron runtime to import from.
  const { app } = await import("electron");
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
          deliveryState: DELIVERY_STATES.includes(e.deliveryState) ? e.deliveryState : legacyState(e),
          recordingPath: typeof e.recordingPath === "string" ? e.recordingPath : null,
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
 * @param {{ recovered?: boolean, cancelled?: boolean, copy?: boolean, sessionId?: string | null }} [meta]
 */
export function recordTranscript(text, pasted, recordingPath = null, meta = {}) {
  if ((!text || !text.trim()) && !recordingPath) return;
  entries.unshift({
    ts: Date.now(),
    text: text || "",
    pasted,
    deliveryState: resolveDeliveryState(pasted, meta),
    recordingPath: recordingPath || null,
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

/**
 * The newest entry that actually has words in it — what the tray's "Copy last
 * result" copies. Entries with only a recording (a failed or empty attempt) are
 * skipped: there is nothing to put on the clipboard, and stopping at one would
 * hide the result the user is reaching for.
 *
 * Whether the text was pasted, cancelled, recovered or left on the clipboard
 * makes no difference here. Those are all "the last thing I said", and this menu
 * item exists precisely to rescue the ones that never landed.
 *
 * @param {HistoryEntry[]} [list] defaults to the live history
 * @returns {HistoryEntry | null}
 */
export function lastResult(list = entries) {
  for (const entry of list) {
    if (entry && typeof entry.text === "string" && entry.text.trim()) return entry;
  }
  return null;
}
