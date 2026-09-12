// No timer may restore an unverified paste. OS sequence numbers also detect a
// user copying the same string (text equality alone misses that ownership loss).
const leases = new WeakMap();
export const DELIVERY_STATES = new Set(['verified', 'sent-unverified', 'refused', 'failed', 'superseded']);

export function createClipboardLease(clipboard, text, { getChangeCount = () => null } = {}) {
  const previousLease = leases.get(clipboard);
  const previousWasDictation = previousLease?.isCurrent() === true;
  previousLease?.finish('superseded');
  const previous = snapshotClipboard(clipboard);
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
  const finish = delivery => {
    if (!DELIVERY_STATES.has(delivery)) throw new Error('Invalid delivery state');
    if (!active) return state;
    const owned = owns();
    state = count != null && !owned ? 'superseded' : delivery;
    try {
      // Never restore another dictation's retained payload. With no native
      // sequence counter, retain the current text and fail closed on restore.
      if (delivery === 'verified' && owned && !previousWasDictation) restoreSnapshot(clipboard, previous);
    } catch { /* A restore failure cannot discard delivery/history metadata. */ }
    finally { active = false; settle(state); }
    return state;
  };
  const keep = () => { const owned = owns(); finish('sent-unverified'); return owned; };
  const lease = { finish, keep, owns, isCurrent, settled, get state() { return state; }, changeCount: count };
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
  // Nothing was there before a verified paste, so leave nothing behind. The
  // words already landed, so clearing cannot lose them.
  if (!Object.keys(snap).length) {
    if (typeof clipboard.clear === 'function') clipboard.clear();
    else clipboard.writeText('');
    return;
  }
  if (typeof clipboard.write === 'function') { clipboard.write(snap); return; }
  if (snap.image) clipboard.writeImage(snap.image);
  else if (snap.text) clipboard.writeText(snap.text);
}
