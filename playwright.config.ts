import { defineConfig } from '@playwright/test';

// Override with E2E_PORT when 5173 is taken (e.g. another worktree's dev server).
const port = Number(process.env.E2E_PORT ?? 5173);

export default defineConfig({
  testDir: 'e2e',
  timeout: 30000,
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1920, height: 1080 },
    // Point at an existing Chromium build instead of downloading one.
    ...(process.env.E2E_CHROMIUM
      ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM } }
      : {})
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    port,
    // Reusing a server that another worktree owns would silently test that
    // worktree's code — only reuse outside CI, and prefer E2E_PORT locally.
    reuseExistingServer: !process.env.CI
  }
});
