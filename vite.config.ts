import adapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { kitCsp, parseCspMode } from './src/lib/security/csp-policy.js';

// Node loads this file, but the TypeScript program it shares with the app has
// no Node types (a browser app: `@types/node` would retype `setTimeout` and the
// other browser globals everywhere). The one Node global read here, typed here.
declare const process: { env: Record<string, string | undefined> };

/**
 * The test-hook switches, as boolean literals: `__MOKURO_TEST_HOOKS__` (the
 * `test` and `interop` modes: src/lib/util/sync/cloud-test-hooks.ts) and
 * `__MOKURO_INTEROP__` (`interop` only: src/lib/interop/hermetic.ts). Each
 * guard reads one where the guarded code is. Rolldown folds such a literal
 * before it splits chunks; an imported `MODE === 'test' || ...` constant is
 * folded only later, which still drops the guarded code but keeps the hooks it
 * called exported from shared chunks, and the chunk of a guarded dynamic
 * `import()`, in a production build (scripts/check-no-test-hooks.mjs). Bare
 * names, not `import.meta.env.*`: Vitest moves those into `process.env`, where
 * `false` becomes the truthy string "false".
 */
function testHookSwitches(): Plugin {
  return {
    name: 'mokuro:test-hook-switches',
    config: (_config, { mode }) => ({
      define: {
        __MOKURO_TEST_HOOKS__: JSON.stringify(mode === 'test' || mode === 'interop'),
        __MOKURO_INTEROP__: JSON.stringify(mode === 'interop')
      }
    })
  };
}

export default defineConfig({
  plugins: [
    // SvelteKit's own configuration (SvelteKit 3 reads no svelte.config.js).
    sveltekit({
      preprocess: vitePreprocess(),

      // `$lib`, which SvelteKit 3 no longer provides by default. The `alias`
      // option is deprecated (SvelteKit prints a warning for it on every build
      // and dev start) but still generates the Vite alias and the tsconfig
      // `paths`. Moving to `#lib` subpath imports
      // touches every import in the app, so it waits until open branches have
      // landed: https://github.com/Gnathonic/mokuro-reader/issues/359
      alias: { $lib: 'src/lib' },

      // adapter-vercel, pinned in the lockfile. adapter-auto installed it at
      // build time OUTSIDE the lockfile, unpinned, on every deploy. The runtime
      // is explicit because adapter-vercel otherwise derives it from the build
      // machine's Node and throws on any major Vercel does not run (CI, a dev box).
      adapter: adapter({ runtime: 'nodejs24.x' }),

      // The shell's Content-Security-Policy, phased by CSP_MODE at build time
      // (off | report-only | enforce; unset = off). See src/lib/security/csp-policy.js.
      csp: kitCsp(parseCspMode(process.env.CSP_MODE)),

      // Only e2e specs that build or serve a SECOND app beside the suite's running
      // dev server set this (e2e/csp.spec.ts: one build per CSP_MODE;
      // e2e/gdrive-auth-backend.spec.ts: a dev server with the auth backend on).
      // Their generated files must not overwrite the first server's: that
      // full-reloads every page open there.
      ...(process.env.MOKURO_E2E_KIT_OUT_DIR ? { outDir: process.env.MOKURO_E2E_KIT_OUT_DIR } : {}),

      // No hourly `_app/version.json` poll (SvelteKit 3's default; 2 had none).
      // Nothing reads `updated`: a new deployment reaches the reader through the
      // service worker's update banner. SvelteKit still checks on focus and on
      // tab visibility, which no option turns off.
      version: { pollInterval: 0 },

      // SvelteKit 3 registers the service worker as `{ type: 'module' }` in
      // every build (2 did only in dev), which a browser without module service
      // workers rejects. The app registers it itself, classic in production:
      // src/lib/util/sw-register.ts.
      serviceWorker: { register: false },

      inspector: true
    }),
    tailwindcss(),
    testHookSwitches()
  ],
  worker: {
    format: 'es'
  },
  server: {
    // No `host` here: the dev server listens on localhost only. For LAN access
    // (testing on a phone), opt in per run with `npm run dev -- --host`.
    fs: {
      // SvelteKit allows src/, node_modules/ and its own output; the version
      // import (`consts/index.ts`) also needs the root package.json — that one
      // file, not the project's parent directory and every sibling in it.
      allow: ['package.json']
    },
    watch: {
      // adapter-vercel writes `.vercel/output` at the project root on EVERY
      // `vite build`, whatever `kit.outDir` says. Its copied HTML
      // (static/oauth/google-callback.html) makes Vite full-reload every page
      // a dev server has open, so a build next to a running dev server (the
      // CSP e2e builds, or a hand-run `npm run build`) reset unrelated e2e
      // tests mid-test and answered some page loads with a 500.
      ignored: ['**/.vercel/**']
    }
  },
  optimizeDeps: {
    exclude: ['clsx', 'tailwind-merge', 'apexcharts', '@floating-ui/dom']
  },
  build: {
    sourcemap: true,
    rolldownOptions: {
      onwarn(warning, warn) {
        // Suppress sourcemap warnings from node_modules (e.g., Flowbite Svelte)
        if (warning.code === 'SOURCEMAP_ERROR' && warning.message.includes('node_modules')) {
          return;
        }

        // Suppress annotation warnings from node_modules
        if (warning.code === 'INVALID_ANNOTATION' && warning.loc?.file?.includes('node_modules')) {
          return;
        }

        warn(warning);
      }
    }
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts,svelte}'],
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Resolve Svelte 5 for browser/client context in tests
    server: { deps: { inline: ['svelte'] } }
  },
  resolve: { conditions: ['browser'] }
});
