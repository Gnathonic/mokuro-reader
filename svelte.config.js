import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { kitCsp, parseCspMode } from './src/lib/security/csp-policy.js';

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

    // The shell's Content-Security-Policy, phased by CSP_MODE at build time
    // (off | report-only | enforce; unset = off). See src/lib/security/csp-policy.js.
    csp: kitCsp(parseCspMode(process.env.CSP_MODE)),

    // Only the CSP e2e spec moves this: it builds one app per CSP_MODE beside a
    // running dev server, which must not see its generated files rewritten.
    ...(process.env.SVELTEKIT_OUT_DIR ? { outDir: process.env.SVELTEKIT_OUT_DIR } : {})
  },

  vitePlugin: {
    inspector: true
  }
};

export default config;
