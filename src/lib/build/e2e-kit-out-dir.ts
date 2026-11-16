/**
 * The SvelteKit options of a SECOND app in this tree: an e2e spec's build
 * (e2e/csp.spec.ts, one per CSP_MODE) or dev server (e2e/gdrive-auth-backend.spec.ts)
 * beside the suite's running dev server, named by `MOKURO_E2E_KIT_OUT_DIR`.
 *
 * Its generated files go to their own `kit.outDir`: a second server writing the
 * first one's generated entry modules full-reloads every page open there.
 *
 * One generated file is not under `outDir` in SvelteKit 3: the tsconfig the
 * project's `tsconfig.json` extends, `node_modules/$app/tsconfig.json`, whose
 * `rootDirs` name `<outDir>/types` (where `./$types` resolves). SvelteKit 2
 * wrote it to `<outDir>/tsconfig.json`; now every process syncing this project
 * writes the same file, so the second app would point the editor's and a bare
 * `tsc`'s `./$types` at ITS types until the next `svelte-kit sync`. The
 * transform below has it write exactly what the default `outDir` writes, and
 * SvelteKit writes a file only when its content changes, so the second app
 * leaves the shared tsconfig untouched. Nothing in the second app type-checks.
 */

/** SvelteKit's default `kit.outDir`, the one the project's tsconfig is for. */
export const DEFAULT_KIT_OUT_DIR = '.svelte-kit';

interface GeneratedTsconfig {
  compilerOptions?: { rootDirs?: string[]; [option: string]: unknown };
  [key: string]: unknown;
}

/**
 * `kit.typescript.config`: the generated tsconfig's `rootDirs` back on the
 * default `outDir`. SvelteKit hands it the config with paths already relative
 * to the generated file: `[<project root>, <outDir>/types]`.
 */
export function rootDirsOnDefaultOutDir(config: GeneratedTsconfig): GeneratedTsconfig {
  const rootDirs = config.compilerOptions?.rootDirs;
  if (!rootDirs || rootDirs.length !== 2) {
    // A SvelteKit that writes another shape: fail the e2e run loudly rather
    // than write a tsconfig nobody checked.
    throw new Error(
      `Unexpected rootDirs in SvelteKit's generated tsconfig: ${JSON.stringify(rootDirs)}`
    );
  }
  const [root] = rootDirs;
  return {
    ...config,
    compilerOptions: {
      ...config.compilerOptions,
      rootDirs: [root, `${root}/${DEFAULT_KIT_OUT_DIR}/types`]
    }
  };
}

/** The options to spread into `sveltekit({...})`: nothing unless `outDir` is set. */
export function e2eKitOutDir(outDir: string | undefined) {
  if (!outDir) return {};
  return {
    outDir,
    // Deprecated in SvelteKit 3 (it warns, in these e2e processes only), and
    // still the one hook into the generated tsconfig: e2e-kit-out-dir.test.ts
    // runs SvelteKit's own writer, so a release that drops it fails there.
    typescript: { config: rootDirsOnDefaultOutDir }
  };
}
