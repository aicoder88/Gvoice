import test from "node:test";
import assert from "node:assert/strict";
import { createSelectionEditor } from "../../src/selection-edit.js";

function fixture() {
  const field = { role: "AXTextArea", subrole: null, value: "Hello old world!", start: 6, length: 3, identity: "123:/test/app", settable: true };
  const calls = [];
  const backend = {
    capture: () => field,
    read: () => ({ ...field, selected: field.value.slice(field.start, field.start + field.length) }),
    focus: () => calls.push("focus"),
    replaceValue: (_, replacement) => { calls.push("replace"); field.value = replacement; field.start = 0; field.length = 0; },
    dispose: () => calls.push("dispose")
  };
  return { field, calls, backend, editor: createSelectionEditor(backend, { readbackTimeoutMs: 20, pollMs: 2 }) };
}

test("captures an opaque token, targets exact field, verifies apply and guarded undo", async () => {
  const { editor, field, calls } = fixture();
  const { target, original } = editor.captureSelection();
  assert.equal(original, "old");
  assert.deepEqual(target, {});
  assert.deepEqual(await editor.applySelectionEdit(target, "newer"), { applied: true, undoAvailable: true });
  assert.equal(field.value, "Hello newer world!");
  assert.deepEqual(await editor.undoSelectionEdit(target), { undone: true });
  assert.equal(field.value, "Hello old world!");
  assert.deepEqual(calls, ["focus", "replace", "focus", "replace"]);
  await assert.rejects(() => editor.undoSelectionEdit(target), { code: "EXPIRED" });
});

test("capture rejects secure, readonly, empty, oversized and inconsistent selections and releases handle", async () => {
  for (const patch of [{ role: "AXSecureTextField" }, { subrole: "AXSecureTextField" }, { settable: false }, { length: 0 }, { start: -1 }, { identity: null }, { value: "x".repeat(200001) }]) {
    const { editor, field, calls } = fixture();
    Object.assign(field, patch);
    assert.throws(() => editor.captureSelection());
    assert.deepEqual(calls, ["dispose"]);
  }
  const { editor, backend, calls } = fixture();
  const read = backend.read; backend.read = () => ({ ...read(), selected: "mismatch" });
  assert.throws(() => editor.captureSelection(), { code: "UNSUPPORTED" });
  assert.deepEqual(calls, ["dispose"]);
});

test("apply refuses text, selection, or app identity changes with no writes", async () => {
  for (const patch of [{ value: "modified content" }, { start: 7 }, { length: 4 }, { identity: "other-app" }]) {
    const { editor, field, calls } = fixture();
    const { target } = editor.captureSelection();
    Object.assign(field, patch);
    await assert.rejects(() => editor.applySelectionEdit(target, "new"), { code: "CHANGED" });
    assert.deepEqual(calls, []);
  }
});

test("focus-triggered changes are caught before replacement", async () => {
  const { editor, backend, field, calls } = fixture();
  const { target } = editor.captureSelection();
  backend.focus = () => { field.value = "changed while focusing"; };
  await assert.rejects(() => editor.applySelectionEdit(target, "new"), { code: "CHANGED" });
  assert.deepEqual(calls, []);
});

test("undo refuses later field edits and never sends global undo", async () => {
  const { editor, field, calls } = fixture();
  const { target } = editor.captureSelection();
  await editor.applySelectionEdit(target, "new");
  field.value += " user edit";
  const previousCalls = [...calls];
  await assert.rejects(() => editor.undoSelectionEdit(target), { code: "CHANGED" });
  assert.deepEqual(calls, previousCalls);
});

test("failed readback makes retry and undo unavailable", async () => {
  const { editor, backend } = fixture();
  const { target } = editor.captureSelection();
  backend.replaceValue = () => {};
  await assert.rejects(() => editor.applySelectionEdit(target, "new"), { code: "UNVERIFIED" });
  await assert.rejects(() => editor.applySelectionEdit(target, "new"), { code: "EXPIRED" });
  await assert.rejects(() => editor.undoSelectionEdit(target), { code: "EXPIRED" });
});

test("disposed tokens cannot edit and native release is idempotent", async () => {
  const { editor, calls } = fixture();
  const { target } = editor.captureSelection();
  editor.disposeSelectionEdit(target); editor.disposeSelectionEdit(target);
  assert.deepEqual(calls, ["dispose"]);
  await assert.rejects(() => editor.applySelectionEdit(target, "new"), { code: "EXPIRED" });
  await assert.rejects(() => editor.applySelectionEdit({}, "new"), { code: "EXPIRED" });
});

test("UTF-16 selection ranges preserve surrounding emoji", async () => {
  const { editor, field } = fixture();
  Object.assign(field, { value: "👋 old world", start: 3 });
  const { target, original } = editor.captureSelection();
  assert.equal(original, "old");
  await editor.applySelectionEdit(target, "🌍");
  assert.equal(field.value, "👋 🌍 world");
  await editor.undoSelectionEdit(target);
  assert.equal(field.value, "👋 old world");
});

test("asynchronous native value update is verified once without retrying mutation", async () => {
  const { editor, backend, field, calls } = fixture();
  const { target } = editor.captureSelection();
  backend.replaceValue = (_, value) => { calls.push("replace"); setTimeout(() => { field.value = value; }, 5); };
  await editor.applySelectionEdit(target, "new");
  assert.equal(field.value, "Hello new world!");
  assert.equal(calls.filter(call => call === "replace").length, 1);
});

test("dispose during pending readback releases native handle only after verification exits", async () => {
  const { editor, backend, calls } = fixture();
  const { target } = editor.captureSelection();
  backend.replaceValue = () => calls.push("replace");
  const pending = editor.applySelectionEdit(target, "new");
  editor.disposeSelectionEdit(target);
  assert.equal(calls.includes("dispose"), false);
  await assert.rejects(pending, { code: "UNVERIFIED" });
  assert.equal(calls.filter(call => call === "dispose").length, 1);
  editor.disposeSelectionEdit(target);
  assert.equal(calls.filter(call => call === "dispose").length, 1);
});

test("unexpected transformed value refuses success and never retries", async () => {
  const { editor, backend, field, calls } = fixture();
  const { target } = editor.captureSelection();
  backend.replaceValue = () => { calls.push("replace"); field.value = "Unexpected transformation"; };
  await assert.rejects(editor.applySelectionEdit(target, "new"), { code: "UNVERIFIED" });
  await assert.rejects(editor.undoSelectionEdit(target), { code: "EXPIRED" });
  assert.equal(calls.filter(call => call === "replace").length, 1);
});

test('a setter timeout after mutation still permits verified undo without retrying', async () => {
  const { editor, backend, field } = fixture();
  const originalWrite = backend.replaceValue;
  let writes = 0;
  backend.replaceValue = (...args) => { writes++; originalWrite(...args); throw new Error('AX response timed out'); };
  const { target } = editor.captureSelection();
  await editor.applySelectionEdit(target, 'newer');
  assert.equal(field.value, 'Hello newer world!');
  assert.equal(writes, 1);
  await editor.undoSelectionEdit(target);
  assert.equal(field.value, 'Hello old world!');
  assert.equal(writes, 2);
});
