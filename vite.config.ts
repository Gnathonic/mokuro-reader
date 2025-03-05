import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: true
  },
  optimizeDeps: {
    exclude: ['clsx', 'tailwind-merge', 'apexcharts', '@floating-ui/dom']
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts,svelte}'],
    globals: true,
    environment: 'jsdom'
  }
});
