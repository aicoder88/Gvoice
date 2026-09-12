// Separate desktop process: GVoice must use real cross-process Accessibility.
import { app, BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

if (app.isPackaged || process.env.GVOICE_TEST_MODE !== '1' || !process.env.GVOICE_TEST_PROFILE) {
  throw new Error('Regression target requires an explicit unpackaged test profile');
}
const profile = resolve(process.env.GVOICE_TEST_PROFILE, 'target');
mkdirSync(profile, { recursive: true });
app.setName('GVoice Regression Target');
app.setPath('userData', profile);
app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true);
  if (process.platform === 'darwin') { app.setActivationPolicy('regular'); app.dock.show(); }
  const target = new BrowserWindow({ width: 700, height: 350, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  globalThis.__gvoiceRegressionTarget = target;
  await target.loadURL('data:text/html,<title>GVoice Regression Target</title><h1>GVoice regression target</h1><textarea id="target" style="width:95%;height:200px" autofocus></textarea>');
  target.show(); app.focus({ steal: true }); target.focus(); target.webContents.focus();
});
app.on('window-all-closed', () => app.quit());
