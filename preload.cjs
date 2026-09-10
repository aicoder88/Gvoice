// @ts-check
const { contextBridge, ipcRenderer } = require("electron");

// Which press the renderer is currently working on. Main issues the name in the
// dictation:start profile and every event sent back echoes it, so a late
// transcript, error or warning can be told apart from one belonging to the live
// press. Kept here rather than in dictation.js so no send site can forget it.
// null, not a made-up value: main treats an unstamped event as current, so
// nothing is silently dropped. This file re-executes whenever the renderer
// reloads (the escalate-recovery path does exactly that) while main keeps its
// own name, and dropping the errors on THAT path is the worst time for it.
let sessionId = null;
// The press this one replaced. reportSuperseded belongs to the dictation that
// was still waiting for its answer when a new press arrived, so it must carry
// the OLD name — by the time it fires, sessionId is already the new press.
let supersededSessionId = null;

contextBridge.exposeInMainWorld("dictationBridge", {
  sendError: (message) => ipcRenderer.send("dictation:error", message, sessionId),
  sendMicWarning: (message) => ipcRenderer.send("dictation:mic-warning", message, sessionId),
  // The mic healed itself in the background — clear any warning shown to the user.
  sendMicRecovered: () => ipcRenderer.send("dictation:mic-recovered", sessionId),
  // Background recovery couldn't find a live mic — ask main to escalate
  // (reload the renderer, then relaunch the app as a last resort).
  requestEscalation: (reason) => ipcRenderer.send("dictation:escalate-recovery", reason, sessionId),
  // payload is { text, chunks, sampleRate } on a real transcript, or "" for a
  // server-decided empty (silence / hallucination filter).
  sendTranscript: (payload) => ipcRenderer.send("dictation:transcript", payload, sessionId),
  reportFailure: (payload) => ipcRenderer.send("dictation:failure", payload, sessionId),
  // A new press arrived before the previous dictation was answered. Stamped
  // with the press it actually belongs to (the one being superseded), never the
  // live one — main must never read this as the live dictation failing.
  reportSuperseded: (payload) => ipcRenderer.send("dictation:superseded", payload, supersededSessionId),
  onStart: (callback) => {
    ipcRenderer.on("dictation:start", (_event, profile) => {
      if (profile && typeof profile.sessionId === "string" && profile.sessionId) {
        supersededSessionId = sessionId;
        sessionId = profile.sessionId;
      }
      callback(profile);
    });
  },
  onStop: (callback) => {
    ipcRenderer.on("dictation:stop", () => callback());
  },
  // main asks the renderer to rebuild its whole mic pipeline (system wake).
  onRebuildCapture: (callback) => {
    ipcRenderer.on("dictation:rebuild-capture", (_event, reason) => callback(reason));
  },

  // --- Microphone preferences (preferences.json, never .env) ----------------
  // The saved mic mode and preferred device, read once on load.
  getMicPrefs: () => ipcRenderer.invoke("mic:prefs"),
  // The user changed them in the Settings window.
  onMicPrefs: (callback) => {
    ipcRenderer.on("mic:prefs", (_event, prefs) => callback(prefs));
  },
  // The Settings window opened and wants a fresh device list.
  onReportMics: (callback) => {
    ipcRenderer.on("dictation:report-mics", () => callback());
  },
  // Which microphones exist, which one is live, and whether it is the chosen
  // one. This window is the only one that can see any of that.
  sendMicState: (state) => ipcRenderer.send("dictation:mic-state", state)
});
