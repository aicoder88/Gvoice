// Isolated running Electron capture check. No hotkeys, clipboard, or history.
import { app, BrowserWindow } from 'electron';
if (app.isPackaged || process.env.GVOICE_TEST_MODE !== '1' || !process.env.GVOICE_TAIL_URL || !process.env.GVOICE_TEST_PROFILE) throw new Error('Explicit isolated capture test required');
app.setPath('userData', process.env.GVOICE_TEST_PROFILE);
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Do not await readiness during ESM evaluation: Electron must finish loading
// its entry module before it can complete application readiness.
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await window.loadURL(process.env.GVOICE_TAIL_URL);
});
