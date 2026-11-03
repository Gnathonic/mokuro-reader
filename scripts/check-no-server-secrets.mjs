#!/usr/bin/env node
// After `npm run build`: no server-only secret may appear in the build output.
// The Drive auth backend reads its secrets at RUNTIME ($env/dynamic/private),
// so a build is never supposed to contain them. A `$env/static/private` import,
// a `VITE_`/`PUBLIC_` prefix or a stray `define` would inline one, and the
// client output is public. Every value of the variables below that is set in
// the build's environment is searched for in every output file, source maps
// included (they are served next to the code). CI builds with canary values;
// a hosting provider's build scans for the real ones.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SECRET_VARS = ['GDRIVE_CLIENT_SECRET', 'GDRIVE_SESSION_KEY', 'GDRIVE_SESSION_KEY_PREV'];
const DIRS = ['.svelte-kit/output', 'build', '.vercel/output', '.netlify'];
// Shorter values would match by chance; real secrets are far longer.
const MIN_LENGTH = 12;

const secrets = SECRET_VARS.map((name) => [name, (process.env[name] ?? '').trim()]).filter(
  ([, value]) => value.length >= MIN_LENGTH
);
if (secrets.length === 0) {
  console.log('check-no-server-secrets: no server secret set in this build environment; skipped');
  process.exit(0);
}

const root = process.cwd();
const dirs = DIRS.map((d) => join(root, d)).filter((d) => existsSync(d));
if (dirs.length === 0) {
  console.error('check-no-server-secrets: no build output found; run `npm run build` first');
  process.exit(2);
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

let scanned = 0;
const hits = [];
for (const dir of dirs) {
  for (const file of files(dir)) {
    scanned++;
    const text = readFileSync(file, 'latin1');
    for (const [name, value] of secrets) {
      if (text.includes(value)) hits.push(`${relative(root, file)}: ${name}`);
    }
  }
}

if (hits.length > 0) {
  // Names only: the value is the secret.
  console.error('Server secrets found in the build output:');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(
  `check-no-server-secrets: ${scanned} files, ${secrets.length} secret(s) checked, none found`
);
