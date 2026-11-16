#!/usr/bin/env node
// After `npm run build`: the built service worker must install on a real
// deployment, and must still be a script the app can register CLASSIC.
//
// 1. Classic-compatible. The app registers the production worker as a classic
//    script (src/lib/util/sw-register.ts: SvelteKit 3's `{ type: 'module' }`
//    registration is rejected by browsers without module service workers). A
//    classic worker that contains a static `import`/`export` or `import.meta`
//    fails to parse and never installs. Compiling it as a classic script
//    (`vm.Script`) finds that.
// 2. Its precache list exists. `install` runs `cache.addAll(ASSETS)`, which is
//    all-or-nothing: ONE path missing from the deployed output and install
//    rejects on every client, so no update can ever activate. The worker is run
//    here as built (SvelteKit's real `$app/manifest` and `resolve()`, base path
//    taken from the worker's own URL) and every path its install handler hands
//    to `addAll` must be a file in the deployed static output.
// 3. SvelteKit does not register the worker as well. Its own registration is
//    switched off (`serviceWorker.register: false`); if a later config edit
//    turned it back on, the shell would register the worker again as a module.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
// adapter-vercel's deployed static output; `build` for adapter-static/node.
const STATIC_DIRS = ['.vercel/output/static', 'build'];
const staticDir = STATIC_DIRS.map((d) => join(root, d)).find((d) =>
  existsSync(join(d, 'service-worker.js'))
);
if (!staticDir) {
  console.error('check-service-worker: no built service-worker.js; run `npm run build` first');
  process.exit(2);
}
const swFile = join(staticDir, 'service-worker.js');
const code = readFileSync(swFile, 'utf8');
const failures = [];

// 1. Parses as a classic script.
try {
  new vm.Script(code, { filename: relative(root, swFile) });
} catch (error) {
  failures.push(
    `${relative(root, swFile)} is not a classic script (registered as one in production): ${error}`
  );
}

// 2. Run it under a minimal worker global and capture what install precaches.
async function precacheList() {
  const listeners = new Map();
  let added = null;
  const cache = {
    addAll: async (paths) => {
      added = [...paths];
    },
    match: async () => undefined,
    put: async () => {}
  };
  const sandbox = {
    location: new URL('https://worker.invalid/service-worker.js'),
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    fetch: async () => {
      throw new Error('the precache check makes no requests');
    },
    URL,
    Response,
    Request,
    console
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = (type, cb) => listeners.set(type, cb);
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: relative(root, swFile) });

  const install = listeners.get('install');
  if (typeof install !== 'function') throw new Error('the worker registers no install handler');
  const waits = [];
  install({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  if (!added) throw new Error('install never called cache.addAll');
  return added;
}

let precached = [];
if (failures.length === 0) {
  try {
    precached = await precacheList();
  } catch (error) {
    failures.push(`running ${relative(root, swFile)}: ${error}`);
  }
}

if (failures.length === 0) {
  if (!precached.some((p) => p.startsWith('/_app/immutable/entry/'))) {
    failures.push('the precache list holds no /_app/immutable/entry/ file: the app itself');
  }
  for (const path of precached) {
    if (!path.startsWith('/')) {
      failures.push(`precache path is not absolute: ${path}`);
      continue;
    }
    const file = join(staticDir, decodeURIComponent(path.slice(1)));
    if (!existsSync(file) || !statSync(file).isFile()) {
      failures.push(`precached but not in ${relative(root, staticDir)}: ${path}`);
    }
  }
}

// 3. No SvelteKit registration left in the server that renders the shell.
function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(m?js)$/.test(name)) yield p;
  }
}
const serverDir = join(root, '.svelte-kit/output/server');
if (existsSync(serverDir)) {
  for (const file of files(serverDir)) {
    if (readFileSync(file, 'utf8').includes('navigator.serviceWorker.register(')) {
      failures.push(
        `${relative(root, file)} renders SvelteKit's own worker registration; ` +
          'keep `serviceWorker: { register: false }` in vite.config.ts'
      );
    }
  }
}

if (failures.length > 0) {
  console.error('check-service-worker:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `check-service-worker: classic script, ${precached.length} precached paths all in ${relative(root, staticDir)}`
);
