import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const child = spawn(require('electron'), [fileURLToPath(new URL('./clipboard-stress-entry.mjs', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, TYPE_VIA_CLIPBOARD: 'true' }
});
const deadline = setTimeout(() => { child.kill('SIGKILL'); process.exitCode = 1; }, 300000);
child.on('exit', code => { clearTimeout(deadline); process.exitCode = code ?? 1; });

child.on("error", error => { clearTimeout(deadline); console.error(error.message); process.exitCode = 1; });
