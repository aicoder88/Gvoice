// @ts-check

// App names (lowercased) that mean "the paste target is a terminal emulator".
// Terminals run TUIs (tmux, vim, editors, Claude Code) that draw box borders and
// wrap lines, so the focused element's on-screen text (AXValue) is a poor place
// to look for our pasted string — read-back verification gives false negatives
// there. Recognising the app lets us skip that check and trust the paste instead
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

/** @param {string} value */
function normalize(value) {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Combine the paste transport result with macOS's optional Accessibility
 * read-back. AX role/focus checks are advisory: custom Electron/browser editors
 * can accept ⌘V while reporting no editable element at all. A successful
 * paste shortcut is therefore the handoff result; AX may confirm it or flag a
 * suspicious readable mismatch, but it cannot turn that success into failure.
 *
 * @param {{
 *   typed: boolean,
 *   restoreRequired: boolean,
 *   restored: boolean,
 *   fieldFocused: boolean | null,
 *   isTerminal: boolean,
 *   fieldValue: string | null,
 *   text: string
 * }} input
 * @returns {{ pasted: boolean, verified: boolean | null, likelyMissed: boolean }}
 */
export function assessPasteOutcome(input) {
  const transportSucceeded = input.typed && !(input.restoreRequired && !input.restored);
  if (!transportSucceeded) return { pasted: false, verified: null, likelyMissed: false };

  const verified = !input.isTerminal && typeof input.fieldValue === "string"
    ? normalize(input.fieldValue).includes(normalize(input.text))
    : null;

  const pasted = true;
  // Two different "the text probably didn't land" shapes. Neither is strong
  // enough to call the paste a failure — both are strong enough to keep the
  // text on the clipboard so ⌘V rescues it.
  //   1. We read the field back, it had real content, and our text wasn't in
  //      it. The seven false "paste failed" pills that got the hard downgrade
  //      removed all read back EMPTY (an app that just doesn't expose its
  //      composer), so requiring content separates them.
  //   2. The pre-paste probe said no editable field was focused AND the
  //      post-paste read-back found nothing to read either. That is what ⌘V
  //      into the Finder desktop (or any window with no text field) looks
  //      like: without this, it reports a bare 3s "Success" and typing.js's
  //      250ms clipboard restore then wipes the only remaining copy.
  //      fieldFocused is false only when AX positively reported "nothing
  //      editable focused" — null (Windows, or AX not trusted) never counts.
  const readBackMismatch = verified === false && (input.fieldValue?.length || 0) > 0;
  const noTargetAtAll = input.fieldFocused === false && !input.isTerminal && input.fieldValue === null;
  const likelyMissed = pasted && (readBackMismatch || noTargetAtAll);
  return { pasted, verified, likelyMissed };
}
