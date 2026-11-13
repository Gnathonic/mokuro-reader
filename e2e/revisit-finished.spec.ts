import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { PAGES, SERIES_UUID, VOL, counter, installVolume, openVolume } from './helpers/positions';

/**
 * #304: going back to check something in a volume finished long ago keeps it
 * finished and keeps its date; the volume editor can correct that date.
 */

test.describe.configure({ timeout: 90_000 });

const FINISHED = '2025-06-01T12:00:00.000Z';

type Rec = { progress: number; completed: boolean; completedAt?: string; chars: number };

async function record(page: Page): Promise<Rec | null> {
  return page.evaluate(async (VOL) => {
    const { volumesWithTrash } = await import('/src/lib/settings/volume-data.ts');
    let all: Record<string, Rec> = {};
    volumesWithTrash.subscribe((v) => (all = v as Record<string, Rec>))();
    const r = all[VOL];
    return r
      ? { progress: r.progress, completed: r.completed, completedAt: r.completedAt, chars: r.chars }
      : null;
  }, VOL);
}

/** The 50-page volume, read to its end a year ago. */
async function finishedLastYear(page: Page) {
  await gotoApp(page);
  await installVolume(page);
  await page.evaluate(
    async ({ VOL, PAGES, FINISHED }) => {
      const { volumesWithTrash, VolumeData } = await import('/src/lib/settings/volume-data.ts');
      volumesWithTrash.update((all) => ({
        ...all,
        [VOL]: new VolumeData({
          progress: PAGES,
          chars: 0,
          completed: true,
          completedAt: FINISHED,
          lastProgressUpdate: FINISHED,
          series_uuid: 'e2e-swap-series',
          series_title: 'Swap Series',
          volume_title: 'Vol 1'
        })
      }));
    },
    { VOL, PAGES, FINISHED }
  );
}

async function turn(page: Page, key: 'ArrowLeft' | 'ArrowRight', to: number) {
  await page.keyboard.press(key);
  await expect(counter(page, to)).toBeVisible();
}

test('looking back in a finished volume keeps it finished and dated', async ({ page }) => {
  await finishedLastYear(page);
  await openVolume(page);
  // Every volume of the series is finished: the reader offers a re-read first.
  // "Not now" is the look back this test is about.
  await page.locator('dialog button', { hasText: 'Not now' }).click({ timeout: 20000 });
  await expect(counter(page, PAGES)).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);

  // RTL: ArrowRight goes back. Page back to a scene, look at it, leave there.
  for (let p = PAGES - 1; p >= 44; p--) await turn(page, 'ArrowRight', p);
  await page.waitForTimeout(4000);
  await page.evaluate((uuid) => (window.location.hash = `#/series/${uuid}`), SERIES_UUID);
  await page.getByRole('button', { name: 'List' }).click();
  await expect(page.locator('[title="Mark as unread"]').first()).toBeVisible({ timeout: 20000 });

  const after = await record(page);
  expect(after).toMatchObject({ progress: 44, completed: true, completedAt: FINISHED });

  // Back in, and flipped forward to the end again: still the old finish.
  await openVolume(page);
  await expect(counter(page, 44)).toBeVisible({ timeout: 20000 });
  for (let p = 45; p <= PAGES; p++) await turn(page, 'ArrowLeft', p);
  await page.waitForTimeout(1000);
  expect(await record(page)).toMatchObject({ completed: true, completedAt: FINISHED });
});

test('the volume editor corrects a finish date', async ({ page }) => {
  await finishedLastYear(page);
  await page.evaluate((uuid) => (window.location.hash = `#/series/${uuid}`), SERIES_UUID);
  await page.getByRole('button', { name: 'List' }).click();
  await page.locator('[title="Edit volume"]').first().click();

  const field = page.locator('#completed-on');
  await expect(field).toHaveValue(
    await page.evaluate((iso) => {
      const d = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }, FINISHED)
  );
  await field.fill('2025-07-15');
  await page.locator('dialog button', { hasText: /^\s*Save\s*$/ }).click();
  await expect(page.locator('#completed-on')).toHaveCount(0);

  const after = await record(page);
  const local = await page.evaluate((iso) => {
    const d = new Date(iso!);
    return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  }, after!.completedAt);
  expect(local).toEqual([2025, 7, 15]);
  expect(after!.completed).toBe(true);
});
