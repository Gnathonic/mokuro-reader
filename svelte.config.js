import adapterAuto from '@sveltejs/adapter-auto';
import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isTauri = process.env.TAURI_ENV === 'true';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),

  kit: {
    adapter: isTauri
      ? adapterStatic({
          pages: 'build',
          assets: 'build',
          fallback: 'index.html'
        })
      : adapterAuto()
  },

  vitePlugin: {
    inspector: true
  }
};

export default config;
