import { defineConfig } from '@playwright/test';

// Override with E2E_PORT when 5173 is taken (e.g. another worktree's dev server).
const port = Number(process.env.E2E_PORT ?? 5173);

export default defineConfig({
  testDir: 'e2e',
  // Generous per test: import, sync and reader flows run several seconds each,
  // and a loaded machine (16 workers on one dev server, or other work) can
  // triple that. A real failure still fails — just later.
  timeout: 90000,
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
    reuseExistingServer: !process.env.CI,
    // AniList-gated UI (the series tracking panel) only renders with a client
    // id; the e2e suite never talks to AniList, so any non-empty value does.
    env: { VITE_ANILIST_CLIENT_ID: process.env.VITE_ANILIST_CLIENT_ID || 'e2e-anilist-client' }
  }
});
