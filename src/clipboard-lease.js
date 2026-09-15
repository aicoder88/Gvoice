// The dictation borrows the clipboard only for the paste keystroke, then the
// user's own clipboard goes back, whatever the outcome. The words are never
// left behind: history is where an undelivered dictation is recovered from
// (owner, 2026-09-15). OS sequence numbers detect a user copying during the
// paste, even the same string (text equality alone misses that ownership loss).
const leases = new WeakMap();
export const DELIVERY_STATES = new Set(['verified', 'sent-unverified', 'refused', 'failed', 'superseded']);

// A paste nobody confirmed may still be sitting in a busy app's event queue.
// Putting the old clipboard back too soon would paste THAT instead of the
// words, so wait this long first. A verified paste already landed, so it
// restores at once.
export const UNVERIFIED_RESTORE_DELAY_MS = Number(process.env.CLIPBOARD_RESTORE_DELAY_MS) || 600;

export function createClipboardLease(clipboard, text, {
  getChangeCount = () => null,
  restoreDelayMs = UNVERIFIED_RESTORE_DELAY_MS,
  schedule = (fn, ms) => setTimeout(fn, ms)
} = {}) {
  const previousLease = leases.get(clipboard);
  // An earlier dictation still on the clipboard is not the user's copy: take
  // over what IT was going to put back, so the user's clipboard still returns.
  const previous = previousLease?.isCurrent() === true ? previousLease.previous : snapshotClipboard(clipboard);
  previousLease?.finish('superseded');
  clipboard.writeText(text);
  const count = getChangeCount();
  const formats = formatSignature(clipboard);
  let active = true;
  let state = null;
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const isCurrent = () => {
    try {
      return leases.get(clipboard) === lease && count != null && getChangeCount() === count &&
        clipboard.readText() === text && formatSignature(clipboard) === formats;
    } catch { return false; }
  };
  const owns = () => active && isCurrent();
  // Checked again at restore time: a copy the user makes during the wait wins.
  // With no native sequence counter, ownership can't be proven, so fail closed.
  const restore = () => {
    try { if (isCurrent()) restoreSnapshot(clipboard, previous); }
    catch { /* A restore failure cannot discard delivery/history metadata. */ }
    finally { settle(state); }
  };
  const finish = delivery => {
    if (!DELIVERY_STATES.has(delivery)) throw new Error('Invalid delivery state');
    if (!active) return state;
    const owned = owns();
    state = count != null && !owned ? 'superseded' : delivery;
    active = false;
    if (!owned) settle(state);
    else if (delivery === 'verified' || !(restoreDelayMs > 0)) restore();
    else schedule(restore, restoreDelayMs);
    return state;
  };
  const keep = () => { const owned = owns(); finish('sent-unverified'); return owned; };
  const lease = { finish, keep, owns, isCurrent, settled, previous, get state() { return state; }, changeCount: count };
  leases.set(clipboard, lease);
  return lease;
}

// Which flavours are on the clipboard, as one comparable string. A change here
// means the user copied something of their own. Guarded because older Electron
// builds and the test doubles have no availableFormats; both readings then
// agree on "", so ownership still reads correctly.
function formatSignature(clipboard) {
  try {
    return typeof clipboard.availableFormats === 'function'
      ? (clipboard.availableFormats() || []).slice().sort().join('\n')
      : '';
  } catch { return ''; }
}

// Everything worth putting back, read before the dictation overwrites it.
// Text alone is not enough: text copied from a web page or a Word document
// carries html and rtf beside it, and restoring only the plain text silently
// strips the formatting the user copied. A screenshot has no text at all, so
// the image is read whenever the text is empty.
function snapshotClipboard(clipboard) {
  let formats = [];
  try { formats = typeof clipboard.availableFormats === 'function' ? clipboard.availableFormats() || [] : []; } catch { formats = []; }
  const has = mime => formats.some(f => String(f).startsWith(mime));
  const snap = {};
  try { const text = clipboard.readText(); if (text) snap.text = text; } catch {}
  try { if (has('text/html') && typeof clipboard.readHTML === 'function') { const html = clipboard.readHTML(); if (html) snap.html = html; } } catch {}
  try { if ((has('text/rtf') || has('public.rtf')) && typeof clipboard.readRTF === 'function') { const rtf = clipboard.readRTF(); if (rtf) snap.rtf = rtf; } } catch {}
  try {
    if (has('image/') || !snap.text) {
      const image = clipboard.readImage();
      if (image && typeof image.isEmpty === 'function' && !image.isEmpty()) snap.image = image;
    }
  } catch {}
  return snap;
}

// Put a snapshot back whole. `write` sets every flavour in one go, so a paste
// elsewhere sees text, html and rtf together rather than whichever was written
// last. Clipboards without it (older Electron, the test doubles) still get the
// image or the text.
function restoreSnapshot(clipboard, snap) {
  // Nothing was there before the paste, so leave nothing behind. The words are
  // in history either way.
  if (!Object.keys(snap).length) {
    if (typeof clipboard.clear === 'function') clipboard.clear();
    else clipboard.writeText('');
    return;
  }
  if (typeof clipboard.write === 'function') { clipboard.write(snap); return; }
  if (snap.image) clipboard.writeImage(snap.image);
  else if (snap.text) clipboard.writeText(snap.text);
}
