import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';

/**
 * The in-reader OCR editor against the REAL app: a seeded one-page volume is
 * opened in the paged reader, edited through the overlay (move, resize, text),
 * reloaded, and the persisted OCR row is asserted on; then "Revert page"
 * restores the original layer.
 */

const SERIES = 'Editor Series';
const SERIES_UUID = 'e2e-editor-series';
const VOLUME_UUID = 'e2e-editor-volume';
const ORIGINAL_BLOCK = { box: [250, 50, 310, 250], vertical: true, font_size: 30, lines: ['あい'] };

async function seedVolume(page: Page, opts: { pages?: number; view?: 'single' | 'dual' } = {}) {
  const pageCount = opts.pages ?? 1;
  const view = opts.view ?? 'single';
  await gotoApp(page);
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOLUME_UUID, ORIGINAL_BLOCK, pageCount, view }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      await Promise.all([
        db.volumes.clear(),
        db.volume_ocr.clear(),
        db.volume_files.clear(),
        (await import('/src/lib/catalog/layer-store.ts')).clearAllLayers(db)
      ]);
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 600;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 400, 600);
      ctx.fillStyle = '#ccc';
      ctx.fillRect(250, 50, 60, 200);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const names = Array.from({ length: pageCount }, (_, i) => `00${i + 1}.png`);
      const files: Record<string, File> = {};
      for (const name of names) files[name] = new File([blob], name, { type: 'image/png' });
      await db.volumes.put({
        volume_uuid: VOLUME_UUID,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.2.1',
        page_count: pageCount,
        character_count: 2 * pageCount,
        page_char_counts: names.map((_, i) => 2 * (i + 1))
      });
      await db.volume_ocr.put({
        volume_uuid: VOLUME_UUID,
        // Every page carries the same block, so a test can tell WHICH page an
        // action touched only by the page it reads back.
        pages: names.map((name) => ({
          version: '0.2.1',
          img_width: 400,
          img_height: 600,
          img_path: name,
          blocks: [structuredClone(ORIGINAL_BLOCK)]
        }))
      });
      await db.volume_files.put({ volume_uuid: VOLUME_UUID, files });
      // Paged mode with the quick actions visible; no continuous scroll.
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('quickActions', true);
      updateSetting('singlePageView', view);
      window.localStorage.removeItem('sidecar-backfill:edited-volumes');
    },
    { SERIES, SERIES_UUID, VOLUME_UUID, ORIGINAL_BLOCK, pageCount, view }
  );
}

async function openReader(page: Page) {
  // Let the catalog settle on the freshly seeded rows before the route
  // changes — a hash set mid-reaction bounces back to the catalog.
  await page.waitForTimeout(800);
  await page.evaluate(
    ({ SERIES_UUID, VOLUME_UUID }) => {
      window.location.hash = `#/reader/${SERIES_UUID}/${VOLUME_UUID}`;
    },
    { SERIES_UUID, VOLUME_UUID }
  );
  await expect(page.locator('[data-page-index="0"]')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(500);
}

async function enterEditMode(page: Page) {
  await page.getByLabel('Quick actions menu').click();
  await page.getByLabel('Edit OCR').click();
  await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
}

async function readOcr(page: Page, pageIndex = 0) {
  return page.evaluate(
    async ({ uuid, pageIndex }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      const ocr = await db.volume_ocr.get(uuid);
      const row = await db.volumes.get(uuid);
      const { getLayerWithPages } = await import('/src/lib/catalog/layer-store.ts');
      const original = await getLayerWithPages(db, uuid, 'original');
      return {
        block: ocr?.pages[pageIndex].blocks[0],
        chars: row?.character_count,
        edited: row?.ocr_edited_at,
        original: original?.pages[pageIndex].blocks[0]
      };
    },
    { uuid: VOLUME_UUID, pageIndex }
  );
}

test.describe('OCR editor', () => {
  test('move, resize and a text edit persist across a reload; revert restores the original', async ({
    page
  }) => {
    await seedVolume(page);
    await openReader(page);
    await enterEditMode(page);

    const block = page.locator('.editBlock').first();
    await expect(block).toBeVisible();

    // Move: drag the body 40px right, 20px down (screen px). The page renders
    // at some zoom, so the image-px delta is derived from the measured box.
    const before = await block.boundingBox();
    const scale = before!.width / 60; // the box is 60 image px wide
    const cx = before!.x + before!.width / 2;
    const cy = before!.y + before!.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 20, { steps: 8 });
    await page.mouse.up();

    // Resize: drag the south-east handle 20px right.
    const se = block.locator('[data-edit-handle="se"]');
    await expect(se).toBeVisible();
    const seBox = await se.boundingBox();
    await page.mouse.move(seBox!.x + 5, seBox!.y + 5);
    await page.mouse.down();
    await page.mouse.move(seBox!.x + 25, seBox!.y + 5, { steps: 8 });
    await page.mouse.up();

    // Text: double click, replace the one line, Escape commits.
    await block.dblclick();
    const line = block.locator('[contenteditable]').first();
    await expect(line).toBeVisible();
    await line.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('かきく');
    await page.keyboard.press('Escape');

    // Autosave (500 ms debounce)
    await page.waitForTimeout(1200);
    const saved = await readOcr(page);
    const dx = 40 / scale;
    const dy = 20 / scale;
    expect(saved.block!.lines).toEqual(['かきく']);
    expect(saved.block!.box[0]).toBeCloseTo(250 + dx, 0);
    expect(saved.block!.box[1]).toBeCloseTo(50 + dy, 0);
    expect(saved.block!.box[2]).toBeCloseTo(310 + dx + 20 / scale, 0);
    expect(saved.chars).toBe(3);
    expect(typeof saved.edited).toBe('string');
    expect(saved.original).toEqual(ORIGINAL_BLOCK);

    await page.reload();
    await openReader(page);
    const after = await readOcr(page);
    expect(after.block).toEqual(saved.block);

    await enterEditMode(page);
    // The edited text is what the overlay shows before the revert…
    const shownBefore = page.locator('.editBlock .line').first();
    await expect(shownBefore).toHaveText('かきく');
    await page.getByLabel('Revert page').click();
    // …and the ORIGINAL text is what it shows after: the model change must
    // reach the DOM, not just the database (regression: stable-keyed line
    // elements whose text was written once at mount).
    await expect(page.locator('.editBlock .line').first()).toHaveText(ORIGINAL_BLOCK.lines[0]);
    // Undo the revert: the edited text comes back on screen too.
    await page.keyboard.press('Control+Z');
    await expect(page.locator('.editBlock .line').first()).toHaveText('かきく');
    await page.keyboard.press('Control+Shift+Z');
    await page.waitForTimeout(1200);
    const reverted = await readOcr(page);
    expect(reverted.block).toEqual(ORIGINAL_BLOCK);
  });

  test('on a two-page spread, undo and revert act on the page that was edited', async ({
    page
  }) => {
    await seedVolume(page, { pages: 2, view: 'dual' });
    // Let the catalog settle on the new rows before the route changes.
    await page.waitForTimeout(1000);
    await openReader(page);
    // A fresh volume defaults to "has cover", which shows page 0 alone; the
    // spread needs it off so pages 0 and 1 render together.
    await page.evaluate(async (uuid) => {
      const { updateVolumeSetting } = await import('/src/lib/settings/index.ts');
      updateVolumeSetting(uuid, 'hasCover', false);
    }, VOLUME_UUID);
    await expect(page.locator('[data-page-index="1"]')).toBeVisible({ timeout: 20000 });
    await enterEditMode(page);

    // Edit the RIGHT-hand page's block (page index 1). The reader's own page
    // index is the left one — the regression was every history/revert call
    // going there, so the right page's edits could never be undone or reverted.
    const rightBlock = page.locator('[data-page-index="1"] .editBlock').first();
    await expect(rightBlock).toBeVisible();
    await rightBlock.dblclick();
    const line = rightBlock.locator('[contenteditable]').first();
    await expect(line).toBeVisible();
    await line.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('さしす');
    await page.keyboard.press('Escape');
    await expect(rightBlock.locator('.line').first()).toHaveText('さしす');

    // Undo reaches the right page: the text comes back on screen and the left
    // page is untouched throughout.
    await page.getByLabel('Undo').click();
    await expect(rightBlock.locator('.line').first()).toHaveText(ORIGINAL_BLOCK.lines[0]);
    await page.getByLabel('Redo').click();
    await expect(rightBlock.locator('.line').first()).toHaveText('さしす');

    // Persist, then revert: the right page returns to its original, and the
    // left page's row was never written.
    await page.waitForTimeout(1200);
    expect((await readOcr(page, 1)).block!.lines).toEqual(['さしす']);
    expect((await readOcr(page, 0)).block).toEqual(ORIGINAL_BLOCK);
    await page.getByLabel('Revert page').click();
    await expect(rightBlock.locator('.line').first()).toHaveText(ORIGINAL_BLOCK.lines[0]);
    await page.waitForTimeout(1200);
    expect((await readOcr(page, 1)).block).toEqual(ORIGINAL_BLOCK);
    expect(page.locator('[data-page-index="0"] .editBlock .line').first()).toHaveText(
      ORIGINAL_BLOCK.lines[0]
    );
  });

  test('the Edit entry is disabled in continuous scroll mode', async ({ page }) => {
    await seedVolume(page);
    await openReader(page);
    await page.evaluate(async () => {
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', true);
    });
    await page.waitForTimeout(500);
    await page.getByLabel('Quick actions menu').click();
    await expect(page.getByLabel('Edit OCR')).toBeDisabled();
  });
});

test.describe('OCR editor — entry points', () => {
  test('the E hotkey toggles edit mode', async ({ page }) => {
    await seedVolume(page);
    await openReader(page);
    // Keyboard shortcuts are window-level; nothing needs focus first.
    await page.keyboard.press('e');
    await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
    await page.keyboard.press('e');
    await expect(page.locator('[data-edit-toolbar]')).toBeHidden();
  });

  test('the settings toggle enters and leaves edit mode', async ({ page }) => {
    await seedVolume(page);
    await openReader(page);
    await page.evaluate(async () => {
      const { requestEditMode } = await import('/src/lib/reader/edit/edit-mode.ts');
      requestEditMode(true);
    });
    await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
    await page.evaluate(async () => {
      const { requestEditMode } = await import('/src/lib/reader/edit/edit-mode.ts');
      requestEditMode(false);
    });
    await expect(page.locator('[data-edit-toolbar]')).toBeHidden();
  });

  test('"Edit this text" in the text box menu opens the editor on that block with the first line focused', async ({
    page
  }) => {
    await seedVolume(page);
    await page.evaluate(async () => {
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('textBoxContextMenu', true);
      updateSetting('alwaysShowOCR', true);
    });
    await openReader(page);
    const box = page.locator('.textBox').first();
    await expect(box).toBeVisible();
    await box.click({ button: 'right' });
    await page.getByText('Edit this text').click();
    await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
    const block = page.locator('.editBlock').first();
    await expect(block).toHaveClass(/selected/);
    const line = block.locator('[contenteditable]').first();
    await expect(line).toBeVisible();
    await expect(line).toBeFocused();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('さしす');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    const saved = await readOcr(page);
    expect(saved.block!.lines).toEqual(['さしす']);
  });
});
