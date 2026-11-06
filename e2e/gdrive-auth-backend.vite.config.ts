/**
 * The Vite config of the SECOND dev server `gdrive-auth-backend.spec.ts` starts:
 * the project's own, with its own dependency cache. Sharing the first server's
 * `node_modules/.vite` would let one server's re-optimization pull chunks out
 * from under the other's pages. (Its SvelteKit output is kept apart by
 * `MOKURO_E2E_KIT_OUT_DIR`, read in svelte.config.js.)
 */
import base from '../vite.config';

export default { ...base, cacheDir: 'node_modules/.vite-e2e-gdrive-auth' };
