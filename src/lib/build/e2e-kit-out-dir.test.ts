/**
 * A second app in this tree (an e2e spec's build or dev server, its own
 * `kit.outDir`) must leave the project's shared generated tsconfig,
 * `node_modules/$app/tsconfig.json`, exactly as the default `outDir` wrote it.
 * Run against SvelteKit's OWN config validation and tsconfig writer, in a
 * scratch project, so a SvelteKit release that changes either fails here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error no type declarations for node:fs in this project
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
// @ts-expect-error no type declarations for node:os in this project
import { tmpdir } from 'node:os';
// @ts-expect-error no type declarations for node:path in this project
import { join } from 'node:path';
import { e2eKitOutDir, rootDirsOnDefaultOutDir } from './e2e-kit-out-dir';

// The one Node global read here (the project carries no `@types/node`).
declare const process: { cwd(): string };

// SvelteKit's internals, by file: the package exports neither. Vitest runs from
// the project root. Imported through a variable so TypeScript does not try to
// type them.
const KIT = join(process.cwd(), 'node_modules/@sveltejs/kit/src/core');
const load = (file: string) => import(/* @vite-ignore */ join(KIT, file));

let root: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});

function scratchProject() {
  root = mkdtempSync(join(tmpdir(), 'kit-out-dir-'));
  writeFileSync(join(root, 'package.json'), '{}');
  mkdirSync(join(root, 'src/lib'), { recursive: true });
  return root;
}

/** Run SvelteKit's sync of the generated tsconfig the way `vite dev`/`vite build` does. */
async function syncTsconfig(kitOptions: Record<string, unknown>) {
  const { validate_config, process_config } = await load('config/index.js');
  const { write_tsconfig } = await load('sync/write_tsconfig/index.js');
  // The deprecated `typescript` option warns; that is expected here.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const config = process_config(
    validate_config({ alias: { $lib: 'src/lib' }, ...kitOptions }),
    root
  );
  write_tsconfig(config, root);
  const file = join(root, 'node_modules/$app/tsconfig.json');
  return { text: readFileSync(file, 'utf8') as string, mtime: statSync(file).mtimeMs as number };
}

describe('e2eKitOutDir', () => {
  it('sets nothing without an override', () => {
    expect(e2eKitOutDir(undefined)).toEqual({});
    expect(e2eKitOutDir('')).toEqual({});
  });

  it('the default outDir points the shared tsconfig at .svelte-kit/types', async () => {
    scratchProject();
    const { text } = await syncTsconfig(e2eKitOutDir(undefined));
    expect(JSON.parse(text).compilerOptions.rootDirs).toEqual(['../..', '../../.svelte-kit/types']);
  });

  it('without the transform, a private outDir would rewrite the shared tsconfig', async () => {
    // The hazard the transform exists for (SvelteKit 3 writes the file outside outDir).
    scratchProject();
    const shared = await syncTsconfig({});
    const second = await syncTsconfig({ outDir: '.svelte-kit/e2e-gdrive-auth' });
    expect(second.text).not.toBe(shared.text);
    expect(JSON.parse(second.text).compilerOptions.rootDirs).toEqual([
      '../..',
      '../../.svelte-kit/e2e-gdrive-auth/types'
    ]);
  });

  it.each([
    ['inside .svelte-kit (the Drive auth dev server)', '.svelte-kit/e2e-gdrive-auth'],
    ['in node_modules/.cache (a CSP build)', 'node_modules/.cache/csp-e2e/enforce'],
    ['an absolute path', '/tmp/kit-out-dir-elsewhere/out']
  ])('a private outDir %s leaves the shared tsconfig untouched', async (_name, outDir) => {
    scratchProject();
    const shared = await syncTsconfig({});
    // A later mtime would be visible even on a coarse-clock filesystem.
    await new Promise((r) => setTimeout(r, 20));
    const second = await syncTsconfig(e2eKitOutDir(outDir));
    expect(second.text).toBe(shared.text);
    expect(second.mtime).toBe(shared.mtime);
  });

  it('refuses a generated tsconfig of another shape', () => {
    expect(() => rootDirsOnDefaultOutDir({ compilerOptions: {} })).toThrow(/rootDirs/);
    expect(() =>
      rootDirsOnDefaultOutDir({ compilerOptions: { rootDirs: ['../..', 'a', 'b'] } })
    ).toThrow(/rootDirs/);
  });
});
