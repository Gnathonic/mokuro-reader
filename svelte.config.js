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
    adapter: adapter({ runtime: 'nodejs24.x' })
  },

  vitePlugin: {
    inspector: true
  }
};

export default config;
