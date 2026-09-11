// @ts-check
// User preferences that are NOT secrets: which microphone to listen to, and how
// ready to keep it. They live in their own JSON file inside the app's data
// folder (`preferences.json`), never in `.env`.
//
// Why a separate file at all: `.env` holds API keys. Every write to it risks the
// keys, it is edited by hand, and it is the one file the app must never lose.
// A microphone choice changes whenever the user plugs in a headset, so it gets a
// file of its own that can be rewritten freely and thrown away without costing
// anything. A missing or corrupt file is not an error – it reads back as the
// defaults.
//
// Kept free of any Electron import so plain `node --test` can exercise it; the
// caller passes in the resolved path (see preferencesPath below).

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * How long the capture graph stays alive after a dictation:
 *   always   – never dropped. The mic is ready the instant the key goes down and
 *              the pre-roll ring already holds the half-second before the press.
 *              Nothing is streamed anywhere while idle.
 *   balanced – dropped two minutes after the last dictation (the old fixed
 *              behaviour). Presses inside a working burst are still instant.
 *   hold     – built per press and dropped on release. No pre-roll, so a fast
 *              speaker can clip their own first word.
 * @type {readonly ["always", "balanced", "hold"]}
 */
export const MIC_MODES = /** @type {const} */ (["always", "balanced", "hold"]);

/** @typedef {{ micMode: "always" | "balanced" | "hold", preferredMicId: string, preferredMicLabel: string }} Preferences */

/** @type {Preferences} */
export const DEFAULT_PREFERENCES = {
  micMode: "always",
  preferredMicId: "",
  preferredMicLabel: ""
};

/**
 * Where the file lives for a given app-data folder. Inside userData, so an
 * isolated dev launch (GVOICE_USER_DATA) keeps its own choices and can never
 * rewrite the installed app's.
 * @param {string} userDataDir
 */
export function preferencesPath(userDataDir) {
  return join(userDataDir, "preferences.json");
}

/**
 * Coerce anything (a parsed file, an IPC payload) into a complete, valid
 * Preferences object. Unknown keys are dropped and bad values fall back to the
 * default rather than reaching the renderer, where an unexpected mode would
 * silently mean "never keep the mic ready".
 *
 * @param {unknown} raw
 * @param {Preferences} [base] values to fall back to (defaults to DEFAULT_PREFERENCES)
 * @returns {Preferences}
 */
export function normalizePreferences(raw, base = DEFAULT_PREFERENCES) {
  const src = /** @type {Record<string, unknown>} */ (raw && typeof raw === "object" ? raw : {});
  const mode = typeof src.micMode === "string" ? src.micMode.toLowerCase() : "";
  const id = typeof src.preferredMicId === "string" ? src.preferredMicId.trim() : null;
  const label = typeof src.preferredMicLabel === "string" ? src.preferredMicLabel.trim() : null;
  return {
    micMode: /** @type {Preferences["micMode"]} */ (
      MIC_MODES.includes(/** @type {any} */ (mode)) ? mode : base.micMode
    ),
    preferredMicId: id === null ? base.preferredMicId : id,
    // A cleared device also clears its remembered name, so the settings window
    // can never show "Preferred: Anker" next to a preference that is gone.
    preferredMicLabel: id === "" ? "" : label === null ? base.preferredMicLabel : label
  };
}

/**
 * Read the file. Missing, unreadable or corrupt all mean "use the defaults" –
 * a mangled preferences file must never stop dictation from working.
 * @param {string} path
 * @returns {Preferences}
 */
export function readPreferences(path) {
  try {
    return normalizePreferences(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Merge `patch` into what is on disk and write the result. Returns the saved
 * preferences. Throws only if the file cannot be written – the caller turns
 * that into a visible message rather than a silent no-op.
 *
 * The write is tmp + rename, so a crash mid-write leaves the previous choices
 * intact instead of a half-written file that reads back as the defaults.
 *
 * @param {string} path
 * @param {unknown} patch
 * @returns {Preferences}
 */
export function writePreferences(path, patch) {
  const next = normalizePreferences(patch, readPreferences(path));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
  return next;
}
