import { dev } from '$app/environment';
import { resolve } from '$app/paths';

/**
 * Register `src/service-worker.js`. The app does this itself instead of
 * SvelteKit (`serviceWorker.register: false` in vite.config.ts).
 *
 * SvelteKit 3 registers its worker as `{ type: 'module' }` in EVERY build;
 * SvelteKit 2 did that only in dev, and a production build registered a
 * classic worker. A browser without module service workers (Firefox before
 * module-worker support shipped, including users on an ESR channel) rejects
 * that registration: no precache, no offline reading and no update banner. The
 * production worker never needs module semantics: SvelteKit bundles it into one
 * file without code splitting, and `scripts/check-service-worker.mjs` fails the
 * build if an `import` or `export` ever reaches it. So production registers it
 * classic, as SvelteKit 2 did. The dev server serves the worker as an ES module
 * that imports its source (`import '/src/service-worker.js'`), so dev registers
 * it as a module, as both majors did.
 *
 * Registers on `load`, as SvelteKit's own registration did, so the worker's
 * precache never competes with the first page's requests.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const register = () => {
    navigator.serviceWorker
      .register(resolve('service-worker.js'), { type: dev ? 'module' : 'classic' })
      .catch((error: unknown) => {
        // Nothing depends on the worker to run: the app works without one.
        console.warn('Service worker registration failed', error);
      });
  };

  if (document.readyState === 'complete') register();
  else addEventListener('load', register, { once: true });
}
