// @ts-check
import { execFile } from "node:child_process";
import { createClipboardLease } from "./clipboard-lease.js";
import { getClipboardChangeCount } from "./clipboard-sequence.js";
import { sendPasteShortcut } from "./foreground.js";
import { checkDestination } from "./paste-guard.js";

// Electron's clipboard, fetched on first use instead of at import time. The
// destination check below has to be testable, and a top-level `import {
// clipboard } from "electron"` makes this module unloadable outside the
// Electron runtime. Inside the main process the import is already resolved, so
// this costs nothing.
/** @type {any} */
let electronClipboard = null;
async function realClipboard() {
  if (!electronClipboard) electronClipboard = (await import("electron")).clipboard;
  return electronClipboard;
}

// Where a paste would land right now. Imported lazily so a caller that passes
// no press-time snapshot (the smoke test, the Windows path) never pulls the
// macOS Accessibility bindings in.
async function realForegroundTarget() {
  const { captureForegroundTarget } = await import("./foreground.js");
  return captureForegroundTarget();
}

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
 * Build a typer: paste (or type) text into the focused app, one delivery at a
 * time. Dependencies are injectable so the whole path runs under plain
 * `node --test`, with no Electron and no real keystroke.
 *
 * Two machines built this separately and it keeps the best of each:
 *
 * - The clipboard is held as a LEASE (src/clipboard-lease.js) that the caller
 *   settles once it knows whether the words landed. The user's own clipboard
 *   always comes back: at once after a VERIFIED paste, after a short wait
 *   otherwise, so a slow app still pastes the words and not the old clipboard.
 *   An undelivered dictation is recovered from history, never the clipboard.
 * - The destination is checked twice. `target` (captured when the key went
 *   down) is compared against a fresh reading right before the clipboard is
 *   touched: a different app, a different window, or a text field that has
 *   gone away all refuse the paste. `expectedPid` is then checked again inside
 *   the very same call that sends the keystroke, leaving no gap to switch apps
 *   in. An app that never looked editable to Accessibility (every terminal)
 *   still gets its paste; see src/paste-guard.js.
 *
 * @param {object} [deps]
 * @param {any} [deps.clipboardTarget] clipboard to use; Electron's by default
 * @param {() => (number | null)} [deps.getChangeCount] OS clipboard sequence
 * @param {(opts: { expectedPid: number | null }) => Promise<any>} [deps.sendShortcut]
 * @param {() => any} [deps.readTarget] destination reader
 * @param {number} [deps.releaseDelayMs]
 */
export function createTextTyper({
  clipboardTarget = null,
  getChangeCount = getClipboardChangeCount,
  sendShortcut = pasteShortcut,
  readTarget = realForegroundTarget,
  releaseDelayMs = RELEASE_DELAY_MS
} = {}) {
  /** @type {Promise<any>} */
  let typingQueue = Promise.resolve();
  /** @type {any} */
  let currentLease = null;

  /**
   * @param {string} text
   * @param {object} [options]
   * @param {() => boolean} [options.canPaste] still this press's to deliver?
   * @param {boolean} [options.exact] no leading space (voice editing)
   * @param {number | null} [options.expectedPid] refuse unless this app is in front
   * @param {import("./foreground.js").ForegroundTarget | null} [options.target]
   */
  return function typeText(text, { canPaste = () => true, exact = false, expectedPid = null, target = null } = {}) {
    const work = typingQueue.then(async () => {
      if (!text) return null;
      await sleep(releaseDelayMs);
      // Ownership is checked AFTER the release delay and the queue wait.
      if (!canPaste()) return null;
      const clipboard = clipboardTarget || (await realClipboard());

      // Last look before the words leave: every millisecond between this
      // check and the keystroke is one the user could switch windows in.
      const destination = await checkDestination(target, readTarget);
      if (!destination.ok) return refusedDelivery(destination.reason);

      const needsLeadingSpace = !exact && !/^[\s.,;:!?\-)\]"'`]/.test(text);
      const textToPaste = needsLeadingSpace ? " " + text : text;
      if (USE_CLIPBOARD) {
        currentLease?.finish("superseded");
        const lease = createClipboardLease(clipboard, textToPaste, { getChangeCount });
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
      // no hold to end and nothing to put back.
      return { dispatched: true, finish(/** @type {string} */ state) { return state; } };
    });
    typingQueue = work.then((lease) => lease?.settled).catch(() => {});
    return work;
  };
}

/**
 * The destination changed, so nothing is pasted and the clipboard is never
 * touched: the words wait in history. Shaped like a lease so the caller
 * settles every outcome the same way, but it holds nothing to restore.
 * @param {string} reason
 */
function refusedDelivery(reason) {
  return {
    dispatched: false,
    refused: true,
    destinationChanged: true,
    reason,
    settled: Promise.resolve("refused"),
    finish() { return "refused"; },
    keep() { return false; }
  };
}

export const typeText = createTextTyper();
