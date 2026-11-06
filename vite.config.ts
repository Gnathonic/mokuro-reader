import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [sveltekit(), tailwindcss()],
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
    }
  },
  optimizeDeps: {
    exclude: ['clsx', 'tailwind-merge', 'apexcharts', '@floating-ui/dom']
  },
  build: {
    sourcemap: true,
    rollupOptions: {
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
    // `$service-worker` is a SvelteKit virtual module; vitest can't mock it
    // directly (SvelteKit's import guard rejects the re-resolved virtual id),
    // so point it at a static stand-in for tests only.
    alias: {
      '$service-worker': new URL('./src/__mocks__/service-worker-env.ts', import.meta.url).pathname
    },
    // Resolve Svelte 5 for browser/client context in tests
    server: { deps: { inline: ['svelte'] } }
  },
  resolve: { conditions: ['browser'] }
});
