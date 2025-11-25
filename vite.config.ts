import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [sveltekit(), tailwindcss()],
  server: { host: true },
  optimizeDeps: {
    exclude: ['clsx', 'tailwind-merge', 'apexcharts', '@floating-ui/dom']
  },
  build: {
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
    // Resolve Svelte 5 for browser/client context in tests
    server: { deps: { inline: ['svelte'] } }
  },
  resolve: { conditions: ['browser'] }
});
