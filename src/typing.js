// @ts-check
import { execFile } from "node:child_process";
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
// How long to let the target app actually consume the ⌘V before we put the
// user's own clipboard back. The keystroke returns as soon as it is delivered,
// not when the app has read the pasteboard, so restoring instantly would rip
// the text away mid-paste. This wait is now AWAITED (it used to be a bare
// fire-and-forget setTimeout), so the restore finishes inside the delivery and
// two dictations can never have their clipboard writes interleave.
const PASTE_SETTLE_MS = Number(process.env.TYPE_PASTE_SETTLE_MS) || 250;

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
function pasteShortcut() {
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
      execFile(
        "/usr/bin/osascript",
        ["-e", 'tell application "System Events" to keystroke "v" using command down'],
        { timeout: PASTE_TIMEOUT_MS, killSignal: "SIGKILL" },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          err ? reject(err) : resolve();
        }
      );
    });
  }
  return nut().then(async ({ keyboard, Key }) => {
    await keyboard.pressKey(Key.LeftControl, Key.V);
    await keyboard.releaseKey(Key.LeftControl, Key.V);
  });
}

// One clipboard at a time. Every delivery runs to completion — snapshot, write,
// paste, restore — before the next one starts, so two transcripts arriving
// close together can never have one's restore land on top of the other's text.
/** @type {Promise<any>} */
let clipboardQueue = Promise.resolve();
/**
 * @template T
 * @param {() => Promise<T>} job
 * @returns {Promise<T>}
 */
function serialise(job) {
  const run = clipboardQueue.then(job, job);
  clipboardQueue = run.then(() => {}, () => {});
  return run;
}

/**
 * Everything on the clipboard right now that we know how to put back: plain
 * text, an image (a screenshot reads back as EMPTY text, so it needs its own
 * capture), and the rich flavours a copy from a document carries. Files and
 * anything else Electron cannot round-trip are simply not captured — the
 * snapshot says what it holds and nothing more.
 * @param {any} clipboard
 * @returns {{ text?: string, html?: string, rtf?: string, image?: any }}
 */
function snapshotClipboard(clipboard) {
  /** @type {string[]} */
  let formats = [];
  try {
    if (typeof clipboard.availableFormats === "function") formats = clipboard.availableFormats() || [];
  } catch { formats = []; }
  const has = (/** @type {string} */ mime) => formats.some((f) => String(f).startsWith(mime));

  /** @type {{ text?: string, html?: string, rtf?: string, image?: any }} */
  const snap = {};
  try {
    const text = clipboard.readText();
    if (text) snap.text = text;
  } catch {}
  try {
    if (has("text/html") && typeof clipboard.readHTML === "function") {
      const html = clipboard.readHTML();
      if (html) snap.html = html;
    }
  } catch {}
  try {
    if ((has("text/rtf") || has("public.rtf")) && typeof clipboard.readRTF === "function") {
      const rtf = clipboard.readRTF();
      if (rtf) snap.rtf = rtf;
    }
  } catch {}
  try {
    // Ask for the image when the formats say there is one, and also when there
    // is no text at all — availableFormats is missing on the injected
    // clipboards the tests use, and a screenshot must survive either way.
    if (has("image/") || !snap.text) {
      const image = clipboard.readImage();
      if (image && typeof image.isEmpty === "function" && !image.isEmpty()) snap.image = image;
    }
  } catch {}
  return snap;
}

/**
 * Put a snapshot back, but ONLY if the clipboard still holds the exact text we
 * put there. If the user copied something of their own while the paste was
 * settling, their copy wins and is never overwritten.
 * @param {any} clipboard
 * @param {{ text?: string, html?: string, rtf?: string, image?: any }} snap
 * @param {string} ourText
 * @returns {boolean} true when the snapshot was written back
 */
function restoreClipboard(clipboard, snap, ourText) {
  try {
    if (clipboard.readText() !== ourText) return false;
  } catch {
    return false;
  }
  const keys = Object.keys(snap);
  try {
    if (keys.length === 0) {
      // Nothing was on it before; leave nothing behind either.
      if (typeof clipboard.clear === "function") clipboard.clear();
      else clipboard.writeText("");
      return true;
    }
    if (typeof clipboard.write === "function") {
      clipboard.write(snap);
      return true;
    }
    // Injected/older clipboards without write(): text and image cover them.
    if (snap.image) clipboard.writeImage(snap.image);
    else clipboard.writeText(snap.text || "");
    return true;
  } catch {
    return false;
  }
}

/**
 * Type or paste `text` into the focused app. With TYPE_VIA_CLIPBOARD=true
 * (default), snapshots the current clipboard, writes `text`, sends the paste
 * shortcut, then puts the snapshot back — but only if the clipboard still reads
 * back as our text, so a copy the user made mid-paste is never clobbered.
 * Deliveries are serialised: one clipboard transaction at a time. Otherwise,
 * types each character via nut-js.
 *
 * `target` is the destination captured when the hotkey went down (see
 * src/foreground.js). If it is set, the destination is read AGAIN here — the
 * last moment before the text leaves — and a paste only happens when the user
 * is still in the same app, the same window, with the caret in something that
 * takes typing. If they moved, the words are left on the clipboard and
 * `{ pasted: false }` comes back so the caller can say "Ready to copy" instead
 * of firing ⌘V into a stranger's window.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {import("./foreground.js").ForegroundTarget | null} [options.target]
 * @param {() => any} [options.readTarget] destination reader (tests inject one)
 * @param {any} [options.clipboard] clipboard (tests inject one)
 * @param {() => Promise<void>} [options.paste] paste keystroke (tests inject one)
 * @param {number} [options.settleMs] how long to let the app read the pasteboard
 * @returns {Promise<{ pasted: boolean, reason: string }>}
 */
export async function typeText(text, options = {}) {
  if (!text) return { pasted: false, reason: "empty" };
  return serialise(() => deliver(text, options));
}

/**
 * One clipboard transaction, start to finish. Only ever called from the queue
 * in typeText().
 * @param {string} text
 * @param {NonNullable<Parameters<typeof typeText>[1]>} options
 * @returns {Promise<{ pasted: boolean, reason: string }>}
 */
async function deliver(text, options) {
  const {
    target = null,
    readTarget = realForegroundTarget,
    clipboard: injectedClipboard = null,
    paste = pasteShortcut,
    settleMs = PASTE_SETTLE_MS
  } = options;
  const clipboard = injectedClipboard || (await realClipboard());

  await sleep(RELEASE_DELAY_MS);

  const needsLeadingSpace = !/^[\s.,;:!?\-)\]"'`]/.test(text);
  const textToPaste = needsLeadingSpace ? " " + text : text;

  // Last check before the words leave. Deliberately after the release delay and
  // immediately before the clipboard write: every millisecond between the check
  // and the keystroke is a millisecond the user could switch windows in.
  const destination = await checkDestination(target, readTarget);
  if (!destination.ok) {
    // The one case where GVoice takes the clipboard and keeps it: the text has
    // nowhere safe to land, so it waits there for the user's own ⌘V. No leading
    // space — a hand-driven paste doesn't need one — and no restore timer, or
    // the rescue would erase itself a quarter-second later.
    clipboard.writeText(text);
    return { pasted: false, reason: destination.reason };
  }

  if (USE_CLIPBOARD) {
    const snapshot = snapshotClipboard(clipboard);
    clipboard.writeText(textToPaste);
    try {
      await paste();
    } finally {
      // Let the app actually take the text, then hand the clipboard back —
      // inside the transaction, so the next delivery starts from a settled
      // clipboard instead of racing this restore.
      if (settleMs > 0) await sleep(settleMs);
      restoreClipboard(clipboard, snapshot, textToPaste);
    }
    return { pasted: true, reason: destination.reason };
  }

  const { keyboard } = await nut();
  await keyboard.type(textToPaste);
  return { pasted: true, reason: destination.reason };
}
