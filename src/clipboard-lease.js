// No timer may restore an unverified paste. OS sequence numbers also detect a
// user copying the same string (text equality alone misses that ownership loss).
const leases = new WeakMap();
export const DELIVERY_STATES = new Set(['verified', 'sent-unverified', 'refused', 'failed', 'superseded']);

export function createClipboardLease(clipboard, text, { getChangeCount = () => null } = {}) {
  const previousLease = leases.get(clipboard);
  const previousWasDictation = previousLease?.isCurrent() === true;
  previousLease?.finish('superseded');
  const previousText = clipboard.readText();
  const previousImage = previousText ? null : clipboard.readImage();
  clipboard.writeText(text);
  const count = getChangeCount();
  const formats = clipboard.availableFormats().sort().join('\n');
  let active = true;
  let state = null;
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const isCurrent = () => {
    try {
      return leases.get(clipboard) === lease && count != null && getChangeCount() === count &&
        clipboard.readText() === text && clipboard.availableFormats().sort().join('\n') === formats;
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
      if (delivery === 'verified' && owned && !previousWasDictation) {
        if (previousImage && !previousImage.isEmpty()) clipboard.writeImage(previousImage);
        else if (previousText) clipboard.writeText(previousText);
        // Unsupported/rich-only clipboard formats cannot be faithfully restored.
      }
    } catch { /* A restore failure cannot discard delivery/history metadata. */ }
    finally { active = false; settle(state); }
    return state;
  };
  const keep = () => { const owned = owns(); finish('sent-unverified'); return owned; };
  const lease = { finish, keep, owns, isCurrent, settled, get state() { return state; }, changeCount: count };
  leases.set(clipboard, lease);
  return lease;
}
