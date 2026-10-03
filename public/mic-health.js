// @ts-check
// Chromium device IDs can change between app launches. Resolve a saved name
// against real inputs, excluding aliases that follow the system default.
export function resolvePreferredInput(devices, id = '', label = '') {
  const inputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId && !['default', 'communications'].includes(d.deviceId));
  const named = label ? inputs.find(d => d.label === label || d.label.startsWith(label + ' (')) : null;
  const exact = inputs.find(d => d.deviceId === id);
  if (label) return named || (exact && !exact.label ? exact : null);
  return exact || null;
}

// Pure decision logic for spotting a dead microphone capture pipeline from the
// loudest frame of a single recorded hold. Shared by the dictation renderer
// (imported over HTTP as an ES module) and the unit tests (imported by node) —
// ONE implementation, provably the same on both sides, instead of a copy in the
// renderer that drifts from a copy in a test.
//
// The signal is digital silence. A real microphone in a real room always
// carries a noise floor, so the loudest frame of any hold is strictly > 0. A
// peak of EXACTLY 0 across a long-enough hold means no audio reached the app at
// all — the capture stream went dead (the classic macOS/Electron failure after
// sleep/wake or an audio-device change, where the track stays "live" but pipes
// zeros). That is proof on a SINGLE hold, so we rebuild immediately. A
// low-but-nonzero peak is ambiguous (a genuinely quiet room, a distant mic, or a
// partly-wedged device), so we only treat a RUN of those as a dead mic.

/**
 * Classify one finished hold.
 *
 * @param {object} p
 * @param {number} p.bytes        bytes captured during this hold
 * @param {number} p.peak         loudest worklet frame this hold (0..1)
 * @param {number} p.minBytes     below this the hold is a misfire (a tap), not judged
 * @param {number} p.silencePeak  peak at/under which a long hold counts as "silent"
 * @param {number} p.silentStreak consecutive silent holds BEFORE this one
 * @param {number} p.streakLimit  this many silent holds in a row ⇒ dead mic
 * @param {number} [p.holdMs]     how long the key was held (0/absent = unknown)
 * @param {number} [p.minHoldMs]  a hold at least this long with ~no bytes ⇒ dead
 * @returns {{ action: "ignore" | "ok" | "silent" | "dead", cause: "" | "no-frames" | "silence" | "quiet", silentStreak: number }}
 *   "dead"   ⇒ rebuild the capture pipeline now (zero peak, or the streak hit);
 *   "silent" ⇒ a silent hold counted toward the streak, not yet dead;
 *   "ok"     ⇒ real audio arrived;
 *   "ignore" ⇒ too short to judge.
 *   `silentStreak` is the new running count to carry into the next hold.
 *
 *   `cause` says WHY a hold is dead, because the three causes deserve different
 *   answers. "no-frames" (a long hold that delivered nothing) and "silence"
 *   (digital zero) are proof the device is not feeding us audio, so the caller
 *   may hunt for another one. "quiet" is only a run of very soft holds – a
 *   distant mic, a soft speaker, a quiet room. Rebuild the same device if you
 *   like, but never switch device or reload on that evidence alone: it accuses
 *   hardware of what may simply be someone talking softly.
 */
export function classifyHold({ bytes, peak, minBytes, silencePeak, silentStreak, streakLimit, holdMs = 0, minHoldMs = 1000 }) {
  // No (or almost no) bytes despite a long hold: the pipeline delivered no
  // frames AT ALL — a wedge the peak checks below can never see, because they
  // need frames to arrive. A half-built graph after a failed rebuild looks
  // exactly like this. The byte gate alone would file it as a tap forever.
  if (bytes < minBytes && holdMs >= minHoldMs) return { action: "dead", cause: "no-frames", silentStreak: 0 };

  // A tap, not a held dictation — nothing to judge, leave the streak untouched.
  if (bytes < minBytes) return { action: "ignore", cause: "", silentStreak };

  // Pure digital silence is a dead pipeline, never a quiet room: one is enough.
  if (peak === 0) return { action: "dead", cause: "silence", silentStreak: 0 };

  // Below the noise threshold but not truly zero — ambiguous. Count it; only a
  // run of these is the mic rather than the user choosing silence.
  if (peak < silencePeak) {
    const next = silentStreak + 1;
    if (next >= streakLimit) return { action: "dead", cause: "quiet", silentStreak: 0 };
    return { action: "silent", cause: "", silentStreak: next };
  }

  // Real audio — reset the streak.
  return { action: "ok", cause: "", silentStreak: 0 };
}

// --- Microphone mode ---------------------------------------------------------
// How long the capture graph stays alive after a dictation, per the user's
// choice in Settings. Shared with src/preferences.js (which owns the names and
// the default) and with the tests, so the renderer can never invent a fourth
// mode or a different number of seconds.

/** ms of idle before the mic is dropped, by mode. Infinity = never drop. */
export const MIC_IDLE_BY_MODE = {
  always: Infinity,   // ready the instant the key goes down; nothing streamed while idle
  balanced: 120000,   // the old fixed two minutes
  hold: 0             // built per press, dropped on release (no pre-roll)
};

/**
 * ms of idle before the mic is dropped. An unknown or missing mode is the
 * default ("always") rather than 0 – guessing "cold" would quietly clip the
 * first word of every dictation.
 * @param {string} [mode]
 * @returns {number}
 */
export function idleMsForMode(mode) {
  const key = typeof mode === "string" ? mode.toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(MIC_IDLE_BY_MODE, key)
    ? MIC_IDLE_BY_MODE[key]
    : MIC_IDLE_BY_MODE.always;
}

// --- Which device to bind to -------------------------------------------------
/**
 * Browser device IDs are scoped to the relay origin, including its random
 * port. Reconnect a saved choice after restart only when its exact label
 * identifies one real input. Duplicate labels and missing devices keep the
 * old choice, so an ambiguous match cannot silently choose another mic.
 * @param {string} preferredId
 * @param {string} preferredLabel
 * @param {{ id: string, label: string }[]} devices
 * @returns {string}
 */
export function resolvePreferredMicId(preferredId, preferredLabel, devices) {
  if (!preferredId || !preferredLabel || devices.some(d => d.id === preferredId)) return preferredId;
  const matches = devices.filter(d => d.id && d.id !== "default" && d.id !== "communications"
    && d.label === preferredLabel);
  return matches.length === 1 ? matches[0].id : preferredId;
}

// The user can name a preferred microphone (a headset, a desk mic). It is not
// always there: it gets unplugged, or the machine wakes before USB re-enumerates.
// The rule, in one place so the renderer and the tests agree:
//   * preferred device present  → bind to it (rebuild if we are on another one);
//   * preferred device missing  → the system default, flagged "fallback", and
//     stay there without churning until the preferred one is back;
//   * no preference at all      → the system default, nothing to return to.
// "Come back to the preferred device" is checked BETWEEN dictations only, never
// mid-hold – rebinding under a live hold would throw away what the user is
// saying.

/**
 * @param {object} p
 * @param {string} [p.preferredId]    the user's chosen deviceId ("" = none)
 * @param {string|null} [p.fallbackId] device to open when there is no usable preference (null = system default)
 * @param {string|null} [p.currentId] deviceId the live graph is bound to right now
 * @param {string|null} [p.requestedId] deviceId the live graph was OPENED for, before the OS resolved it
 * @param {string[]} [p.availableIds] audio input deviceIds visible right now (empty = we could not look)
 * @param {boolean} [p.captureReady]  is there a live capture graph at all
 * @returns {{ deviceId: string|null, source: "preferred"|"fallback"|"default", rebuild: boolean }}
 */
export function chooseCaptureDevice({
  preferredId = "",
  fallbackId = null,
  currentId = null,
  requestedId = null,
  availableIds = [],
  captureReady = false
} = {}) {
  // An empty list means enumerateDevices failed or has not been allowed yet –
  // NOT that every microphone vanished. Treating that as "preferred is gone"
  // would drop the user's choice the first time the browser refused to list
  // devices, so an unknown list keeps the preference.
  const known = Array.isArray(availableIds) && availableIds.length > 0;

  if (preferredId && (!known || availableIds.includes(preferredId))) {
    // Already on it counts two ways, because the id we ask for and the id we
    // get back are not always the same string. getSettings() reports the
    // CONCRETE device, so a preference the OS resolves ("default", or an id it
    // maps to another entry) never equals the live one – and comparing only
    // those two asked for a rebuild after every single dictation, forever.
    // Asking "did we open this graph FOR the preferred device?" converges.
    const onIt = currentId === preferredId || requestedId === preferredId;
    return {
      deviceId: preferredId,
      source: "preferred",
      rebuild: !captureReady || !onIt
    };
  }

  return {
    deviceId: captureReady ? currentId : fallbackId,
    // Named "fallback" only when there IS a preference we could not honour, so
    // the settings window can say so instead of implying the user chose this.
    source: preferredId ? "fallback" : "default",
    rebuild: !captureReady
  };
}
