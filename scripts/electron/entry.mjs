// Test-only entry: isolate persistence before the real app imports bootstrap-env.
import { app } from 'electron';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (app.isPackaged || process.env.GVOICE_TEST_MODE !== '1' || !process.env.GVOICE_TEST_PROFILE || !process.env.GVOICE_TEST_MAIN) {
  throw new Error('Electron regression entry requires an explicit unpackaged test profile');
}
app.setPath('userData', resolve(process.env.GVOICE_TEST_PROFILE));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
process.env.GVOICE_HOME = resolve(process.env.GVOICE_TEST_PROFILE);
process.chdir(process.env.GVOICE_HOME);
await import(pathToFileURL(resolve(process.env.GVOICE_TEST_MAIN)).href);
const { isEditableFieldFocused, captureForegroundApp, captureForegroundWindow } = await import(new URL('../../src/foreground.js', import.meta.url));
globalThis.__gvoiceHarnessFocus = isEditableFieldFocused;
globalThis.__gvoiceHarnessTargetPid = captureForegroundApp;
globalThis.__gvoiceHarnessTargetWindow = captureForegroundWindow;
