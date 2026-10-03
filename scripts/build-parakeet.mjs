// Build the small persistent worker against a pinned, MIT-licensed runtime.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, statfsSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const revision = '84cdbbac18a5237553cb40842e5a453af2576191';
const source = join(root, '.verification/parakeet-runtime');
const build = join(root, '.verification/parakeet-build');
const dest = join(root, 'build/parakeet');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const disk = statfsSync(root);
if (disk.bavail * disk.bsize < 3 * 1024 ** 3) throw new Error('Need 3 GiB free before building, preserving the 2 GiB reserve.');
if (!existsSync(source)) {
  mkdirSync(source, { recursive: true });
  run('git', ['init'], source);
  run('git', ['fetch', '--depth', '1', 'https://github.com/handy-computer/transcribe.cpp.git', revision], source);
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], source);
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (head !== revision) throw new Error('Parakeet runtime checkout does not match the pinned revision.');
run('cmake', ['-S', join(root, 'src/native'), '-B', build, `-DTRANSCRIBE_SOURCE=${source}`, '-DCMAKE_BUILD_TYPE=Release']);
run('cmake', ['--build', build, '--target', 'gvoice-parakeet', '-j', '2']);
mkdirSync(dest, { recursive: true });
// Replace by rename, then sign: overwriting an executable inode leaves macOS's
// cached code pages invalid and the next launch can be killed with SIGKILL.
copyFileSync(join(build, 'gvoice-parakeet'), join(dest, 'gvoice-parakeet.new'));
renameSync(join(dest, 'gvoice-parakeet.new'), join(dest, 'gvoice-parakeet'));
if (process.platform === 'darwin') run('codesign', ['--force', '--sign', '-', join(dest, 'gvoice-parakeet')]);
copyFileSync(join(source, 'LICENSE'), join(dest, 'LICENSE-transcribe.cpp'));
copyFileSync(join(source, 'ggml/LICENSE'), join(dest, 'LICENSE-ggml'));
writeFileSync(join(dest, 'runtime.json'), JSON.stringify({ repository: 'https://github.com/handy-computer/transcribe.cpp', revision }, null, 2) + '\n');
