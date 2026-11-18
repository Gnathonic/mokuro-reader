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
  await waitForBoot(page);
}

/**
 * After any document load (`goto`, `reload`): wait until the app's router has
 * claimed the URL, landing on `hash` (`#/catalog` for `/`, and for an AniList
 * callback, whose token it scrubs). Every load fetches the app's modules from
 * the dev server again, so this gets the BOOT budget, not expect's 5 s default:
 * measured with 16 workers on a machine at load ~105 (48 CPU burners), a second
 * load of an already warm page claimed the URL 7.2 s (p50) to 9.6 s (max) after
 * `goto` resolved — and always did; first loads up to 10.7 s.
 */
export async function waitForBoot(page: Page, hash = '#/catalog'): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.location.hash), {
      timeout: 30000,
      message: 'the app never booted (the router never claimed the URL)'
    })
    .toBe(hash);
}
