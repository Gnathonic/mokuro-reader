import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * OCR layers against the REAL app: a seeded one-page volume is opened in the
 * paged reader; a layer is created from the quick-actions picker, displayed,
 * edited (the primary row untouched), promoted (primary updated, original
 * kept), exported as `<title>.<id>.mokuro`; the original layer is
 * read-only; a layer can be deleted.
 */

const SERIES = 'Layers Series';
const SERIES_UUID = 'e2e-layers-series';
const VOLUME_UUID = 'e2e-layers-volume';
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
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('quickActions', true);
      updateSetting('singlePageView', 'single');
      window.localStorage.removeItem('sidecar-backfill:edited-volumes');
    },
    { SERIES, SERIES_UUID, VOLUME_UUID, ORIGINAL_BLOCK }
  );
}

async function openReader(page: Page) {
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

async function openQuickActions(page: Page) {
  const menu = page.getByLabel('Quick actions menu');
  await menu.click();
  // The menu toggles; make sure it is open (the Edit item is always there).
  if (!(await page.getByLabel('Next page', { exact: true }).isVisible())) await menu.click();
}

async function enterEditMode(page: Page) {
  await openQuickActions(page);
  await page.getByLabel('Edit OCR', { exact: true }).click();
  await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
}

async function openLayerPicker(page: Page) {
  await openQuickActions(page);
  await page.getByLabel('OCR layers').click();
  await expect(page.getByRole('dialog', { name: 'OCR layers' })).toBeVisible();
}

async function readState(page: Page) {
  return page.evaluate(async (uuid) => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const ocr = await db.volume_ocr.get(uuid);
    const layers = await db.volume_ocr_layers.where('volume_uuid').equals(uuid).toArray();
    const volumes = JSON.parse(window.localStorage.getItem('volumes') || '{}');
    return {
      primaryLines: ocr?.pages[0].blocks[0]?.lines ?? null,
      layers: Object.fromEntries(
        layers.map((l) => [
          l.layer_id,
          { kind: l.kind, lines: l.pages[0].blocks[0]?.lines ?? null }
        ])
      ),
      setting: volumes[uuid]?.settings?.ocrLayer ?? null
    };
  }, VOLUME_UUID);
}

test.describe('OCR layers', () => {
  test('create a copy layer, display it, edit it, promote it, export it', async ({ page }) => {
    await seedVolume(page);
    await openReader(page);

    // No layers yet: the quick actions menu has no layers entry outside edit mode.
    await openQuickActions(page);
    await expect(page.getByLabel('OCR layers')).toHaveCount(0);
    await page.getByLabel('Quick actions menu').click();

    // In edit mode the picker is offered; it lists Primary only.
    await enterEditMode(page);
    await openLayerPicker(page);
    const picker = page.getByRole('dialog', { name: 'OCR layers' });
    await expect(picker.getByRole('radio')).toHaveCount(1);

    // New layer → copy of the current pages → becomes the displayed layer.
    await picker.getByLabel('New layer').click();
    await page.getByRole('textbox', { name: 'Layer name' }).fill('Fix');
    await page.getByLabel('Confirm layer name').click();
    await expect.poll(async () => (await readState(page)).setting).toBe('fix');
    let state = await readState(page);
    expect(state.layers.fix).toEqual({ kind: 'edit', lines: ['あい'] });
    expect(state.primaryLines).toEqual(['あい']);
    // The picker marks the layer current once the reader has loaded its pages.
    await openLayerPicker(page);
    await expect(picker.getByRole('radio', { name: /Fix/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await picker.getByLabel('Close layers').click();

    // Edit the displayed layer's block: the layer row changes, primary does not.
    await enterEditMode(page);
    const block = page.locator('.editBlock').first();
    await block.dblclick();
    const line = block.locator('[contenteditable]').first();
    await line.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('かきく');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    state = await readState(page);
    expect(state.layers.fix.lines).toEqual(['かきく']);
    expect(state.primaryLines).toEqual(['あい']);

    // Promote: primary takes the layer's text; the previous primary is kept
    // as `original` (none existed); nothing else is snapshotted; display
    // returns to Primary.
    await openLayerPicker(page);
    await page.getByLabel('Promote layer Fix').click();
    await page.getByRole('button', { name: 'Yes' }).click();
    await expect.poll(async () => (await readState(page)).primaryLines).toEqual(['かきく']);
    state = await readState(page);
    expect(state.layers.original).toEqual({ kind: 'original', lines: ['あい'] });
    expect(Object.keys(state.layers).sort()).toEqual(['fix', 'original']);
    expect(state.setting).toBeNull();

    // Export downloads `<title>.<id>.mokuro` holding the layer's pages.
    await openLayerPicker(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByLabel('Export layer Fix').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Vol 1.fix.mokuro');
    const json = JSON.parse(await readFile(await download.path(), 'utf8'));
    expect(json.volume_uuid).toBe(VOLUME_UUID);
    expect(json.pages[0].blocks[0].lines).toEqual(['かきく']);
  });

  test('the L key cycles Primary → each layer → Primary', async ({ page }) => {
    await seedVolume(page);
    await page.evaluate(async (uuid) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      const ocr = await db.volume_ocr.get(uuid);
      const now = new Date().toISOString();
      await db.volume_ocr_layers.put({
        volume_uuid: uuid,
        layer_id: 'fix',
        name: 'Fix',
        kind: 'edit',
        created_at: now,
        updated_at: now,
        pages: ocr!.pages
      });
    }, VOLUME_UUID);
    await openReader(page);
    expect((await readState(page)).setting).toBeNull();

    await page.keyboard.press('l');
    await expect(page.getByText('OCR layer: Fix')).toBeVisible();
    await expect.poll(async () => (await readState(page)).setting).toBe('fix');

    await page.keyboard.press('l');
    await expect(page.getByText('OCR layer: Primary')).toBeVisible();
    await expect.poll(async () => (await readState(page)).setting).toBeNull();
  });

  test('the original layer is read-only; a layer can be deleted', async ({ page }) => {
    await seedVolume(page);
    await page.evaluate(async (uuid) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      const ocr = await db.volume_ocr.get(uuid);
      const now = new Date().toISOString();
      await db.volume_ocr_layers.bulkAdd([
        {
          volume_uuid: uuid,
          layer_id: 'original',
          name: 'Original',
          kind: 'original',
          created_at: now,
          updated_at: now,
          pages: ocr!.pages
        },
        {
          volume_uuid: uuid,
          layer_id: 'scratch',
          name: 'Scratch',
          kind: 'edit',
          created_at: now,
          updated_at: now,
          pages: ocr!.pages
        }
      ]);
    }, VOLUME_UUID);
    await openReader(page);

    // Display the original: Edit is disabled with the reason.
    await openLayerPicker(page);
    await page.getByRole('radio', { name: /Original/ }).click();
    await expect.poll(async () => (await readState(page)).setting).toBe('original');
    await openQuickActions(page);
    const edit = page.getByLabel('Edit OCR', { exact: true });
    await expect(edit).toBeDisabled();
    await expect(edit).toHaveAttribute('title', 'The original layer is read-only');
    await page.getByLabel('Quick actions menu').click();

    // Back to Primary: Edit is enabled again.
    await openLayerPicker(page);
    await page.getByRole('radio', { name: /Primary/ }).click();
    await expect.poll(async () => (await readState(page)).setting).toBeNull();
    await openQuickActions(page);
    await expect(page.getByLabel('Edit OCR', { exact: true })).toBeEnabled();
    await page.getByLabel('Quick actions menu').click();

    // Delete the scratch layer (original offers no delete).
    await openLayerPicker(page);
    await expect(page.getByLabel('Delete layer Original')).toHaveCount(0);
    await page.getByLabel('Delete layer Scratch').click();
    await page.getByRole('button', { name: 'Yes' }).click();
    await expect
      .poll(async () => Object.keys((await readState(page)).layers))
      .toEqual(['original']);
  });
});
