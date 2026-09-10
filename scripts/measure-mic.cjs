// Baseline timing for "press to first audio" and for the paste that ends a
// dictation. Runs under the repo's own Electron, in a hidden window, with its
// own data folder — it never touches the installed app.
//
// Press-to-first-audio is measured two ways, because the app has two states:
//   cold  — no capture graph yet: open the mic, build the AudioContext, load the
//           worklet, connect, wait for the first batch of samples.
//   warm  — the graph is already alive (what "Always ready" will make normal):
//           flip the recording flag and wait for the next batch.
// The graph is built exactly the way public/dictation.js builds it.
//
// Paste duration is the real path from src/typing.js: the 80 ms release delay,
// the clipboard write, and the osascript ⌘V round trip. Pass --paste to include
// it; without the flag the keystroke is skipped (it would land in whatever
// window is in front).
//
// Run: npx electron scripts/measure-mic.cjs [runs] [--paste]
const { app, BrowserWindow, clipboard, ipcMain, systemPreferences } = require("electron");
const { execFile } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const RUNS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 10);
const DO_PASTE = process.argv.includes("--paste");
const PUBLIC = path.join(__dirname, "..", "public");
const RELEASE_DELAY_MS = 80; // src/typing.js

function median(list) {
  const s = [...list].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const PAGE = `<!doctype html><meta charset="utf-8"><body><script type="module">
const RUNS = ${RUNS};
const targetSampleRate = 16000;
let ctx = null, stream = null, source = null, node = null, mute = null, workletLoaded = false;
let onFrame = null;

async function build() {
  ctx = ctx || new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  stream = await navigator.mediaDevices.getUserMedia({ audio: {
    channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  if (!workletLoaded) { await ctx.audioWorklet.addModule("/audio-capture-worklet.js"); workletLoaded = true; }
  source = ctx.createMediaStreamSource(stream);
  node = new AudioWorkletNode(ctx, "audio-capture-processor", { processorOptions: { outputRate: targetSampleRate, inputGain: 2.5 } });
  mute = ctx.createGain(); mute.gain.value = 0;
  node.port.onmessage = () => { if (onFrame) { const f = onFrame; onFrame = null; f(); } };
  source.connect(node); node.connect(mute); mute.connect(ctx.destination);
}

function teardown(full) {
  try { node && node.disconnect(); } catch {}
  try { source && source.disconnect(); } catch {}
  try { mute && mute.disconnect(); } catch {}
  try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
  node = source = mute = stream = null;
  if (full && ctx) { try { ctx.close(); } catch {} ctx = null; workletLoaded = false; }
}

const nextFrame = () => new Promise((r) => { onFrame = r; });

const cold = [], coldBuild = [], warm = [];
const label = [];
try {
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await build();
    const built = performance.now();
    await nextFrame();
    const first = performance.now();
    coldBuild.push(Math.round(built - t0));
    cold.push(Math.round(first - t0));
    if (!label.length && stream) label.push(stream.getAudioTracks()[0]?.label || "(unknown)");
    teardown(true);
    await new Promise((r) => setTimeout(r, 300));
  }
  await build();
  await nextFrame();
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await nextFrame();
    warm.push(Math.round(performance.now() - t));
  }
  const graphs = ctx ? 1 : 0;
  teardown(true);
  window.measure.done({ cold, coldBuild, warm, label: label[0] || "(unknown)", graphs });
} catch (err) {
  window.measure.fail(String((err && err.stack) || err));
}
</script></body>`;

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/measure.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(PAGE);
  }
  const file = path.join(PUBLIC, url.replace(/^\/+/, ""));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end("no");
  }
  res.writeHead(200, { "content-type": url.endsWith(".js") ? "text/javascript" : "text/plain" });
  res.end(fs.readFileSync(file));
});

function pasteOnce() {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down'],
      { timeout: 4000, killSignal: "SIGKILL" }, (err) => (err ? reject(err) : resolve()));
  });
}

// A small visible window whose text box takes the ⌘V. Pasting into our own
// window keeps the keystroke off whatever the person was actually working in.
async function openPasteTarget() {
  const win = new BrowserWindow({ width: 360, height: 140, title: "GVoice paste measurement" });
  await win.loadURL("data:text/html," + encodeURIComponent(
    '<body style="font:13px system-ui;margin:8px"><p>Measuring paste speed…</p>' +
    '<textarea id="t" style="width:340px;height:60px"></textarea>' +
    '<script>document.getElementById("t").focus()</script></body>'));
  win.focus();
  app.focus({ steal: true });
  await new Promise((r) => setTimeout(r, 800));
  return win;
}

async function measurePaste() {
  const text = " gvoice paste probe";
  const times = [];
  const target = DO_PASTE ? await openPasteTarget() : null;
  if (target) {
    const front = await new Promise((resolve) => {
      execFile("/usr/bin/osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
        (err, out) => resolve(err ? "" : String(out).trim()));
    });
    console.log("paste target frontmost process: " + front);
    if (!/electron/i.test(front)) {
      console.log("PASTE_SKIPPED=our window is not in front (" + front + ") — refusing to type into it");
      target.destroy();
      return null;
    }
  }
  for (let i = 0; i < RUNS; i++) {
    const t = Date.now();
    await new Promise((r) => setTimeout(r, RELEASE_DELAY_MS));
    const previous = clipboard.readText();
    clipboard.writeText(text);
    if (DO_PASTE) {
      try { await pasteOnce(); } catch (err) { console.log("PASTE_ERROR=" + err.message); target && target.destroy(); return null; }
    }
    times.push(Date.now() - t);
    clipboard.writeText(previous);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (target) {
    const landed = await target.webContents.executeJavaScript('document.getElementById("t").value');
    console.log("paste landed characters: " + String(landed).length);
    target.destroy();
  }
  return times;
}

app.commandLine.appendSwitch("use-fake-ui-for-media-stream"); // no permission popup on a hidden window
app.whenReady().then(async () => {
  console.log("MIC_PERMISSION=" + systemPreferences.getMediaAccessStatus("microphone"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, "measure-mic-preload.cjs") } });
  win.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(true));

  const result = await new Promise((resolve) => {
    ipcMain.once("measure:done", (_e, payload) => resolve(payload));
    ipcMain.once("measure:fail", (_e, msg) => resolve({ error: msg }));
    win.loadURL(`http://127.0.0.1:${port}/measure.html`);
  });

  if (result.error) {
    console.log("MIC_MEASURE_FAILED=" + result.error);
  } else {
    console.log("mic device: " + result.label);
    console.log("cold build (getUserMedia+context+worklet+connect) ms: " + result.coldBuild.join(", "));
    console.log("cold press-to-first-audio ms: " + result.cold.join(", "));
    console.log("warm press-to-first-audio ms: " + result.warm.join(", "));
    console.log("MEDIAN_COLD_BUILD_MS=" + median(result.coldBuild));
    console.log("MEDIAN_COLD_PRESS_TO_FIRST_AUDIO_MS=" + median(result.cold));
    console.log("MEDIAN_WARM_PRESS_TO_FIRST_AUDIO_MS=" + median(result.warm));
  }

  const paste = await measurePaste();
  if (paste) {
    console.log("paste ms: " + paste.join(", "));
    console.log("MEDIAN_PASTE_MS=" + median(paste) + (DO_PASTE ? "" : " (clipboard only, no keystroke)"));
  }

  win.destroy();
  server.close();
  app.quit();
});
