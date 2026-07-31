// @ts-check
const { contextBridge, ipcRenderer } = require("electron");

// Which press the renderer is currently working on. Main stamps it into the
// dictation:start profile and every terminal event echoes it back, so a late
// error/failure can be told apart from one belonging to the live press. Kept
// here rather than in dictation.js so no send site can forget it.
let pressGen = 0;

contextBridge.exposeInMainWorld("dictationBridge", {
  sendError: (message) => ipcRenderer.send("dictation:error", message, pressGen),
  sendMicWarning: (message) => ipcRenderer.send("dictation:mic-warning", message, pressGen),
  // The mic healed itself in the background — clear any warning shown to the user.
  sendMicRecovered: () => ipcRenderer.send("dictation:mic-recovered"),
  // Background recovery couldn't find a live mic — ask main to escalate
  // (reload the renderer, then relaunch the app as a last resort).
  requestEscalation: (reason) => ipcRenderer.send("dictation:escalate-recovery", reason),
  // payload is { text, chunks, sampleRate } on a real transcript, or "" for a
  // server-decided empty (silence / hallucination filter).
  sendTranscript: (payload) => ipcRenderer.send("dictation:transcript", payload),
  reportFailure: (payload) => ipcRenderer.send("dictation:failure", payload, pressGen),
  onStart: (callback) => {
    ipcRenderer.on("dictation:start", (_event, profile) => {
      if (profile && typeof profile.gen === "number") pressGen = profile.gen;
      callback(profile);
    });
  },
  onStop: (callback) => {
    ipcRenderer.on("dictation:stop", () => callback());
  },
  // main asks the renderer to rebuild its whole mic pipeline (system wake).
  onRebuildCapture: (callback) => {
    ipcRenderer.on("dictation:rebuild-capture", (_event, reason) => callback(reason));
  }
});
