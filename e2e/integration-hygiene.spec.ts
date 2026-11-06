import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';

/**
 * The integration-hygiene fixes in a real browser:
 *  1. An AnkiConnect URL that arrived in a profile (as an import or a synced
 *     profiles.json leaves it) is shown and not used until confirmed here.
 *  2. The AniList login marker expires: a callback for a login abandoned more
 *     than 10 minutes ago stores nothing; a fresh one connects and names the
 *     account.
 *  3. The AniList settings say that disconnecting does not revoke access, and
 *     link to where it can be revoked.
 * Nothing here talks to Anki or AniList: AniList's GraphQL endpoint is
 * answered by the test.
 */

async function openSettingsSection(page: Page, section: string) {
  // The navbar's settings button carries no label; it follows Progress Tracker.
  await page.locator('button[title="Progress Tracker"] + button').click();
  const drawer = page.locator('#settings');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: section, exact: true }).click();
  return drawer;
}

/** Point the current profile's AnkiConnect URL at `url`, as an import or a sync would. */
async function setProfileAnkiUrl(page: Page, url: string) {
  await page.evaluate((ankiUrl) => {
    const profiles = JSON.parse(localStorage.getItem('profiles') ?? '{}');
    const current = localStorage.getItem('currentProfile') ?? 'Desktop';
    profiles[current] = {
      ...profiles[current],
      ankiConnectSettings: { ...profiles[current]?.ankiConnectSettings, url: ankiUrl }
    };
    localStorage.setItem('profiles', JSON.stringify(profiles));
  }, url);
}

test.describe('AnkiConnect URL trust', () => {
  test('a URL from a profile is not used until it is confirmed on this device', async ({
    page
  }) => {
    const ankiRequests: string[] = [];
    await page.route('https://anki.example.com/**', (route) => {
      ankiRequests.push(route.request().url());
      return route.fulfill({ json: { result: 6, error: null } });
    });
    await gotoApp(page);
    await setProfileAnkiUrl(page, 'https://anki.example.com');
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/catalog');

    const drawer = await openSettingsSection(page, 'Anki Connect');
    const banner = drawer.getByTestId('anki-url-unconfirmed');
    await expect(banner).toBeVisible();
    await expect(banner.locator('code')).toHaveText('https://anki.example.com');

    // Connect while unconfirmed: refused, and nothing reached the host.
    await drawer.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText(/is not confirmed on this device/)).toBeVisible();
    expect(ankiRequests).toEqual([]);

    await banner.getByRole('button', { name: 'Use this URL' }).click();
    await expect(banner).toBeHidden();
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('anki_connect_confirmed_urls') ?? '{}')
    );
    expect(Object.keys(stored)).toEqual(['https://anki.example.com/']);

    // Confirmed: the connection now goes there.
    await drawer.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect.poll(() => ankiRequests.length).toBeGreaterThan(0);
  });

  test('Anki on this machine needs no confirmation', async ({ page }) => {
    await gotoApp(page);
    const drawer = await openSettingsSection(page, 'Anki Connect');
    await expect(drawer.getByPlaceholder('http://127.0.0.1:8765')).toBeVisible();
    await expect(drawer.getByTestId('anki-url-unconfirmed')).toHaveCount(0);
  });
});

test.describe('AniList login', () => {
  async function answerViewer(page: Page) {
    await page.route('https://graphql.anilist.co/**', (route) =>
      route.fulfill({ json: { data: { Viewer: { id: 7, name: 'Tester' } } } })
    );
  }

  /** Arrive on an AniList callback in a fresh document of this tab. */
  async function arriveWithToken(page: Page, startedMsAgo: number) {
    await page.evaluate((ago) => {
      sessionStorage.setItem(
        'anilist_return',
        JSON.stringify({ hash: '#/catalog', at: Date.now() - ago })
      );
    }, startedMsAgo);
    await page.goto('/?callback=1#access_token=tok-e2e&token_type=Bearer&expires_in=3600');
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/catalog');
  }

  test('a callback for a login abandoned over 10 minutes ago stores nothing', async ({ page }) => {
    await answerViewer(page);
    await gotoApp(page);
    await arriveWithToken(page, 10 * 60 * 1000 + 5_000);

    expect(await page.evaluate(() => localStorage.getItem('anilist_token'))).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem('anilist_return'))).toBeNull();
  });

  test('a fresh login connects, names the account, and explains Disconnect', async ({ page }) => {
    await answerViewer(page);
    await gotoApp(page);
    await arriveWithToken(page, 1_000);

    await expect(page.getByText('Connected to AniList as Tester')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('anilist_token'))).toBe('tok-e2e');

    const drawer = await openSettingsSection(page, 'AniList');
    await expect(drawer.getByText('Connected as Tester')).toBeVisible();
    const note = drawer.getByTestId('anilist-revoke-note');
    await expect(note).toContainText('does not revoke');
    const link = note.getByRole('link', { name: 'anilist.co/settings/apps' });
    await expect(link).toHaveAttribute('href', 'https://anilist.co/settings/apps');

    await drawer.getByRole('button', { name: 'Disconnect' }).click();
    await expect(note).toContainText('Disconnected on this device only');
    expect(await page.evaluate(() => localStorage.getItem('anilist_token'))).toBeNull();
  });

  test('coming back from AniList without a token ends the pending login', async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() =>
      sessionStorage.setItem(
        'anilist_return',
        JSON.stringify({ hash: '#/catalog', at: Date.now() })
      )
    );
    // The app loads again on an ordinary route (Back on AniList's page).
    // The URL already reads #/catalog, so wait for the boot itself: the
    // router's clearing is what is under test.
    await page.goto('/?back=1#/catalog');
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('anilist_return')), {
        timeout: 30000
      })
      .toBeNull();
  });
});
