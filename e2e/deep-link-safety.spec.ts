import { test, expect, type Page } from '@playwright/test';

/**
 * Deep links are read-only until the user clicks, against the REAL app.
 *
 * - `#/upload?cbz=…` asks before it fetches anything, naming the host it would
 *   download from, with plain-words warnings for plain http and for addresses
 *   on this device or the local network.
 * - `#/cloud?server=…` only fills the WebDAV form (never signs in), says so in
 *   a banner, and refuses to fill a plain-http server that is not this device.
 *
 * Every request to a host a link names is intercepted and counted: none may
 * happen before a click.
 */

/** Count (and refuse) every request to these hosts. */
async function watchHosts(page: Page, hosts: string[]): Promise<string[]> {
  const seen: string[] = [];
  await page.route(
    (url) => hosts.includes(url.host),
    (route) => {
      seen.push(route.request().url());
      return route.abort();
    }
  );
  return seen;
}

/** Open the app straight at a deep link, as a click on that link would. */
async function openLink(page: Page, hash: string) {
  await page.goto('/' + hash);
}

/**
 * The first thing a test waits for after `openLink` waits as long as a cold
 * boot can take: the dev server compiles the app and the view's chunk on first
 * use, and under parallel workers that runs past the 5 s default (the same
 * budget `gotoApp` gives the router).
 */
const BOOT = { timeout: 30_000 };

test.describe('import by link', () => {
  test('asks first, shows the host and the warnings, and fetches nothing on No', async ({
    page
  }) => {
    const seen = await watchHosts(page, ['192.168.1.20:8080']);
    await openLink(
      page,
      '#/upload?cbz=' +
        encodeURIComponent('http://192.168.1.20:8080/mokuro-reader/Dr Stone/Dr Stone 01.cbz')
    );

    await expect(page.getByText('Import Dr Stone 01 into your catalog?')).toBeVisible(BOOT);
    const source = page.getByTestId('confirmation-source');
    await expect(source).toContainText('Downloads from');
    await expect(source).toContainText('192.168.1.20:8080');
    const warnings = page.getByTestId('confirmation-warnings');
    await expect(warnings).toContainText('does not use a secure connection (https)');
    await expect(warnings).toContainText('private address');
    // A stray Enter declines: Cancel holds the focus.
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/catalog');
    await page.waitForTimeout(500);
    expect(seen).toEqual([]);
  });

  test('a public https host carries no warning, and Escape is a no too', async ({ page }) => {
    const seen = await watchHosts(page, ['books.example.com']);
    await openLink(
      page,
      '#/upload?cbz=' + encodeURIComponent('https://books.example.com/S/Volume 1.cbz')
    );

    await expect(page.getByTestId('confirmation-source')).toContainText('books.example.com', BOOT);
    await expect(page.getByTestId('confirmation-warnings')).toHaveCount(0);

    await page.keyboard.press('Escape');
    // Dismissed without a button still leaves the import page for the catalog.
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/catalog');
    await page.waitForTimeout(500);
    expect(seen).toEqual([]);
  });
});

test('leaving the import page takes its open question with it', async ({ page }) => {
  const seen = await watchHosts(page, ['books.example.com']);
  await openLink(page, '#/upload?cbz=' + encodeURIComponent('https://books.example.com/S/V.cbz'));
  await expect(page.getByTestId('confirmation-source')).toBeVisible(BOOT);

  await page.evaluate(() => {
    window.location.hash = '#/cloud';
  });
  await expect(page.getByText('Choose a Cloud Storage Provider')).toBeVisible();
  await expect(page.getByTestId('confirmation-source')).toBeHidden();
  // Its "no" did not drag the user back to the catalog either.
  expect(await page.evaluate(() => window.location.hash)).toBe('#/cloud');
  expect(seen).toEqual([]);
});

test.describe('cloud prefill by link', () => {
  test('fills an https server and the username, says it came from a link, signs nothing in', async ({
    page
  }) => {
    const seen = await watchHosts(page, ['dav.example.com']);
    await openLink(
      page,
      '#/cloud?server=' +
        encodeURIComponent('https://dav.example.com/remote.php/dav') +
        '&username=reader'
    );

    const banner = page.getByTestId('webdav-link-prefill');
    await expect(banner).toBeVisible(BOOT);
    await expect(banner).toContainText('filled in from a link');
    await expect(banner).toContainText('dav.example.com');
    const form = page.locator('#webdav-login-form');
    await expect(form.locator('input[type="url"]')).toHaveValue(
      'https://dav.example.com/remote.php/dav'
    );
    await expect(form.locator('input[type="text"]')).toHaveValue('reader');
    await expect(form.locator('input[type="password"]')).toHaveValue('');

    // The banner is about the link's address: typing another one retires it.
    await form.locator('input[type="url"]').fill('https://my.example.org/dav');
    await expect(banner).toHaveCount(0);

    await page.waitForTimeout(500);
    expect(seen).toEqual([]);
  });

  test('refuses to fill a plain-http server on the local network', async ({ page }) => {
    const seen = await watchHosts(page, ['192.168.1.20']);
    await openLink(
      page,
      '#/cloud?server=' + encodeURIComponent('http://192.168.1.20/dav') + '&username=bob'
    );

    const refused = page.getByTestId('webdav-link-prefill-refused');
    await expect(refused).toBeVisible(BOOT);
    await expect(refused).toContainText('http://192.168.1.20');
    await expect(refused).toContainText('type its address yourself');
    const form = page.locator('#webdav-login-form');
    await expect(form.locator('input[type="url"]')).toHaveValue('');
    await expect(form.locator('input[type="text"]')).toHaveValue('');
    await expect(page.getByTestId('webdav-link-prefill')).toHaveCount(0);
    expect(seen).toEqual([]);
  });

  test('fills plain http on this device (a local server)', async ({ page }) => {
    await openLink(page, '#/cloud?server=' + encodeURIComponent('http://localhost:9090'));
    await expect(page.getByTestId('webdav-link-prefill')).toContainText('localhost:9090', BOOT);
    await expect(page.locator('#webdav-login-form input[type="url"]')).toHaveValue(
      'http://localhost:9090'
    );
  });
});
