import { expect, test, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { importVolume } from './helpers/import-volume';
import { writeSyntheticVolume, type SyntheticVolume } from './helpers/synthetic-volume';

/**
 * Rebindable keys (#55) in a real browser: today's keys at defaults, the
 * #55 request itself (A/D page turns, bound in the settings section), unbinding,
 * the profile scope, continuous scroll through the reader's single key
 * listener, the library and Back owners, and "Mouse wheel: turns pages" with
 * the zoom/pan wheel contracts intact.
 */

const PAGES = 6;

/** Patch the active profile in localStorage, then reload so the app reads it. */
async function patchProfile(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    const profiles = JSON.parse(localStorage.getItem('profiles') ?? '{}');
    const id = localStorage.getItem('currentProfile') ?? 'Desktop';
    profiles[id] = { ...profiles[id], ...p, lastUpdated: new Date().toISOString() };
    localStorage.setItem('profiles', JSON.stringify(profiles));
  }, patch);
  await page.reload();
}

async function profileSetting(page: Page, key: string) {
  return page.evaluate((k) => {
    const profiles = JSON.parse(localStorage.getItem('profiles') ?? '{}');
    return profiles[localStorage.getItem('currentProfile') ?? 'Desktop']?.[k];
  }, key);
}

async function openReader(page: Page, volume: SyntheticVolume) {
  await page.evaluate(
    ([series, vol]) => (window.location.hash = `#/reader/${series}/${vol}`),
    [volume.seriesUuid, volume.volumeUuid]
  );
  await expect(page.locator('#page-num')).toContainText(`/ ${PAGES}`, { timeout: 30000 });
  await expect(page.locator('[data-page-index]').first()).toBeVisible();
}

/** The page the reader shows ("3 / 6" → 3). */
async function currentPage(page: Page): Promise<number> {
  const text = await page.locator('#page-num').innerText();
  return Number(/(\d+)(?:,\d+)? \/ \d+/.exec(text)?.[1]);
}

async function expectPage(page: Page, n: number) {
  await expect.poll(() => currentPage(page), { timeout: 5000 }).toBe(n);
}

/** Stay on `n` for a while — a key that must do nothing. */
async function expectStays(page: Page, n: number) {
  await page.waitForTimeout(400);
  expect(await currentPage(page)).toBe(n);
}

async function setup(page: Page, title: string, patch: Record<string, unknown> = {}) {
  const volume = writeSyntheticVolume(title, PAGES);
  await gotoApp(page);
  // One page at a time, so every turn is exactly one page.
  await patchProfile(page, { singlePageView: 'single', ...patch });
  await gotoApp(page);
  await importVolume(page, volume);
  return volume;
}

async function openShortcuts(page: Page) {
  await page.locator('button.reader-hud.right-3').click();
  // CSS, not getByRole: roles inside flowbite's <dialog> do not resolve.
  await page.locator('#settings button', { hasText: 'Keyboard shortcuts' }).click();
  await expect(page.locator('[data-keyboard-shortcuts]')).toBeVisible();
}

async function closeDrawer(page: Page) {
  // Mousedown on the drawer's backdrop closes it (Settings.svelte).
  await page.mouse.click(200, 540);
  await expect(page.locator('dialog#settings')).toBeHidden();
}

function row(page: Page, id: string) {
  return page.locator(`[data-key-action="${id}"]`);
}

test('defaults: today’s keys, Shift+Space inert, Escape climbs one level per press', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyDefaults');
  await openReader(page, volume);
  await expectPage(page, 1);

  // Right-to-left (the default): ← is forward.
  await page.keyboard.press('ArrowLeft');
  await expectPage(page, 2);
  await page.keyboard.press('Space');
  await expectPage(page, 3);
  await page.keyboard.press('PageDown');
  await expectPage(page, 4);
  await page.keyboard.press('PageUp');
  await expectPage(page, 3);
  await page.keyboard.press('ArrowRight');
  await expectPage(page, 2);
  await page.keyboard.press('End');
  await expectPage(page, PAGES);
  await page.keyboard.press('Home');
  await expectPage(page, 1);

  // §9.1: Shift+Space (scan modifier held) no longer turns forward.
  await page.keyboard.press('Shift+Space');
  await expectStays(page, 1);
  // Exact modifiers: Ctrl+← is not ←.
  await page.keyboard.press('Control+ArrowLeft');
  await expectStays(page, 1);

  // T toggles Always show OCR (a letter default).
  expect(await profileSetting(page, 'alwaysShowOCR')).toBe(false);
  await page.keyboard.press('t');
  await expect.poll(() => profileSetting(page, 'alwaysShowOCR')).toBe(true);
  await page.keyboard.press('t');
  await expect.poll(() => profileSetting(page, 'alwaysShowOCR')).toBe(false);

  // Escape: the reader → the series page, and stays there (one owner, one level).
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/series\//);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => location.hash)).toMatch(/^#\/series\//);

  // The library: hover a volume, E opens its editor; Escape closes the dialog
  // ONLY (Back does not fire under an open dialog).
  const item = page.getByText(`${volume.seriesTitle} 01`, { exact: true }).first();
  await item.hover();
  // §9.4: Ctrl+C on a hovered volume is the browser's copy again.
  const copyPrevented = await page.evaluate(() => {
    let prevented: boolean | null = null;
    const probe = (e: KeyboardEvent) => (prevented = e.defaultPrevented);
    window.addEventListener('keydown', probe);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyC', key: 'c', ctrlKey: true, cancelable: true })
    );
    window.removeEventListener('keydown', probe);
    return prevented;
  });
  expect(copyPrevented).toBe(false);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await page.keyboard.press('e');
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(page.locator('dialog[open]')).toContainText('Edit Volume');
  // Escape under an open dialog is the dialog's; Back must not fire.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => location.hash)).toMatch(/^#\/series\//);
  if ((await page.locator('dialog[open]').count()) > 0) {
    await page.locator('dialog[open] button', { hasText: /^\s*Cancel\s*$/ }).click();
  }
  await expect(page.locator('dialog[open]')).toHaveCount(0);

  // Escape on the series page → the catalog (the layout's Back; SeriesView no
  // longer listens too).
  await page.mouse.move(5, 5);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/catalog');
});

test('#55: A and D bound in the settings section turn pages, survive a reload, follow the profile', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyRebind');
  await openReader(page, volume);
  await openShortcuts(page);

  // Escape cancels a recording — and only the recording: the drawer stays.
  await row(page, 'reader.page-left').locator('[data-key-capture]').click();
  await expect(row(page, 'reader.page-left')).toContainText('Press a key');
  await page.keyboard.press('Escape');
  await expect(row(page, 'reader.page-left')).not.toContainText('Press a key');
  await expect(page.locator('dialog#settings')).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toMatch(/^#\/reader\//);

  // "+ Add", then the key.
  await row(page, 'reader.page-left').locator('[data-key-capture]').click();
  await expect(row(page, 'reader.page-left')).toContainText('Press a key');
  await page.keyboard.press('a');
  await expect(row(page, 'reader.page-left').locator('[data-key-chip="A"]')).toBeVisible();
  await row(page, 'reader.page-right').locator('[data-key-capture]').click();
  await page.keyboard.press('d');
  await expect(row(page, 'reader.page-right').locator('[data-key-chip="D"]')).toBeVisible();
  // Recording swallowed the keys: no page turned underneath.
  await closeDrawer(page);
  await expectPage(page, 1);
  expect(await profileSetting(page, 'keyBindings')).toEqual({
    'reader.page-left': ['ArrowLeft', 'KeyA'],
    'reader.page-right': ['ArrowRight', 'KeyD']
  });

  // RTL: Page left (A) is forward, Page right (D) is back. Arrows still work.
  await page.keyboard.press('a');
  await expectPage(page, 2);
  await page.keyboard.press('a');
  await expectPage(page, 3);
  await page.keyboard.press('d');
  await expectPage(page, 2);
  await page.keyboard.press('ArrowLeft');
  await expectPage(page, 3);
  // Exact modifiers: Shift+A is not A.
  await page.keyboard.press('Shift+KeyA');
  await expectStays(page, 3);

  // Reload: still bound (the profile in localStorage).
  await page.reload();
  await expect(page.locator('#page-num')).toContainText(`/ ${PAGES}`, { timeout: 30000 });
  await expectPage(page, 3);
  await page.keyboard.press('a');
  await expectPage(page, 4);

  // Another profile has its own keys: A does nothing there.
  await page.evaluate(() => localStorage.setItem('currentProfile', 'Mobile'));
  await page.reload();
  await expect(page.locator('#page-num')).toContainText(`/ ${PAGES}`, { timeout: 30000 });
  const before = await currentPage(page);
  await page.keyboard.press('a');
  await expectStays(page, before);
  // (Mobile pairs pages, so a turn may move two.)
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => currentPage(page), { timeout: 5000 }).toBeGreaterThan(before);
});

test('unbinding: a removed key does nothing and its hint disappears; Reset brings it back', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyUnbind');
  await openReader(page, volume);
  await page.locator('button.reader-hud.right-3').click();

  // The Reader section (open in the reader) shows the live binding.
  const hint = page.locator('[data-key-hint="reader.ocr-always"]');
  await expect(hint).toHaveText('(T)');
  const section = (name: string) =>
    page.locator('#settings h2 button', { hasText: new RegExp(`^\\s*${name}\\s*$`) });
  await section('Keyboard shortcuts').click();
  await page.locator('[aria-label="Remove T from Always show OCR"]').click();
  await expect(row(page, 'reader.ocr-always')).toContainText('Not set');
  // Back in the Reader section: no hint for an unbound action.
  await section('Reader').click();
  await expect(page.locator('#settings label', { hasText: 'Always show OCR' })).toBeVisible();
  await expect(hint).toHaveCount(0);
  await closeDrawer(page);

  await page.keyboard.press('t');
  await page.waitForTimeout(300);
  expect(await profileSetting(page, 'alwaysShowOCR')).toBe(false);
  expect(await profileSetting(page, 'keyBindings')).toEqual({ 'reader.ocr-always': [] });

  await page.locator('button.reader-hud.right-3').click();
  await section('Keyboard shortcuts').click();
  await row(page, 'reader.ocr-always').locator('button', { hasText: 'Reset' }).click();
  await section('Reader').click();
  await expect(hint).toHaveText('(T)');
  await closeDrawer(page);
  await page.keyboard.press('t');
  await expect.poll(() => profileSetting(page, 'alwaysShowOCR')).toBe(true);
  expect(await profileSetting(page, 'keyBindings')).toEqual({});
});

test('continuous vertical: the reader’s one key listener drives the scroll reader', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyVertical', {
    continuousScroll: true,
    scrollMode: 'vertical',
    keyBindings: { 'reader.page-next': ['PageDown', 'Space', 'KeyS'] }
  });
  await openReader(page, volume);
  await expectPage(page, 1);
  await page.keyboard.press('PageDown');
  await expectPage(page, 2);
  // A rebound key reaches the scroll reader too (it no longer listens itself).
  await page.keyboard.press('s');
  await expectPage(page, 3);
  await page.keyboard.press('PageUp');
  await expectPage(page, 2);
  // §9.2: modifiers no longer scroll here.
  await page.keyboard.press('Shift+PageDown');
  await expectStays(page, 2);
});

test('mouse wheel: turns pages, one per notch; a zoomed page pans to its edge first; ctrl+wheel zooms', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyWheel');
  await openReader(page, volume);

  // Chosen in the Reader section's select.
  await page.locator('button.reader-hud.right-3').click();
  await page.locator('#wheel-mode').selectOption('turn');
  await expect.poll(() => profileSetting(page, 'wheelTurnsPages')).toBe(true);
  expect(await profileSetting(page, 'swapWheelBehavior')).toBe(false);
  await closeDrawer(page);

  const pageEl = page.locator('#manga-panel [data-page-index]').last();
  await page.mouse.move(960, 540);
  await page.mouse.wheel(0, 100);
  await expectPage(page, 2);
  await page.waitForTimeout(400);
  await page.mouse.wheel(0, 100);
  await expectPage(page, 3);
  await page.waitForTimeout(400);
  await page.mouse.wheel(0, -100);
  await expectPage(page, 2);
  await page.waitForTimeout(400);

  // A notched ctrl+wheel still zooms (one ladder step), and turns nothing.
  const widthBefore = (await pageEl.boundingBox())!.width;
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect
    .poll(async () => (await pageEl.boundingBox())!.width, { timeout: 5000 })
    .toBeGreaterThan(widthBefore * 1.1);
  await expectStays(page, 2);
  await page.waitForTimeout(400);

  // Zoomed in, content is hidden below: the stream pans, the page stays.
  const topBefore = (await pageEl.boundingBox())!.y;
  await page.mouse.wheel(0, 100);
  await expect
    .poll(async () => (await pageEl.boundingBox())!.y, { timeout: 5000 })
    .toBeLessThan(topBefore - 20);
  await expectStays(page, 2);

  // Pan to the bottom edge within one stream (notches < 250 ms apart)…
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(60);
  }
  await expectStays(page, 2);
  // …then a NEW stream at the edge turns the page.
  await page.waitForTimeout(600);
  await page.mouse.wheel(0, 100);
  await expectPage(page, 3);
});
