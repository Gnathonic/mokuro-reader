#!/usr/bin/env node
// After `npm run build`: the production bundle must contain none of the cloud
// test hooks (src/lib/util/sync/cloud-test-hooks.ts and the interop helpers).
// They are guarded by a compile-time constant that is false in a production
// build, so the bundler drops them; this proves it. Exits 1 listing every file
// that still names one. A build made with VITE_CLOUD_TEST_HOOKS=1 fails it.
//
// Source maps are skipped: their `sourcesContent` carries the original source
// of every module that fed a chunk, hooks module included, though none of its
// code survived; what must be clean is the code that runs.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const NAMES = [
  'setCloudTestBases',
  'setCloudTestToken',
  'cloudTestToken',
  '__mokuroCloudTestHooks',
  'installGapiRestShim',
  'VITE_CLOUD_TEST_HOOKS',
  'CLOUDSIM'
];
// SvelteKit's output, and the adapter's (adapter-auto writes one only on a host it knows).
const DIRS = ['.svelte-kit/output', 'build', '.vercel/output', '.netlify'];

const root = process.cwd();
const dirs = DIRS.map((d) => join(root, d)).filter((d) => existsSync(d));
if (dirs.length === 0) {
  console.error('check-no-test-hooks: no build output found; run `npm run build` first');
  process.exit(2);
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (!name.endsWith('.map')) yield p;
  }
}

let scanned = 0;
const hits = [];
for (const dir of dirs) {
  for (const file of files(dir)) {
    scanned++;
    const text = readFileSync(file, 'latin1');
    const found = NAMES.filter((n) => text.includes(n));
    if (found.length > 0) hits.push(`${relative(root, file)}: ${found.join(', ')}`);
  }
}

if (hits.length > 0) {
  console.error('Cloud test hooks found in the production build:');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-no-test-hooks: ${scanned} files in ${dirs.length} output dir(s), no test hooks`);
