import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const walk = dir => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
// Hash only distributable code/assets. Never read environment/credential files.
const files = ['main.js', 'server.js', 'realtime-relay.js', 'models/vocab.txt', 'package.json', ...readdirSync(root).filter(name => /^preload.*\.cjs$/.test(name)), ...walk('src'), ...walk('public')].sort();
const hash = createHash('sha256');
for (const file of files) hash.update(file).update('\0').update(readFileSync(join(root, file)));
let revision = 'unknown';
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
const identity = { revision, sourceDigest: hash.digest('hex'), builtAt: new Date().toISOString() };
mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build/build-info.json'), JSON.stringify(identity, null, 2) + '\n');
console.log(JSON.stringify(identity));
