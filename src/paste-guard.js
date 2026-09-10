// @ts-check
// Is the text still going where the user was looking when they started talking?
//
// Dictation takes seconds. In that time the user can click into Slack, switch
// desktops, or have a meeting window steal focus — and a ⌘V fired blindly at
// the end drops private words into whatever is in front. This module answers
// one question: does the place a paste would land right now match the place the
// press started in?
//
// Pure on purpose. It takes two snapshots from src/foreground.js and returns a
// decision, so the whole rule is unit-testable without Electron, without
// Accessibility permission and without a real window on screen.

/** @typedef {import("./foreground.js").ForegroundTarget} ForegroundTarget */

/**
 * @typedef {object} DestinationDecision
 * @property {boolean} ok    true = paste, false = leave it on the clipboard
 * @property {string} reason one of: unchecked, match, unreadable, app-changed,
 *   window-changed, no-editable-field
 */

/**
 * Compare the destination captured at press time with the one in front of the
 * user now.
 *
 * `before` null means the check isn't available on this machine (Windows, no
 * Accessibility permission, AX unreachable). Nothing was promised, so nothing
 * is refused: the paste goes ahead exactly as it did before this guard existed,
 * and the platform's own signals (the Windows hwnd check, the macOS read-back)
 * stay in charge. That is the ONLY path that pastes without a comparison.
 *
 * `after` null with a real `before` is the opposite case: we could read the
 * destination a moment ago and cannot now. That is not a licence to guess —
 * the words stay on the clipboard.
 *
 * @param {ForegroundTarget | null | undefined} before
 * @param {ForegroundTarget | null | undefined} after
 * @returns {DestinationDecision}
 */
export function sameDestination(before, after) {
  if (!before) return { ok: true, reason: "unchecked" };
  if (!after) return { ok: false, reason: "unreadable" };
  // The pid is the strongest half of the app's identity: two windows of the
  // same app share a name, and a relaunched app gets a new pid. The name is
  // compared too so a pid the OS recycled can't slip through.
  if (before.pid !== after.pid || before.app !== after.app) {
    return { ok: false, reason: "app-changed" };
  }
  // Only compared when BOTH readings have a number. A macOS that no longer
  // exposes window ids would otherwise refuse every paste on the machine.
  const bw = before.windowNumber;
  const aw = after.windowNumber;
  if (typeof bw === "number" && typeof aw === "number" && bw !== aw) {
    return { ok: false, reason: "window-changed" };
  }
  // Right app, right window, but the caret is no longer in something that
  // takes typing (the user clicked the canvas, a dialog took focus inside the
  // same window). ⌘V there goes nowhere or, worse, fires a keyboard shortcut.
  if (after.editable !== true) return { ok: false, reason: "no-editable-field" };
  return { ok: true, reason: "match" };
}

/**
 * Take the second reading and decide. Kept next to the comparison so every
 * caller treats a reader that throws the same way a reader that returns null is
 * treated: unreadable, so don't paste.
 *
 * @param {ForegroundTarget | null | undefined} before
 * @param {() => (ForegroundTarget | null | Promise<ForegroundTarget | null>)} read
 * @returns {Promise<DestinationDecision>}
 */
export async function checkDestination(before, read) {
  if (!before) return { ok: true, reason: "unchecked" };
  let after = null;
  try {
    after = await read();
  } catch (err) {
    console.error("[paste-guard] destination read failed:", err && err.message);
    after = null;
  }
  return sameDestination(before, after);
}
