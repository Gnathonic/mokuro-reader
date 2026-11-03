import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';

/**
 * A series card that APPEARS while the catalog is on screen must draw its covers.
 *
 * Regression for "covers latch blank as downloads come in": a series' first installed
 * volume moves its card from the cloud list into the library list, so it mounts as a
 * brand-new keyed `{#each}` item mid-update. On Svelte 5.43 such an item rendered its
 * markup (the canvas, the per-spine download badges sized from the row) but its effects
 * and `use:` actions NEVER ran — no draw, no cover request — until something remounted
 * it (a refresh or a navigation). Fixed upstream in Svelte's batch scheduler; measured
 * against this spec on clean installs: 5.43.14, 5.43.15 and 5.44.0 latch; 5.56.4 and
 * every later release tried pass. 5.45.0-5.56.3 cannot be tested here — their compiler
 * emits invalid JS for flowbite-svelte's TS optional parameters (fixed in 5.56.4,
 * sveltejs/svelte#18448) — so `package.json` pins the floor at 5.56.4, the lowest
 * release that both builds this app and passes.
 *
 * It needs a catalog of some size and arrivals in a steady stream; one new series into
 * an empty catalog does not reproduce it. No cloud is involved: rows are written straight
 * to Dexie, the way a finished download's `saveVolume` lands them.
 */

const SERIES = 60;
const ARRIVALS = 60;

async function seed(page: Page) {
  await page.evaluate(async (SERIES) => {
    const { db } = await import('/src/lib/catalog/db.ts');
    await db.open();
    await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_files.clear()]);
    const cvs = document.createElement('canvas');
    cvs.width = 250;
    cvs.height = 350;
    const c = cvs.getContext('2d')!;
    const rows = [];
    for (let s = 0; s < SERIES; s++) {
      for (let v = 0; v < 3; v++) {
        c.fillStyle = `hsl(${(s * 37 + v * 11) % 360} 70% 50%)`;
        c.fillRect(0, 0, 250, 350);
        const blob: Blob = await new Promise((r) => cvs.toBlob((b) => r(b!), 'image/webp'));
        const title = `Series ${String(s).padStart(2, '0')}`;
        rows.push({
          volume_uuid: `vol-${s}-${v}`,
          series_uuid: `series-${s}`,
          series_title: title,
          volume_title: `${title} ${v + 1}`,
          mokuro_version: '0.2.0',
          page_count: 10,
          character_count: 100,
          page_char_counts: [],
          thumbnail: new File([blob], 'cover.webp', { type: 'image/webp' }),
          thumbnail_width: 250,
          thumbnail_height: 350
        });
      }
    }
    await db.volumes.bulkPut(rows);
  }, SERIES);
}

/** A new series' first volume lands, sorted in among the ones already on screen. */
async function arrive(page: Page, i: number) {
  await page.evaluate(async (i) => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const cvs = document.createElement('canvas');
    cvs.width = 250;
    cvs.height = 350;
    const c = cvs.getContext('2d')!;
    c.fillStyle = `hsl(${(i * 53) % 360} 80% 40%)`;
    c.fillRect(0, 0, 250, 350);
    const blob: Blob = await new Promise((r) => cvs.toBlob((b) => r(b!), 'image/webp'));
    // "Series 00a", "Series 01a", … then "Series 00b": each lands next to a seeded series.
    const title = `Series ${String(i % 30).padStart(2, '0')}${String.fromCharCode(97 + Math.floor(i / 30))}`;
    await db.volumes.put({
      volume_uuid: `new-${i}`,
      series_uuid: `series-new-${i}`,
      series_title: title,
      volume_title: `${title} 1`,
      mokuro_version: '0.2.0',
      page_count: 10,
      character_count: 100,
      page_char_counts: [],
      thumbnail: new File([blob], 'cover.webp', { type: 'image/webp' }),
      thumbnail_width: 250,
      thumbnail_height: 350
    });
  }, i);
}

/** Every card inside the viewport, and whether its canvas has any pixels. */
function onScreenCards(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const a of Array.from(document.querySelectorAll('a[href^="#/series/"]'))) {
      const r = a.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const title = a.querySelector('p')?.textContent?.trim() ?? '?';
      const canvases = Array.from(a.querySelectorAll('canvas')) as HTMLCanvasElement[];
      let painted = false;
      for (const cv of canvases) {
        const ctx = cv.getContext('2d');
        if (!ctx || !cv.width || !cv.height) continue;
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        for (let i = 3; i < d.length; i += 4 * 53)
          if (d[i] !== 0) {
            painted = true;
            break;
          }
        if (painted) break;
      }
      out.push(`${painted ? 'painted' : canvases.length ? 'BLANK' : 'NO-CANVAS'}|${title}`);
    }
    return out;
  });
}

test('series cards that appear mid-session draw their covers', async ({ page }) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1890, height: 1000 });
  await gotoApp(page);
  await seed(page);
  await expect
    .poll(async () => (await onScreenCards(page)).filter((c) => c.startsWith('painted')).length, {
      timeout: 30000
    })
    .toBeGreaterThan(0);

  for (let i = 0; i < ARRIVALS; i++) {
    await arrive(page, i);
    await page.waitForTimeout(250);
  }

  let cards: string[] = [];
  await expect
    .poll(
      async () => {
        cards = await onScreenCards(page);
        return cards.filter((c) => !c.startsWith('painted'));
      },
      { timeout: 20000, message: 'on-screen cards that never drew a cover' }
    )
    .toEqual([]);
  // The arrivals must actually be among what was checked, or this proves nothing.
  expect(
    cards.some((c) => /\|Series \d\d[ab]$/.test(c)),
    cards.join('\n')
  ).toBe(true);
});
