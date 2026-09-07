// How long the pasted text stays on the clipboard before the user's own
// clipboard comes back. Long enough for the target app to finish reading the
// ⌘V, short enough that a copy-paste right after a dictation still works.
export const RESTORE_DELAY_MS = 250;
// While the caller is checking whether the paste actually landed, the restore
// must not fire underneath it: the check sleeps 150ms and then makes
// Accessibility calls that are each capped at 200ms and can stack. Losing that
// race silently discards the text the user just dictated, so the hold is set
// well past the worst case. The caller always ends the hold itself (keep() on a
// miss, armRestore(remaining) on a hit, restore() if it throws) — this value is
// only the backstop for a caller that dies mid-check.
export const VERIFY_HOLD_MS = 2000;

// A delayed restore owns only the clipboard contents it wrote. A user copy or
// a subsequent GVoice paste revokes that ownership.
export function createClipboardLease(clipboard, text, { delay = RESTORE_DELAY_MS, schedule = setTimeout, cancel = clearTimeout, defer = false } = {}) {
  const previousText = clipboard.readText();
  const previousImage = previousText ? null : clipboard.readImage();
  clipboard.writeText(text);
  const formats = clipboard.availableFormats().sort().join("\n");
  let active = true;
  let timer;
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const owns = () => {
    try { return active && clipboard.readText() === text && clipboard.availableFormats().sort().join("\n") === formats; }
    catch { return false; }
  };
  const restore = () => {
    cancel(timer);
    try {
      if (owns()) {
        if (previousImage && !previousImage.isEmpty()) clipboard.writeImage(previousImage);
        // Rich/file-only clipboards cannot be faithfully reconstructed here — the
        // writeText that opened the lease already replaced them. previousText is
        // "" in that case, and writing it back is still right: leaving the
        // dictation sitting on the clipboard forever is the worse of the two.
        else clipboard.writeText(previousText);
      }
    } catch {} finally { active = false; settle(); }
  };
  const keep = () => { cancel(timer); const owned = owns(); active = false; settle(); return owned; };
  // An explicit delay overrides the lease's own: the paste-verification pass
  // holds the clipboard longer while it checks, then re-arms with what is left
  // of the normal window.
  const armRestore = (overrideMs) => {
    cancel(timer);
    if (active) timer = schedule(restore, Number.isFinite(overrideMs) ? Math.max(0, overrideMs) : delay);
  };
  if (!defer) armRestore();
  return { restore, keep, owns, armRestore, settled };
}
