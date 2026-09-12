import { readFileSync } from 'node:fs';
export function readBuildIdentity() {
  try {
    const { revision, sourceDigest, builtAt } = JSON.parse(readFileSync(new URL('../build/build-info.json', import.meta.url), 'utf8'));
    return { revision, sourceDigest, builtAt };
  } catch { return { revision: 'unknown', sourceDigest: 'unknown', builtAt: null }; }
}
