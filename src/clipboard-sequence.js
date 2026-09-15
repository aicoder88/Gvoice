// A content-free OS clipboard revision. Failure disables restoration, never
// falls back to text equality, which cannot detect identical-value user copies.
let readSequence = () => null;
try {
  const koffi = (await import('koffi')).default;
  if (process.platform === 'darwin') {
    koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
    const objc = koffi.load('/usr/lib/libobjc.A.dylib');
    const getClass = objc.func('void *objc_getClass(const char *name)');
    const selector = objc.func('void *sel_registerName(const char *name)');
    const sendPointer = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
    const sendInteger = objc.func('objc_msgSend', 'long', ['void *', 'void *']);
    const board = sendPointer(getClass('NSPasteboard'), selector('generalPasteboard'));
    const changeCount = selector('changeCount');
    readSequence = () => Number(sendInteger(board, changeCount));
  } else if (process.platform === 'win32') {
    const sequence = koffi.load('user32.dll').func('uint32_t GetClipboardSequenceNumber(void)');
    readSequence = () => { const value = sequence(); return value === 0 ? null : value; };
  }
} catch { /* Recovery remains available when native counters are unavailable. */ }
export function getClipboardChangeCount() {
  try { const count = readSequence(); return Number.isSafeInteger(count) ? count : null; }
  catch { return null; }
}
