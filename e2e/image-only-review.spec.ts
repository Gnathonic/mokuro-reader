import { test as base, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * The image-only review (#285) in the real app: picked files, the review
 * dialog, the queue and IndexedDB. Uses the owner's layouts —
 * "Chained Soldier (Semi-Color)/01..", "Killing Bites/Killing Bites 01.." —
 * plus loose .cbz files, the way phones import.
 */

/**
 * WebKit runs on a persistent profile. Its ephemeral contexts (Playwright's
 * default, like private browsing) refuse Blob/File values in IndexedDB —
 * "UnknownError: Error preparing Blob/File data to be stored in object store" —
 * and every import stores its pages as File objects, so on the default context
 * no volume could ever save, on any build of the app.
 */
const test = base.extend({
  context: async (
    { context, browserName, playwright, baseURL, viewport, hasTouch },
    use,
    testInfo
  ) => {
    if (browserName !== 'webkit') return use(context);
    const persistent = await playwright.webkit.launchPersistentContext(
      testInfo.outputPath('webkit-profile'),
      { baseURL, viewport, hasTouch }
    );
    await use(persistent);
    await persistent.close();
  }
});

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

function put(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG);
}

/** Loose `.cbz` archives with one page at their root, like a phone's Downloads. */
function looseArchives(root: string, names: string[]): string[] {
  return names.map((name) => {
    const pages = mkdtempSync(join(root, 'pages-'));
    put(join(pages, '001.png'));
    const cbz = join(root, `${name}.cbz`);
    execFileSync('zip', ['-q', '-j', cbz, join(pages, '001.png')]);
    return cbz;
  });
}

// The navbar's icon cluster (`gap-3 sm:gap-5 md:order-2`): stats, progress
// tracker, settings, then the upload icon that opens the Import modal.
const uploadButton = (page: Page) => page.locator('nav div.md\\:order-2 > button').nth(3);
const review = (page: Page) => page.locator('[data-testid="image-only-review"]');
const stepLabel = (page: Page) => review(page).locator('[data-testid="review-step"]');
const seriesField = (page: Page) => review(page).locator('[data-testid="review-series"]');
const names = (page: Page) => review(page).locator('[data-testid="review-volume-name"]');
const reviewButton = (page: Page, text: string) =>
  review(page).locator('button', { hasText: new RegExp(`^\\s*${text}\\s*$`) });
/** A step that replaces a decided one ignores clicks for a moment (a double click guard). */
const armed = (page: Page) =>
  expect(review(page).locator('[data-testid="review-step-body"]')).toHaveAttribute(
    'data-armed',
    'true'
  );
const nameValues = (page: Page) =>
  names(page).evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(uploadButton(page)).toBeVisible({ timeout: 20_000 });
}

/** Pick through the real Import modal (nav icon → choose files/folder → Import). */
async function pick(
  page: Page,
  button: 'choose files' | 'choose folder',
  paths: string | string[]
) {
  await uploadButton(page).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('dialog button', { hasText: button }).click();
  await (await chooser).setFiles(paths);
  // Flowbite's Button renders "Import " (trailing whitespace), so anchor loosely.
  await page.locator('dialog button', { hasText: /^\s*Import\s*$/ }).click();
}

/** `importFiles` straight from the page — what a drop or a second pick calls. */
async function importInPage(page: Page, entries: { path: string; b64: string }[]) {
  await page.evaluate(async (items) => {
    const { importFiles } = await import('/src/lib/import/index.ts');
    const files = items.map(({ path, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], path.split('/').pop()!);
      if (path.includes('/')) Object.defineProperty(file, 'webkitRelativePath', { value: path });
      return file;
    });
    void importFiles(files);
  }, entries);
}

async function savedTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    return (await db.volumes.toArray())
      .filter((r) => !r.metadata_only)
      .map((r) => `${r.series_title} / ${r.volume_title}`)
      .sort();
  });
}

test('picked loose .cbz files are reviewed as one series and import', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'review-e2e-'));
  const cbz = looseArchives(root, ['Dorohedoro v01', 'Dorohedoro v02', 'Dorohedoro v03']);
  await openApp(page);
  await pick(page, 'choose files', cbz);

  await expect(stepLabel(page)).toHaveText('Series 1 of 1');
  await expect(seriesField(page)).toHaveValue('Dorohedoro');
  await expect
    .poll(() => nameValues(page))
    .toEqual(['Dorohedoro 01', 'Dorohedoro 02', 'Dorohedoro 03']);
  await expect(review(page).locator('[data-testid="review-volume-source"]')).toHaveText([
    'Dorohedoro v01.cbz',
    'Dorohedoro v02.cbz',
    'Dorohedoro v03.cbz'
  ]);
  await reviewButton(page, 'Import').click();
  await expect(review(page)).toBeHidden();
  await expect
    .poll(() => savedTitles(page), { timeout: 30_000 })
    .toEqual([
      'Dorohedoro / Dorohedoro 01',
      'Dorohedoro / Dorohedoro 02',
      'Dorohedoro / Dorohedoro 03'
    ]);
});

test("the owner's layouts: one step per series, and series 1 imports while series 2 is on screen", async ({
  page,
  browserName
}) => {
  test.skip(
    browserName !== 'chromium',
    'folder picking (webkitdirectory) is exercised in Chromium'
  );
  const root = mkdtempSync(join(tmpdir(), 'review-e2e-'));
  const library = join(root, 'library');
  for (const v of ['01', '02', '03'])
    put(join(library, 'Chained Soldier (Semi-Color)', v, '001.png'));
  for (const v of ['Killing Bites 01', 'Killing Bites 02'])
    put(join(library, 'Killing Bites', v, '001.png'));
  const loose = looseArchives(root, ['Dorohedoro v01', 'Dorohedoro v02']);

  await openApp(page);
  // The library already holds two Killing Bites volumes (removed from this device).
  await page.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    await db.volumes.bulkPut(
      [1, 2].map((n) => ({
        volume_uuid: `seed-kb-${n}`,
        series_uuid: 'seed-kb',
        series_title: 'Killing Bites',
        volume_title: `Killing Bites 0${n}`,
        mokuro_version: '',
        page_count: 1,
        character_count: 0,
        page_char_counts: [0],
        metadata_only: true as const
      }))
    );
  });

  await pick(page, 'choose folder', library);
  await expect(stepLabel(page)).toHaveText('Series 1 of 2');
  // A second import while the review is open joins it.
  await importInPage(
    page,
    loose.map((p) => ({ path: basename(p), b64: readFileSync(p).toString('base64') }))
  );
  await expect(stepLabel(page)).toHaveText('Series 1 of 3');

  // Series 1: rename one volume, try both modes, start at 5.
  await expect(seriesField(page)).toHaveValue('Chained Soldier (Semi-Color)');
  await expect
    .poll(() => nameValues(page))
    .toEqual([
      'Chained Soldier (Semi-Color) 01',
      'Chained Soldier (Semi-Color) 02',
      'Chained Soldier (Semi-Color) 03'
    ]);
  await names(page).nth(2).fill('Chained Soldier Extra');
  await reviewButton(page, 'Folder names').click();
  await expect.poll(() => nameValues(page)).toEqual(['01', '02', 'Chained Soldier Extra']);
  await reviewButton(page, 'Cleaned up').click();
  await review(page).locator('[data-testid="review-start"]').fill('5');
  await expect
    .poll(() => nameValues(page))
    .toEqual([
      'Chained Soldier (Semi-Color) 05',
      'Chained Soldier (Semi-Color) 06',
      'Chained Soldier Extra'
    ]);
  await reviewButton(page, 'Import').click();

  // Series 2 is on screen while series 1 imports.
  await expect(stepLabel(page)).toHaveText('Series 2 of 3');
  await expect
    .poll(() => savedTitles(page), { timeout: 30_000 })
    .toEqual([
      'Chained Soldier (Semi-Color) / Chained Soldier (Semi-Color) 05',
      'Chained Soldier (Semi-Color) / Chained Soldier (Semi-Color) 06',
      'Chained Soldier (Semi-Color) / Chained Soldier Extra'
    ]);
  await expect(stepLabel(page)).toHaveText('Series 2 of 3');

  // Series 2 continues after the volumes the library already has.
  await expect(seriesField(page)).toHaveValue('Killing Bites');
  await expect(review(page).locator('[data-testid="review-start"]')).toHaveValue('3');
  await expect.poll(() => nameValues(page)).toEqual(['Killing Bites 03', 'Killing Bites 04']);
  await expect(review(page).locator('datalist option[value="Killing Bites"]')).toHaveCount(1);
  await armed(page);
  await reviewButton(page, 'Import').click();

  // Series 3, the loose archives: skipped.
  await expect(stepLabel(page)).toHaveText('Series 3 of 3');
  await expect(seriesField(page)).toHaveValue('Dorohedoro');
  await armed(page);
  await reviewButton(page, 'Skip').click();
  await expect(review(page)).toBeHidden();

  await expect
    .poll(() => savedTitles(page), { timeout: 30_000 })
    .toEqual([
      'Chained Soldier (Semi-Color) / Chained Soldier (Semi-Color) 05',
      'Chained Soldier (Semi-Color) / Chained Soldier (Semi-Color) 06',
      'Chained Soldier (Semi-Color) / Chained Soldier Extra',
      'Killing Bites / Killing Bites 03',
      'Killing Bites / Killing Bites 04'
    ]);
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('one column, the list scrolls, the buttons stay on screen; closing skips everything', async ({
    page
  }, testInfo) => {
    await openApp(page);
    await importInPage(
      page,
      Array.from({ length: 30 }, (_, i) => ({
        path: `Long Series/${String(i + 1).padStart(2, '0')}/001.png`,
        b64: PNG_B64
      }))
    );
    await expect(stepLabel(page)).toHaveText('Series 1 of 1');

    const layout = () =>
      page.evaluate(() => {
        const dialog = document
          .querySelector('[data-testid="image-only-review"]')!
          .getBoundingClientRect();
        const list = document.querySelector('[data-testid="review-volumes"]') as HTMLElement;
        const importButton = [
          ...document.querySelectorAll('[data-testid="image-only-review"] button')
        ]
          .find((b) => b.textContent?.trim() === 'Import')!
          .getBoundingClientRect();
        return {
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          dialogLeft: dialog.left,
          dialogRight: dialog.right,
          width: window.innerWidth,
          height: window.innerHeight,
          listScrolls: list.scrollHeight > list.clientHeight,
          importBottom: importButton.bottom
        };
      });

    // The dialog fades in; screenshot it once its opening animation is over.
    await expect
      .poll(() =>
        page.evaluate(() =>
          document
            .querySelector('[data-testid="image-only-review"]')!
            .getAnimations({ subtree: true })
            .every((a) => a.playState !== 'running')
        )
      )
      .toBe(true);
    const before = await layout();
    await page.screenshot({ path: testInfo.outputPath('review-phone.png') });
    expect(before.pageOverflow).toBeLessThanOrEqual(0);
    expect(before.dialogLeft).toBeGreaterThanOrEqual(0);
    expect(before.dialogRight).toBeLessThanOrEqual(before.width);
    expect(before.listScrolls).toBe(true);
    expect(before.importBottom).toBeLessThanOrEqual(before.height);

    // Editing a name (where a phone raises its keyboard) keeps the buttons on screen.
    await names(page).nth(29).focus();
    const editing = await layout();
    expect(editing.importBottom).toBeLessThanOrEqual(editing.height);

    await review(page).locator('[data-testid="review-close"]').click();
    await expect(review(page)).toBeHidden();
    // An approval enqueues the moment it is made, so by now a skip-all has left
    // nothing queued — no settle delay needed to prove nothing will import.
    expect(
      await page.evaluate(async () => {
        const { importQueue } = await import('/src/lib/import/import-service.ts');
        let queued = -1;
        importQueue.subscribe((items) => (queued = items.length))();
        return queued;
      })
    ).toBe(0);
    expect(await savedTitles(page)).toEqual([]);
  });
});
