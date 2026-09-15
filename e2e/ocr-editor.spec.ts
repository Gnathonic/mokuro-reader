import { test, expect, type Page } from '@playwright/test';

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

async function seedVolume(page: Page) {
  await page.goto('/');
  await page.waitForTimeout(800);
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOLUME_UUID, ORIGINAL_BLOCK }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      await Promise.all([
        db.volumes.clear(),
        db.volume_ocr.clear(),
        db.volume_files.clear(),
        db.volume_ocr_layers.clear()
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
      const file = new File([blob], '001.png', { type: 'image/png' });
      await db.volumes.put({
        volume_uuid: VOLUME_UUID,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.2.1',
        page_count: 1,
        character_count: 2,
        page_char_counts: [2]
      });
      await db.volume_ocr.put({
        volume_uuid: VOLUME_UUID,
        pages: [
          {
            version: '0.2.1',
            img_width: 400,
            img_height: 600,
            img_path: '001.png',
            blocks: [ORIGINAL_BLOCK]
          }
        ]
      });
      await db.volume_files.put({ volume_uuid: VOLUME_UUID, files: { '001.png': file } });
      // Paged mode with the quick actions visible; no continuous scroll.
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('quickActions', true);
      window.localStorage.removeItem('sidecar-backfill:edited-volumes');
    },
    { SERIES, SERIES_UUID, VOLUME_UUID, ORIGINAL_BLOCK }
  );
}

async function openReader(page: Page) {
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

async function readOcr(page: Page) {
  return page.evaluate(async (uuid) => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const ocr = await db.volume_ocr.get(uuid);
    const row = await db.volumes.get(uuid);
    const original = await db.volume_ocr_layers.get([uuid, 'original']);
    return {
      block: ocr?.pages[0].blocks[0],
      chars: row?.character_count,
      edited: row?.ocr_edited_at,
      original: original?.pages[0].blocks[0]
    };
  }, VOLUME_UUID);
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
    await page.getByLabel('Revert page').click();
    await page.waitForTimeout(1200);
    const reverted = await readOcr(page);
    expect(reverted.block).toEqual(ORIGINAL_BLOCK);
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
