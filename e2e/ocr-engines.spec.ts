import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * The experimental engines against the REAL app, with the HTTP APIs stubbed
 * by `page.route`: no key → no engine actions; "OCR this page" → a `gcv`
 * layer from a recorded-shape Cloud Vision reply; "Translate this page" → a
 * `tr-en` layer from a Gemini reply; a whole-volume run asks first with the
 * page count and cost; the settings card persists a key to localStorage only.
 * No real API call is made anywhere in this file.
 */

const SERIES = 'Engines Series';
const SERIES_UUID = 'e2e-engines-series';
const VOLUME_UUID = 'e2e-engines-volume';
const ORIGINAL_BLOCK = { box: [250, 50, 310, 250], vertical: true, font_size: 30, lines: ['あい'] };
const VISION = 'https://vision.googleapis.com/**';
const GEMINI = 'https://generativelanguage.googleapis.com/**';

async function seedVolume(page: Page, opts: { pages?: number; googleKey?: string } = {}) {
  const pageCount = opts.pages ?? 1;
  await page.goto('/');
  await page.waitForTimeout(800);
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOLUME_UUID, ORIGINAL_BLOCK, pageCount, googleKey }) => {
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
        pages: names.map((name) => ({
          version: '0.2.1',
          img_width: 400,
          img_height: 600,
          img_path: name,
          blocks: [structuredClone(ORIGINAL_BLOCK)]
        }))
      });
      await db.volume_files.put({ volume_uuid: VOLUME_UUID, files });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('quickActions', true);
      updateSetting('singlePageView', 'single');
      for (const k of [
        'engine_google_key',
        'engine_anthropic_key',
        'engine_openai_key',
        'engine_openai_base_url',
        'engine_openai_model'
      ])
        window.localStorage.removeItem(k);
      if (googleKey) window.localStorage.setItem('engine_google_key', googleKey);
      window.localStorage.removeItem('miscSettings');
    },
    { SERIES, SERIES_UUID, VOLUME_UUID, ORIGINAL_BLOCK, pageCount, googleKey: opts.googleKey }
  );
  // The credentials store reads localStorage at module load: reload so the
  // seeded key is what the app sees.
  await page.reload();
  await page.waitForTimeout(800);
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
  if (!(await page.getByLabel('Next page', { exact: true }).isVisible())) await menu.click();
}

async function readLayers(page: Page) {
  return page.evaluate(async (uuid) => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const layers = await db.volume_ocr_layers.where('volume_uuid').equals(uuid).toArray();
    const volumes = JSON.parse(window.localStorage.getItem('volumes') || '{}');
    return {
      layers: Object.fromEntries(
        layers.map((l) => [
          l.layer_id,
          {
            kind: l.kind,
            engine: l.engine,
            pages: l.pages.map((p) =>
              p.blocks.map((b) => ({ lines: b.lines, vertical: b.vertical }))
            )
          }
        ])
      ),
      setting: volumes[uuid]?.settings?.ocrLayer ?? null
    };
  }, VOLUME_UUID);
}

async function stubVision(page: Page) {
  const fixture = await readFile('src/lib/engines/__fixtures__/gcv-vertical.json', 'utf8');
  let calls = 0;
  await page.route(VISION, async (route) => {
    calls++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: fixture });
  });
  return () => calls;
}

async function stubGemini(page: Page, text: string) {
  await page.route(GEMINI, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    // index-aligned reply for every block the prompt listed
    const prompt: string = body.contents?.[0]?.parts?.[0]?.text ?? '';
    const listed = [...prompt.matchAll(/"index": (\d+)/g)].map((m) => Number(m[1]));
    const reply = JSON.stringify(listed.map((index) => ({ index, text })));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] } }] })
    });
  });
}

test.describe('OCR & translation engines', () => {
  test('without a key there are no engine actions anywhere', async ({ page }) => {
    await seedVolume(page);
    await openReader(page);
    await openQuickActions(page);
    await expect(page.getByLabel('OCR this page')).toHaveCount(0);
    await expect(page.getByLabel('Translate this page')).toHaveCount(0);
    await page.getByLabel('Edit OCR', { exact: true }).click();
    await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
    await expect(page.locator('[data-edit-toolbar]').getByLabel('OCR this page')).toHaveCount(0);
  });

  test('OCR this page → gcv layer, displayed; Translate this page → tr-en layer, displayed', async ({
    page
  }) => {
    const visionCalls = await stubVision(page);
    await stubGemini(page, 'Hello world');
    await seedVolume(page, { googleKey: 'e2e-google' });
    await openReader(page);

    await openQuickActions(page);
    await page.getByLabel('OCR this page').click();
    await expect.poll(async () => (await readLayers(page)).setting, { timeout: 15000 }).toBe('gcv');
    let state = await readLayers(page);
    expect(visionCalls()).toBe(1);
    expect(state.layers.gcv.kind).toBe('ocr');
    expect(state.layers.gcv.engine).toBe('gcv');
    expect(state.layers.gcv.pages[0]).toEqual([
      { lines: ['こんにちは', 'せかい'], vertical: true }
    ]);
    // the picker marks the new layer current
    await openQuickActions(page);
    await page.getByLabel('OCR layers').click();
    const picker = page.getByRole('dialog', { name: 'OCR layers' });
    await expect(picker.getByRole('radio', { name: /Cloud Vision/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await picker.getByLabel('Close layers').click();

    // Translate the displayed (gcv) layer.
    await openQuickActions(page);
    await page.getByLabel('Translate this page').click();
    await expect
      .poll(async () => (await readLayers(page)).setting, { timeout: 15000 })
      .toBe('tr-en');
    state = await readLayers(page);
    expect(state.layers['tr-en'].kind).toBe('translation');
    expect(state.layers['tr-en'].engine).toBe('gemini:gemini-2.5-flash');
    const block = state.layers['tr-en'].pages[0][0];
    expect(block.vertical).toBe(false);
    expect(block.lines.join('').replace(/\s/g, '')).toBe('Helloworld');
    // the gcv layer was the source and is untouched
    expect(state.layers.gcv.pages[0][0].lines).toEqual(['こんにちは', 'せかい']);
  });

  test('OCR whole volume asks first with the page count and cost, then runs every page', async ({
    page
  }) => {
    const visionCalls = await stubVision(page);
    await seedVolume(page, { pages: 2, googleKey: 'e2e-google' });
    await openReader(page);
    await openQuickActions(page);
    await page.getByLabel('OCR layers').click();
    await page.getByLabel('OCR whole volume').click();
    const dialog = page.getByRole('dialog').filter({ hasText: /2 pages/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('$1.50 per 1000 pages');
    await expect(dialog).toContainText(/experimental/i);
    await dialog.getByRole('button', { name: 'Yes' }).click();
    await expect
      .poll(async () => (await readLayers(page)).layers.gcv?.pages.filter((p) => p.length).length, {
        timeout: 20000
      })
      .toBe(2);
    expect(visionCalls()).toBe(2);
  });

  test('the settings card persists a key to localStorage and never to profiles', async ({
    page
  }) => {
    await seedVolume(page);
    await openReader(page);
    // The reader's settings gear (top-right; other HUD buttons share the class).
    await page.locator('button.reader-hud.top-3.right-3').click();
    await page.getByText('OCR & translation engines (experimental)').click();
    const input = page.getByLabel('Google API key', { exact: true });
    await input.fill('e2e-typed-key');
    await input.blur();
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('engine_google_key')))
      .toBe('e2e-typed-key');
    const profiles = await page.evaluate(() => window.localStorage.getItem('profiles') ?? '');
    expect(profiles).not.toContain('e2e-typed-key');
    const misc = await page.evaluate(() => window.localStorage.getItem('miscSettings') ?? '');
    expect(misc).not.toContain('e2e-typed-key');
  });
});
