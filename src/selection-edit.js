import { createRequire } from "node:module";

const MAX_FIELD = 200000;
const MAX_SELECTION = 20000;
const MAX_REPLACEMENT = 40000;
const editableRoles = new Set(["AXTextArea", "AXTextField"]);
export class SelectionEditError extends Error {
  constructor(code, message) { super(message); this.name = "SelectionEditError"; this.code = code; }
}
const error = (code, message) => new SelectionEditError(code, message);

function validate(snapshot) {
  if (!snapshot || !editableRoles.has(snapshot.role) || /secure|password/i.test(snapshot.subrole || "")) {
    throw error("UNSUPPORTED", "Select text in an accessible, non-password text field.");
  }
  if (!snapshot.settable || typeof snapshot.value !== "string" || snapshot.value.length > MAX_FIELD ||
      !snapshot.identity || !Number.isInteger(snapshot.start) || !Number.isInteger(snapshot.length) ||
      snapshot.start < 0 || snapshot.length < 0 || snapshot.start + snapshot.length > snapshot.value.length) {
    throw error("UNSUPPORTED", "This text field does not support safe selection editing.");
  }
}

/** Native reads/writes are synchronous; bounded polling allows Chromium to update its AX tree.
 * Tokens never cross renderer IPC. dispose defers CFRelease until pending verification exits.
 */
export function createSelectionEditor(backend, { readbackTimeoutMs = 1500, pollMs = 30 } = {}) {
  const targets = new WeakMap();
  function state(target) {
    const record = target && targets.get(target);
    if (!record || record.disposed) throw error("EXPIRED", "Select the text again to start a new edit.");
    return record;
  }
  function inspect(record, expected) {
    const now = backend.read(record.handle);
    validate(now);
    if (now.identity !== record.before.identity || now.value !== expected) {
      throw error("CHANGED", "The original text field changed. Select the text again.");
    }
    return now;
  }
  function releaseIfIdle(record) {
    if (record.disposed && !record.inFlight && !record.released) {
      record.released = true;
      backend.dispose(record.handle);
    }
  }
  async function replace(record, expected, range, replacement, requireSelection) {
    record.inFlight++;
    try {
      inspect(record, expected);
      backend.focus(record.handle);
      const selected = inspect(record, expected);
      if (requireSelection && (selected.start !== range.start || selected.length !== range.length || selected.selected !== record.original)) {
        throw error("CHANGED", "The selection changed before the edit could be applied.");
      }
      const wanted = expected.slice(0, range.start) + replacement + expected.slice(range.start + range.length);
      // Chromium advertises AXSelectedText as writable but does not implement
      // kReplaceSelectedText in its web renderer. Use AXValue for supported plain
      // text controls, reconstructing the complete field from the checked snapshot.
      // Do not retry or use a second mutation method after this setter.
      // An AX timeout can arrive after the target accepted the write. Read back
      // even when the setter reports failure; never retry the mutation.
      try { backend.replaceValue(record.handle, wanted); } catch {}
      const deadline = Date.now() + readbackTimeoutMs;
      for (;;) {
        if (record.disposed) throw error("UNVERIFIED", "The editor closed during apply. Check the original app for the result.");
        const actual = (backend.readValue || backend.read)(record.handle);
        if (!actual || actual.identity !== record.before.identity) break;
        if (actual.value === wanted) return wanted;
        // A third value is a concurrent edit or an unexpected transformation.
        // Only the unchanged prior value can be an asynchronously pending write.
        if (actual.value !== expected || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
      throw error("UNVERIFIED", "The edit could not be verified. Check the original app before trying again.");
    } finally {
      record.inFlight--;
      releaseIfIdle(record);
    }
  }
  return {
    captureSelection() {
      const handle = backend.capture();
      try {
        const before = backend.read(handle);
        validate(before);
        if (!before.length || before.length > MAX_SELECTION) throw error("NO_SELECTION", "Select between 1 and 20000 characters first.");
        const original = before.value.slice(before.start, before.start + before.length);
        if (before.selected !== original) throw error("UNSUPPORTED", "The selected text could not be verified.");
        const target = Object.freeze({});
        targets.set(target, { handle, before, original, phase: "captured", disposed: false, inFlight: 0, released: false });
        return { target, original };
      } catch (err) { backend.dispose(handle); throw err; }
    },
    async applySelectionEdit(target, replacement) {
      const record = state(target);
      if (record.phase !== "captured") throw error("EXPIRED", "This edit has already been applied or cannot be retried safely.");
      if (typeof replacement !== "string" || !replacement.length || replacement.length > MAX_REPLACEMENT || replacement.includes("\0")) {
        throw error("INVALID_INPUT", "Replacement must contain between 1 and 40000 characters.");
      }
      if (record.before.value.length - record.before.length + replacement.length > MAX_FIELD) {
        throw error("INVALID_INPUT", "The resulting text field would exceed the safe editing limit.");
      }
      const now = inspect(record, record.before.value);
      if (now.start !== record.before.start || now.length !== record.before.length || now.selected !== record.original) {
        throw error("CHANGED", "The original selection changed. Select the text again.");
      }
      // A failed native setter may still have changed the field. Disable retries until read-back proves success.
      record.phase = "uncertain";
      record.after = await replace(record, record.before.value, record.before, replacement, true);
      record.replacement = replacement;
      record.phase = "applied";
      return { applied: true, undoAvailable: true };
    },
    async undoSelectionEdit(target) {
      const record = state(target);
      if (record.phase !== "applied") throw error("EXPIRED", "There is no verified edit to undo.");
      inspect(record, record.after);
      record.phase = "uncertain";
      await replace(record, record.after, { start: record.before.start, length: record.replacement.length }, record.original, false);
      record.phase = "undone";
      return { undone: true };
    },
    disposeSelectionEdit(target) {
      const record = target && targets.get(target);
      if (record && !record.disposed) {
        record.disposed = true;
        releaseIfIdle(record);
        targets.delete(target);
      }
    }
  };
}

function createMacBackend() {
  if (process.platform !== "darwin") throw error("UNSUPPORTED", "Selection editing currently requires macOS.");
  const koffi = createRequire(import.meta.url)("koffi");
  const CF = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
  const AX = koffi.load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
  const sys = koffi.load("/usr/lib/libSystem.B.dylib");
  const release = CF.func("void CFRelease(void *cf)");
  const retain = CF.func("void *CFRetain(void *cf)");
  const str = CF.func("void *CFStringCreateWithCString(void *alloc, const char *str, uint32_t encoding)");
  const stringType = CF.func("unsigned long CFStringGetTypeID(void)");
  const type = CF.func("unsigned long CFGetTypeID(void *cf)");
  const stringOut = CF.func("bool CFStringGetCString(void *str, _Out_ char *buffer, long size, uint32_t encoding)");
  const trusted = AX.func("bool AXIsProcessTrusted(void)");
  const system = AX.func("void *AXUIElementCreateSystemWide(void)");
  const app = AX.func("void *AXUIElementCreateApplication(int pid)");
  const copy = AX.func("int AXUIElementCopyAttributeValue(void *el, void *attr, _Out_ void **value)");
  const set = AX.func("int AXUIElementSetAttributeValue(void *el, void *attr, void *value)");
  const writable = AX.func("int AXUIElementIsAttributeSettable(void *el, void *attr, _Out_ bool *value)");
  const pid = AX.func("int AXUIElementGetPid(void *el, _Out_ int *pid)");
  const path = sys.func("int proc_pidpath(int pid, _Out_ char *buffer, uint32_t size)");
  const valueType = AX.func("unsigned long AXValueGetTypeID(void)");
  const getRange = AX.func("bool AXValueGetValue(void *value, int type, _Out_ void *output)");
  const messagingTimeout = AX.func("int AXUIElementSetMessagingTimeout(void *element, float timeout)");
  const yes = koffi.decode(CF.symbol("kCFBooleanTrue"), "void *");
  const encoding = 0x08000100;
  function attr(name, fn) {
    const key = str(null, name, encoding);
    try { return fn(key); } finally { release(key); }
  }
  function read(el, name, fn, optional = false) {
    return attr(name, key => {
      const out = [null];
      const status = copy(el, key, out);
      if (status || !out[0]) { if (optional) return null; throw error("UNSUPPORTED", "The selected field is no longer accessible."); }
      try { return fn(out[0]); } finally { release(out[0]); }
    });
  }
  function text(el, name, optional = false) {
    return read(el, name, value => {
      if (type(value) !== stringType()) return null;
      const buf = Buffer.alloc(MAX_FIELD * 4 + 1);
      if (!stringOut(value, buf, buf.length, encoding)) return null;
      return buf.toString("utf8", 0, buf.indexOf(0));
    }, optional);
  }
  function setValue(el, name, value) {
    if (attr(name, key => set(el, key, value)) !== 0) throw error("UNSUPPORTED", "This field could not accept the edit safely.");
  }
  function identity(el) {
    const out = [0];
    if (pid(el, out) || !out[0]) return null;
    const buf = Buffer.alloc(4096);
    const len = path(out[0], buf, buf.length);
    return len > 0 ? { pid: out[0], identity: `${out[0]}:${buf.toString("utf8", 0, len).replace(/\0.*$/, "")}` } : null;
  }
  return {
    capture() {
      if (!trusted()) throw error("UNSUPPORTED", "Enable GVoice Accessibility access before editing selected text.");
      const root = system();
      try {
        messagingTimeout(root, 0.2);
        return read(root, "AXFocusedUIElement", el => {
          // CopyAttributeValue owns the returned reference. Retain for the token lifetime.
          retain(el);
          messagingTimeout(el, 0.2);
          return el;
        });
      } finally { release(root); }
    },
    read(el) {
      const role = text(el, "AXRole");
      const subrole = text(el, "AXSubrole", true);
      if (!editableRoles.has(role) || /secure|password/i.test(subrole || "")) return { role, subrole };
      const range = read(el, "AXSelectedTextRange", value => {
        if (type(value) !== valueType()) return null;
        const buf = Buffer.alloc(16);
        if (!getRange(value, 4, buf)) return null;
        return { start: Number(buf.readBigInt64LE(0)), length: Number(buf.readBigInt64LE(8)) };
      });
      const settable = ["AXValue"].every(name => attr(name, key => {
        const out = [false]; return writable(el, key, out) === 0 && out[0];
      }));
      return { role, subrole, value: text(el, "AXValue"), selected: text(el, "AXSelectedText"),
        ...range, identity: identity(el)?.identity, settable };
    },
    focus(el) {
      const owner = identity(el);
      if (!owner) throw error("CHANGED", "The original app is no longer available.");
      const application = app(owner.pid);
      try { setValue(application, "AXFrontmost", yes); setValue(el, "AXFocused", yes); }
      finally { release(application); }
    },
    readValue(el) { return { value: text(el, "AXValue"), identity: identity(el)?.identity }; },
    replaceValue(el, replacement) {
      const value = str(null, replacement, encoding);
      try { setValue(el, "AXValue", value); } finally { release(value); }
    },
    dispose: release
  };
}

let defaultEditor;
function editor() {
  if (!defaultEditor) {
    try { defaultEditor = createSelectionEditor(createMacBackend()); }
    catch (err) { if (err instanceof SelectionEditError) throw err; throw error("UNSUPPORTED", "Native selection editing is unavailable on this device."); }
  }
  return defaultEditor;
}
export const captureSelection = () => editor().captureSelection();
export const applySelectionEdit = (target, replacement) => editor().applySelectionEdit(target, replacement);
export const undoSelectionEdit = target => editor().undoSelectionEdit(target);
export const disposeSelectionEdit = target => defaultEditor?.disposeSelectionEdit(target);
