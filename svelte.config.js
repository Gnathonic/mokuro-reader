import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // Consult https://kit.svelte.dev/docs/integrations#preprocessors
  // for more information about preprocessors
  preprocess: vitePreprocess(),

  kit: {
    // adapter-vercel, pinned in the lockfile. adapter-auto installed it at
    // build time OUTSIDE the lockfile, unpinned, on every deploy. The runtime
    // is explicit because adapter-vercel otherwise derives it from the build
    // machine's Node and throws on any major Vercel does not run (CI, a dev box).
    adapter: adapter({ runtime: 'nodejs24.x' }),
    // Only an e2e spec that starts a SECOND dev server in this tree sets this
    // (e2e/gdrive-auth-backend.spec.ts): its generated entry modules must not
    // overwrite the first server's, which full-reloads every page open there.
    ...(process.env.MOKURO_E2E_KIT_OUT_DIR ? { outDir: process.env.MOKURO_E2E_KIT_OUT_DIR } : {})
  },

  vitePlugin: {
    inspector: true
  }
};

export default config;
