// @ts-check
import { clipboard } from "electron";
import { execFile } from "node:child_process";
import { createClipboardLease } from "./clipboard-lease.js";
import { getClipboardChangeCount } from "./clipboard-sequence.js";
import { sendPasteShortcut } from "./foreground.js";

const isWin = process.platform === "win32";

const USE_CLIPBOARD = process.env.TYPE_VIA_CLIPBOARD !== "false";
const RELEASE_DELAY_MS = Number(process.env.TYPE_RELEASE_DELAY_MS || 80);
// How long to wait for the osascript paste helper before declaring the paste
// failed. Normally it returns in well under a second; the only time it doesn't
// is a system-level wedge (System Events not launching, or processes stuck in
// kernel exit — seen 2026-06-06), where waiting longer never helps. Without
// this cap, typeText awaits forever and the pill is stuck on "Transcribing…".
const PASTE_TIMEOUT_MS = Number(process.env.TYPE_PASTE_TIMEOUT_MS) || 4000;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// nut-js pulls in a large image stack (jimp) at import time, and is only needed
// for the non-clipboard "type each character" path. The paste keystroke uses a
// native OS call on both macOS (osascript) and Windows (keybd_event, via
// foreground.js), so neither touches nut-js. Load it lazily so the default
// clipboard path never imports it — that keeps a heavy, packaging-fragile
// dependency off the hot path (its jimp sub-packages do not survive the
// electron-builder + pnpm bundle, which broke every Windows paste).
/** @type {Promise<typeof import("@nut-tree-fork/nut-js")> | null} */
let nutPromise = null;
function nut() {
  if (!nutPromise) {
    nutPromise = import("@nut-tree-fork/nut-js").then((mod) => {
      mod.keyboard.config.autoDelayMs = 0;
      return mod;
    });
  }
  return nutPromise;
}

/**
 * Pay the nut-js import cost (~300ms — it pulls in a large image stack) at
 * startup instead of on the user's FIRST paste, so the first dictation types
 * out as fast as every one after it. Fire-and-forget: the lazy path in
 * pasteShortcut() still covers it if this never ran or failed.
 *
 * Skipped entirely on the native-paste platforms (macOS, Windows) when in the
 * default clipboard mode — there the paste keystroke never goes through nut-js,
 * so importing the jimp stack would only waste startup time (and, in the
 * packaged Windows app, log a harmless-but-noisy missing-module error).
 * @returns {Promise<void>}
 */
export function prewarmTyping() {
  const nativePaste = USE_CLIPBOARD && (process.platform === "darwin" || isWin);
  if (nativePaste) return Promise.resolve();
  return nut().then(() => {}, () => {});
}

/**
 * Send the paste shortcut (⌘V / Ctrl+V) to the frontmost app. macOS uses the
 * built-in `osascript` and Windows a native `keybd_event` (both need only the
 * Accessibility / input permission the app already requires for typing, and
 * neither pulls in nut-js). Linux falls back to nut-js.
 * @returns {Promise<void>}
 */
export function pasteShortcut({ expectedPid = null } = {}) {
  if (isWin) {
    // Native Win32 Ctrl+V. Returns false only if koffi never loaded, in which
    // case we fall through to the nut-js path below as a last resort.
    if (sendPasteShortcut()) return Promise.resolve();
  }
  if (process.platform === "darwin") {
    return new Promise((resolve, reject) => {
      // Settle exactly once: on the child's exit, or on the timeout — whichever
      // comes first. execFile's own `timeout` SIGKILLs the child as a best
      // effort, but a kernel-stuck child ignores signals and never emits
      // 'close', so we must not rely on the callback alone.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("osascript paste helper did not return within " + PASTE_TIMEOUT_MS + "ms (System Events hung?)"));
      }, PASTE_TIMEOUT_MS);
      const guard = Number.isSafeInteger(expectedPid) && expectedPid > 0
        ? `if (unix id of first application process whose frontmost is true) is not ${expectedPid} then return "gvoice-refused"\n`
        : "";
      execFile(
        "/usr/bin/osascript",
        ["-e", `tell application "System Events"\n${guard}keystroke "v" using command down\nreturn "gvoice-sent"\nend tell`],
        { timeout: PASTE_TIMEOUT_MS, killSignal: "SIGKILL" },
        (err, stdout) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          err ? reject(err) : resolve({ refused: stdout?.trim() === "gvoice-refused" });
        }
      );
    });
  }
  return nut().then(async ({ keyboard, Key }) => {
    await keyboard.pressKey(Key.LeftControl, Key.V);
    await keyboard.releaseKey(Key.LeftControl, Key.V);
  });
}

/**
 * Type or paste `text` into the focused app. With TYPE_VIA_CLIPBOARD=true
 * (default), saves the current clipboard, writes `text`, sends the paste
 * shortcut, then retains it until the caller explicitly settles delivery. Otherwise, types
 * each character via nut-js.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
export function createTextTyper({ clipboardTarget = clipboard, getChangeCount = getClipboardChangeCount,
  sendShortcut = pasteShortcut, releaseDelayMs = RELEASE_DELAY_MS } = {}) {
let typingQueue = Promise.resolve();
let currentLease = null;
return function typeText(text, { canPaste = () => true, exact = false, expectedPid = null } = {}) {
  const work = typingQueue.then(async () => {
    if (!text) return null;
    await sleep(releaseDelayMs);
    // Ownership is checked AFTER the release delay and queue wait.
    if (!canPaste()) return null;
    const needsLeadingSpace = !exact && !/^[\s.,;:!?\-)\]"'`]/.test(text);
    const textToPaste = needsLeadingSpace ? " " + text : text;
    if (USE_CLIPBOARD) {
      currentLease?.finish("superseded");
      const lease = createClipboardLease(clipboardTarget, textToPaste, { getChangeCount });
      currentLease = lease;
      try {
        const dispatch = await sendShortcut({ expectedPid });
        lease.refused = dispatch?.refused === true;
        lease.dispatched = !lease.refused;
        return lease;
      } catch (error) {
        lease.dispatched = false;
        lease.dispatchError = error;
        return lease; // Caller settles without overwriting a newer user copy.
      }
    }
    const { keyboard } = await nut();
    if (!canPaste()) return null;
    await keyboard.type(textToPaste);
    // Typed key by key: nothing of ours ever reached the clipboard, so there is
    // no hold to end and nothing there to keep. No `keep` is how the caller
    // tells this apart from a real lease — with one it would log a phantom
    // "clipboard lost" on every rescue, and skip the rescue write it needs.
    return { dispatched: true, finish(state) { return state; } };
  });
  typingQueue = work.then(lease => lease?.settled).catch(() => {});
  return work;
}

}
export const typeText = createTextTyper();
