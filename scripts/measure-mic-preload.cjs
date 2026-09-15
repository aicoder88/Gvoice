// Bridge for scripts/measure-mic.cjs: the measuring page hands its numbers back.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("measure", {
  done: (payload) => ipcRenderer.send("measure:done", payload),
  fail: (msg) => ipcRenderer.send("measure:fail", msg)
});
