// @ts-check
// Boot-time environment setup. Imported FIRST from main.js (before anything
// that reads process.env), so it must have no side effects beyond preparing the
// environment.
//
// Why this exists: a packaged GVoice.app launched from Finder starts with a
// bare PATH and "/" as its working directory — so the Homebrew whisper-server
// binary isn't found, and a cwd-relative ".env" / model path resolves to
// nothing. A dev launch (`electron .` from the repo) already has the right cwd
// and PATH, so for that case everything here is a harmless no-op.
import dotenv from "dotenv";
import { app } from "electron";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, isAbsolute, resolve as resolvePath } from "node:path";

// This module is imported before main.js calls app.setName, so set the name here
// too (idempotent). Without it, app.getPath("userData") below would resolve to
// Electron's default ".../Application Support/Electron" folder, and the packaged
// app would read its config from the wrong place.
app.setName("GVoice");

// GVOICE_USER_DATA redirects EVERY per-user path — debug.log, temp-recordings,
// custom-vocab.json, history.json, the whisper-server PID record, the control
// socket — into a folder of the caller's choosing. scripts/dev-isolated.sh sets
// it so a dev launch shares nothing with the copy in /Applications: without it
// both instances read the same PID file and a dev start reaps the INSTALLED
// app's speech engine out from under the person using it.
//
// This runs before the first app.getPath("userData") in the process (this module
// is main.js's first import) and therefore before `ready`, which is what
// app.setPath requires.
if (process.env.GVOICE_USER_DATA) {
  const wanted = process.env.GVOICE_USER_DATA;
  if (!isAbsolute(wanted)) {
    throw new Error("GVOICE_USER_DATA must be an absolute path, got: " + wanted);
  }
  const dir = resolvePath(wanted);
  mkdirSync(dir, { recursive: true });
  app.setPath("userData", dir);
}

// One resolved value every module can read, including the ones that never import
// electron (src/providers/whisper-local.js runs in the relay, and in the parity
// harness with no app at all). Always set, whether or not GVOICE_USER_DATA was.
process.env.GVOICE_USER_DATA_RESOLVED = app.getPath("userData");

// The dev repo this build was historically pinned to. Kept ONLY to migrate an
// existing install's config (and find a model the user already downloaded) the
// first time this self-contained build runs — never as the live home.
const LEGACY_HOME = "/Users/macmini/dev/voice";

// Where the app's config (.env), the Whisper model, and the downloaded engine
// binaries live. Kept OUTSIDE the app bundle so (a) real API keys never ship
// inside a distributable, and (b) the app can WRITE here — the macOS .app bundle
// is read-only/signed, so a downloaded model must never land inside it.
//
// Dev launch (`electron .` from the repo): HOME = cwd, so the models/ + bin/
// already checked into the repo are used as-is. Packaged launch: HOME =
// per-user data dir (app.getPath('userData') — writable on Windows AND macOS),
// where the first-run downloader drops the model + binaries. GVOICE_HOME
// overrides either.
const USERDATA_HOME = app.getPath("userData");
const HOME = process.env.GVOICE_HOME || (app.isPackaged ? USERDATA_HOME : process.cwd());

// One source of truth for where engine assets live, reused by the on-demand
// downloader (src/model-download.js) and main.js so nothing guesses a path.
export const MODELS_DIR = join(HOME, "models");
export const BIN_DIR = join(HOME, "bin");

// First packaged boot into the new home with no .env yet: migrate the one from
// the old dev-repo location if it's there, so an existing install keeps working
// without the user re-entering their keys. One-time copy — afterwards HOME/.env
// is the single source of truth and the dev repo can be moved or deleted.
if (app.isPackaged && HOME === USERDATA_HOME) {
  const homeEnv = join(HOME, ".env");
  const legacyEnv = join(LEGACY_HOME, ".env");
  if (!existsSync(homeEnv) && existsSync(legacyEnv)) {
    try {
      mkdirSync(HOME, { recursive: true });
      copyFileSync(legacyEnv, homeEnv);
    } catch {}
  }
}

// Finder launches with a minimal PATH. Prepend the dirs the app shells out to
// (Homebrew for whisper-server / whisper-cli) so local Whisper works.
if (process.platform === "darwin") {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"];
  const current = (process.env.PATH || "").split(":").filter(Boolean);
  const missing = extra.filter((dir) => !current.includes(dir));
  if (missing.length) process.env.PATH = [...missing, ...current].join(":");
}

// Load .env from the app home (not cwd), so config is found wherever launched.
// GVOICE_NO_ENV=1 skips this entirely — offline checks (test:unit, test:parity,
// test:pipeline-smoke) set it so a real key or provider setting sitting in a
// developer's .env can never leak into a check that must pass on a bare clone.
const envFile = join(HOME, ".env");
if (process.env.GVOICE_NO_ENV !== "1") {
  if (existsSync(envFile)) dotenv.config({ path: envFile });
  else dotenv.config();
}

// Exported so the rest of the app (main.js, the settings writer) edits the SAME
// .env this loaded — never a cwd-relative guess that misses in a packaged launch.
export const ENV_FILE = envFile;

// Default the Whisper model to an absolute path under HOME if the user hasn't
// pinned one — a cwd-relative "./models/…" would miss in a packaged launch. We
// pick the first model that actually exists from a preference list (the
// multilingual small the repo ships, then the smaller base, then the
// English-only build) so the default tracks whatever the downloader dropped.
// Look in HOME's models first, then the legacy repo — so an existing install
// that kept the model in the old dev repo still finds it. If none exists,
// WHISPER_MODEL stays unset and main.js's onboarding surfaces "point GVoice at
// a model" instead of failing per-dictation.
if (!process.env.WHISPER_MODEL) {
  const candidates = ["ggml-small-q5_1.bin", "ggml-base-q5_1.bin", "ggml-small.en-q5_1.bin"];
  outer:
  for (const base of [MODELS_DIR, join(LEGACY_HOME, "models")]) {
    for (const name of candidates) {
      const model = join(base, name);
      if (existsSync(model)) { process.env.WHISPER_MODEL = model; break outer; }
    }
  }
}

// Same for the whisper-cli binary: prefer the one the downloader placed under
// BIN_DIR; otherwise leave it unset so the PATH-based default (Homebrew on mac,
// system PATH on Windows) still applies.
if (!process.env.WHISPER_BIN) {
  const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const bin = join(BIN_DIR, exe);
  if (existsSync(bin)) process.env.WHISPER_BIN = bin;
}
