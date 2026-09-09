// @ts-check

// App names (lowercased) that mean "the paste target is a terminal emulator".
// Terminals run TUIs (tmux, vim, editors, Claude Code) that draw box borders and
// wrap lines, so the focused element's on-screen text (AXValue) is a poor place
// to look for our pasted string — read-back verification gives false negatives
// there. Recognising the app lets us skip that check and retain the clipboard instead
// of flagging a failure. Matched EXACTLY against the .app bundle name and the
// executable basename (e.g. "iterm" and "iterm2") — never a substring — so an
// app merely *containing* one of these words ("Terminal Velocity",
// "Hyperplanning") is NOT mistaken for a terminal and keeps its read-back check.
// The bundle name alone covers every listed app; the extra binary basenames are
// the fallback for a terminal binary launched outside a .app wrapper.
const TERMINAL_BINARIES = new Set([
  "iterm", "iterm2", "terminal", "ghostty", "alacritty", "wezterm",
  "wezterm-gui", "kitty", "warp", "tabby", "hyper", "cmux"
]);

/** @param {string} bundle @param {string} basename */
export function isTerminalApp(bundle, basename) {
  return TERMINAL_BINARIES.has(bundle.toLowerCase()) || TERMINAL_BINARIES.has(basename.toLowerCase());
}

// Confirm one exact insertion into the same readable field. Existing matching
// text, smart punctuation changes, whitespace normalization, or a different
// field are not evidence that this particular paste was consumed.
export function exactInsertionConfirmed(before, after, text) {
  if (typeof before !== "string" || typeof after !== "string" || !text || after.length !== before.length + text.length) return false;
  let prefix = 0;
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const earliest = Math.max(0, before.length - suffix);
  const insertion = after.indexOf(text, earliest);
  return insertion >= earliest && insertion <= prefix;

}

export function assessPasteOutcome(input) {
  const pasted = input.typed && !(input.restoreRequired && !input.restored);
  if (!pasted) return { pasted: false, verified: null, likelyMissed: false, deliveryState: "failed" };
  const readable = !input.isTerminal && typeof input.fieldValue === "string";
  const verified = readable ? input.sameField === true && exactInsertionConfirmed(input.beforeValue, input.fieldValue, input.text) : null;
  const likelyMissed = (verified === false && input.fieldValue.length > 0) ||
    (input.fieldFocused === false && !input.isTerminal && input.fieldValue === null);
  return { pasted: true, verified, likelyMissed, deliveryState: verified === true ? "verified" : "sent-unverified" };
}

/**
 * Should this paste be allowed to land, given the app that owned the field when
 * the user pressed the hotkey and the app that owns it now?
 *
 *   "same"      — read the app, it's the one we recorded. Paste.
 *   "different" — read the app, it's a DIFFERENT one. Refuse.
 *   "unknown"   — Accessibility wouldn't say. Refuse, but not as a failure.
 *
 * "unknown" refusing is deliberate, and it is the opposite of how this app
 * treats every other Accessibility answer. Everywhere else null means "couldn't
 * tell, don't hold it against the paste", because the cost of being wrong is a
 * pill that says the wrong thing. Here the cost of being wrong is the user's
 * dictation appearing inside a stranger's window, and that is not recoverable.
 * The two mistakes are not the same size, so they don't get the same default.
 *
 * Refusing costs one ⌘V: the caller keeps the text on the clipboard and tells
 * the user where it is. Allowing costs a leak. Measured 2026-09-07: the app
 * that most often returns nothing at all to a system-wide focused-element read
 * is Chrome — i.e. "couldn't tell" lines up with "some other app is in front",
 * which is exactly the case the guard exists for.
 *
 * @param {number | null | undefined} sourcePid app that owned the field at press time
 * @param {number | null | undefined} currentPid app that owns it now
 * @returns {"same" | "different" | "unknown"}
 */
export function decidePasteOwnership(sourcePid, currentPid) {
  // Nothing recorded at press time: there is no claim to check, so this guard
  // has no opinion and the paste goes ahead as it always did.
  if (sourcePid == null) return "same";
  if (currentPid == null) return "unknown";
  return currentPid === sourcePid ? "same" : "different";
}
