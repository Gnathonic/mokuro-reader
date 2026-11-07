import { expect, type Page } from '@playwright/test';

/**
 * Open the app at `/` and wait until it has BOOTED, never for a fixed time.
 *
 * SvelteKit's `start()` reads `location.href`, loads the route, then
 * `replaceState`s that captured URL — so a hash set while it is still loading
 * (slow on a cold dev server, or with many workers) is silently wiped, and the
 * app lands on the catalog instead of where the test sent it. The hash router
 * writes `#/catalog` only after that navigation has finished, so its arrival
 * means the app owns the URL and the stylesheet and layout are mounted.
 */
export async function gotoApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => window.location.hash), {
      timeout: 30000,
      message: 'the app never booted (the router never claimed the URL)'
    })
    .toBe('#/catalog');
}
