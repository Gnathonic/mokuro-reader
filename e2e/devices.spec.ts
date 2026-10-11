import { test, expect, type Browser, type Page } from '@playwright/test';
import { WebDavStub } from './helpers/webdav-stub';
import { gotoApp } from './helpers/app';

/**
 * Device views (phase 4) on the reading-speed page, in a real browser over
 * the real stores: a single-device user sees no device anywhere; once the
 * history holds another device's reading, the page asks to name this one
 * and lists reading per device, and a name given in either place sticks
 * across a reload. The other device is planted the way a sync would import
 * it: its facts row plus its `page` events, then the recorded-events signal.
 */

const VOL_OWN = 'e2e-devices-own';
const VOL_PHONE = 'e2e-devices-phone';
const PHONE = 'e2e-phone-0001';
const PHONE_LABEL = 'Phone · Android · Chrome';

/** Three 300-char pages read for a minute each, on this device. */
async function readHere(page: Page) {
  await page.evaluate(async (volume) => {
    const { recordEvent } = await import('/src/lib/reading-history/record.ts');
    const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
    const { setIdleOverride } = await import('/src/lib/settings/tracking-data.ts');
    setIdleOverride(12);
    for (let p = 1; p <= 3; p++) {
      await recordEvent({
        kind: 'page',
        volume,
        first_page: p,
        last_page: p,
        page_chars: [300],
        chars_before: (p - 1) * 300,
        dwell_ms: 60_000,
        layout: 'single',
        orientation: 'portrait',
        viewport: { w: 400, h: 800 }
      });
      // The device split counts volumes with a record, as the page does.
      updateProgress(volume, p, p * 300);
    }
  }, VOL_OWN);
}

/** The same reading by another device, as a sync would import it. */
async function readOnPhone(page: Page) {
  await page.evaluate(
    async ({ volume, device }) => {
      const { historyDb } = await import('/src/lib/reading-history/history-db.ts');
      const { notifyEventsRecorded } = await import('/src/lib/reading-history/record.ts');
      const db = historyDb();
      const now = Date.now();
      await db.devices.put({
        device,
        class: 'phone',
        os: 'Android',
        browser: 'Chrome',
        first_seen: new Date(now - 86_400_000).toISOString(),
        last_seen: new Date(now).toISOString()
      });
      const events = [1, 2, 3].map((p) => ({
        kind: 'page' as const,
        volume,
        first_page: p,
        last_page: p,
        page_chars: [300],
        chars_before: (p - 1) * 300,
        dwell_ms: 60_000,
        layout: 'single' as const,
        orientation: 'portrait' as const,
        viewport: { w: 400, h: 800 },
        device,
        seq: p,
        t: now - (4 - p) * 60_000
      }));
      await db.reading_events.bulkAdd(events);
      notifyEventsRecorded(events);
      (await import('/src/lib/settings/volume-data.ts')).updateProgress(volume, 3, 900);
    },
    { volume: VOL_PHONE, device: PHONE }
  );
}

/** Counted time for a volume, once the stats store has caught up. */
async function countedMs(page: Page, volume: string): Promise<number> {
  return page.evaluate(async (volume) => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    stats.flushReadingStats();
    let ms = 0;
    stats.readingStats.subscribe((s) => (ms = s.byVolume.get(volume)?.timeMs ?? 0))();
    return ms;
  }, volume);
}

async function openStats(page: Page) {
  await page.evaluate(() => (window.location.hash = '#/reading-speed'));
  await expect(page.getByRole('heading', { name: 'Reading Speed History' })).toBeVisible();
}

test.describe('device views on the stats page', () => {
  test('one device shows none; a second brings the banner and the device list, and names stick', async ({
    page
  }) => {
    await gotoApp(page);
    await readHere(page);
    await expect.poll(() => countedMs(page, VOL_OWN), { timeout: 15000 }).toBeGreaterThan(0);
    await openStats(page);
    await expect(page.getByText('Achievements', { exact: true })).toBeVisible();
    await expect(page.getByTestId('device-banner')).toHaveCount(0);
    await expect(page.getByTestId('device-stats')).toHaveCount(0);

    await readOnPhone(page);
    const banner = page.getByTestId('device-banner');
    await expect(banner).toContainText('You read on 2 devices — name this one?', {
      timeout: 15000
    });
    const card = page.getByTestId('device-stats');
    const rows = card.getByTestId('device-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('This device');
    await expect(rows.nth(1).getByTestId('device-name')).toHaveText(PHONE_LABEL);
    await expect(rows.nth(1)).toContainText('3 min');
    await expect(rows.nth(1)).toContainText('900 chars');
    await expect(rows.nth(1)).toContainText('50% of time');

    // Inline rename of the other device.
    await rows.nth(1).getByRole('button', { name: PHONE_LABEL }).click();
    const field = rows.nth(1).getByRole('textbox');
    await expect(field).toBeFocused();
    await field.fill('Pixel 8');
    await field.press('Enter');
    await expect(rows.nth(1).getByTestId('device-name')).toHaveText('Pixel 8');

    // Name this device from the banner: it stays put, confirmed.
    const own = banner.getByRole('textbox');
    await own.fill('Work laptop');
    await own.press('Enter');
    await expect(banner).toContainText('Saved.');
    await expect(rows.nth(0).getByTestId('device-name')).toHaveText('Work laptop');

    // Both names survive a reload; a named device is not asked again.
    await gotoApp(page);
    await openStats(page);
    await expect(page.getByTestId('device-stats').getByTestId('device-name')).toHaveText(
      ['Work laptop', 'Pixel 8'],
      { timeout: 15000 }
    );
    await expect(page.getByTestId('device-banner')).toHaveCount(0);
  });

  test('"Not now" hides the banner in this browser, across reloads', async ({ page }) => {
    await gotoApp(page);
    await readHere(page);
    await readOnPhone(page);
    await openStats(page);
    const banner = page.getByTestId('device-banner');
    await expect(banner).toBeVisible({ timeout: 15000 });
    await banner.getByRole('button', { name: 'Not now' }).click();
    await expect(banner).toHaveCount(0);

    await gotoApp(page);
    await openStats(page);
    // The device list proves the stats are in; the banner still stays away.
    await expect(page.getByTestId('device-stats').getByTestId('device-row')).toHaveCount(2, {
      timeout: 15000
    });
    await expect(page.getByTestId('device-banner')).toHaveCount(0);
  });
});
