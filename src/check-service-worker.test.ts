/**
 * scripts/check-service-worker.mjs, the post-build gate that runs the BUILT
 * service worker: its unit test (service-worker-behaviour.test.ts) mocks
 * `$app/manifest` and `$app/paths`, so only this gate sees the real precache
 * list. Each case builds a minimal output tree and runs the script in it.
 */
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error no type declarations for node:child_process in this project
import { spawnSync } from 'node:child_process';
// @ts-expect-error no type declarations for node:fs in this project
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// @ts-expect-error no type declarations for node:os in this project
import { tmpdir } from 'node:os';
// @ts-expect-error no type declarations for node:path in this project
import { dirname, join } from 'node:path';

// The one Node global read here (the project carries no `@types/node`).
declare const process: { execPath: string; cwd(): string };

// Vitest runs from the project root.
const SCRIPT = join(process.cwd(), 'scripts/check-service-worker.mjs');

/** A worker shaped like SvelteKit's build: base from its own URL, then addAll. */
function worker(paths: string[], { prefix = '' } = {}) {
  return `${prefix}
globalThis.__sveltekit_x = { base: location.pathname.split('/').slice(0, -1).join('/') };
var base = globalThis.__sveltekit_x.base;
var ASSETS = ${JSON.stringify(paths)}.map(function (p) { return base + '/' + p; });
self.addEventListener('install', function (event) {
  event.waitUntil(caches.open('c').then(function (cache) { return cache.addAll(ASSETS); }));
});
`;
}

let root: string;

function tree(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), 'check-sw-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
}

function check() {
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
  return { code: run.status, out: run.stdout + run.stderr };
}

const STATIC = '.vercel/output/static';
const ENTRY = '_app/immutable/entry/app.js';

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('check-service-worker', () => {
  it('passes a classic worker whose every precached path is deployed', () => {
    tree({
      [`${STATIC}/service-worker.js`]: worker([ENTRY, 'favicon.png']),
      [`${STATIC}/${ENTRY}`]: '',
      [`${STATIC}/favicon.png`]: '',
      '.svelte-kit/output/server/index.js': 'export const render = () => "<script></script>";'
    });
    const { code, out } = check();
    expect(out).toContain('2 precached paths');
    expect(code).toBe(0);
  });

  it('fails when a precached path is missing from the deployed output', () => {
    // install's addAll is all-or-nothing: no client could ever install.
    tree({
      [`${STATIC}/service-worker.js`]: worker([ENTRY, '_app/immutable/chunks/gone.js']),
      [`${STATIC}/${ENTRY}`]: ''
    });
    const { code, out } = check();
    expect(out).toContain(
      'precached but not in .vercel/output/static: /_app/immutable/chunks/gone.js'
    );
    expect(code).toBe(1);
  });

  it('fails a worker that only parses as a module (registered classic in production)', () => {
    tree({
      [`${STATIC}/service-worker.js`]: worker([ENTRY]) + '\nexport {};\n',
      [`${STATIC}/${ENTRY}`]: ''
    });
    const { code, out } = check();
    expect(out).toContain('is not a classic script');
    expect(code).toBe(1);
  });

  it("fails when the server still renders SvelteKit's own registration", () => {
    tree({
      [`${STATIC}/service-worker.js`]: worker([ENTRY]),
      [`${STATIC}/${ENTRY}`]: '',
      '.svelte-kit/output/server/chunks/instance.js':
        "const s = `navigator.serviceWorker.register(sanitised, { type: 'module' })`;"
    });
    const { code, out } = check();
    expect(out).toContain("renders SvelteKit's own worker registration");
    expect(code).toBe(1);
  });

  it('fails when the precache list lacks the app itself', () => {
    tree({
      [`${STATIC}/service-worker.js`]: worker(['favicon.png']),
      [`${STATIC}/favicon.png`]: ''
    });
    const { code, out } = check();
    expect(out).toContain('holds no /_app/immutable/entry/ file');
    expect(code).toBe(1);
  });

  it('asks for a build when there is no worker to check', () => {
    tree({ 'package.json': '{}' });
    expect(check().code).toBe(2);
  });
});
