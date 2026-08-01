// @ts-check
// Must be first: prepares PATH + loads .env from the app home before any module
// reads process.env (see src/bootstrap-env.js). Replaces the old
// `import "dotenv/config"`, which only worked when launched from the repo dir.
import "./src/bootstrap-env.js";
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, screen, Notification, clipboard, powerMonitor, dialog } from "electron";

// Brand the app as "GVoice" even when run unpackaged (otherwise the menu bar,
// About panel, and userData folder all read "Electron"). Must run before the
// app is ready and before any getPath("userData") call.
app.setName("GVoice");

// Single-instance lock. Without this every `npm start` would spawn an extra
// Electron process whose global Alt hotkey listener competed with the
// existing one — pressing right-Alt once fired N parallel dictation sessions
// and Deepgram WebSockets stepped on each other. Second launches just bring
// the existing window to the front and exit.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  // Headless app — there's no main window to refocus, just flash the tray
  // tooltip so the user knows the existing instance acknowledged them.
  if (tray) tray.displayBalloon?.({ title: "GVoice", content: "Already running. Hold Ctrl+Shift to dictate." });
});

process.on("uncaughtException", (err) => {
  const stack = err && err.stack ? err.stack : String(err);
  console.error("[uncaughtException]", stack);
  // dlog is a hoisted function declaration, so it's reachable here even though
  // it's defined further down. Capture the crash in the file too (console alone
  // is invisible in a packaged launch).
  try { dlog("uncaughtException", stack); } catch {}
});
process.on("unhandledRejection", (reason) => {
  const stack = reason && typeof reason === "object" && "stack" in reason ? reason.stack : String(reason);
  console.error("[unhandledRejection]", stack);
  try { dlog("unhandledRejection", String(stack)); } catch {}
});
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { startServer } from "./server.js";
import { DictationSession } from "./src/dictation-session.js";
import * as vocab from "./src/vocab.js";
import { createCorrectionWatcher } from "./src/correction-watch.js";
import { looksLikeRetraction } from "./src/cleanup.js";
import { captureForegroundWindow, restoreForegroundWindow, getWindowRect, isEditableFieldFocused, isForegroundWindow, readbackPasteTarget } from "./src/foreground.js";
import { initHistory, getHistory, getHistoryPath, recordTranscript } from "./src/history.js";
import { computeStats } from "./src/stats.js";
import { ensureWhisperServer, stopWhisperServer } from "./src/providers/whisper-local.js";
import { ENV_FILE, MODELS_DIR, BIN_DIR } from "./src/bootstrap-env.js";
import { writeEnvFile, settingsView, patchFromView, VALID_PROVIDERS } from "./src/settings.js";
import { probeCapability, recommendedAssets } from "./src/hardware.js";
import { suggestBeforeBenchmark } from "./src/benchmark.js";
import { runLocalBenchmark } from "./src/benchmark-run.js";
import { ensureModel, ensureWindowsBinaries, findInstalledWhisperCli, hasWhisperServer, MODELS, WINDOWS_BINARY_ZIPS } from "./src/model-download.js";
import { saveRecording, pruneRecordings, clearRecordings } from "./src/recordings.js";
import { transcribeWavFile, batchFailureReason } from "./src/providers/deepgram.js";
import { resolveDeepgramKey } from "./realtime-relay.js";
import { appendFileSync, statSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { mkdir as mkdirAsync } from "node:fs/promises";
import { execFile } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = ENV_FILE;

// The one Mac-specific step of the on-device engine: the binaries come from
// Homebrew instead of a download, so the app can only point at them.
const LOCAL_ENGINE_INSTALL_HINT =
  "The free on-device engine needs a one-time install. Open Terminal, run: brew install whisper-cpp — then reopen this window.";

// Half an install: whisper-cli present, whisper-server missing. It still works,
// but every clip reloads the model — including the speed test's, which then
// reads far slower than everyday use would.
const LOCAL_ENGINE_NO_SERVER_HINT =
  "Heads up: whisper-server is missing next to whisper-cli, so this will time the slow path. `brew install whisper-cpp` installs both.";

/**
 * Is the on-device engine usable on this machine, and where is its binary?
 * Windows answers "ready" without a path because the benchmark downloads the
 * binaries itself.
 *
 * @returns {{ state: "ready" | "install" | "unsupported", bin: string | null, server: boolean }}
 */
function localEngineState() {
  if (process.platform === "win32") return { state: "ready", bin: null, server: true };
  if (process.platform !== "darwin") return { state: "unsupported", bin: null, server: false };
  const bin = findInstalledWhisperCli();
  if (!bin) return { state: "install", bin: null, server: false };
  return { state: "ready", bin, server: hasWhisperServer(bin) };
}

/** @type {import("electron").BrowserWindow | null} */
let splashWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let pillWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let dictationWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let vocabWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let dictionaryWindow = null;
/** @type {import("electron").BrowserWindow | null} */
let settingsWindow = null;
/** @type {string | null} */
let recordingsDir = null;
// The transcript + recording shown on the current result pill, so the pill's
// Copy / Open-recording buttons act on the right data. Set when a result pill
// is shown, cleared when it hides.
/** @type {string | null} */
let currentTranscript = null;
/** @type {string | null} */
let currentRecordingPath = null;
/** @type {import("electron").Tray | null} */
let tray = null;
// The menu is popped up by hand on right-click instead of being handed to
// setContextMenu — otherwise macOS shows it on left-click too and the "click"
// event never fires, which would kill the click-to-talk toggle.
/** @type {import("electron").Menu | null} */
let trayMenu = null;
// True while a LEFT-CLICK on the tray is holding the mic open. Can't be derived
// from dictation.busy: that stays true through transcription (up to 25s), so
// the next click would read as "stop" when nothing is recording.
let trayHolding = false;
/** @type {number | null} */
let serverPort = null;
/** @type {string | null} */
let serverError = null;
/** @type {{ stop: () => void } | null} */
let hotkeyEngine = null;
// Module-scoped so shutdownAll() can clear a pending max-hold watchdog on quit —
// a closure-local timer would outlive teardown and fire on a destroyed window.
/** @type {ReturnType<typeof setTimeout> | null} */
let maxHoldTimer = null;
// True when the global hotkey failed to start. Without it the app LOOKS alive
// (tray, splash "Ready") while every key-hold silently does nothing — so the
// tooltip and splash must tell the truth instead.
let hotkeyFailed = false;
// Narrower case: the key hook was refused because macOS Accessibility isn't
// granted (uiohook throws UIOHOOK_ERROR_AXAPI_DISABLED). "Quit and reopen" is
// wrong advice for it — reopening changes nothing until the permission is
// granted — so this drives its own message and a tray item that opens the pane.
let hotkeyNeedsAccessibility = false;
// The hook started fine and then delivered nothing (see the watchdog below).
// Deliberately NOT hotkeyFailed: that one gates the ready path, and by the time
// we can tell, the app has long since reported itself ready.
let hotkeyDeaf = false;
let isQuitting = false;
// The busy guard must outlive the renderer's 20s transcriber watchdog
// (public/dictation.js FAILURE_MS): with the old 500ms default it expired on
// nearly every dictation, so a second press mid-transcription wiped
// savedForegroundHwnd and could paste into the wrong window. A terminal event
// always ends the session sooner; this is only the anti-jam backstop.
const dictation = new DictationSession({ safetyTimeoutMs: 25000 });

// Terminal events from the renderer carry the generation of the press that
// produced them (stamped in preload.cjs from the dictation:start profile). A
// late one belongs to a press that is already over: acting on it would clear
// `busy` for the LIVE press and paint over its pill. Logging and recording
// still happen — only the shared session state is protected.
const isStalePress = (/** @type {unknown} */ gen) => dictation.isStale(gen);

// The diagnostic log MUST live in userData, not next to main.js. When the app
// is packaged, __dirname is inside the read-only .app/.asar bundle, so the old
// join(__dirname, "debug.log") made every appendFileSync throw — silently, since
// dlog swallows errors — and the INSTALLED app logged nothing at all (that's why
// a real incident was a forensic dig). userData is writable in every launch.
// app.getPath("userData") is valid here because app.setName ran at the top.
const DEBUG_LOG = join(app.getPath("userData"), "debug.log");
const DEBUG_LOG_ROTATED = join(app.getPath("userData"), "debug.log.1");
const DEBUG_LOG_MAX_BYTES = 1024 * 1024; // ~1 MB
/** @type {number} bytes appended to debug.log since boot; seeded from disk on first write */
let dlogBytesWritten = -1;
function dlog(/** @type {string} */ tag, /** @type {unknown} */ data) {
  try {
    const line = `[${new Date().toISOString()}] ${tag} ${typeof data === "string" ? data : JSON.stringify(data)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    // Seed the byte counter once with the file's current size so we account
    // for content carried over from previous runs. Ensure the userData dir
    // exists first — early boot lines can land before it's otherwise created.
    if (dlogBytesWritten < 0) {
      try { mkdirSync(dirname(DEBUG_LOG), { recursive: true }); } catch {}
      try { dlogBytesWritten = statSync(DEBUG_LOG).size; }
      catch { dlogBytesWritten = 0; }
    }
    if (dlogBytesWritten + lineBytes > DEBUG_LOG_MAX_BYTES) {
      try { if (existsSync(DEBUG_LOG_ROTATED)) unlinkSync(DEBUG_LOG_ROTATED); } catch {}
      try { renameSync(DEBUG_LOG, DEBUG_LOG_ROTATED); } catch {}
      dlogBytesWritten = 0;
    }
    appendFileSync(DEBUG_LOG, line);
    dlogBytesWritten += lineBytes;
  } catch {}
}

// Per-event tracing is noisy (a line per press/release/cleanup/paste, plus the
// renderer and relay diagnostics). Keep the durable record in debug.log; only
// echo to the console when GVOICE_DEBUG is set.
const VERBOSE = process.env.GVOICE_DEBUG === "1" || process.env.GVOICE_DEBUG === "true";
function debug(/** @type {any[]} */ ...args) {
  if (VERBOSE) console.error(...args);
}

// In a packaged launch there's normally no terminal, so every console.error —
// the relay diagnostics, provider warnings ("deepgram ALL EMPTY"), the whisper
// silence gate, typing failures — would vanish. Mirror them into debug.log so
// the installed app's failures are diagnosable in one file. We only ALSO echo
// to the real console when GVOICE_DEBUG is set: a packaged app that happens to
// inherit a console (e.g. launched from a parent shell) would otherwise flood
// it with per-event traces. Dev launches (not packaged) keep the console
// untouched — the terminal already shows everything.
if (app.isPackaged) {
  const consoleError = console.error.bind(console);
  console.error = (/** @type {any[]} */ ...args) => {
    if (VERBOSE) consoleError(...args);
    try {
      const msg = args
        .map((a) => {
          if (typeof a === "string") return a;
          if (a && a.stack) return a.stack;
          // A rich error object can carry a circular reference; JSON.stringify
          // would throw and (caught below) silently drop the MOST interesting
          // log line. Fall back to String() so it's never lost.
          try { return JSON.stringify(a); } catch { return String(a); }
        })
        .join(" ");
      dlog("console.error", msg);
    } catch {}
  };
}

/** @type {number | null} */
let savedForegroundHwnd = null;

// --- Custom-dictionary suggestion state ---
// Cursor pop-up size (fixed; the card height is set in CSS). One source so the
// window bounds and the cursor-anchoring math can't drift apart.
const VOCAB_SIZE = { width: 300, height: 104 };
// How long after a dictation we watch for a manual correction (macOS/Linux).
// Kept short so we're not comparing every word typed in normal post-dictation
// prose against the last transcript.
const CORRECTION_WATCH_MS = Number(process.env.GVOICE_CORRECTION_WATCH_MS || 12000);
// Set once the pop-up window's HTML has loaded and registered its IPC handler,
// so the very first prompt isn't sent into the void.
let vocabWindowReady = false;
// Words GVoice typed in the just-finished dictation, used to recognise a manual
// fix as a near-miss of one of them.
/** @type {string[]} */
let recentTypedWords = [];
// The term currently shown on the cursor pop-up (one at a time).
/** @type {string | null} */
let pendingVocabTerm = null;
// Terms already offered this session, so an ignored prompt isn't re-shown until
// restart (an explicit "No thanks" persists in vocab's dismissed list forever).
const promptedThisSession = new Set();
let vocabHideTimer = null;
const correctionWatcher = createCorrectionWatcher({
  onWord: (word) => {
    const matched = vocab.isLikelyCorrection(word, recentTypedWords);
    if (matched) showVocabPrompt(word, "correction");
  }
});

// Whisper "non-speech" tokens that the model emits for music, applause,
// keyboard noise, silence, etc. These are model artifacts, not speech the
// user wants pasted. Strip them before the cleanup pass.
const NOISE_TOKEN_PATTERNS = [
  /\[\s*music[^\]]*\]/gi,
  /\[\s*applause[^\]]*\]/gi,
  /\[\s*laughter[^\]]*\]/gi,
  /\[\s*silence[^\]]*\]/gi,
  /\[\s*sounds?\s+of[^\]]*\]/gi,
  /\[\s*background\s+noise[^\]]*\]/gi,
  /\(\s*music[^)]*\)/gi,
  /\(\s*applause[^)]*\)/gi,
  /\(\s*laughter[^)]*\)/gi,
  /\(\s*keyboard[^)]*\)/gi,
  /\(\s*clicking[^)]*\)/gi,
  /\(\s*typing[^)]*\)/gi,
  /\(\s*coughing[^)]*\)/gi,
  /\(\s*breathing[^)]*\)/gi
];

function stripWhisperNoiseTokens(/** @type {string} */ text) {
  let out = text;
  for (const re of NOISE_TOKEN_PATTERNS) out = out.replace(re, "");
  return out.replace(/\s+/g, " ").trim();
}

/** @type {Electron.NativeImage | null} */
let trayIconCache = null;

function makeTrayIcon() {
  // The icon is a single static template image now, so build it once and reuse
  // it — updateTrayTooltip and the power-monitor re-assert call this on a hot-ish
  // path, and re-reading the PNG (+ @2x) from disk every time is wasted I/O.
  if (trayIconCache) return trayIconCache;
  try {
    // A single soundwave glyph. It's a macOS template image (black shape + alpha),
    // so macOS tints it to match the menu bar and it stays subtle in light or dark
    // mode. createFromPath picks up the @2x file automatically for Retina.
    const img = nativeImage.createFromPath(join(__dirname, "public", "trayTemplate.png"));
    if (!img.isEmpty()) {
      img.setTemplateImage(true);
      trayIconCache = img;
      return img;
    }
  } catch {}
  return nativeImage.createEmpty();
}

async function bootRelayServer() {
  // The relay only needs OPENAI_API_KEY when the dictation window will
  // actually open an OpenAI WebSocket. whisper-local and deepgram providers
  // talk to their own backends, so don't gate boot on the OpenAI key.
  // Clear any error from a previous (failed) attempt so a successful retry —
  // e.g. after the user saves a key in Settings on first run — doesn't leave a
  // stale "Missing …" string behind for a later code path to surface.
  serverError = null;
  const provider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    serverError = `Missing OPENAI_API_KEY in ${envPath}`;
    return null;
  }
  try {
    const result = await startServer({ recordingsDir });
    serverPort = result.port;
    // Open the Deepgram connection the first press will use, now, while nobody
    // is waiting on it. The relay parks one after every dictation; this covers
    // the first words after launch. Costs nothing — Deepgram bills audio, not
    // an open socket — and never blocks boot.
    if (provider === "deepgram") {
      import("./src/providers/deepgram.js")
        .then((dg) => dg.prewarm({
          apiKey: resolveDeepgramKey(),
          model: process.env.DEEPGRAM_MODEL || "nova-3",
          language: DICTATION_LANGUAGE
        }))
        .catch(() => {});
    }
    return result;
  } catch (error) {
    serverError = error.message || String(error);
    return null;
  }
}

// Splash readiness, mirroring vocabWindowReady: a status pushed before the
// renderer has attached its IPC listener would be dropped, so we hold the
// latest one and flush it on load. `splashDismissed` makes the tuck-away
// animation run exactly once even if two code paths request it.
let splashReady = false;
let splashDismissed = false;
/** @type {{ message: string, state: string } | null} */
let pendingSplashStatus = null;

// The boot splash: a small, frameless, branded "Starting GVoice…" card shown
// the instant the app launches, so the first thing the user sees is the app —
// not a terminal or a bare window. It reports boot progress, then animates
// itself down into the menu-bar / tray icon and closes, leaving the app running
// silently. Centered on whichever display the cursor is on.
function createSplashWindow() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = 360;
  const height = 300;
  const wa = display.workArea;
  splashWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload-splash.cjs")
    }
  });
  splashWindow.setAlwaysOnTop(true, "screen-saver");
  splashWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Once the renderer's IPC handler is live, flush whatever the latest status
  // was (boot stages set before this point would otherwise be dropped).
  splashWindow.webContents.once("did-finish-load", () => {
    splashReady = true;
    if (pendingSplashStatus) splashWindow?.webContents.send("splash:status", pendingSplashStatus);
  });
  // Loaded from disk (not the relay) because the splash must appear before the
  // relay server is up.
  splashWindow.loadFile(join(__dirname, "public", "splash.html"));
  splashWindow.once("ready-to-show", () => splashWindow?.showInactive());
}

// Push a boot-progress line to the splash. `state` drives the look:
// "loading" (default), "ready" (green), or "error" (red). Held until the
// renderer is ready (see createSplashWindow); the latest status wins.
function setSplashStatus(
  /** @type {string} */ message,
  /** @type {"loading" | "ready" | "error"} */ state = "loading"
) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  pendingSplashStatus = { message, state };
  if (splashReady) splashWindow.webContents.send("splash:status", pendingSplashStatus);
}

// Animate the splash shrinking and sliding down into the tray icon, then close
// it — the visual "the app tucked itself into the menu bar" moment. Falls back
// to the top-right corner if the tray bounds aren't reported (some Linux DEs,
// or before the tray exists). Pure main-process bounds/opacity animation so it
// works on a transparent, non-focusable window.
function dismissSplashToTray() {
  if (splashDismissed) return;
  splashDismissed = true;
  if (!splashWindow || splashWindow.isDestroyed()) {
    splashWindow = null;
    return;
  }
  const win = splashWindow;
  const start = win.getBounds();
  const trayBounds = (() => {
    try { return tray?.getBounds?.(); } catch { return null; }
  })();
  let targetCx;
  let targetCy;
  if (trayBounds && trayBounds.width) {
    targetCx = trayBounds.x + trayBounds.width / 2;
    targetCy = trayBounds.y + trayBounds.height / 2;
  } else {
    // No tray rect: aim for the top-right (macOS menu bar) corner of the display.
    const wa = screen.getDisplayNearestPoint({ x: start.x, y: start.y }).workArea;
    targetCx = wa.x + wa.width - 24;
    targetCy = wa.y + 12;
  }
  const startCx = start.x + start.width / 2;
  const startCy = start.y + start.height / 2;
  const steps = 22;
  let i = 0;
  const timer = setInterval(() => {
    i++;
    if (!splashWindow || splashWindow.isDestroyed()) {
      clearInterval(timer);
      splashWindow = null;
      return;
    }
    // Ease-in (accelerate toward the tray) on a 0..1 progress.
    const p = i / steps;
    const e = p * p;
    const scale = 1 - 0.82 * e; // shrink to ~18% of its size
    const w = Math.max(24, Math.round(start.width * scale));
    const h = Math.max(20, Math.round(start.height * scale));
    const cx = startCx + (targetCx - startCx) * e;
    const cy = startCy + (targetCy - startCy) * e;
    win.setBounds({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h });
    win.setOpacity(Math.max(0, 1 - e));
    if (i >= steps) {
      clearInterval(timer);
      if (!win.isDestroyed()) win.close();
      splashWindow = null;
    }
  }, 16);
}

function createPillWindow() {
  pillWindow = new BrowserWindow({
    width: 200,
    height: 56,
    frame: false,
    transparent: true,
    // Must stay resizable: a non-resizable window ignores setBounds() size
    // changes on macOS, which would pin the pill at its launch width and clip
    // the wider success/error states.
    resizable: true,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload-pill.cjs")
    }
  });
  pillWindow.setAlwaysOnTop(true, "screen-saver");
  // This is an accessory app (Dock hidden). Without this, the always-on-top
  // pill won't appear over full-screen apps or on other Spaces. skipTransform
  // keeps the app from flipping to a regular Dock app when we call this.
  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Click-through by default. Flipped on only for the success/error states so
  // the Copy / Open-recording buttons are clickable (see setPillState).
  pillWindow.setIgnoreMouseEvents(true);

  if (serverPort) {
    pillWindow.loadURL(`http://127.0.0.1:${serverPort}/pill.html`);
  } else {
    pillWindow.loadFile(join(__dirname, "public", "pill.html"));
  }
}

// The pill is a transparent window with the rounded pill centered inside it.
// The window is sized per state: small for listening/transcribing, wider for
// the success/error states that carry Copy / Open-recording buttons. It sits
// at the bottom-middle of whichever screen the user is working on.
// ponytail: 8px, not 28 — at 28 the pill floated a visible gap above the dock
// and read as "halfway up the screen". The pill itself is bottom-anchored
// inside its window (pill.html), so this is the real on-screen gap.
const PILL_BOTTOM_MARGIN = 8; // gap above the dock / taskbar
const PILL_SIDE_MARGIN = 12; // gap from the right edge of the screen
const PILL_SIZES = {
  listening: { width: 200, height: 56 },
  transcribing: { width: 220, height: 56 },
  // Wide enough for the full action row (Copy · Play recording · Transcribe
  // again · Add word · ✕) plus a readable reason — at 560 the label ellipsized
  // away the instruction the user needs. Taller too: the longest reason (the
  // "pick your microphone" one) needs three lines beside the buttons, and
  // widening alone left it clipped.
  // 84, not 72: three lines at 13px/1.25 plus the pill's 18px of padding is
  // ~67px, and pill.html's 8px bottom padding eats into the same box — at 72
  // the top line was being sliced off.
  success: { width: 760, height: 84 },
  error: { width: 760, height: 84 }
};

// Pick the display the pill should appear on: the one holding the window the
// user was dictating into (Windows, where we have its rect), else the display
// under the cursor (macOS, where getWindowRect is a stub).
function pillDisplay() {
  const rect = savedForegroundHwnd ? getWindowRect(savedForegroundHwnd) : null;
  if (rect && rect.right > rect.left && rect.bottom > rect.top) {
    const cx = Math.round((rect.left + rect.right) / 2);
    const cy = Math.round((rect.top + rect.bottom) / 2);
    return screen.getDisplayNearestPoint({ x: cx, y: cy });
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// Sit the pill in the bottom-RIGHT of the work area (which already excludes the
// dock / menu bar / taskbar). Bottom-centre put a 760px-wide result pill
// directly over the input line of whatever the user was dictating into — the
// one place on screen guaranteed to be in the way.
function positionPill(/** @type {number} */ width, /** @type {number} */ height) {
  if (!pillWindow) return;
  const wa = pillDisplay().workArea;
  const x = Math.round(wa.x + wa.width - width - PILL_SIDE_MARGIN);
  const y = Math.round(wa.y + wa.height - height - PILL_BOTTOM_MARGIN);
  pillWindow.setBounds({ x, y, width, height });
}

function showPillForWindow(/** @type {number | null} */ _hwnd) {
  if (!pillWindow) return;
  clearTimeout(pillSafetyTimer);
  setPillState("listening");
  pillWindow.showInactive();
}

// Drive the pill's look + behaviour. listening/transcribing are passive and
// click-through; success/error carry action buttons, so mouse events are
// enabled and the renderer owns the auto-hide (with hover-pause). `opts` only
// applies to result states: { canCopy, canOpen }.
function setPillState(
  /** @type {"listening" | "transcribing" | "success" | "error"} */ state,
  /** @type {{ canCopy?: boolean, canOpen?: boolean, holdMs?: number, reason?: string }} */ opts = {}
) {
  if (!pillWindow || pillWindow.isDestroyed()) return;
  const size = PILL_SIZES[state] || PILL_SIZES.listening;
  positionPill(size.width, size.height);
  const interactive = state === "success" || state === "error";
  // Result states stay click-through but FORWARD mouse moves to the renderer,
  // which flips real interactivity on only while the pointer is over the
  // visible pill (pill:set-interactive). Without forwarding, the invisible
  // margins of the fixed 480px window would eat clicks at the bottom-center
  // of the screen for the whole 6–30s linger.
  if (interactive) pillWindow.setIgnoreMouseEvents(true, { forward: true });
  else pillWindow.setIgnoreMouseEvents(true);
  pillWindow.webContents.send("pill:state", {
    state,
    canCopy: !!opts.canCopy,
    canOpen: !!opts.canOpen,
    holdMs: opts.holdMs,
    // A short, plain-English reason shown on result pills so a red "Error" isn't
    // a mystery ("No audio reached the app — mic restarted, try again", etc.).
    reason: opts.reason || ""
  });
}

// Open a saved recording in a media player that actually plays it.
// macOS hands .wav (and .mp3 — switching format wouldn't help) to Music.app,
// which refuses to play a file that isn't in its library, so shell.openPath
// looked like it did nothing. Ask for VLC by name; LaunchServices finds it in
// /Applications or ~/Applications. No VLC installed → fall back to the OS
// default, which is still better than nothing.
function playRecording(/** @type {string | null} */ path) {
  if (!path) return;
  if (process.platform !== "darwin") {
    shell.openPath(path).catch(() => {});
    return;
  }
  execFile("open", ["-a", "VLC", path], (err) => {
    if (err) shell.openPath(path).catch(() => {});
  });
}

// Show a terminal result pill (success or error) and remember what its buttons
// act on. The renderer auto-hides it; the safety timer is a longer backstop in
// case the renderer's own timer is lost.
function showPillResult(
  /** @type {"success" | "error"} */ state,
  /** @type {string | null} */ transcript,
  /** @type {string | null} */ recordingPath,
  /** @type {{ reason?: string, holdMs?: number }} */ opts = {}
) {
  currentTranscript = transcript;
  currentRecordingPath = recordingPath;
  // How long the pill lingers before the renderer auto-hides it.
  //  - A genuine error (no speech, failed paste, transcribe failure) lingers 30s
  //    so the text/recording stays recoverable from the pill. This is the only
  //    case the pill should sit on screen for a long time.
  //  - A confirmed-landed success (read back and verified) — or a paste into a
  //    terminal, which we trust — clears fast (3s, just long enough to register)
  //    and gets out of the way.
  //  - An UNCERTAIN success (pasted, but not read back and not a terminal) used
  //    to linger 8s to make a rare silent miss catchable. In practice almost
  //    every paste is unverifiable, so 8s was the normal case and the pill
  //    overstayed on every dictation. The text is in Recent dictations either
  //    way, so a success is a success: 3s.
  //  - `opts.holdMs` overrides all of it, for a success whose text only landed
  //    on the clipboard (the retry recovery) and so needs reading time.
  const holdMs = opts.holdMs ?? (state === "error" ? 30000 : 3000);
  setPillState(state, { canCopy: !!transcript, canOpen: !!recordingPath, holdMs, reason: opts.reason });
  pillWindow?.showInactive();
  // Crash backstop only — must outlive the renderer's own timer so it never
  // cuts the pill short. Normal completions clear it via hidePill() first.
  armPillSafetyHide(holdMs + 15000);
}

let pillSafetyTimer = null;

// Backstop: if the renderer ever fails to report back (crash, lost IPC), make
// sure the pill doesn't linger on screen. Normal completions clear this via
// hidePill() well before it fires.
function armPillSafetyHide(/** @type {number} */ ms = 15000) {
  clearTimeout(pillSafetyTimer);
  pillSafetyTimer = setTimeout(() => {
    pillSafetyTimer = null;
    hidePill();
  }, ms);
}

function hidePill() {
  clearTimeout(pillSafetyTimer);
  pillSafetyTimer = null;
  currentTranscript = null;
  currentRecordingPath = null;
  if (pillWindow && !pillWindow.isDestroyed()) {
    // Restore click-through so a hidden result pill can't swallow clicks.
    pillWindow.setIgnoreMouseEvents(true);
    if (pillWindow.isVisible()) pillWindow.hide();
  }
}

// The "add to dictionary?" pop-up. Like the pill, it's a frameless,
// non-focusable, always-on-top window so clicking its buttons never steals the
// caret from whatever the user is typing into. It appears next to the mouse
// cursor (the text caret's screen position isn't reliably available across apps
// on macOS, but the cursor is where the user's attention already is).
function createVocabWindow() {
  vocabWindow = new BrowserWindow({
    width: VOCAB_SIZE.width,
    height: VOCAB_SIZE.height,
    frame: false,
    transparent: true,
    resizable: true,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload-vocab.cjs")
    }
  });
  vocabWindow.setAlwaysOnTop(true, "screen-saver");
  vocabWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // It has clickable buttons, so (unlike the passive pill) mouse events stay on.
  vocabWindow.setIgnoreMouseEvents(false);
  vocabWindow.webContents.once("did-finish-load", () => { vocabWindowReady = true; });
  if (serverPort) {
    vocabWindow.loadURL(`http://127.0.0.1:${serverPort}/vocab-prompt.html`);
  } else {
    vocabWindow.loadFile(join(__dirname, "public", "vocab-prompt.html"));
  }
}

// Place the pop-up just below-right of the mouse cursor, flipping/clamping so it
// always stays inside the work area of the display under the cursor.
function positionVocabAtCursor(/** @type {number} */ width, /** @type {number} */ height) {
  if (!vocabWindow) return;
  const pt = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(pt).workArea;
  let x = pt.x + 16;
  let y = pt.y + 18;
  if (x + width > wa.x + wa.width) x = pt.x - width - 16;
  if (y + height > wa.y + wa.height) y = pt.y - height - 18;
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  vocabWindow.setBounds({ x, y, width, height });
}

// Offer to add `term` to the custom dictionary. No-ops if a prompt is already
// up, the term is already known/declined, or we've already asked this session.
function showVocabPrompt(/** @type {string} */ term, /** @type {"name" | "correction"} */ reason) {
  if (!vocabWindow || vocabWindow.isDestroyed() || !term) return;
  if (pendingVocabTerm) return;
  const key = term.toLowerCase();
  if (promptedThisSession.has(key)) return;
  try { if (vocab.isKnown(term) || vocab.isDismissed(term)) return; } catch { return; }
  pendingVocabTerm = term;
  promptedThisSession.add(key);
  positionVocabAtCursor(VOCAB_SIZE.width, VOCAB_SIZE.height);
  // Send only once the renderer has registered its onPrompt handler, or the
  // first prompt of a session (before the window finishes loading) would be
  // dropped and the card would show its empty placeholder.
  const send = () => vocabWindow?.webContents.send("vocab:prompt", { term, reason });
  if (vocabWindowReady) send();
  else vocabWindow.webContents.once("did-finish-load", send);
  vocabWindow.showInactive();
  dlog("vocab-prompt", { term, reason });
  clearTimeout(vocabHideTimer);
  // If the user ignores it, fade out after a bit. Not a decision either way:
  // the term stays un-dismissed, just not re-asked until next restart.
  vocabHideTimer = setTimeout(hideVocab, 7000);
}

function hideVocab() {
  clearTimeout(vocabHideTimer);
  vocabHideTimer = null;
  pendingVocabTerm = null;
  if (vocabWindow && !vocabWindow.isDestroyed() && vocabWindow.isVisible()) {
    vocabWindow.hide();
  }
}

// After a successful dictation, arm the manual-correction watcher. The ONLY
// signal worth a pop-up is the user hand-typing a fix of a just-dictated word
// (a near-miss the watcher recognises) — that's real evidence the engine
// mis-heard it. We deliberately do NOT offer mid-sentence capitalized words on
// their own: a correctly-spelled name means the engine already got it right, so
// "save it?" is pure noise — and saving common-word homophones like "Stripe" or
// "Mike" actively degrades recognition (see models/vocab.txt).
function maybeSuggestVocab(/** @type {string} */ typedText) {
  try {
    recentTypedWords = vocab.wordsOf(typedText);
    correctionWatcher.arm(CORRECTION_WATCH_MS);
  } catch (err) {
    debug("[vocab] suggestion failed:", err && err.message);
  }
}

// The dictionary manager — a normal, focusable window (tray → "Manage
// dictionary…") where the user types in the names and made-up words the engine
// should spell exactly. This is the reliable way to seed words the engine
// mishears: the cursor pop-up can only confirm what was transcribed, but a
// made-up word gets transcribed as something else, so it can never be captured
// that way. Words added here bias every engine on the next dictation.
function openDictionaryWindow() {
  // This is an accessory app (Dock hidden), so a window won't become key on its
  // own — pull the whole app forward so the text field actually accepts typing.
  app.focus({ steal: true });
  if (dictionaryWindow && !dictionaryWindow.isDestroyed()) {
    dictionaryWindow.show();
    dictionaryWindow.focus();
    return;
  }
  dictionaryWindow = new BrowserWindow({
    width: 440,
    height: 540,
    title: "GVoice dictionary",
    show: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#14181e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload-dictionary.cjs")
    }
  });
  dictionaryWindow.on("closed", () => { dictionaryWindow = null; });
  dictionaryWindow.webContents.once("did-finish-load", () => {
    if (dictionaryWindow && !dictionaryWindow.isDestroyed()) dictionaryWindow.focus();
  });
  if (serverPort) {
    dictionaryWindow.loadURL(`http://127.0.0.1:${serverPort}/dictionary.html`);
  } else {
    dictionaryWindow.loadFile(join(__dirname, "public", "dictionary.html"));
  }
}

// The Settings window — a normal, focusable window (tray → "Settings…", and
// opened automatically on first run when a required key/model is missing). Lets
// the user pick the speech engine, default language, cleanup, API keys, and
// recording privacy without hand-editing the .env file. `firstRun` shows a short
// welcome line; `reason` (optional) explains what's missing.
// Speech models the speed test pulled down that weren't on disk before. The
// download happens BEFORE the test can run, so a user who then keeps a cloud
// engine — or just closes Settings — would otherwise be left with a 57 MB-1 GB
// file and no UI to remove it. A SET, not one slot: the Settings dropdown shows
// each model's measured time, so testing several to compare them is the normal
// flow, and one slot would silently strand every model but the last. Entries are
// dropped (file kept) only for the model actually applied as the engine. Only
// ever these paths: never a MODELS_DIR sweep, because in a dev launch MODELS_DIR
// is the repo's own models/ folder.
/** @type {Set<string>} */
const benchDownloadedModels = new Set();
let benchmarkInFlight = false;

/** Bin every unused benchmark download. No-op while a test is still running. */
function dropUnusedBenchModels() {
  if (benchmarkInFlight) return;
  for (const path of benchDownloadedModels) {
    try { unlinkSync(path); } catch {}
  }
  benchDownloadedModels.clear();
}

function openSettingsWindow(opts = {}) {
  // Accessory app (Dock hidden) — pull the app forward so the text fields accept
  // typing, same as the dictionary window.
  app.focus({ steal: true });
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    if (opts.firstRun || opts.reason) sendSettingsIntro(opts);
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 760,
    height: 600,
    minWidth: 680,
    minHeight: 520,
    title: "GVoice settings",
    show: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#14181e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload-settings.cjs")
    }
  });
  // Closing the window without answering "on-device or cloud?" is the other way
  // a downloaded-but-unused model gets stranded on disk.
  settingsWindow.on("closed", () => { settingsWindow = null; dropUnusedBenchModels(); });
  settingsWindow.webContents.once("did-finish-load", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus();
      sendSettingsIntro(opts);
    }
  });
  if (serverPort) {
    settingsWindow.loadURL(`http://127.0.0.1:${serverPort}/settings.html`);
  } else {
    settingsWindow.loadFile(join(__dirname, "public", "settings.html"));
  }
}

// Push the first-run welcome / "what's missing" note to the settings renderer.
function sendSettingsIntro(opts = {}) {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  if (!opts.firstRun && !opts.reason) return;
  settingsWindow.webContents.send("settings:intro", {
    firstRun: !!opts.firstRun,
    reason: opts.reason || ""
  });
}

function createDictationWindow() {
  if (!serverPort) return;
  dictationWindow = new BrowserWindow({
    width: 400,
    height: 200,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.cjs")
    }
  });
  dictationWindow.webContents.on("console-message", (_e, level, message) => {
    console.error("[dictation/renderer]", message);
  });
  // The hidden renderer owns mic capture + the WebSocket. If it crashes, the
  // hotkey would keep IPCing into a dead webContents and every press would
  // silently do nothing until an app restart — the same "works until it doesn't"
  // trap. Reload it so the next press has a live renderer, and capture the crash
  // in the log (invisible on the console in a packaged launch).
  dictationWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[dictation/renderer] process gone:", details && details.reason);
    dlog("render-process-gone", details || {});
    // Small delay so we don't tight-loop if it dies again on load.
    setTimeout(() => {
      try { if (dictationWindow && !dictationWindow.isDestroyed()) reloadDictationWindow(); } catch {}
    }, 800);
  });
  dictationWindow.webContents.on("unresponsive", () => {
    console.error("[dictation/renderer] unresponsive");
    dlog("renderer-unresponsive", {});
  });
  dictationWindow.loadURL(dictationUrl());
}

// The renderer reads the provider once at load, so a Settings change takes
// effect via reloadDictationWindow(). The mic lifecycle is fixed in the
// renderer: one second of post-release capture, then the device closes.
function dictationUrl() {
  const provider = encodeURIComponent((process.env.STT_PROVIDER || "openai").toLowerCase());
  return `http://127.0.0.1:${serverPort}/dictation.html?provider=${provider}`;
}

// Dictation is English-only: the bundled local model is ggml-small.en (English),
// so there's no language to choose. whisper-local reads WHISPER_LANGUAGE from
// process.env on every transcription, so lock it here at module load — before the
// relay starts — overriding whatever an older .env left behind.
const DICTATION_LANGUAGE = "en";
process.env.WHISPER_LANGUAGE = DICTATION_LANGUAGE;

function updateTrayTooltip() {
  if (!tray) return;
  if (hotkeyFailed) {
    tray.setToolTip(hotkeyNeedsAccessibility
      ? "GVoice can't read the dictation key.\nAllow GVoice under Privacy & Security > Accessibility, then reopen."
      : "GVoice — the dictation key couldn't start.\nQuit and reopen the app. Details: debug.log");
    try { tray.setImage(makeTrayIcon()); } catch {}
    return;
  }
  if (hotkeyDeaf) {
    tray.setToolTip(DEAF_HOTKEY_TITLE + "\n" + DEAF_HOTKEY_BODY);
    try { tray.setImage(makeTrayIcon()); } catch {}
    return;
  }
  const keyLabel = process.platform === "darwin" ? "right Option" : "Ctrl+Shift";
  tray.setToolTip(`GVoice\nHold ${keyLabel} to dictate, or click this icon to start and stop.`);
  try { tray.setImage(makeTrayIcon()); } catch {}
}

// Longest a single push-to-talk hold can run before we assume the key-up event
// was lost (a dropped global-hook event on a Space switch, screen lock, or fast
// modifier combo) and end the recording ourselves. Real dictations are seconds
// long; this only ever fires on a stuck hold. Without it a single missed key-up
// leaves the session permanently "busy" and EVERY later press is silently
// ignored — the app looks dead while the process is healthy.
const MAX_HOLD_MS = 90000;

// The click-to-talk toggle has no key-up to lose, and it invites long, hands-off
// dictations — 90s would cut the user off mid-sentence and paste half a thought.
// Still capped, so a forgotten "on" click can't hold the mic open all day.
const CLICK_MAX_HOLD_MS = 600000;

// --- Deaf-hotkey watchdog -----------------------------------------------------
// The failure this catches: the key hook STARTS cleanly and then delivers
// nothing. A client hit it by launching GVoice from a terminal — on macOS the
// Accessibility grant belongs to the process that launched the app, so a
// terminal without it produces an app that looks completely healthy (tray icon,
// "Ready") whose dictation key does nothing. uiohook reports no error for this,
// and isTrustedAccessibilityClient() answers for GVoice rather than the
// launcher, so silence is the only symptom there is.
//
// So: armed, but not one keyboard or mouse event, WHILE the user is
// demonstrably at the machine. powerMonitor.getSystemIdleTime() is the
// cross-check — it reads real HID activity and needs no permission of its own
// (verified with an untrusted app: isTrustedAccessibilityClient() false, idle
// time still readable) — so a machine nobody is touching never trips this.
const DEAF_HOTKEY_TITLE = "GVoice isn't hearing your keyboard";
const DEAF_HOTKEY_BODY =
  "If you started it from a terminal, quit and open GVoice from Finder instead — " +
  "or allow that terminal under Privacy & Security > Accessibility.";
const HOOK_CHECK_MS = 15000;
// The user must look active on two checks in a row, so one unlucky sample
// (a keystroke that landed just before we looked) can't convict a live hook.
const HOOK_STRIKES = 2;
// Seconds since the last real input that still counts as "at the machine".
const HOOK_ACTIVE_IDLE_S = 5;
let hookWatchdogTimer = null;

function startHookWatchdog(/** @type {() => boolean} */ sawEvent) {
  if (hookWatchdogTimer) clearInterval(hookWatchdogTimer);
  let strikes = 0;
  hookWatchdogTimer = setInterval(() => {
    // Any event at all means the hook is alive — stop looking, for good.
    if (sawEvent()) return stopHookWatchdog();
    // Nobody's touching the machine: no verdict either way.
    if (powerMonitor.getSystemIdleTime() >= HOOK_ACTIVE_IDLE_S) {
      strikes = 0;
      return;
    }
    strikes += 1;
    if (strikes < HOOK_STRIKES) return;
    // One verdict per launch: stop before telling the user, so this can't nag.
    stopHookWatchdog();
    reportDeafHotkey();
  }, HOOK_CHECK_MS);
}

function stopHookWatchdog() {
  if (!hookWatchdogTimer) return;
  clearInterval(hookWatchdogTimer);
  hookWatchdogTimer = null;
}

function reportDeafHotkey() {
  hotkeyDeaf = true;
  console.error("[hotkey] armed but receiving no events — likely launched from a terminal without Accessibility");
  dlog("hotkey-deaf", {});
  updateTrayTooltip();
  rebuildTrayMenu();
  try {
    if (Notification.isSupported()) {
      const note = new Notification({ title: DEAF_HOTKEY_TITLE, body: DEAF_HOTKEY_BODY });
      note.on("click", () => openAccessibilitySettings());
      note.show();
    }
  } catch {}
}

// Begin a dictation. Module-level (not a setupHotkey closure) so the tray's
// left-click toggle can start one too — including on a run where the global
// hotkey failed to arm, which is exactly when a clickable fallback matters.
// Returns false if the press was rejected (previous dictation still in flight,
// or no renderer to talk to).
function startDictation(/** @type {number} */ maxHoldMs = MAX_HOLD_MS) {
  if (!dictationWindow || dictationWindow.isDestroyed()) return false;
  if (!dictation.tryStart()) return false;
  // A new dictation supersedes any correction-watch window from the last
  // one, and clears a pop-up the user never answered.
  correctionWatcher.disarm();
  recentTypedWords = [];
  hideVocab();
  // `gen` rides along so the renderer can stamp its terminal events with the
  // press they belong to (see isStalePress).
  const profile = {
    language: DICTATION_LANGUAGE,
    model: process.env.DEEPGRAM_MODEL || "nova-3",
    gen: dictation.generation
  };
  savedForegroundHwnd = captureForegroundWindow();
  dlog("press", { profile, hwnd: savedForegroundHwnd });
  debug("[main] dictation:start lang=" + profile.language + " (hwnd=" + savedForegroundHwnd + ")");
  showPillForWindow(savedForegroundHwnd);
  dictationWindow.webContents.send("dictation:start", profile);
  // Self-heal a lost key-up: if the hold never reports a release, end it
  // the same way a real release would (commit + transcribe + re-open the
  // session) so a dropped event can't jam dictation until the next quit.
  if (maxHoldTimer) clearTimeout(maxHoldTimer);
  maxHoldTimer = setTimeout(() => fireRelease("max-hold"), maxHoldMs);
  return true;
}

function fireRelease(/** @type {string} */ source) {
  // Whatever ends the dictation — key-up, max-hold, or a tray click — the tray
  // toggle is no longer holding the mic open.
  trayHolding = false;
  if (maxHoldTimer) { clearTimeout(maxHoldTimer); maxHoldTimer = null; }
  if (!dictation.release()) return;
  dlog("release", { source });
  debug("[main] dictation:stop (" + source + ")");
  // Guard like every other webContents.send in this file: a max-hold timer
  // (or a late real release) can fire during teardown, after the window is
  // gone, and an unguarded send throws "Object has been destroyed".
  if (!dictationWindow || dictationWindow.isDestroyed()) return;
  dictationWindow.webContents.send("dictation:stop");
  // Keep the pill visible but switch it to the pulsing-blue "Transcribing…"
  // state so the user can see work is still happening. A terminal event
  // (transcript / failure / error) flips it to success/error; the safety
  // timer covers a renderer that never reports back.
  setPillState("transcribing");
  // Must outlive the renderer's 20s FAILURE_MS watchdog, or the
  // transcribing pill vanishes mid-work and the result pops up later
  // with no context.
  armPillSafetyHide(25000);
}

async function setupHotkey() {
  if (!serverPort || !dictationWindow) return false;
  try {
    const mod = await import("./src/hotkey.js");
    hotkeyEngine = mod.startHotkey({
      onPress: () => { startDictation(); },
      onRelease: () => { fireRelease("hotkey"); }
    });
    updateTrayTooltip();
    startHookWatchdog(hotkeyEngine.sawEvent);
    const altLabel = process.platform === "darwin"
      ? "right Option (⌥), left Ctrl+Cmd, or mouse back button"
      : "Ctrl+Shift (either side)";
    console.log(`Global hotkeys active: hold ${altLabel} to dictate.`);
    return true;
  } catch (error) {
    hotkeyFailed = true;
    // uiohook-napi throws this code (src/lib/addon.c) when macOS refused the
    // global key hook for want of Accessibility permission. libuiohook asks for
    // it with the system prompt, so the user is looking at macOS's "control this
    // computer" dialog at this exact moment — telling them to restart the app
    // instead of to grant it is what made this look like a broken app.
    hotkeyNeedsAccessibility = process.platform === "darwin"
      && !!error && error.code === "UIOHOOK_ERROR_AXAPI_DISABLED";
    console.error("Failed to start global hotkey:", error.message);
    dlog("hotkey-failed", { code: error && error.code, detail: error && (error.stack || error.message) });
    // The app would otherwise look alive while every key-hold does nothing.
    updateTrayTooltip();
    rebuildTrayMenu();
    try {
      if (Notification.isSupported()) {
        const note = hotkeyNeedsAccessibility
          ? new Notification({
              title: "GVoice needs permission to hear the dictation key",
              body: "Allow GVoice under Privacy & Security > Accessibility, then reopen the app. Click here to open it."
            })
          : new Notification({
              title: "GVoice — the dictation key couldn't start",
              body: "Quit and reopen the app. Details are in debug.log."
            });
        if (hotkeyNeedsAccessibility) note.on("click", () => openAccessibilitySettings());
        note.show();
      }
    } catch {}
    return false;
  }
}

// Open System Settings straight to the Accessibility list. The tray item and the
// permission notification both land here so the user never has to hunt for the
// pane. Silently a no-op off macOS — nothing else calls it there.
function openAccessibilitySettings() {
  if (process.platform !== "darwin") return;
  shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").catch(() => {});
}

// Clean up a raw transcript (strip Whisper noise tokens, optional LLM polish,
// trailing punctuation) and type it into the focused app. Shared by the live
// dictation path and the backup retry path. Returns the text that was typed,
// or null if there was nothing to type.
//
// `restoreHwnd` (live path only): the foreground window captured on key-press.
// Focus is restored to it immediately before the paste, so Ctrl/Cmd+V lands in
// the app the user was dictating into rather than whatever grabbed focus
// during the IPC round-trip. The retry path passes nothing (the user is
// interacting with the pop-up, so there's no window to restore).
//
// @param {string} transcript
// @param {number | null} [restoreHwnd]
// @returns {Promise<{ text: string, pasted: boolean, verified: boolean | null, likelyMissed: boolean, notice: string } | null>}
async function processTranscript(transcript, restoreHwnd = null) {
  if (!transcript || !transcript.trim()) return null;
  let textToType = stripWhisperNoiseTokens(transcript.trim());
  if (!textToType) {
    dlog("noise-only", { original: transcript });
    return null;
  }

  // Fix-after-the-fact vocabulary correction (runs before cleanup so the LLM
  // sees the right spellings). Custom terms are no longer biased into whisper's
  // prompt; instead we repair genuine near-misses here ("Cloud"→"Claud") while
  // leaving unrelated words untouched. No-op when the dictionary is empty.
  const corrected = vocab.correctTranscript(textToType);
  if (corrected !== textToType) {
    dlog("vocab-correct", { from: textToType, to: corrected });
    textToType = corrected;
  }

  const cleanupEnabled = process.env.CLEANUP_ENABLED !== "false";
  const commaCount = (textToType.match(/,/g) || []).length;
  const hasFiller = /\b(uh|um|uhh|er|erm)\b/i.test(textToType);
  const hasOrdinal = /\b(first|second|third|fourth|fifth|next,|finally,)\b/i.test(textToType);
  // A spoken self-correction ("buy milk no wait buy water") is usually short and
  // clean, so the length/filler heuristics below would skip cleanup and paste the
  // retracted words verbatim. looksLikeRetraction matches only unambiguous
  // multi-word cues (not a bare "no"/"actually", which the prompt judges in
  // context) — when one appears, always run cleanup so the retraction is dropped.
  // Gated by the Settings toggle (SELF_CORRECTION); off → don't force-route.
  const hasRetraction = process.env.SELF_CORRECTION !== "false" && looksLikeRetraction(textToType);
  // Short, clean utterances skip LLM cleanup — they need only a trailing period,
  // not restructuring. The LLM adds value on long or messy dictations; sending
  // short clear phrases to it causes unneeded rewriting.
  const needsCleanup =
    (textToType.length >= 40 || hasFiller || hasOrdinal || commaCount >= 4 || hasRetraction) &&
    (textToType.length > 120 ||
     hasFiller ||
     !/[.!?…]$/.test(textToType) ||
     hasOrdinal ||
     commaCount >= 4 ||
     hasRetraction);
  // Set when the cleanup pass gave up and the raw transcript went through
  // instead — most often the free tier's per-minute cap. Carried out to the
  // success pill so the user SEES which dictations were typed unformatted; the
  // system notification below still fires only once per run.
  let cleanupNotice = "";
  if (cleanupEnabled && needsCleanup) {
    const t0 = Date.now();
    try {
      const { polishTranscript, takeCleanupError, FREE_LIMIT_MESSAGE } = await import("./src/cleanup.js");
      textToType = await polishTranscript(textToType);
      debug("[main] cleanup done (" + (Date.now() - t0) + "ms):", JSON.stringify(textToType));
      // polishTranscript swallows its own errors and returns the raw text, so a
      // permanently dead cleanup engine looks exactly like a working one with
      // nothing to fix. Say it out loud once instead of only in a console log.
      cleanupNotice = takeCleanupError() || "";
      if (cleanupNotice) dlog("cleanup-notice", cleanupNotice);
      // The free tier's per-minute cap is routine — it clears itself in under a
      // minute and the pill already says so on the exact dictation it hit. A
      // system notification for it would be noise. Notifications are for the
      // failures that stay broken until someone acts.
      if (cleanupNotice !== FREE_LIMIT_MESSAGE) showCleanupWarning(cleanupNotice);
    } catch (error) {
      console.error("[main] Cleanup pass failed, using raw:", error.message);
    }
  } else {
    debug("[main] cleanup SKIPPED (short/clean, length=" + textToType.length + ")");
  }

  textToType = (textToType || "").trim();
  if (!textToType) return null;
  if (!/[.!?…,;:"')\]]$/.test(textToType)) {
    textToType += ".";
  }

  // Check whether an editable field is actually focused BEFORE we paste, while
  // the user's app is still frontmost. On macOS this reads the Accessibility
  // API (true/false); on Windows it returns null (we fall back to the restore
  // signal). null = couldn't tell, so don't hold it against the paste.
  const fieldFocused = isEditableFieldFocused();

  const tType = Date.now();
  const { typeText } = await import("./src/typing.js");
  let restored = false;
  if (restoreHwnd != null) {
    restored = restoreForegroundWindow(restoreHwnd);
    dlog("paste", { hwnd: restoreHwnd, restored });
  }
  // Best-effort confidence that the text actually landed in a text field.
  // Clipboard paste is fire-and-forget, so we can't truly confirm — but these
  // signals tell us it did NOT: typeText threw; (Windows) we had a foreground
  // window to restore and the restore failed; or (macOS) no editable element
  // was focused, so ⌘V went nowhere.
  let typed = true;
  try {
    await typeText(textToType);
  } catch (error) {
    typed = false;
    console.error("[main] typeText failed:", error && (error.stack || error.message));
  }
  let pasted =
    typed &&
    !(restoreHwnd != null && restored === false) &&
    fieldFocused !== false;
  // Windows paste verification: confirm focus is STILL the window we restored to
  // right after sending Ctrl+V. If another app grabbed the foreground mid-paste,
  // the keystroke went somewhere else — downgrade so the text stays recoverable
  // from the pill instead of a false "Success". isForegroundWindow returns null
  // off Windows (and when koffi is unavailable), which we never hold against a
  // paste. This is the Windows counterpart to macOS's AX focus/read-back check.
  if (pasted && process.platform === "win32" && restoreHwnd != null) {
    const stillForeground = isForegroundWindow(restoreHwnd);
    if (stillForeground === false) {
      pasted = false;
      dlog("paste-foreground-lost", { hwnd: restoreHwnd });
    }
  }
  // Post-paste verification (macOS, best-effort): re-read the focused field and
  // check our text actually appeared in it. Only DOWNGRADE on a readable string
  // that's missing the text — null means "couldn't verify" (web areas, secure
  // fields), which must never turn a good paste into a false error.
  // Terminals draw TUIs (tmux, vim, editors, Claude Code) whose on-screen text
  // is full of box borders and line wraps, so reading it back and looking for
  // our pasted string gives false negatives. fieldFocused already confirmed an
  // editable area, so skip the read-back for terminals and trust the paste —
  // the alternative was a sticky false "paste failed" error on every terminal.
  // The terminal check and the read-back are one AX snapshot (readbackPasteTarget)
  // so a focus change can't make them disagree about which app is focused.
  let verified = null;
  let readTarget = "";
  let readLen = /** @type {number | null} */ (null);
  if (pasted) {
    await new Promise((resolve) => setTimeout(resolve, 150)); // let the paste settle
    const { isTerminal, value: fieldValue, app } = readbackPasteTarget();
    readTarget = app;
    readLen = typeof fieldValue === "string" ? fieldValue.length : null;
    if (!isTerminal && typeof fieldValue === "string") {
      // Normalize what apps auto-substitute (smart quotes, em-dashes, NBSP,
      // collapsed whitespace) so autocorrect can't turn a good paste into a
      // false error.
      const norm = (/** @type {string} */ s) =>
        s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
         .replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
      verified = norm(fieldValue).includes(norm(textToType));
      // A read-back that can't find the text used to mean "the paste failed".
      // It doesn't: 2026-07-30, seven pastes in a row that visibly LANDED were
      // all called failures, each one a 30s error pill telling the user to click
      // Copy for text already sitting in front of them. An app that doesn't
      // expose its composer's text faithfully (web areas, Electron editors,
      // rich-text composers) is indistinguishable from a real miss here, so this
      // signal can only ever mean "unconfirmed", so on its own it never shows an
      // error — only `likelyMissed` below acts on it, by leaving the text on the
      // clipboard. The signals that CAN prove a miss (typeText threw, no editable field,
      // Windows focus lost) still set pasted = false above.
    }
  }
  debug("[main] paste done (" + (Date.now() - tType) + "ms paste, restored=" + restored + ", fieldFocused=" + fieldFocused + ", verified=" + verified + ", pasted=" + pasted + ")");
  // target/readLen say WHY a paste came back unverified — which app owned the
  // field and whether anything was readable in it — without ever logging what
  // the user dictated or what was already in the field.
  dlog("typed", {
    len: textToType.length,
    ms: Date.now() - tType,
    fieldFocused,
    pasted,
    verified,
    target: readTarget,
    readLen
  });
  // verified: true = read back and confirmed, false = read back and missing
  // (already downgraded pasted), null = couldn't read the field to check.
  // The strongest miss signal we have that still isn't strong enough to call a
  // failure: we read the field back, it had real content in it, and our text
  // wasn't there. The seven false "paste failed" pills that got the downgrade
  // removed all read back EMPTY (readLen 0 — an app that just doesn't expose
  // its composer), so requiring content separates them. Not enough to show an
  // error, but enough to leave the text on the clipboard so ⌘V rescues it.
  const likelyMissed = pasted && verified === false && (readLen || 0) > 0;
  return { text: textToType, pasted, verified, likelyMissed, notice: cleanupNotice };
}

// How many recent recordings to keep on disk — matched to the history length so
// every dictation in the tray's "Recent dictations" list can still be played.
const MAX_RECORDINGS = 50;

// Privacy controls for the saved recordings (everything the user dictated sits
// here unencrypted). RECORDINGS_ENABLED=false turns saving off entirely;
// RECORDING_RETENTION_DAYS bounds how long clips linger on top of the count cap.
// Both are read fresh each call so a Settings change applies without a restart.
function recordingsEnabled() {
  return !/^(false|0|no|off)$/i.test(String(process.env.RECORDINGS_ENABLED ?? "true").trim());
}
function recordingMaxAgeMs() {
  const days = Number(process.env.RECORDING_RETENTION_DAYS ?? 7);
  if (!Number.isFinite(days) || days <= 0) return 0; // 0 = no age cap
  return days * 24 * 60 * 60 * 1000;
}

// Write the just-captured audio to the recordings folder so the pill's "Open
// recording" button and the tray's "Play recording" items have a file to open.
// Clips are pruned by BOTH a count cap (MAX_RECORDINGS) and an age cap, and they
// survive a restart. Returns the path, or null (nothing to save, or the user
// turned recording off).
//
// @param {string[]} chunks   base64 PCM16 frames
// @param {number} [sampleRate]
// @returns {Promise<string | null>}
async function saveTempRecording(chunks, sampleRate) {
  if (!recordingsDir || !chunks || !chunks.length || !recordingsEnabled()) return null;
  try {
    const pcm = Buffer.concat(chunks.map((b64) => Buffer.from(b64, "base64")));
    if (!pcm.length) return null;
    const path = await saveRecording(recordingsDir, pcm, sampleRate || 24000, {
      maxCount: MAX_RECORDINGS,
      maxAgeMs: recordingMaxAgeMs()
    });
    dlog("temp-recording", { bytes: pcm.length });
    return path;
  } catch (error) {
    console.error("[main] Failed to save temp recording:", error && (error.stack || error.message));
    return null;
  }
}

let retryInFlight = false;

// The pill belongs to whatever is happening NOW. A retry takes seconds, and a
// key-press during it starts a fresh dictation that owns the pill from then on —
// so every late write (the retry's own, and the callers' fallbacks below) has to
// ask first instead of painting over a live "Listening…".
function pillFree() {
  return !dictation.busy;
}

// Can the batch retry run for this clip at all? Three ways it can't, and the
// on-demand path below turns each into a message rather than a dead button.
//   - no clip (never saved, or pruned since)
//   - one retry already in flight (the tray offers this on every saved clip, so
//     two can be started seconds apart — they'd fight over the pill and both
//     write history)
//   - the engine isn't Deepgram. Batch IS Deepgram's cloud: sending an OpenAI
//     or on-device user's audio there, with our shared fallback key, would ship
//     it to a vendor they never chose (and for on-device, break the whole point
//     of choosing it).
function retryCanRun(recordingPath) {
  return !!recordingPath && existsSync(recordingPath) && !retryInFlight && sttProvider() === "deepgram";
}

function sttProvider() {
  return (process.env.STT_PROVIDER || "openai").toLowerCase();
}

// Second chance for a dictation that came back with nothing. The audio is
// already on disk, so a failed live stream doesn't have to mean lost words:
// re-send the saved .wav to Deepgram's batch API, which has no handshake to
// race and no streaming timeouts. Runs automatically after an empty result on
// the Deepgram engine (see retryCanRun), and on demand from the pill's
// "Transcribe again" button or the tray.
//
// The recovered text goes to the CLIPBOARD and the pill, not straight into the
// focused app: the round-trip takes a few seconds, by which time the window the
// user was dictating into is often no longer the one in front.
//
// @param {string | null} recordingPath
// @returns {Promise<string | null>} the recovered text, "" if the retry ran and
//   found none, or null if it never ran at all (caller still owns the pill).
async function retranscribeRecording(recordingPath, { deliver = true } = {}) {
  if (!retryCanRun(recordingPath)) return null;
  retryInFlight = true;
  const t0 = Date.now();
  if (pillFree()) {
    setPillState("transcribing");
    pillWindow?.showInactive();
  }
  try {
    const attempt = () => transcribeWavFile(recordingPath, {
      apiKey: resolveDeepgramKey(),
      model: process.env.DEEPGRAM_MODEL || "nova-3",
      language: DICTATION_LANGUAGE
    });
    let text = await attempt();
    // Deepgram sometimes answers a perfectly good clip with nothing at all —
    // measured 2026-08-01: a 4.3s clip with normal speech level came back empty
    // (13.5s), and the identical file transcribed correctly two minutes later.
    // withRetry can't see this: it's a 200 with an empty transcript, not an
    // error. This is the LAST chance before the user is told their recording had
    // no speech in it, so spend one more call rather than lose the words.
    if (!text) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      text = await attempt();
      if (text) dlog("retranscribe-second-try", { path: recordingPath, len: text.length });
    }
    dlog("retranscribe", { path: recordingPath, len: text.length, ms: Date.now() - t0 });
    if (!text) {
      if (pillFree()) showPillResult("error", null, recordingPath, { reason: "Retried — no speech in the recording." });
      return "";
    }
    const cleaned = stripWhisperNoiseTokens(text) || text;
    // deliver:false — the caller is going to paste this itself (the automatic
    // rescue of a blank stream). Don't touch the clipboard, the pill, or the
    // history here, or the user would get two pills and a clipboard they never
    // asked us to overwrite for text that landed normally.
    if (!deliver) return cleaned;
    // It WORKED — green dot. (This used to ride the error state purely to buy
    // the 30s linger, so a rescued dictation looked like a failure.) The text is
    // only on the clipboard, so keep the long linger via holdMs.
    //
    // Both the clipboard and the pill are gated on still owning the moment: a
    // press during the round trip starts a new dictation, and dropping this
    // (older) text onto the clipboard behind it would silently replace whatever
    // the user had copied — with no pill to explain where their ⌘V went. The
    // rescued text is still in history and the tray.
    if (pillFree()) {
      clipboard.writeText(cleaned);
      showPillResult("success", cleaned, recordingPath, { reason: "Got it on retry — press ⌘V.", holdMs: 30000 });
    }
    recordTranscript(cleaned, false, recordingPath);
    rebuildTrayMenu();
    return cleaned;
  } catch (error) {
    const detail = error && (error.message || String(error));
    console.error("[main] retranscribe failed:", detail);
    dlog("retranscribe-failed", { path: recordingPath, error: String(detail), status: error?.status });
    if (pillFree()) showPillResult("error", null, recordingPath, { reason: batchFailureReason(error) });
    return "";
  } finally {
    retryInFlight = false;
  }
}

// "Transcribe again" from the pill or the tray. Same retry, but nobody else is
// holding the pill — so when it can't run at all, say so instead of letting the
// click do nothing visible.
async function retranscribeOnDemand(/** @type {string | null} */ recordingPath) {
  // A dictation is live right now (tray "Transcribe again" is clickable during
  // one). Running would upload the clip and then throw every result away —
  // retranscribeRecording gates its pill AND its clipboard write on pillFree() —
  // and the message below would paint over a live "Listening…". The pill the
  // user is already looking at is the answer, so leave it alone.
  if (!pillFree()) return;
  if (!retryCanRun(recordingPath)) {
    // Nothing will happen, so say why. The button used to sit there doing
    // absolutely nothing on every one of these.
    const provider = sttProvider();
    const engine = provider === "whisper-local" || provider === "local" ? "on-device" : provider;
    const reason = provider !== "deepgram"
      ? "Transcribe again needs the Deepgram engine — GVoice is set to " + engine + "."
      : retryInFlight
        ? "Already trying that one again — give it a few seconds."
        : "That recording is gone — there's nothing left to retry.";
    showPillResult("error", null, recordingPath, { reason });
    return;
  }
  await retranscribeRecording(recordingPath);
}

function setupIpc() {
  ipcMain.on("dictation:transcript", async (_event, payload) => {
    // payload is { text, chunks, sampleRate } on a real transcript, or "" on a
    // server-decided empty (silence gate / hallucination filter).
    // Not const: an empty stream that the batch retry rescues below replaces
    // this with the recovered text and falls through to the normal delivery.
    let text = typeof payload === "string" ? payload : (payload && payload.text) || "";
    const chunks = (payload && typeof payload === "object" && payload.chunks) || null;
    const sampleRate = (payload && typeof payload === "object" && payload.sampleRate) || undefined;
    // Captured audio proves the mic worked at least once — unlocks the relaunch
    // recovery rung for a later wedge.
    if (chunks && chunks.length) everHadLiveMic = true;
    // Which press this transcript belongs to. Everything below can run for
    // seconds (cleanup, the batch rescue, the paste) while `busy` has already
    // been cleared — by the rescue's early done() OR, on an ordinary dictation,
    // by release()'s 500ms safety timer. A press in that window starts a NEW
    // dictation, and the shared state below belongs to that one from then on.
    const gen = dictation.generation;
    const stillMine = () => dictation.generation === gen;
    // Grab the window THIS press captured while it's still ours. Read later
    // (after the rescue round trip) it could already be the next dictation's.
    const targetHwnd = savedForegroundHwnd;
    const { releaseAt, sinceRelease } = dictation.finalize();
    debug("[main] received transcript (" + sinceRelease + "ms after release):", JSON.stringify(text));
    dlog("transcript", { len: (text || "").trim().length, sinceRelease });

    // Set when the audio was already written to disk by the empty-stream rescue
    // below, so the normal path doesn't save a second copy of the same clip.
    let rescuedPath = null;
    // Empty transcript. If the renderer still sent the captured audio, this was
    // a real attempt that came back blank (a slow connect, a flush race, both
    // auto-language legs silent, or genuine silence) — the clip is on disk, so
    // ask the batch API before calling it a failure. If there's no audio at all
    // (a too-short accidental tap), hide quietly; an Error on every misfire
    // would just be noise.
    if (!text || !text.trim()) {
      // Re-open the session BEFORE the retry below. The batch round trip takes
      // seconds (minutes on a half-open connection), and every hotkey press in
      // that window would otherwise be dropped in silence — no pill, no clue.
      // done() only clears the busy flag, so the normal path's finally can call
      // it again harmlessly when a rescue falls through.
      dictation.done();
      if (!chunks || !chunks.length) {
        hidePill();
        return;
      }
      const failedPath = await saveTempRecording(chunks, sampleRate);
      // The live stream heard nothing, but the audio is on disk — try the batch
      // API before calling it a failure. That recovers every dictation the
      // stream lost to a slow connect or a timeout rather than to real silence.
      // deliver:false keeps the recovered text OUT of the clipboard-and-⌘V
      // treatment: it comes back here and goes through the normal paste, so a
      // stream that came back blank costs the user a second, not a manual
      // paste. (It also means the rescued text gets the cleanup pass, which the
      // clipboard route skipped.)
      const recovered = failedPath ? await retranscribeRecording(failedPath, { deliver: false }) : null;
      // A press during the round trip started a NEW dictation (the session was
      // re-opened above so presses aren't swallowed). Pasting this older text
      // now would land it in the middle of what the user is saying right now —
      // and taking the clipboard from them would be worse. Park it in history
      // and the tray's Recent dictations, where it stays recoverable.
      if (recovered && !stillMine()) {
        recordTranscript(recovered, false, failedPath);
        rebuildTrayMenu();
        return;
      }
      if (recovered) {
        text = recovered;
        rescuedPath = failedPath;
      } else {
        // null = the retry never ran (nothing saved, one already in flight, or
        // a non-Deepgram engine). It never touched the pill, so this path still
        // has to say what happened instead of leaving "Transcribing…" up —
        // unless a new press has taken the pill since (saving the clip and the
        // retry both take long enough for that), in which case this stale "No
        // speech detected." would paint over a live "Listening…".
        if (recovered === null && stillMine()) {
          showPillResult("error", null, failedPath, { reason: "No speech detected." });
        }
        // "" = the retry ran and genuinely heard nothing; it owns the pill in
        // that case. Either way, record the failed attempt so the clip stays
        // playable from the tray.
        recordTranscript("", false, failedPath);
        rebuildTrayMenu();
        return;
      }
    }

    // Save the audio first so "Open recording" works even on a clean success.
    const recordingPath = rescuedPath || (await saveTempRecording(chunks, sampleRate));
    try {
      // Restore focus to whichever app the user was dictating into, then type.
      // processTranscript strips Whisper noise tokens, runs the cleanup pass,
      // and pastes — restoring focus right before the paste lands.
      const result = await processTranscript(text, targetHwnd);
      // Only clear the global if this press still owns the session. Comparing
      // the VALUE instead would be wrong in the commonest case of all: two
      // dictations into the same app back to back capture the same window, so
      // the values match, we'd wipe the new press's target, and its paste would
      // land with nothing to restore focus to — the exact bug this guards.
      if (stillMine()) savedForegroundHwnd = null;
      debug("[main] total since release: " + (Date.now() - releaseAt) + "ms");
      // A new dictation owns the pill (and the session) from here on. Writing to
      // either would paint over a live "Listening…" and — via the finally below —
      // clear the NEW session's busy flag mid-hold, swallowing the user's key
      // release. Park the text where it stays recoverable and get out.
      if (!stillMine()) {
        console.error("[main] transcript landed after a newer press — parked in history");
        dlog("transcript-stale", { gen });
        if (result && result.text) {
          recordTranscript(result.text, false, recordingPath);
          rebuildTrayMenu();
        }
        return;
      }
      if (!result || !result.text) {
        // Noise-only after cleanup — nothing landed. Quiet hide.
        console.error("[main] transcript was noise-only, dropped");
        hidePill();
        // A rescued clip is different: the batch API DID hear words, cleanup
        // just left nothing. Without this the recovered clip vanishes — no
        // history entry, nothing playable from the tray.
        if (rescuedPath) {
          recordTranscript(text, false, recordingPath);
          rebuildTrayMenu();
        }
      } else {
        // Success when the text was pasted somewhere (verified or not — a paste
        // we couldn't read back, e.g. into a terminal or browser, still landed
        // almost every time and clears fast). Only a real miss shows Error, which
        // lingers so the text stays recoverable via Copy / the recording.
        showPillResult(
          result.pasted ? "success" : "error",
          result.text,
          recordingPath,
          {
            // Only the hard-miss case gets an explanatory reason; a confirmed
            // success keeps the plain "Success" label — unless something happened
            // the user has to know about. Two of those, in priority order:
            //   1. likelyMissed — the text probably didn't land AND the code below
            //      takes their clipboard to make it recoverable. Silently swapping
            //      what ⌘V does, behind a bare 3s "Success", is the worse surprise,
            //      so it beats the cleanup notice when both are true.
            //   2. notice — cleanup gave up, so the text went in exactly as spoken.
            // Action first: the label can ellipsize, so the instruction must
            // survive truncation.
            reason: !result.pasted
              ? "Click Copy — the paste didn't land."
              : result.likelyMissed
                ? "Press ⌘V if the text didn't land — it's on your clipboard."
                : result.notice,
            // A reason needs reading time; a bare "Success" doesn't.
            holdMs: result.pasted && (result.likelyMissed || result.notice) ? 6000 : undefined
          }
        );
        // Keep the last 50 dictations on disk and in the tray menu, so a
        // missed paste is recoverable — and listenable — even after the pill is
        // gone.
        recordTranscript(result.text, result.pasted, recordingPath);
        rebuildTrayMenu();
        // Failed paste — or one that read back as missing from a field with
        // other text in it: leave the text on the clipboard so it's recoverable
        // with ⌘V even if the pill is missed. Delayed past typeText's 250ms
        // clipboard restore, which would otherwise overwrite it.
        if (!result.pasted || result.likelyMissed) {
          const lostText = result.text;
          setTimeout(() => { try { clipboard.writeText(lostText); } catch {} }, 450);
        }
        // Offer to teach the dictionary any likely-misheard names, and start
        // watching for a hand-typed correction. Only when the text actually
        // landed somewhere.
        if (result.pasted) maybeSuggestVocab(result.text);
      }
    } catch (error) {
      console.error("[main] Typing failed:", error.stack || error.message);
      // Same rule as above: a newer press owns the pill, so log it to history
      // only rather than painting an old error over a live "Listening…".
      if (stillMine()) {
        showPillResult("error", text, recordingPath, { reason: "Something went wrong typing it out — click Copy." });
      }
      // Cleanup never ran on this path — at least strip Whisper noise tokens
      // so the history entry matches the others as closely as possible.
      recordTranscript(stripWhisperNoiseTokens(text.trim()) || text, false, recordingPath);
      rebuildTrayMenu();
    } finally {
      // Never on a stale transcript: `busy` belongs to the newer press, and
      // clearing it mid-hold makes fireRelease bail out of dictation:stop.
      if (stillMine()) dictation.done();
    }
  });

  // A dictation couldn't be transcribed but audio was captured. Save the clip
  // and show the Error pill so the user can open the recording and try again.
  ipcMain.on("dictation:failure", async (_event, payload, pressGen) => {
    // Snapshot before fail() re-opens the session. Saving the clip and the batch
    // retry below take seconds, and a press in that window owns the pill from
    // then on. pillFree() alone can't see that — it reads `busy`, which the new
    // press's own safety timer clears while its dictation is still live.
    // A failure stamped with an OLDER press was already overtaken before it even
    // arrived: don't end the live session for it, and don't run the batch rescue
    // (its text would paste into the middle of the new dictation). The clip is
    // still saved and logged, so the tray can replay it.
    const stale = isStalePress(pressGen);
    const gen = dictation.generation;
    const stillMine = () => !stale && dictation.generation === gen;
    if (!stale) dictation.fail();
    const chunks = (payload && payload.chunks) || [];
    const recordingPath = await saveTempRecording(chunks, payload && payload.sampleRate);
    if (recordingPath) console.error("[main] dictation recording saved:", recordingPath);
    // The renderer sends a plain-English reason ("didn't respond in time", "lost
    // the connection…"); show it on the pill. No transcript to copy; the
    // recording is what we offer. Logged in history too for tray playback.
    // Same second chance as the empty-transcript path: the stream died, but the
    // saved audio can still go to the batch API — and when there IS a clip to
    // retry, that retry owns the pill start to finish. Flashing this handler's
    // reason first would be replaced within a frame AND would leave its own
    // 45s safety-hide timer armed behind the retry's shorter states.
    const reason = (payload && payload.reason) || "Couldn't transcribe.";
    const recovered = recordingPath && !stale ? await retranscribeRecording(recordingPath) : null;
    // null = no retry happened (see retranscribeRecording) — show the
    // renderer's plain-English reason rather than a pill stuck on "Transcribing…",
    // but only if a new press hasn't claimed the pill in the meantime.
    if (recovered === null && stillMine()) showPillResult("error", null, recordingPath, { reason });
    if (!recovered && recordingPath) {
      recordTranscript("", false, recordingPath);
      rebuildTrayMenu();
    }
  });

  // A press started before the previous dictation came back. Its answer is gone
  // (the renderer is closing that socket), so keep the audio: save the clip and
  // log it so the tray can replay or re-transcribe it. Deliberately silent —
  // the live press owns the pill, and ending its session here would be wrong.
  ipcMain.on("dictation:superseded", async (_event, payload) => {
    const chunks = (payload && payload.chunks) || [];
    const recordingPath = await saveTempRecording(chunks, payload && payload.sampleRate);
    dlog("superseded", { saved: !!recordingPath, path: recordingPath || null });
    if (!recordingPath) return;
    recordTranscript("", false, recordingPath);
    rebuildTrayMenu();
  });

  ipcMain.on("dictation:error", (_event, message, gen) => {
    console.error("Dictation error:", message);
    dlog("dictation-error", { message, gen, live: dictation.generation });
    // A newer press owns the session and the pill — log the old error, but
    // don't end the live dictation or paint over its "Listening…".
    if (isStalePress(gen)) return;
    dictation.fail();
    // No audio, no transcript (mic blocked, relay down, offline). Show the
    // reason on the pill so the user knows WHY, not just that it failed.
    showPillResult("error", null, null, { reason: typeof message === "string" ? message : "" });
  });

  // Pill action buttons (success/error states only).
  ipcMain.on("pill:copy", () => {
    if (currentTranscript) {
      clipboard.writeText(currentTranscript);
      dlog("pill-copy", { len: currentTranscript.length });
    }
  });
  ipcMain.on("pill:open", () => {
    if (currentRecordingPath) {
      playRecording(currentRecordingPath);
      dlog("pill-open", { path: currentRecordingPath });
    }
  });
  // "Transcribe again" — force the saved clip back through the batch API. The
  // automatic retry already ran, so this is for a second try after the network
  // came back, or on a clip whose transcript was wrong rather than missing.
  ipcMain.on("pill:retry", () => {
    if (currentRecordingPath) retranscribeOnDemand(currentRecordingPath);
  });
  ipcMain.on("pill:hide", () => hidePill());
  ipcMain.on("pill:add-word", () => openDictionaryWindow());
  // Pointer entered/left the visible pill (renderer detects it from the
  // forwarded mouse moves). On=real clicks land; off=back to forward-only.
  ipcMain.on("pill:set-interactive", (_event, on) => {
    if (!pillWindow || pillWindow.isDestroyed()) return;
    if (on) pillWindow.setIgnoreMouseEvents(false);
    else pillWindow.setIgnoreMouseEvents(true, { forward: true });
  });

  // Cursor "add to dictionary?" pop-up actions.
  ipcMain.on("vocab:add", (_event, term) => {
    const added = vocab.addTerm(term);
    dlog("vocab-add", { term, added });
    hideVocab();
  });
  ipcMain.on("vocab:dismiss", (_event, term) => {
    vocab.dismissTerm(term);
    dlog("vocab-dismiss", { term });
    hideVocab();
  });

  // Dictionary manager window (request/response — each returns the updated list).
  ipcMain.handle("vocab:list", () => vocab.getTerms());
  ipcMain.handle("vocab:add-many", (_event, text) => {
    const parts = (Array.isArray(text) ? text : String(text || "").split(/[,\n]/));
    let added = 0, duplicate = 0, tooLong = 0;
    for (const part of parts) {
      // addTermResult owns validation (collapse-then-length, normalize), so the
      // counts match what actually happened: an "invalid" entry (blank or
      // punctuation-only) is skipped silently rather than miscounted.
      switch (vocab.addTermResult(part)) {
        case "added": added++; break;
        case "duplicate": duplicate++; break;
        case "too-long": tooLong++; break;
      }
    }
    dlog("vocab-add-many", { added, duplicate, tooLong });
    return { added, duplicate, tooLong, terms: vocab.getTerms() };
  });
  ipcMain.handle("vocab:remove", (_event, term) => {
    vocab.removeTerm(term);
    dlog("vocab-remove", { term });
    return vocab.getTerms();
  });

  // Settings window (request/response). get returns the current view; save
  // writes the .env, applies the change live, and returns the fresh view.
  ipcMain.handle("settings:get", () => settingsView(process.env));
  // Activity tab: words/time-saved/streak + recent dictations from history.json.
  ipcMain.handle("stats:get", () => computeStats(getHistory(), Date.now()));
  ipcMain.handle("settings:save", async (_event, payload) => {
    const patch = patchFromView(payload || {});
    try {
      writeEnvFile(envPath, patch);
    } catch (err) {
      const error = "Couldn't save your settings. Check that GVoice can write to its settings folder, then try again.";
      console.error("[main] settings write failed:", err && err.message);
      return { error };
    }
    await applyEnvPatchLive(patch, "settings-save");
    return settingsView(process.env);
  });

  // --- On-device engine setup: probe → download+benchmark → apply ---------
  // The settings window's "speech engine" panel drives these. The benchmark is
  // the real decision-maker (a hardware guess is unreliable), so local is only
  // ever kept after it measurably beats the cloud — or the user opts in anyway.
  //
  // Where the engine binaries come from differs by platform, and that is the
  // ONLY difference — the model download, the speed test and the apply step are
  // already cross-platform:
  //   Windows — downloaded on demand into BIN_DIR by ensureWindowsBinaries.
  //   macOS   — Homebrew's whisper-cpp (ships whisper-cli AND whisper-server),
  //             installed once by the user; we only locate it.
  //   Linux   — not wired up.
  ipcMain.handle("engine:probe", () => {
    const probe = probeCapability();
    const local = localEngineState();
    return {
      probe,
      suggestion: suggestBeforeBenchmark(probe),
      models: MODELS,
      recommendedModel: recommendedAssets(probe).model,
      currentProvider: (process.env.STT_PROVIDER || "openai").toLowerCase(),
      currentModel: process.env.WHISPER_MODEL ? basename(process.env.WHISPER_MODEL) : "",
      platform: process.platform,
      localEngine: local.state,
      localEngineHint: local.state === "install"
        ? LOCAL_ENGINE_INSTALL_HINT
        : (local.state === "ready" && !local.server ? LOCAL_ENGINE_NO_SERVER_HINT : "")
    };
  });

  ipcMain.handle("engine:benchmark", async (event, payload) => {
    // Single-flight: the Settings window's disabled-button guard dies with the
    // window. A second concurrent run would stream into the same .part file
    // and rename a corrupt model into place — which then passes the
    // "already downloaded" size check forever.
    if (benchmarkInFlight) {
      return { ok: false, error: "A speed test is already running — give it a moment to finish." };
    }
    benchmarkInFlight = true;
    const probe = probeCapability();
    const modelName = (payload && payload.model) || recommendedAssets(probe).model;
    const variant = recommendedAssets(probe).variant; // cuda for NVIDIA, else cpu
    const send = (stage, extra = {}) => {
      try { event.sender.send("engine:progress", { stage, ...extra }); } catch {}
    };
    try {
      // 1) Engine binaries. Windows downloads them (the CUDA build is a 700 MB
      // pull — say so up front instead of surprising a metered connection);
      // macOS uses the Homebrew install, which we only have to locate.
      let bin;
      if (process.platform === "win32") {
        const zipMB = WINDOWS_BINARY_ZIPS[variant] ? WINDOWS_BINARY_ZIPS[variant].sizeMB : "?";
        send(`Getting the on-device engine ready (${zipMB} MB download if not yet installed)…`);
        bin = await ensureWindowsBinaries(variant, BIN_DIR, {
          onProgress: (p) => send(`Downloading the on-device engine (${zipMB} MB)…`, p)
        });
      } else {
        const local = localEngineState();
        if (local.state !== "ready") {
          throw new Error(local.state === "install"
            ? LOCAL_ENGINE_INSTALL_HINT
            : "The on-device engine isn't available on this platform yet — use a cloud engine.");
        }
        bin = local.bin;
      }
      // 2) The speech model (only downloaded if missing).
      const sizeMB = MODELS[modelName] ? MODELS[modelName].sizeMB : "?";
      send(`Downloading the speech model (${sizeMB} MB)…`);
      // Note whether this test is about to fetch the model, so a "keep cloud"
      // answer can put the disk back the way it found it.
      if (!existsSync(join(MODELS_DIR, modelName))) benchDownloadedModels.add(join(MODELS_DIR, modelName));
      const model = await ensureModel(modelName, MODELS_DIR, {
        onProgress: (p) => send(`Downloading the speech model (${sizeMB} MB)…`, p)
      });
      // 3) The real, timed speed test on this hardware.
      send("Testing speed on your computer…");
      const verdict = await runLocalBenchmark({ bin, model, onStage: (m) => send(m) });
      dlog("engine-benchmark", { modelName, variant, elapsedMs: verdict.elapsedMs, fastEnough: verdict.fastEnough });
      return { ok: true, verdict, modelName };
    } catch (err) {
      console.error("[main] engine benchmark failed:", err && err.message);
      return { ok: false, error: (err && err.message) || "The speed test couldn't run." };
    } finally {
      benchmarkInFlight = false;
    }
  });

  // Commit the user's choice: which engine to use (and, for local, which model).
  ipcMain.handle("engine:apply", async (_event, payload) => {
    const provider = (payload && payload.provider) || "deepgram";
    // Defense-in-depth: the renderer is trusted local content, but this value is
    // persisted to .env and (for the model) becomes a child-process arg — keep
    // both to known allow-lists so a stray value can't point the engine elsewhere.
    if (!VALID_PROVIDERS.has(provider)) return { error: "Unknown engine." };
    // Going (or staying) cloud: bin the model the speed test just downloaded.
    // Going local keeps it — it's about to be the engine. The "stop tracking it"
    // half waits until after the checks below: an apply that bails out (or one
    // that keeps a hand-edited off-list model) leaves the download unused, and
    // forgetting it here would strand up to 1 GB with no UI to remove it.
    if (provider !== "whisper-local") dropUnusedBenchModels();
    /** @type {Record<string,string>} */
    const patch = { STT_PROVIDER: provider };
    if (provider === "whisper-local" && payload && payload.modelName) {
      // modelName must be a bare allow-listed model key (this also rejects any
      // path separator / "../" traversal, since those are never MODELS keys).
      // Object.hasOwn, not a bracket truthy-check: a bare key like "constructor"
      // would otherwise resolve up the prototype chain and slip the gate.
      if (!Object.hasOwn(MODELS, payload.modelName)) {
        return { error: "Unknown speech model." };
      }
      const modelPath = join(MODELS_DIR, payload.modelName);
      // Never write a config pointing at a model that isn't on disk — a failed
      // download would otherwise brick every dictation until re-setup.
      if (!existsSync(modelPath)) {
        return { error: "That speech model isn't downloaded yet — run the speed test first." };
      }
      patch.WHISPER_MODEL = modelPath;
      // Always an ABSOLUTE path: a Finder-launched .app inherits none of your
      // shell's PATH, so a bare "whisper-cli" works in dev and dies installed.
      if (process.platform === "win32") {
        patch.WHISPER_BIN = join(BIN_DIR, "whisper-cli.exe");
      } else {
        // macOS/Linux: whisper.cpp comes from the system (Homebrew, or a
        // self-build). Pin the absolute path when we can find it; if we can't,
        // leave WHISPER_BIN unset so the existing PATH default still carries a
        // working install rather than blocking it. On a Mac that IS the guided
        // path, so say what's missing instead of writing a config that fails.
        const cli = findInstalledWhisperCli();
        if (cli) patch.WHISPER_BIN = cli;
        else if (process.platform === "darwin") return { error: LOCAL_ENGINE_INSTALL_HINT };
      }
    }
    // Past every check: only the model actually becoming the engine is kept. Any
    // OTHER model the user speed-tested to compare stays tracked and gets binned
    // when Settings closes.
    if (patch.WHISPER_MODEL) benchDownloadedModels.delete(patch.WHISPER_MODEL);
    try {
      writeEnvFile(envPath, patch);
    } catch (err) {
      const error = "Couldn't save your speech-engine choice. Check that GVoice can write to its settings folder, then try again.";
      console.error("[main] engine apply write failed:", err && err.message);
      return { error };
    }
    await applyEnvPatchLive(patch, "engine-apply");
    return settingsView(process.env);
  });
  // Delete every saved recording (the privacy "wipe my voice clips" button).
  ipcMain.handle("settings:clear-recordings", async () => {
    if (!recordingsDir) return 0;
    const removed = await clearRecordings(recordingsDir);
    dlog("recordings-cleared", { removed });
    rebuildTrayMenu();
    return removed;
  });

  // The renderer lost the microphone (disconnected, muted, seized by another
  // app, or silent for several holds in a row) and rebuilt its capture. Make
  // the failure visible instead of silently typing nothing.
  ipcMain.on("dictation:mic-warning", (_event, message, gen) => {
    console.error("[main] mic warning:", message);
    dlog("mic-warning", { message, gen, live: dictation.generation });
    // The mic really is unhappy either way, so the notification always fires.
    // The pill and the session belong to whichever press is live: a warning
    // stamped with an older press must not kill it.
    showMicWarning(message);
    if (isStalePress(gen)) return;
    dictation.fail();
    // Show the reason ON the pill (not just a system notification the user may
    // have muted) so a dead-mic rebuild visibly says "press and try again"
    // instead of a bare red dot. Keep the throttled notification as a backup.
    showPillResult("error", null, null, { reason: message });
  });

  // The renderer healed the mic on its own — drop the warning so the user isn't
  // left staring at a stale "check your microphone" pill, and reset the
  // escalation ladder so the next dead-mic episode starts fresh.
  ipcMain.on("dictation:mic-recovered", () => {
    console.error("[main] mic recovered (auto)");
    dlog("mic-recovered", {});
    recoveryReloadedAt = 0;
    everHadLiveMic = true;
    try { hidePill(); } catch {}
  });

  // The renderer tried hard to find a live mic and couldn't. Escalate, cheapest
  // first: reload the hidden renderer (fresh AudioContext); if that already
  // happened this episode and the mic is STILL dead, the audio service itself is
  // wedged — only a full relaunch respawns it. Guarded so neither step can loop.
  ipcMain.on("dictation:escalate-recovery", (_event, reason) => {
    handleRecoveryEscalation(typeof reason === "string" ? reason : "recovery");
  });
}

// Escalation ladder state. recoveryReloadedAt marks the renderer reload for the
// current dead-mic episode (cleared on recovery); lastAutoRelaunchAt rate-limits
// the heavy last-resort relaunch.
let recoveryReloadedAt = 0;
// Whether a live mic has worked at all this session. Gates the heavy relaunch
// rung: if the mic never once worked, relaunching won't conjure hardware — it'd
// just boot-loop. Relaunch targets the "was working, then the audio service
// wedged" case, which a restart actually fixes.
let everHadLiveMic = false;
// Survive the cooldown across an auto-relaunch: a fresh process would reset an
// in-memory counter to 0 and could relaunch-loop if the mic is genuinely gone.
// The relaunch carries its timestamp in argv so the restarted instance still
// rate-limits itself.
let lastAutoRelaunchAt = (() => {
  const arg = process.argv.find((a) => a.startsWith("--mic-relaunch-at="));
  const ts = arg ? Number(arg.split("=")[1]) : 0;
  return Number.isFinite(ts) ? ts : 0;
})();
const RECOVERY_EPISODE_MS = 120000;   // a fresh escalation after this = new episode
const AUTO_RELAUNCH_COOLDOWN_MS = 300000; // never auto-relaunch more than once / 5 min

function handleRecoveryEscalation(reason) {
  const now = Date.now();
  dlog("recovery-escalate", { reason });
  // First escalation of this episode → reload the renderer. Cheap and invisible:
  // a brand-new renderer + AudioContext, which re-probes for a live device on
  // load. Reuses the shared audio helper process, so if THAT is the wedge this
  // won't help — which is exactly what the relaunch step below is for.
  if (!recoveryReloadedAt || now - recoveryReloadedAt > RECOVERY_EPISODE_MS) {
    recoveryReloadedAt = now;
    console.error("[main] mic recovery → reloading dictation renderer");
    reloadDictationWindow();
    return;
  }
  // Reload already tried this episode and the mic is still dead. The audio
  // service is wedged; a full relaunch respawns it. Two guards keep this from
  // becoming a restart loop: it must have worked at least once this session
  // (else there's no wedge to clear, only missing hardware), and it's rate-
  // limited (the timestamp survives the relaunch via argv).
  if (!everHadLiveMic) {
    console.error("[main] mic recovery → relaunch skipped (mic never worked this session)");
    showMicWarning("GVoice can't find a working microphone. Open System Settings → Sound → Input and pick one.");
    return;
  }
  if (now - lastAutoRelaunchAt < AUTO_RELAUNCH_COOLDOWN_MS) {
    console.error("[main] mic recovery → relaunch suppressed (cooldown)");
    showMicWarning("GVoice can't reach your microphone. Open System Settings → Sound → Input, pick your mic, then try again.");
    return;
  }
  lastAutoRelaunchAt = now;
  console.error("[main] mic recovery → relaunching app to clear wedged audio");
  dlog("auto-relaunch", { reason });
  try {
    if (Notification.isSupported()) {
      new Notification({ title: "GVoice", body: "Restarted to fix the microphone — give it a second." }).show();
    }
  } catch {}
  // Carry the relaunch timestamp into the next process so its cooldown holds
  // (drop any stale flag first so the arg list can't grow on repeat relaunches).
  const args = process.argv.slice(1).filter((a) => !a.startsWith("--mic-relaunch-at="));
  args.push("--mic-relaunch-at=" + now);
  app.relaunch({ args });
  app.exit(0);
}

const cleanupWarnings = new Set();

// Tell the user their cleanup engine is down. Once per DISTINCT message, not
// once per app run: a single latch meant the first hiccup of the session ate
// the only notification, so weeks later — engine genuinely dead, every call
// failing — the user got nothing. Keyed by message, so each kind of failure
// still says itself once and a repeat can't spam. The dictation lands either
// way (raw), so this is information, not an interruption.
// Pass null (the no-error case) and this does nothing.
function showCleanupWarning(/** @type {string | null} */ message) {
  if (!message || cleanupWarnings.has(message)) return;
  cleanupWarnings.add(message);
  console.error("[main] cleanup warning:", message);
  dlog("cleanup-warning", message);
  try {
    if (Notification.isSupported()) {
      new Notification({ title: "GVoice — cleanup is off", body: message }).show();
    }
  } catch (err) {
    console.error("[main] cleanup-warning notification failed:", err && err.message);
  }
  try { tray?.displayBalloon?.({ title: "GVoice — cleanup is off", content: message }); } catch {}
}

let lastMicWarningAt = 0;

// Surface a microphone problem to the user. Throttled so a burst of silent
// holds can't spam the notification center.
function showMicWarning(/** @type {string} */ message) {
  const now = Date.now();
  if (now - lastMicWarningAt < 10000) return;
  lastMicWarningAt = now;
  try {
    if (Notification.isSupported()) {
      new Notification({ title: "GVoice — check your microphone", body: message }).show();
    }
  } catch (err) {
    console.error("[main] mic-warning notification failed:", err && err.message);
  }
  // Windows tray balloon as a secondary channel (no-op on macOS).
  try { tray?.displayBalloon?.({ title: "GVoice — check your microphone", content: message }); } catch {}
}

// Rebuild the mic pipeline proactively when the machine wakes. Sleep/wake (and
// screen unlock) is exactly when the macOS capture stream goes dead and starts
// delivering pure silence — so instead of waiting for the FIRST post-sleep
// dictation to be the silent one that trips recovery, we tell the renderer to
// rebuild the moment we wake. Wired once.
let powerMonitorWired = false;
function setupPowerMonitor() {
  if (powerMonitorWired) return;
  powerMonitorWired = true;
  const rebuild = (/** @type {string} */ reason) => {
    dlog("power", reason);
    // The menu-bar icon sometimes drops during sleep/wake — and with no window,
    // a missing icon means no way back into the app. The Tray object usually
    // isn't destroyed when the icon vanishes (it's held in a module var), so a
    // destroyed-check alone wouldn't fire — re-assert the image unconditionally
    // to force a redraw, and only fully recreate if the object is actually gone.
    // Log the real state so a future occurrence is diagnosable instead of guessed.
    try {
      const state = tray ? (tray.isDestroyed() ? "destroyed" : "alive") : "null";
      dlog("tray-state-on-wake", { reason, state });
      if (!tray || tray.isDestroyed()) {
        createTray();
        console.error("[main] tray recreated after " + reason + " (was " + state + ")");
      } else {
        tray.setImage(makeTrayIcon());
      }
    } catch (err) {
      console.error("[main] tray re-assert failed:", err && err.message);
    }
    if (dictationWindow && !dictationWindow.isDestroyed()) {
      dictationWindow.webContents.send("dictation:rebuild-capture", reason);
    }
  };
  powerMonitor.on("resume", () => rebuild("resume"));
  powerMonitor.on("unlock-screen", () => rebuild("unlock-screen"));
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  // Left-click starts the mic, left-click again stops it and pastes — the
  // no-keyboard way to dictate. Right-click (or control-click, which macOS
  // reports as a left click with ctrlKey set) opens the menu with Quit in it.
  tray.on("click", (/** @type {import("electron").KeyboardEvent} */ event) => {
    if (event && event.ctrlKey) { if (trayMenu) tray?.popUpContextMenu(trayMenu); return; }
    if (trayHolding) { fireRelease("tray"); return; }
    if (startDictation(CLICK_MAX_HOLD_MS)) { trayHolding = true; return; }
    // Nothing to record — the renderer is gone, or the last dictation is still
    // transcribing. A click that does nothing looks like a dead app, and with no
    // dock icon and no window the menu is the only way to reach Quit or Settings.
    if (trayMenu) tray?.popUpContextMenu(trayMenu);
  });
  // Read trayMenu at click time, not capture it — rebuildTrayMenu replaces it
  // after every dictation.
  tray.on("right-click", () => { if (trayMenu) tray?.popUpContextMenu(trayMenu); });
  updateTrayTooltip();
  rebuildTrayMenu();
}

// The "Recent dictations" submenu changes after every dictation, and Electron
// tray menus are static once set — so the whole menu is rebuilt on demand.
function rebuildTrayMenu() {
  if (!tray) return;

  // One row per saved dictation, newest first: time + a preview. Each opens a
  // submenu to copy the text or play the recording (whichever exists). A failed
  // attempt has no text — only the recording to listen back to.
  const history = getHistory();
  const historyItems = history.map((entry) => {
    const time = new Date(entry.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    // Newlines break NSMenu labels (display cuts at the first one) — flatten.
    const flat = (entry.text || "").replace(/\s+/g, " ").trim();
    const preview = flat
      ? (flat.length > 60 ? flat.slice(0, 60) + "…" : flat)
      : "(no transcript — recording only)";
    const hasRecording = !!entry.recordingPath && existsSync(entry.recordingPath);
    /** @type {import("electron").MenuItemConstructorOptions[]} */
    const sub = [];
    // The ⚠ on the parent row needs a legend — say what it means right where
    // the user looks for the text.
    if (!entry.pasted) sub.push({ label: "⚠ Wasn't pasted into any app", enabled: false });
    if (flat) sub.push({ label: "Copy text", click: () => clipboard.writeText(entry.text) });
    sub.push({
      label: hasRecording ? "Play recording" : "Recording unavailable",
      enabled: hasRecording,
      click: () => playRecording(entry.recordingPath || null)
    });
    // Force the saved audio back through transcription — the way to rescue a
    // dictation whose words never arrived (or arrived wrong) at the time.
    if (hasRecording) {
      sub.push({
        label: "Transcribe again",
        click: () => retranscribeOnDemand(entry.recordingPath || null)
      });
    }
    return {
      label: `${time}${entry.pasted ? "" : " ⚠"}  ${preview}`,
      submenu: sub
    };
  });

  // The newest saved recording, for the one-click "play my last attempt" item.
  const lastRecording = history.find((e) => e.recordingPath && existsSync(e.recordingPath));

  const menu = Menu.buildFromTemplate([
    // Only present when macOS refused the key hook. First item in the menu
    // because nothing else in the app works until it's dealt with.
    ...(hotkeyNeedsAccessibility ? [
      { label: "⚠ Dictation key blocked — needs permission", enabled: false },
      {
        label: "Allow GVoice in Accessibility…",
        click: () => openAccessibilitySettings()
      },
      { type: /** @type {const} */ ("separator") }
    ] : []),
    // Same placement, for the hook that started and then heard nothing: the
    // fix is either to relaunch from Finder or to grant the launcher the
    // permission, so offer the pane here too.
    ...(hotkeyDeaf && !hotkeyNeedsAccessibility ? [
      { label: "⚠ Not hearing your keyboard — open from Finder", enabled: false },
      {
        label: "Open Accessibility settings…",
        click: () => openAccessibilitySettings()
      },
      { type: /** @type {const} */ ("separator") }
    ] : []),
    {
      label: "Recent dictations",
      enabled: historyItems.length > 0,
      submenu: [
        ...historyItems,
        { type: /** @type {const} */ ("separator") },
        {
          label: "Open history file…",
          click: () => { const p = getHistoryPath(); if (p) shell.showItemInFolder(p); }
        }
      ]
    },
    {
      label: "Play last recording",
      enabled: !!lastRecording,
      click: () => {
        playRecording((lastRecording && lastRecording.recordingPath) || null);
      }
    },
    {
      label: "Transcribe last recording again",
      enabled: !!lastRecording,
      click: () => {
        retranscribeOnDemand((lastRecording && lastRecording.recordingPath) || null);
      }
    },
    { type: "separator" },
    // Engine-room jargon that opened a leftover dev page — dev runs only.
    ...(VERBOSE ? [{
      label: serverPort ? `Relay: http://127.0.0.1:${serverPort}` : "Relay: not running",
      enabled: !!serverPort,
      click: () => { if (serverPort) shell.openExternal(`http://127.0.0.1:${serverPort}`); }
    }] : []),
    {
      label: "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (/** @type {import("electron").MenuItem} */ item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      }
    },
    {
      // Manual mic recovery without touching a terminal: forces the renderer to
      // probe for a live input and rebind. The app heals itself automatically,
      // but this is here for reassurance / the rare case it's still acting up.
      label: "Restart microphone",
      click: () => {
        if (dictationWindow && !dictationWindow.isDestroyed()) {
          dictationWindow.webContents.send("dictation:rebuild-capture", "manual");
        }
      }
    },
    {
      // Open the dictionary manager: add the names/made-up words the engine
      // should spell exactly, and review or remove existing ones.
      label: "Manage dictionary…",
      click: () => openDictionaryWindow()
    },
    {
      // Engine, language, cleanup, API keys, and recording privacy.
      label: "Settings…",
      click: () => openSettingsWindow()
    },
    {
      // Delete the saved voice clips on disk (privacy). Enabled whenever the
      // folder exists — clips can linger on disk even when none are in the
      // (capped, in-memory) history, and the wipe should still reach them.
      label: "Clear recordings",
      enabled: !!recordingsDir,
      click: async () => {
        if (!recordingsDir) return;
        // One stray click otherwise wipes every saved clip — including the one
        // backing a dictation that hasn't been recovered yet. Confirm first.
        const { response } = await dialog.showMessageBox({
          type: "warning",
          buttons: ["Delete", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: "Delete all saved recordings?",
          detail: "You won't be able to recover a dictation that didn't land."
        });
        if (response !== 0) return;
        await clearRecordings(recordingsDir);
        rebuildTrayMenu();
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  trayMenu = menu;
}

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  /** @type {import("electron").MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: /** @type {import("electron").MenuItemConstructorOptions[]} */ ([
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            {
              label: "Quit GVoice",
              accelerator: "Cmd+Q",
              click: () => { isQuitting = true; app.quit(); }
            }
          ])
        }]
      : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Bring up the live dictation machinery: the pill, the vocab pop-up, the hidden
// dictation renderer, and the global hotkey. Idempotent — guarded so the
// first-run "save your key" path can call it after the relay finally boots
// without double-creating windows. `onReady` fires once the dictation renderer
// has loaded and the hotkey is armed.
let dictationBroughtUp = false;
async function bringUpDictation(onReady) {
  if (!serverPort) return;
  if (dictationBroughtUp) { onReady?.(!hotkeyFailed); return; }
  dictationBroughtUp = true;
  createPillWindow();
  createVocabWindow();
  createDictationWindow();
  setupPowerMonitor();
  if (!dictationWindow) return;
  dictationWindow.webContents.once("did-finish-load", async () => {
    const hotkeyOk = await setupHotkey();
    onReady?.(hotkeyOk);
  });
}

// Reload the hidden dictation renderer pointed at the current provider. The
// provider is carried in the URL query and read once at renderer load, so a
// Settings change to the engine takes effect by reloading (the hotkey closures
// reference the module-level dictationWindow, so they keep working). No-op if
// the window isn't up yet.
function reloadDictationWindow() {
  if (!serverPort || !dictationWindow || dictationWindow.isDestroyed()) return;
  dictationWindow.loadURL(dictationUrl());
}

// Apply an already-written .env patch to the LIVE app without a restart: mirror
// it into process.env, then boot the relay (first run) or reload the dictation
// window (provider switch) so the next dictation honors it. Shared by
// settings:save and engine:apply so both take effect identically.
async function applyEnvPatchLive(patch, source) {
  const prevProvider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  // Everything the dictation renderer reads once at load must be compared here:
  // without a reload the new value does nothing until the app is restarted.
  const prevUrl = serverPort ? dictationUrl() : "";
  for (const [key, value] of Object.entries(patch)) process.env[key] = value;
  const newProvider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  dlog(source, { keys: Object.keys(patch), providerChanged: newProvider !== prevProvider });

  if (!serverPort) {
    // First-run path: the relay never booted (no key at launch). Now that a key
    // may be present, try again and bring dictation fully up.
    await bootRelayServer();
    if (serverPort) await bringUpDictation();
  } else if (dictationUrl() !== prevUrl) {
    reloadDictationWindow();
  }
  // A speed test (or an on-device setup the user then abandoned) can leave a
  // whisper-server warm, keeping the model resident in RAM/VRAM for the rest of
  // the session. Once we're committed to a cloud engine, reclaim it. Idempotent:
  // a no-op when nothing is running, and skipped on the on-device path.
  if (newProvider !== "whisper-local" && newProvider !== "local") {
    try { stopWhisperServer(); } catch {}
  }
  updateTrayTooltip();
  rebuildTrayMenu();
}

// First-run / misconfiguration check: returns a short, plain-English reason the
// app can't dictate yet (no .env, or the active engine's key/model is missing),
// or null when everything needed is present. Drives the auto-opened Settings
// window so a fresh install guides the user instead of silently doing nothing.
function needsOnboarding() {
  if (!existsSync(envPath)) {
    return "Welcome to GVoice. Add your speech engine details below to start dictating.";
  }
  const provider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    return "Add your OpenAI API key to start dictating.";
  }
  // Deepgram is deliberately NOT checked: the relay ships a fallback key
  // (realtime-relay.js DEEPGRAM_FALLBACK_KEY), so a blank DEEPGRAM_API_KEY
  // still dictates. Asking for a key here would nag on every single launch
  // about a problem the user doesn't have.
  if ((provider === "whisper-local" || provider === "local") &&
      !(process.env.WHISPER_MODEL && existsSync(process.env.WHISPER_MODEL))) {
    return "Point GVoice at a local Whisper model file to dictate offline.";
  }
  return null;
}

app.whenReady().then(async () => {
  // Defense-in-depth navigation lockdown. Every window today loads only bundled
  // app HTML or the loopback relay, so nothing here triggers — but if a future
  // change ever rendered remote or transcript-derived markup, this stops a
  // window from navigating itself off-origin or spawning a popup. (Registered
  // before any window is created so it catches all of them.)
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      const local = url.startsWith("file://") ||
        url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:");
      if (!local) event.preventDefault();
    });
  });

  // The very first thing on screen: a branded splash, not a terminal or a bare
  // window. It reports boot progress and later tucks itself into the tray.
  createSplashWindow();
  setSplashStatus("Starting up…");

  // Headless tray app — Electron's "no windows" default behaviour would quit
  // the process otherwise. The pill/dictation windows come and go; we want
  // the tray to stay live regardless.
  if (process.platform === "darwin") {
    app.dock?.hide();
  }
  // Recent recordings live here. The pill's "Open recording" button and the
  // tray's "Play recording" / "Play last recording" items open them, so they
  // persist across restarts (the last MAX_RECORDINGS clips are kept, older ones
  // pruned as new ones are saved — see saveTempRecording). Created if missing.
  recordingsDir = join(app.getPath("userData"), "temp-recordings");
  await mkdirAsync(recordingsDir, { recursive: true }).catch(() => {});
  // Enforce the count + age caps at boot too, so clips that aged out while the
  // app was closed (or a freshly-lowered retention setting) are cleared now, not
  // only as new recordings are saved.
  await pruneRecordings(recordingsDir, { maxCount: MAX_RECORDINGS, maxAgeMs: recordingMaxAgeMs() }).catch(() => {});
  // Custom dictionary lives in userData so it survives reinstalls/updates and
  // isn't bundled into the read-only app. The providers read it on every
  // connection; the cursor pop-up writes to it.
  vocab.init(join(app.getPath("userData"), "custom-vocab.json"));
  // Last-50 dictation history, persisted across restarts; shown in the tray's
  // "Recent dictations" menu. Loaded before the tray builds its first menu.
  await initHistory();

  setSplashStatus("Getting things ready…");
  await bootRelayServer();
  buildAppMenu();
  createTray();
  setupIpc();

  // First run / misconfiguration: guide the user to Settings instead of silently
  // doing nothing. The tray stays live either way.
  const onboard = needsOnboarding();

  if (serverPort) {
    setSplashStatus("Connecting to your speech engine…");
    // Backstop: if the dictation window's load never completes (relay route
    // hangs, renderer crash), still tuck the splash away instead of leaving it
    // pinned on screen. The normal ready path below fires well before this.
    setTimeout(dismissSplashToTray, 9000);
    await bringUpDictation((hotkeyOk) => {
      // Fully live now: flip the splash to its "ready" look, let it land for a
      // beat, then animate it down into the tray and disappear. If the hotkey
      // failed to arm, say THAT instead of a false "Ready".
      if (hotkeyOk === false) {
        setSplashStatus("The dictation key couldn't start — quit GVoice and reopen it.", "error");
        setTimeout(dismissSplashToTray, 4500);
        return;
      }
      const holdKey = process.platform === "darwin" ? "right Option" : "Ctrl+Shift";
      setSplashStatus(`Ready — hold ${holdKey} to dictate.`, "ready");
      setTimeout(dismissSplashToTray, 650);
    });
  } else {
    // Relay couldn't start (usually a missing API key). Surface it on the
    // splash instead of failing silently, then tuck it away — the tray stays.
    // serverError is raw Node text (EADDRINUSE etc.) — keep that in the log,
    // show plain words on screen.
    if (serverError) dlog("boot-error", serverError);
    setSplashStatus(
      onboard || (serverError
        ? "Couldn't start — another copy of GVoice may be running. Quit it and reopen."
        : "Couldn't start. Check your settings."),
      onboard ? "loading" : "error"
    );
    setTimeout(dismissSplashToTray, onboard ? 1800 : 4500);
  }

  // Open Settings on first run (or when the active engine is missing its key /
  // model) so a fresh install isn't a dead end. Saving a working key there boots
  // the relay and brings dictation up without a restart (see settings:save).
  if (onboard) openSettingsWindow({ firstRun: true, reason: onboard });

  // Prewarm the typing module at startup. prewarmTyping() returns immediately on
  // the native-paste platforms in clipboard mode (paste is a native keystroke —
  // no nut-js), so this only pays the ~300ms nut-js import up front where it's
  // actually used: Linux, or anywhere TYPE_VIA_CLIPBOARD=false.
  import("./src/typing.js").then((m) => m.prewarmTyping()).catch(() => {});

  // Warm whisper-server at boot so the first dictation doesn't pay the model
  // load cost — and so any server orphaned by a previous crash is reaped now,
  // not on the first dictation. One retry covers a transient spawn hiccup;
  // after that the per-dictation path still falls back to whisper-cli.
  const provider = (process.env.STT_PROVIDER || "openai").toLowerCase();
  if (provider === "whisper-local" || provider === "local") {
    const bin = process.env.WHISPER_BIN || process.env.WHISPER_CLI || "whisper-cli";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await ensureWhisperServer(bin);
        dlog("whisper", "warmed at boot");
        console.error("[main] whisper-server warmed at boot");
        break;
      } catch (err) {
        dlog("whisper", "warm attempt " + attempt + " failed: " + (err && err.message));
        console.error("[main] whisper warm attempt " + attempt + " failed:", err && err.message);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

// Shut everything this app started back down: hotkey listener, correction
// watcher, and the local whisper-server (so the model never lingers in memory
// after the app is closed). Synchronous so it completes even if the app exits
// immediately after.
function shutdownAll() {
  if (maxHoldTimer) { clearTimeout(maxHoldTimer); maxHoldTimer = null; }
  stopHookWatchdog();
  if (hotkeyEngine && typeof hotkeyEngine.stop === "function") {
    try { hotkeyEngine.stop(); } catch {}
  }
  try { correctionWatcher.stop(); } catch {}
  try { stopWhisperServer(); } catch {}
}

app.on("before-quit", () => {
  isQuitting = true;
  shutdownAll();
});

// Terminal-launched runs (dev / debugging) don't get 'before-quit' on Ctrl-C or
// a kill — tear down the whisper-server here too so no orphan is left behind.
for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.on(sig, () => {
    shutdownAll();
    app.quit();
    // If the event loop is already unwinding, make sure we actually exit.
    setTimeout(() => process.exit(0), 300).unref?.();
  });
}
