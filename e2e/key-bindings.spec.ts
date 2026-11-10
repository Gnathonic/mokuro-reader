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
  await page.locator('#settings button', { hasText: 'Shortcuts and quick menu' }).click();
  await expect(page.locator('[data-keyboard-shortcuts]')).toBeVisible();
}

/** Open one of the section's groups (they start collapsed, mounting no rows). */
async function openGroup(page: Page, group: string) {
  const header = page.locator(`[data-key-group="${group}"] h4 button`);
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
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
  // Collapsed until opened: no action row is mounted yet.
  await expect(page.locator('[data-key-action]')).toHaveCount(0);
  await openGroup(page, 'navigation');

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
  await section('Shortcuts and quick menu').click();
  await openGroup(page, 'text');
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
  await section('Shortcuts and quick menu').click();
  await openGroup(page, 'text');
  // The group says a row in it is changed.
  await expect(page.locator('[data-key-group="text"] [data-key-group-changed]')).toHaveText(
    '1 changed'
  );
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

test('mouse wheel: a spin onto a tall page pans it instead of skipping it (#55 review)', async ({
  page
}) => {
  test.setTimeout(150_000);
  // Fit to width on a landscape viewport: every 600×900 page is taller than
  // the screen and opens at its top.
  const volume = await setup(page, 'KeyWheelTall', {
    wheelTurnsPages: true,
    zoomDefault: 'zoomFitToWidth'
  });
  await openReader(page, volume);
  await expectPage(page, 1);
  const pageEl = page.locator('#manga-panel [data-page-index]').last();
  await page.mouse.move(960, 540);

  // Pan page 1 to its bottom in one stream, then pause.
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(60);
  }
  await expectStays(page, 1);
  await page.waitForTimeout(600);

  // One spin of four notches, 50 ms apart: the first turns to page 2, the
  // rest pan page 2 — they must not turn to 3, 4 and 5 unseen.
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(50);
  }
  await expectStays(page, 2);
  const top = (await pageEl.boundingBox())!.y;
  expect(top).toBeLessThan(-20);
});

test('mouse wheel: a flick never runs past the volume’s ends; a fresh notch does', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyWheelEdge', { wheelTurnsPages: true });
  await openReader(page, volume);
  await page.mouse.move(960, 540);
  const flick = async (deltaY: number) => {
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(50);
    }
  };

  // Backward from page 2: one turn to page 1, the leftovers stay in the book.
  await page.keyboard.press('ArrowLeft');
  await expectPage(page, 2);
  await page.waitForTimeout(400);
  await flick(-100);
  await expectStays(page, 1);
  expect(await page.evaluate(() => location.hash)).toMatch(/^#\/reader\//);

  // Forward from the second-to-last page: the same at the end.
  await page.keyboard.press('End');
  await expectPage(page, PAGES);
  await page.keyboard.press('ArrowRight');
  await expectPage(page, PAGES - 1);
  await page.waitForTimeout(400);
  await flick(100);
  await expectStays(page, PAGES);
  expect(await page.evaluate(() => location.hash)).toMatch(/^#\/reader\//);

  // After a pause, a deliberate notch leaves the volume (no next volume: the
  // series page), like Next page on the last page.
  await page.waitForTimeout(600);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/series\//);
});

test('LTR: the arrows follow the reading direction', async ({ page }) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyLtr', {
    volumeDefaults: { singlePageView: 'single', rightToLeft: false, hasCover: true }
  });
  await openReader(page, volume);
  await expectPage(page, 1);
  await page.keyboard.press('ArrowRight');
  await expectPage(page, 2);
  await page.keyboard.press('ArrowRight');
  await expectPage(page, 3);
  await page.keyboard.press('ArrowLeft');
  await expectPage(page, 2);
  // Reading-order keys are direction-free.
  await page.keyboard.press('PageDown');
  await expectPage(page, 3);
  await page.keyboard.press('Space');
  await expectPage(page, 4);
  await page.keyboard.press('PageUp');
  await expectPage(page, 3);
});

test('continuous horizontal: page keys step the strip through the reader’s one listener', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyHorizontal', {
    continuousScroll: true,
    scrollMode: 'horizontal'
  });
  await openReader(page, volume);
  await expectPage(page, 1);
  // RTL: ← is forward one page, → back one.
  await page.keyboard.press('ArrowLeft');
  await expectPage(page, 2);
  await page.keyboard.press('ArrowLeft');
  await expectPage(page, 3);
  await page.keyboard.press('ArrowRight');
  await expectPage(page, 2);
  // PageDown / PageUp step a spread.
  await page.keyboard.press('PageDown');
  await expectPage(page, 4);
  await page.keyboard.press('PageUp');
  await expectPage(page, 2);
  await page.keyboard.press('End');
  await expectPage(page, PAGES);
  await page.keyboard.press('Home');
  await expectPage(page, 1);
});

test('edit mode: Escape clears the selection first and stays in the reader', async ({ page }) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyEditEsc');
  await openReader(page, volume);
  await page.keyboard.press('e');
  await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
  const block = page.locator('.editBlock').first();
  await block.click();
  await expect(page.locator('.editBlock.selected')).toHaveCount(1);

  // One level per press: the selection…
  await page.keyboard.press('Escape');
  await expect(page.locator('.editBlock.selected')).toHaveCount(0);
  await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toMatch(/^#\/reader\//);
  // …then edit mode…
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-edit-toolbar]')).toBeHidden();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => location.hash)).toMatch(/^#\/reader\//);
  // …then the reader.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/series\//);
});

test('Escape under a plain confirmation dialog closes it only — Back does not fire', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyConfirmEsc');
  // The series page (the layout owns Back there).
  await page.evaluate((s) => (window.location.hash = `#/series/${s}`), volume.seriesUuid);
  const item = page.getByText(`${volume.seriesTitle} 01`, { exact: true }).first();
  await expect(item).toBeVisible({ timeout: 30000 });
  await item.hover();
  // Delete on a hovered volume asks through promptConfirmation — a dialog
  // with NO capture-phase Escape of its own, so only the layout's open-dialog
  // guard keeps Back from firing too.
  // flowbite's Dialog re-asserts `open` from the dialog's async `toggle` event,
  // so an Escape landing before that event (a few ms after showModal — only a
  // script is that fast) is undone and the dialog stays. Wait for it.
  await page.evaluate(() => {
    const w = window as unknown as { __dialogShown?: boolean };
    w.__dialogShown = false;
    document.addEventListener(
      'toggle',
      (e) => {
        if ((e as ToggleEvent).newState === 'open') w.__dialogShown = true;
      },
      true
    );
  });
  await page.keyboard.press('Delete');
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(page.locator('dialog[open]')).toContainText('Remove');
  await page.waitForFunction(
    () => (window as unknown as { __dialogShown?: boolean }).__dialogShown
  );
  // The dialog opens focused on its checkbox — an input, which the layout's
  // typing-target guard already ignores. On a BUTTON (tabbed to, or a popup
  // without a checkbox) only the open-dialog guard is left.
  const no = page.locator('dialog[open] button', { hasText: /^\s*No\s*$/ });
  await no.focus();
  await expect(no).toBeFocused();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  // Back did not fire (it would also have cancelled the Escape, so the dialog
  // would still be open)…
  expect(await page.evaluate(() => location.hash)).toMatch(/^#\/series\//);
  // …and the dialog closed.
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  // Nothing was removed: the volume is still there.
  await expect(item).toBeVisible();
});

test('re-read prompt open: a rebound page key does not page continuous scroll underneath', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyReread', {
    continuousScroll: true,
    scrollMode: 'vertical',
    keyBindings: { 'reader.page-next': ['PageDown', 'Space', 'KeyS'] }
  });
  // The whole (one-volume) series read: opening its first volume offers a re-read.
  await page.evaluate(
    (v) =>
      localStorage.setItem(
        'volumes',
        JSON.stringify({
          [v.volumeUuid]: {
            progress: 2,
            completed: true,
            lastProgressUpdate: new Date().toISOString(),
            series_title: v.seriesTitle,
            volume_title: `${v.seriesTitle} 01`
          }
        })
      ),
    volume
  );
  await page.reload();
  await gotoApp(page);
  await openReader(page, volume);
  await expect(page.getByText('Start a re-read?')).toBeVisible({ timeout: 10000 });
  const before = await currentPage(page);
  await page.keyboard.press('s');
  await page.keyboard.press('PageDown');
  await expectStays(page, before);
  await expect(page.getByText('Start a re-read?')).toBeVisible();
  // Escape is the prompt's: it closes, and the reader stays.
  await page.keyboard.press('Escape');
  await expect(page.getByText('Start a re-read?')).toBeHidden();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => location.hash)).toMatch(/^#\/reader\//);
  // With the prompt gone the rebound key pages again.
  await page.keyboard.press('s');
  await expectPage(page, before + 1);
});

// ---------------------------------------------------------------------------
// Every control bindable (spec section 17, step A): actions generated from
// the setting definitions, the C/O change, the schedule message's button, the
// one settings-open flag, and the page scopes outside the reader.
// ---------------------------------------------------------------------------

function notification(page: Page) {
  return page.locator('[data-reader-notification]');
}

async function filterShortcuts(page: Page, text: string) {
  await page.locator('[data-keyboard-shortcuts] input[type="search"]').fill(text);
  // A search is applied a pause after the last keystroke: wait for THIS one.
  await expect(page.locator('[data-keyboard-shortcuts]')).toHaveAttribute('data-key-search', text);
}

async function bind(page: Page, id: string, key: string) {
  await row(page, id).locator('[data-key-capture]').click();
  await expect(row(page, id)).toContainText('Press a key');
  await page.keyboard.press(key);
  await expect(row(page, id).locator(`[data-key-chip="${key.toUpperCase()}"]`)).toBeVisible();
}

async function miscSetting(page: Page, key: string) {
  return page.evaluate(
    (k) => JSON.parse(localStorage.getItem('miscSettings') ?? '{}')[k] as unknown,
    key
  );
}

async function volumeHasCover(page: Page, volume: SyntheticVolume) {
  return page.evaluate(
    (uuid) => JSON.parse(localStorage.getItem('volumes') ?? '{}')[uuid]?.settings?.hasCover,
    volume.volumeUuid
  );
}

test('generated setting actions: listed unbound, bound in the section, run from the reader', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyGenerated');
  await openReader(page, volume);
  await openShortcuts(page);

  // New actions ship unbound, each with its icon; the setting's name finds all of its actions.
  await filterShortcuts(page, 'paged zoom');
  await expect(page.locator('[data-key-action]')).toHaveCount(7);
  await expect(row(page, 'set.zoom-paged.next')).toContainText('Not set');
  await expect(row(page, 'set.zoom-paged.next').locator('svg').first()).toBeVisible();
  await bind(page, 'set.zoom-paged.to.zoomFitToWidth', 'w');

  await filterShortcuts(page, 'bold font');
  await expect(row(page, 'set.bold.toggle')).toContainText('Not set');
  await bind(page, 'set.bold.toggle', 'b');

  await filterShortcuts(page, 'brightness');
  await bind(page, 'set.brightness.up', 'u');
  await bind(page, 'set.brightness.reset', 'y');

  // A pinned toggle kept its id and its key.
  await filterShortcuts(page, 'night mode');
  await expect(row(page, 'reader.night').locator('[data-key-chip="N"]')).toBeVisible();
  await closeDrawer(page);

  expect(await profileSetting(page, 'keyBindings')).toEqual({
    'set.zoom-paged.to.zoomFitToWidth': ['KeyW'],
    'set.bold.toggle': ['KeyB'],
    'set.brightness.up': ['KeyU'],
    'set.brightness.reset': ['KeyY']
  });

  // Toggle: written, and announced in the reader's own notification.
  await page.keyboard.press('b');
  await expect(notification(page)).toHaveText('Bold font: On');
  expect(await profileSetting(page, 'boldFont')).toBe(true);
  // A held toggle does not flicker: auto-repeat is swallowed.
  await page.keyboard.down('b');
  await page.keyboard.down('b');
  await page.keyboard.down('b');
  await page.keyboard.up('b');
  await expect(notification(page)).toHaveText('Bold font: Off');
  expect(await profileSetting(page, 'boldFont')).toBe(false);

  // Slider: one step per press, and a held key repeats.
  await page.keyboard.press('u');
  await expect(notification(page)).toHaveText('Brightness: 105%');
  await page.keyboard.down('u');
  await page.keyboard.down('u');
  await page.keyboard.up('u');
  await expect(notification(page)).toHaveText('Brightness: 115%');
  expect(await profileSetting(page, 'pageBrightness')).toBe(115);
  await page.keyboard.press('y');
  await expect(notification(page)).toHaveText('Brightness: 100%');
  expect(await profileSetting(page, 'pageBrightness')).toBe(100);

  // Set-to: the stored value, announced by the option's name.
  await page.keyboard.press('w');
  await expect(notification(page)).toHaveText('Paged zoom: Fit to width');
  expect(await profileSetting(page, 'zoomDefault')).toBe('zoomFitToWidth');

  // The seven old toggles go through the same handler, in the common wording.
  await page.keyboard.press('t');
  await expect(notification(page)).toHaveText('Always show OCR: On');
  await page.keyboard.press('t');
  await expect(notification(page)).toHaveText('Always show OCR: Off');

  // A plain message leaves by itself after its 2 s.
  await expect(notification(page)).toHaveCount(0, { timeout: 4000 });

  // P and Z are still ONE mode-aware cycle each.
  await page.keyboard.press('z');
  await expect(notification(page)).toHaveText('Fill Screen');
  expect(await profileSetting(page, 'zoomDefault')).toBe('zoomFillScreen');
  await page.keyboard.press('p');
  await expect(notification(page)).toHaveText('Dual Page');

  // V: continuous scroll. The paged zoom key is not live there; M (continuous only) is.
  await page.keyboard.press('v');
  await expect(notification(page)).toHaveText('Continuous scroll: On');
  await expect(page.locator('[data-page-index]').first()).toBeVisible();
  await page.keyboard.press('w');
  await page.waitForTimeout(300);
  expect(await profileSetting(page, 'zoomDefault')).toBe('zoomFillScreen');
  await page.keyboard.press('m');
  await expect(notification(page)).toHaveText('Page dividers: On');
  expect(await profileSetting(page, 'pageDividers')).toBe(true);

  // The settings drawer shows what the keys wrote (one list, used twice).
  await page.locator('button.reader-hud.right-3').click();
  await expect(page.locator('dialog#settings')).toBeVisible();
  await expect(page.locator('#settings label', { hasText: 'Continuous scroll' })).toBeVisible();
  await expect(page.locator('#settings select').first()).toBeVisible();
  const scrollModes = await page
    .locator('#settings select')
    .first()
    .locator('option')
    .allTextContents();
  expect(scrollModes.map((t) => t.trim()).filter((t) => t && !t.startsWith('Choose'))).toEqual([
    'Match orientation',
    'Vertical scroll',
    'Horizontal scroll'
  ]);
  // Keys stand down while typing in the drawer.
  await page.keyboard.press('b');
  expect(await profileSetting(page, 'boldFont')).toBe(false);
});

test('C is freed and O offsets the spreads; a stored reader.cover folds into O', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyCoverOffset', { singlePageView: 'dual' });
  await openReader(page, volume);
  const before = (await volumeHasCover(page, volume)) ?? true;

  // C: nothing answers it in the reader any more.
  await page.keyboard.press('c');
  await page.waitForTimeout(500);
  await expect(notification(page)).toHaveCount(0);
  expect((await volumeHasCover(page, volume)) ?? true).toBe(before);
  // …and the key keeps its browser default.
  const cPrevented = await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { code: 'KeyC', key: 'c', cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(cPrevented).toBe(false);

  // O: "Spreads offset".
  await page.keyboard.press('o');
  await expect(notification(page)).toHaveText('Spreads Offset');
  await expect.poll(() => volumeHasCover(page, volume)).toBe(!before);
  await page.keyboard.press('o');
  await expect.poll(() => volumeHasCover(page, volume)).toBe(before);

  // The section lists one action for it, on O; no "First page is cover" action.
  await openShortcuts(page);
  await filterShortcuts(page, 'spreads offset');
  await expect(row(page, 'reader.offset-spreads').locator('[data-key-chip="O"]')).toBeVisible();
  await filterShortcuts(page, 'cover');
  await expect(page.locator('[data-key-action="reader.cover"]')).toHaveCount(0);
  // The cover toggle in the drawer stays, without a key hint. (One section
  // is open at a time: back to Reader, which opening the shortcuts closed.)
  await page.locator('#settings h2 button', { hasText: /^\s*Reader\s*$/ }).click();
  const coverToggle = page.locator('#settings label', { hasText: 'First page is cover' });
  await expect(coverToggle).toBeVisible();
  await expect(coverToggle.locator('[data-key-hint]')).toHaveCount(0);
  await closeDrawer(page);

  // A profile written by an earlier build of this branch: C is dropped, X moves onto O.
  await patchProfile(page, { keyBindings: { 'reader.cover': ['KeyC', 'KeyX'] } });
  await expect(page.locator('#page-num')).toContainText(`/ ${PAGES}`, { timeout: 30000 });
  expect(await profileSetting(page, 'keyBindings')).toEqual({
    'reader.offset-spreads': ['KeyO', 'KeyX']
  });
  const folded = (await volumeHasCover(page, volume)) ?? true;
  await page.keyboard.press('c');
  await page.waitForTimeout(400);
  expect((await volumeHasCover(page, volume)) ?? true).toBe(folded);
  await page.keyboard.press('x');
  await expect(notification(page)).toHaveText('Spreads Offset');
  await expect.poll(() => volumeHasCover(page, volume)).toBe(!folded);
});

test('N on a schedule: the message carries “Set to manual”, which keeps what is on screen', async ({
  page
}) => {
  test.setTimeout(150_000);
  // All day, so night mode is on by schedule whenever this runs; the manual value says off.
  const volume = await setup(page, 'KeySchedule', {
    nightMode: false,
    nightModeSchedule: { enabled: true, startTime: '00:00', endTime: '23:59' }
  });
  await openReader(page, volume);
  await expectPage(page, 1);
  // The notice's lifetime runs on the page's clock, which this test moves:
  // no sleeping through it. (Exact lifetimes: ReaderNotification.test.ts.)
  await page.clock.install();

  await page.keyboard.press('n');
  await expect(notification(page)).toContainText('Night Mode is on automatic schedule');
  const button = notification(page).locator('button', { hasText: 'Set to manual' });
  await expect(button).toBeVisible();
  // The key changed nothing.
  expect(await profileSetting(page, 'nightMode')).toBe(false);
  expect(((await profileSetting(page, 'nightModeSchedule')) as { enabled: boolean }).enabled).toBe(
    true
  );
  // It never takes focus: the reader's keys keep working under it.
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
  await page.keyboard.press('ArrowLeft');
  await expectPage(page, 2);

  // With a button it outlives a plain message's 2 s…
  await page.clock.runFor(3000);
  await expect(button).toBeVisible();
  // …and stays for as long as the REAL pointer is on it, however long that is…
  await notification(page).hover();
  await page.clock.runFor(60_000);
  await expect(button).toBeVisible();
  // …then runs out once the pointer has left.
  await page.mouse.move(200, 700);
  await page.clock.runFor(60_000);
  await expect(notification(page)).toHaveCount(0);
  // The hold went with it: the same message again takes its own time, unheld.
  await page.keyboard.press('n');
  await expect(button).toBeVisible();
  await page.clock.runFor(60_000);
  await expect(notification(page)).toHaveCount(0);
  await page.keyboard.press('n');
  await expect(button).toBeVisible();

  // The button: schedule off, and night mode stays ON (what is on screen).
  await button.click();
  await expect(notification(page)).toHaveText('Night mode: On (manual)');
  expect(await profileSetting(page, 'nightMode')).toBe(true);
  expect(((await profileSetting(page, 'nightModeSchedule')) as { enabled: boolean }).enabled).toBe(
    false
  );
  // The press neither took focus, turned the page nor left the reader.
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
  await expectStays(page, 2);
  expect(await page.evaluate(() => location.hash)).toMatch(/^#\/reader\//);

  // The next press of the key toggles it.
  await page.keyboard.press('n');
  await expect(notification(page)).toHaveText('Night mode: Off');
  expect(await profileSetting(page, 'nightMode')).toBe(false);
  await expect(notification(page).locator('button')).toHaveCount(0);

  // The settings card agrees: Manual, off.
  await page.locator('button.reader-hud.right-3').click();
  await expect(page.locator('dialog#settings')).toBeVisible();
  await expect(page.locator('#settings', { hasText: 'Night mode' })).toBeVisible();
});

test('Mark this volume read or unread: by key and from the quick menu, on the row button’s rule', async ({
  page
}) => {
  test.setTimeout(150_000);
  // Ships unbound and off the menu: this profile bound it and switched it on.
  const volume = await setup(page, 'KeyMarkRead', {
    keyBindings: { 'reader.volume-read': ['KeyR'] },
    quickMenu: { 'reader.volume-read': true }
  });
  const stored = () =>
    page.evaluate((uuid) => {
      const v = JSON.parse(localStorage.getItem('volumes') ?? '{}')[uuid];
      return v ? { progress: v.progress, completed: !!v.completed } : null;
    }, volume.volumeUuid);
  await openReader(page, volume);
  await expectPage(page, 1);
  await page.keyboard.press('ArrowLeft');
  await expectPage(page, 2);

  // Read: the last page, finished — what the row's button does.
  await page.keyboard.press('r');
  await expect(notification(page)).toHaveText('Marked as read');
  await expectPage(page, PAGES);
  await expect.poll(stored).toEqual({ progress: PAGES, completed: true });
  // The menu entry is the same toggle and shows the state.
  await menuButton(page).click();
  await expect(menuEntry(page, 'reader.volume-read')).toHaveAttribute('aria-pressed', 'true');
  await expect(menuEntry(page, 'reader.volume-read')).toHaveAttribute(
    'aria-label',
    'Mark this volume read or unread'
  );
  // Unread: back to the start.
  await menuEntry(page, 'reader.volume-read').click();
  await expect(notification(page)).toHaveText('Marked as unread');
  await expectPage(page, 1);
  await expect.poll(async () => (await stored())?.completed).toBe(false);
  await menuButton(page).click();
  await expect(menuEntry(page, 'reader.volume-read')).toHaveAttribute('aria-pressed', 'false');

  // Listed under "Reader: this volume", with the key this profile gave it.
  await openShortcuts(page);
  await filterShortcuts(page, 'this volume read');
  await expect(row(page, 'reader.volume-read').locator('[data-key-chip="R"]')).toBeVisible();
  await expect(page.locator('[data-key-group="volume"]')).toContainText('Reader: this volume');
});

test('one settings-open flag: each button opens exactly one drawer, in its own context', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyDrawer');
  const open = page.locator('dialog#settings[open]');

  // The library: the NavBar's button, the library's content (volume defaults).
  await expect(open).toHaveCount(0);
  await page.locator('nav button[title="Settings"]').click();
  await expect(open).toHaveCount(1);
  await expect(open).toContainText('Volume defaults');
  await page.mouse.click(200, 540);
  await expect(open).toHaveCount(0);

  // The reader: its own button, the reader's content (per-volume settings).
  await openReader(page, volume);
  await page.locator('button.reader-hud.right-3').click();
  await expect(open).toHaveCount(1);
  await expect(open).toContainText('Per-volume settings');
  await expect(open).not.toContainText('Volume defaults');

  // Leaving the reader with it open: it closes, and the library's does not open in its place.
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/catalog');
  await page.waitForTimeout(600);
  await expect(open).toHaveCount(0);

  // The library's button still opens the library's drawer afterwards.
  await page.locator('nav button[title="Settings"]').click();
  await expect(open).toHaveCount(1);
  await expect(open).toContainText('Volume defaults');
});

test('outside the reader: a page-scope action fires on its page only, announced by the snackbar', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyPages', {
    keyBindings: {
      'set.gallery-layout.next': ['KeyG'],
      'set.series-view.next': ['KeyG'],
      'set.series-sort.next': ['KeyS'],
      'set.theme.to.nord': ['KeyT']
    }
  });
  const toast = page.locator('[role="alert"]', { hasText: /:/ });

  // Catalog: G is the gallery layout. The same order the layout button walks.
  expect(await miscSetting(page, 'galleryLayout')).toBe('grid');
  await page.keyboard.press('g');
  await expect.poll(() => miscSetting(page, 'galleryLayout')).toBe('list');
  await expect(toast.last()).toContainText('Gallery layout: List');
  await page.keyboard.press('g');
  await expect.poll(() => miscSetting(page, 'galleryLayout')).toBe('grid');
  // S is the series page's: nothing here.
  await page.keyboard.press('s');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => localStorage.getItem('series-sort-mode'))).toBe('unread-first');
  // Not from a text field.
  const search = page.locator('input[type="search"], input[placeholder*="earch"]').first();
  await search.click();
  await page.keyboard.press('g');
  await page.waitForTimeout(300);
  expect(await miscSetting(page, 'galleryLayout')).toBe('grid');
  await search.fill('');
  await page.locator('body').click({ position: { x: 5, y: 400 } });

  // An app-scope action works on every page.
  await page.keyboard.press('t');
  await expect.poll(() => profileSetting(page, 'theme')).toBe('nord');
  await expect(toast.last()).toContainText('Theme: Nord');

  // The series page: G is ITS view now, the gallery is untouched; S walks the sort button's order.
  await page.evaluate((id) => (window.location.hash = `#/series/${id}`), volume.seriesUuid);
  await expect(page.getByText(`${volume.seriesTitle} 01`, { exact: true }).first()).toBeVisible({
    timeout: 30000
  });
  await page.mouse.move(5, 5);
  expect(await page.evaluate(() => localStorage.getItem('series-view-mode'))).toBe('grid');
  await page.keyboard.press('g');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('series-view-mode')))
    .toBe('list');
  await expect(toast.last()).toContainText('Series view: List');
  expect(await miscSetting(page, 'galleryLayout')).toBe('grid');

  const sortButton = page.locator('button', { hasText: /Unread first|Default|Reverse default/ });
  await expect(sortButton.first()).toContainText('Unread first');
  await page.keyboard.press('s');
  await expect(sortButton.first()).toContainText('Default');
  await expect(toast.last()).toContainText('Series sort: Default');
  await sortButton.first().click();
  await expect(sortButton.first()).toContainText('Reverse default');
  await sortButton.first().click();
  await expect(sortButton.first()).toContainText('Unread first');

  // The view survives a reload (the same localStorage keys as before).
  await page.reload();
  await expect(page.getByText(`${volume.seriesTitle} 01`, { exact: true }).first()).toBeVisible({
    timeout: 30000
  });
  expect(await page.evaluate(() => localStorage.getItem('series-view-mode'))).toBe('list');
  await expect(page.locator('button', { hasText: /^\s*Grid\s*$/ }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Commands (spec 17.10, step B): every control a key can reach, each behind
// its own button's test, and ONE key listener outside the reader.
// ---------------------------------------------------------------------------

const notice = (page: Page) => page.locator('[data-reader-notification]');
const snackbar = (page: Page) => page.locator('[role="alert"]');
const openDialogs = (page: Page) => page.locator('dialog[open]');
const pageWidth = async (page: Page) =>
  (await page.locator('[data-page-index]').first().boundingBox())!.width;

test('reader commands by key: go to page, zoom steps, quick menu, layer picker, copy, timer, settings', async ({
  page,
  context
}) => {
  test.setTimeout(180_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const volume = await setup(page, 'KeyCommands', {
    keyBindings: {
      'reader.goto-page': ['KeyJ'],
      'reader.zoom-in': ['Equal'],
      'reader.zoom-out': ['Minus'],
      'reader.zoom-fit': ['Digit0'],
      'reader.quick-menu': ['KeyQ'],
      'reader.ocr-layers': ['KeyK'],
      'reader.ocr-layer-prev': ['Shift+KeyL'],
      'reader.ocr-layer-primary': ['KeyH'],
      'reader.copy-page-text': ['KeyY'],
      'reader.anki-image': ['KeyA'],
      'reader.anki-image-2': ['KeyB'],
      'reader.timer-pause': ['KeyU'],
      'reader.controls': ['KeyC'],
      'layer.rename': ['KeyR'],
      'app.settings': ['KeyS'],
      'app.sync': ['KeyD']
    }
  });
  await openReader(page, volume);
  await expectPage(page, 1);

  // Go to page: the page popover, its number field focused and selected.
  const field = page.locator('input[type="number"]');
  await expect(field).toHaveCount(0);
  await page.keyboard.press('j');
  await expect(field).toBeFocused();
  await page.keyboard.type('4');
  await page.keyboard.press('Enter');
  await expectPage(page, 4);
  // Opened by the key, so Enter puts it away: back to reading.
  await expect(field).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expectPage(page, 3);
  // With the controls hidden it brings them back first.
  await page.keyboard.press('c');
  await expect(page.locator('#page-num')).toHaveCount(0);
  await page.keyboard.press('j');
  await expect(field).toBeFocused();
  await expect(page.locator('#page-num')).toBeVisible();
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await expectPage(page, 1);

  // Zoom in / out: one ladder step, anchored at the screen centre.
  const fit = await pageWidth(page);
  await page.keyboard.press('Equal');
  await expect.poll(() => pageWidth(page), { timeout: 5000 }).toBeGreaterThan(fit * 1.1);
  await page.waitForTimeout(400);
  const zoomed = await page.locator('[data-page-index]').first().boundingBox();
  expect(Math.abs(zoomed!.x + zoomed!.width / 2 - 960)).toBeLessThan(6);
  await page.keyboard.press('Equal');
  await expect.poll(() => pageWidth(page), { timeout: 5000 }).toBeGreaterThan(zoomed!.width * 1.1);
  await page.waitForTimeout(400);
  const twice = await pageWidth(page);
  await page.keyboard.press('Minus');
  await expect.poll(() => pageWidth(page), { timeout: 5000 }).toBeLessThan(twice * 0.95);
  // Zoom to fit: the whole page again.
  await page.keyboard.press('Digit0');
  await expect
    .poll(async () => Math.abs((await pageWidth(page)) - fit), { timeout: 5000 })
    .toBeLessThan(2);
  await expectStays(page, 1);

  // Quick menu: opened and closed by the key…
  const fitButton = page.getByLabel('Zoom to fit');
  await expect(fitButton).toHaveCount(0);
  await page.keyboard.press('q');
  await expect(fitButton).toBeVisible();
  await page.keyboard.press('q');
  await expect(fitButton).toHaveCount(0);
  // …also while its button is hidden with the controls.
  await page.keyboard.press('c');
  await expect(page.getByLabel('Quick actions menu')).toHaveCount(0);
  await page.keyboard.press('q');
  await expect(fitButton).toBeVisible();
  await expect(page.getByLabel('Quick actions menu')).toBeVisible();
  await page.keyboard.press('q');
  await expect(page.getByLabel('Quick actions menu')).toHaveCount(0);

  // The layer picker opens by key with the controls still hidden, owns the
  // keyboard while it is up, and Escape closes it — and only it.
  const picker = page.locator('[role="dialog"][aria-label="OCR layers"]');
  await page.keyboard.press('k');
  await expect(picker).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  expect(await page.evaluate(() => location.hash)).toMatch(/^#\/reader\//);
  await page.keyboard.press('c');
  await expect(page.locator('#page-num')).toBeVisible();
  // The arrow under the picker turned nothing.
  expect(await currentPage(page)).toBe(1);

  // Copy page text: the page on screen, to the clipboard.
  await page.keyboard.press('y');
  await expect(notice(page)).toContainText('Copied the page text');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(volume.text);

  // A command that cannot run says why.
  await page.keyboard.press('a');
  await expect(notice(page)).toContainText('AnkiConnect is off');
  await page.keyboard.press('b');
  await expect(notice(page)).toContainText('AnkiConnect is off');
  await page.keyboard.press('Shift+L');
  await expect(notice(page)).toContainText('No OCR layers for this volume');
  await page.keyboard.press('r');
  await expect(notice(page)).toContainText('Not available for the primary layer');
  await page.keyboard.press('h');
  await expect(notice(page)).toContainText('OCR Layer:');
  await page.keyboard.press('d');
  await expect(notice(page)).toContainText('Connect cloud storage to sync progress');

  // The timer: what a click on it does.
  await page.keyboard.press('u');
  await expect(notice(page)).toContainText('Reading timer: Paused');
  await page.keyboard.press('u');
  await expect(notice(page)).toContainText('Reading timer: Running');

  // Open settings: the one flag, the reader's drawer. Keys stand down under it.
  await page.keyboard.press('s');
  await expect(page.locator('dialog#settings[open]')).toHaveCount(1);
  await page.keyboard.press('ArrowLeft');
  await expectStays(page, 1);
  await closeDrawer(page);
  await page.keyboard.press('ArrowLeft');
  await expectPage(page, 2);
});

test('Add image to Anki: the keys and the quick menu buttons run one handler', async ({ page }) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyAnki', {
    singlePageView: 'dual',
    keyBindings: { 'reader.anki-image': ['KeyA'], 'reader.anki-image-2': ['KeyB'] }
  });
  // AnkiConnect on (the picker itself talks to nothing until a box is chosen).
  await page.evaluate(() => {
    const profiles = JSON.parse(localStorage.getItem('profiles') ?? '{}');
    const id = localStorage.getItem('currentProfile') ?? 'Desktop';
    profiles[id].ankiConnectSettings = { ...profiles[id].ankiConnectSettings, enabled: true };
    localStorage.setItem('profiles', JSON.stringify(profiles));
  });
  await page.reload();
  await openReader(page, volume);
  const picker = page.locator('dialog[open]', { hasText: 'Select Text Box' });
  const cancel = page.locator('dialog[open] button', { hasText: /^\s*Cancel\s*$/ });

  // The cover stands alone: there is no second page to add.
  await expectPage(page, 1);
  await page.keyboard.press('b');
  await expect(notice(page)).toContainText('There is no second page on screen');
  await expect(openDialogs(page)).toHaveCount(0);

  // A spread: each key opens the text box picker on its page.
  await page.keyboard.press('ArrowLeft');
  await expectPage(page, 2);
  await page.keyboard.press('a');
  await expect(picker).toBeVisible();
  // Under the picker the reader's keys stand down: no second picker, no page turn.
  await cancel.focus();
  await page.keyboard.press('b');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(400);
  await expect(openDialogs(page)).toHaveCount(1);
  await cancel.click();
  await expect(openDialogs(page)).toHaveCount(0);
  await expectPage(page, 2);
  await page.keyboard.press('b');
  await expect(picker).toBeVisible();
  await cancel.click();
  await expect(openDialogs(page)).toHaveCount(0);

  // The quick menu's two buttons are the same handler.
  await page.getByLabel('Quick actions menu').click();
  await page.getByLabel('Add image 2 to Anki').click();
  await expect(picker).toBeVisible();
  await cancel.click();
  await expect(openDialogs(page)).toHaveCount(0);
  await page.getByLabel('Quick actions menu').click();
  await page.getByLabel('Add image to Anki', { exact: true }).click();
  await expect(picker).toBeVisible();
});

test('reader commands by key: layer and edit commands, dialogs never stack, continuous zoom', async ({
  page
}) => {
  test.setTimeout(180_000);
  const volume = await setup(page, 'KeyLayerEdit', {
    continuousZoomDefault: 'zoomFillScreen',
    keyBindings: {
      'layer.new': ['KeyW'],
      'layer.delete': ['KeyX'],
      'layer.rename': ['KeyR'],
      'layer.promote': ['KeyY'],
      'edit.merge': ['KeyJ'],
      'edit.draw-tool': ['KeyD'],
      'edit.flip': ['KeyK'],
      'edit.revert-page': ['KeyU'],
      'reader.zoom-in': ['Equal'],
      'reader.zoom-fit': ['Digit0']
    }
  });
  await openReader(page, volume);
  await expectPage(page, 1);

  // New layer: the picker's own name prompt. The reader's keys stand down under it.
  await page.keyboard.press('w');
  await expect(openDialogs(page)).toHaveCount(1);
  await page.locator('dialog[open] input[aria-label="Layer name"]').fill('Scratch');
  await page.getByLabel('Confirm layer name').click();
  await expect(openDialogs(page)).toHaveCount(0);
  // (The switch is announced before the new row's name has loaded.)
  await expect(notice(page)).toContainText(/OCR Layer: scratch/i);

  // Delete layer asks first. A second press cannot stack another question
  // behind it, and no key acts on the page under the dialog.
  await page.keyboard.press('x');
  await expect(openDialogs(page)).toHaveCount(1);
  await expect(openDialogs(page)).toContainText('Delete layer "Scratch"?');
  const no = page.locator('dialog[open] button', { hasText: /^\s*No\s*$/ });
  await no.focus();
  await page.keyboard.press('x');
  await page.keyboard.press('w');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(400);
  await expect(openDialogs(page)).toHaveCount(1);
  expect(await currentPage(page)).toBe(1);
  await no.click();
  await expect(openDialogs(page)).toHaveCount(0);

  // Promote: the same rule, through the confirmation; declined, nothing changes.
  await page.keyboard.press('y');
  await expect(openDialogs(page)).toContainText('Replace this volume');
  await page.locator('dialog[open] button', { hasText: /^\s*No\s*$/ }).click();
  await expect(openDialogs(page)).toHaveCount(0);

  // Rename: the prompt opens on the displayed layer's name.
  await page.keyboard.press('r');
  await expect(page.locator('dialog[open] input[aria-label="Layer name"]')).toHaveValue('Scratch');
  await page.locator('dialog[open] button', { hasText: /^\s*Cancel\s*$/ }).click();
  await expect(openDialogs(page)).toHaveCount(0);

  // Edit commands: the toolbar's own enablement, said out loud when it is off.
  await page.keyboard.press('e');
  await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
  await page.keyboard.press('j');
  await expect(notice(page)).toContainText('Select two or more boxes to merge');
  await page.keyboard.press('k');
  await expect(notice(page)).toContainText('Select a box to flip its writing mode');
  await page.keyboard.press('u');
  await expect(notice(page)).toContainText('No original to revert to');
  const draw = page.getByLabel('Draw new box');
  await expect(draw).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('d');
  await expect(draw).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('d');
  await expect(draw).toHaveAttribute('aria-pressed', 'false');
  // With a box selected, Flip runs — one undoable edit.
  await expect(page.getByLabel('Undo', { exact: true })).toBeDisabled();
  await page.locator('.editBlock').first().click();
  await expect(page.locator('.editBlock.selected')).toHaveCount(1);
  await page.keyboard.press('k');
  await expect(page.getByLabel('Undo', { exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-edit-toolbar]')).toBeHidden();

  // Continuous scroll: Zoom to fit sets the zoom mode (there is no transient
  // view there), announced like any setting; Zoom in steps the strip's zoom.
  await page.keyboard.press('v');
  await expect.poll(() => profileSetting(page, 'continuousScroll')).toBe(true);
  expect(await profileSetting(page, 'continuousZoomDefault')).toBe('zoomFillScreen');
  await page.keyboard.press('Digit0');
  await expect.poll(() => profileSetting(page, 'continuousZoomDefault')).toBe('zoomFitToScreen');
  await expect(notice(page)).toContainText('Continuous zoom: Fit to screen');
  await page.waitForTimeout(600);
  const before = await pageWidth(page);
  await page.keyboard.press('Equal');
  await expect.poll(() => pageWidth(page), { timeout: 5000 }).toBeGreaterThan(before * 1.1);
});

test('one listener outside the reader: the card under the pointer, then the page, then app', async ({
  page,
  context
}) => {
  test.setTimeout(180_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const volume = await setup(page, 'KeyLibrary', {
    keyBindings: {
      'library.focus-search': ['Slash'],
      // One chord on a card's action and on the page's: the card goes first.
      'library.series-open': ['KeyO'],
      'set.gallery-layout.next': ['KeyO'],
      // …and on a volume row's and the series page's.
      'series.edit': ['KeyE'],
      'library.volume-text': ['KeyT'],
      'series.text': ['KeyT'],
      'library.volume-read': ['KeyR'],
      'library.volume-backup': ['KeyB'],
      'series-editor.next-unlinked': ['KeyN'],
      'app.open-progress-tracker': ['KeyP'],
      'text.copy': ['KeyC'],
      'tracker.current-period': ['KeyC']
    }
  });
  const hash = () => page.evaluate(() => location.hash);
  const seriesLink = page.locator('a[href^="#/series/"]').first();
  const away = () => page.mouse.move(5, 300);

  // Focus search — and the key's own character is not typed into it.
  const search = page.locator('input[type="search"]').first();
  await expect(search).toBeVisible({ timeout: 30000 });
  await away();
  await page.keyboard.press('Slash');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
  await page.locator('body').click({ position: { x: 5, y: 400 } });

  // O with nothing under the pointer is the catalog's own action…
  await away();
  expect(await miscSetting(page, 'galleryLayout')).toBe('grid');
  await page.keyboard.press('o');
  await expect.poll(() => miscSetting(page, 'galleryLayout')).toBe('list');
  // …and with a series row under it (list layout), the row's: open the series.
  await seriesLink.hover();
  await page.keyboard.press('o');
  await expect.poll(hash).toMatch(/^#\/series\//);
  expect(await miscSetting(page, 'galleryLayout')).toBe('list');
  await away();
  await page.keyboard.press('Escape');
  await expect.poll(hash).toBe('#/catalog');
  // The same on a grid card.
  await away();
  await page.keyboard.press('o');
  await expect.poll(() => miscSetting(page, 'galleryLayout')).toBe('grid');
  await seriesLink.hover();
  await page.keyboard.press('o');
  await expect.poll(hash).toMatch(/^#\/series\//);
  expect(await miscSetting(page, 'galleryLayout')).toBe('grid');

  // The series page. E with nothing under the pointer: the series editor.
  const item = page.getByText(`${volume.seriesTitle} 01`, { exact: true }).first();
  await expect(item).toBeVisible({ timeout: 30000 });
  await away();
  await page.keyboard.press('e');
  await expect(openDialogs(page)).toHaveCount(1);
  await expect(openDialogs(page)).toContainText('Titles & AniList');
  // Under the dialog only ITS keys work: Next unlinked answers (there is no
  // other series), an app key and the page's keys do not.
  await page.locator('dialog[open] button[data-autofocus]').focus();
  await page.keyboard.press('n');
  await expect(snackbar(page).last()).toContainText('No other series is missing its AniList link');
  await page.keyboard.press('p');
  await page.keyboard.press('t');
  await page.waitForTimeout(400);
  expect(await hash()).toMatch(/^#\/series\/[^/]+$/);
  await expect(openDialogs(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(openDialogs(page)).toHaveCount(0);
  expect(await hash()).toMatch(/^#\/series\/[^/]+$/);

  // E with a volume under the pointer is still the VOLUME editor.
  await item.hover();
  await page.keyboard.press('e');
  await expect(openDialogs(page)).toContainText('Edit Volume');
  await page.locator('dialog[open] button', { hasText: /^\s*Cancel\s*$/ }).click();
  await expect(openDialogs(page)).toHaveCount(0);

  // Row commands: the buttons' own handlers and tests.
  await item.hover();
  await page.keyboard.press('r');
  await expect(snackbar(page).last()).toContainText(`Marked ${volume.seriesTitle} 01 as read`);
  await page.keyboard.press('r');
  await expect(snackbar(page).last()).toContainText(`Marked ${volume.seriesTitle} 01 as unread`);
  await page.keyboard.press('b');
  await expect(snackbar(page).last()).toContainText('Connect cloud storage to back up');
  // T: the hovered volume's text, not the series'.
  await page.keyboard.press('t');
  await expect.poll(hash).toMatch(/^#\/reader\/[^/]+\/[^/]+\/text$/);
  await expect(page.locator('button', { hasText: 'Copy All Text' })).toBeVisible({
    timeout: 30000
  });
  await away();
  await page.keyboard.press('c');
  await expect(page.locator('button', { hasText: 'Copied!' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(volume.text);

  // T on the series page with nothing under the pointer: the series' text.
  await page.evaluate((s) => (window.location.hash = `#/series/${s}`), volume.seriesUuid);
  await expect(item).toBeVisible({ timeout: 30000 });
  await away();
  await page.keyboard.press('t');
  await expect.poll(hash).toMatch(/^#\/series\/[^/]+\/text$/);
  await expect(page.locator('button', { hasText: 'Copy All Text' })).toBeVisible({
    timeout: 30000
  });
  await page.keyboard.press('c');
  await expect(page.locator('button', { hasText: 'Copied!' })).toBeVisible();

  // An app action from anywhere, and the tracker's own.
  await page.keyboard.press('p');
  await expect.poll(hash).toBe('#/progress-tracker');
  // Views load on demand: the tracker provides its keys once it is mounted.
  await expect(page.locator('h1', { hasText: 'Progress Tracker' })).toBeVisible({ timeout: 30000 });
  await page.keyboard.press('c');
  await expect(snackbar(page).last()).toContainText('Already on a period that is still open');
});

// ---------------------------------------------------------------------------
// Step C: the registry-driven quick menu and the regrouped section.
// ---------------------------------------------------------------------------

const menuButton = (page: Page) => page.getByLabel('Quick actions menu');
const menuEntries = (page: Page) => page.locator('[data-quick-action]');
const menuEntry = (page: Page, id: string) => page.locator(`[data-quick-action="${id}"]`);
const menuIds = (page: Page) =>
  menuEntries(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-quick-action')));

/** Today's menu with AnkiConnect off and no OCR layers: what a fresh install shows. */
const DEFAULT_MENU = [
  'reader.edit-mode',
  'reader.fullscreen',
  'reader.zoom-fit',
  'reader.page-next',
  'reader.page-prev'
];
const menuIcon = (page: Page, id: string) =>
  menuEntry(page, id).getAttribute('data-quick-action-icon');
/**
 * The menu button's LAYOUT box. It turns 45° while the menu is open, and a
 * turned square's bounds are 10 px wider each side than the button — and
 * moving, for the 0.3 s the turn takes. Its centre does not move.
 */
const menuButtonBox = (page: Page) =>
  menuButton(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = el as HTMLElement;
    return {
      x: r.left + r.width / 2 - width / 2,
      y: r.top + r.height / 2 - height / 2,
      width,
      height
    };
  });

async function switchOnMenu(page: Page, id: string) {
  const toggle = row(page, id).locator('[data-quick-menu-switch]');
  await toggle.click();
  return toggle;
}

test('quick menu at defaults is today’s menu, and each entry runs its key’s handler', async ({
  page
}) => {
  test.setTimeout(150_000);
  // Vertical, so that V below lands in vertical scroll whatever the window's shape.
  const volume = await setup(page, 'KeyMenuDefaults', { scrollMode: 'vertical' });
  await openReader(page, volume);
  await expectPage(page, 1);
  expect(await profileSetting(page, 'quickMenu')).toEqual({});

  await menuButton(page).click();
  expect(await menuIds(page)).toEqual(DEFAULT_MENU);
  // Named by their actions, in a single column above the menu's own button.
  await expect(menuEntry(page, 'reader.page-next')).toHaveAttribute('aria-label', 'Next page');
  await expect(menuEntry(page, 'reader.page-next')).toHaveAttribute('title', 'Next page');
  await expect(menuEntry(page, 'reader.page-prev')).toHaveAttribute('aria-label', 'Previous page');
  // A right-to-left book: each arrow points where its page turn goes.
  expect(await menuIcon(page, 'reader.page-next')).toBe('ArrowLeftOutline');
  expect(await menuIcon(page, 'reader.page-prev')).toBe('ArrowRightOutline');
  const xs = await menuEntries(page).evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().left))
  );
  const buttonX = Math.round((await menuButtonBox(page)).x);
  expect(new Set(xs)).toEqual(new Set([buttonX]));
  const ys = await menuEntries(page).evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().top)
  );
  expect(ys).toEqual([...ys].sort((a, b) => a - b));
  expect(ys[ys.length - 1]).toBeLessThan((await menuButtonBox(page)).y);

  // Next page and Previous page, as the owner's list has them.
  await menuEntry(page, 'reader.page-next').click();
  await expectPage(page, 2);
  await expect(menuEntries(page)).toHaveCount(0);
  await menuButton(page).click();
  await menuEntry(page, 'reader.page-prev').click();
  await expectPage(page, 1);

  // Edit: the same toggle E is. Pressed while editing.
  await menuButton(page).click();
  await menuEntry(page, 'reader.edit-mode').click();
  await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
  await menuButton(page).click();
  await expect(menuEntry(page, 'reader.edit-mode')).toHaveAttribute('aria-pressed', 'true');
  // While editing, the layer picker joins the menu (as it always has).
  expect(await menuIds(page)).toEqual(['reader.ocr-layers', ...DEFAULT_MENU]);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-edit-toolbar]')).toHaveCount(0);

  // Continuous VERTICAL scroll: the same menu — nobody loses the two page
  // buttons by turning it on — with Edit saying why it is off.
  await page.keyboard.press('v');
  await expect.poll(() => profileSetting(page, 'continuousScroll')).toBe(true);
  await expect(menuEntry(page, 'reader.edit-mode')).toBeDisabled();
  await expect(menuEntry(page, 'reader.edit-mode')).toHaveAttribute(
    'title',
    'Edit is available in paged mode only'
  );
  expect(await menuIds(page)).toEqual(DEFAULT_MENU);
  // Down the strip and back up, and the arrows say so.
  expect(await menuIcon(page, 'reader.page-next')).toBe('ArrowDownOutline');
  expect(await menuIcon(page, 'reader.page-prev')).toBe('ArrowUpOutline');
  await menuEntry(page, 'reader.page-next').click();
  await expectPage(page, 2);
  await menuButton(page).click();
  await menuEntry(page, 'reader.page-next').click();
  await expectPage(page, 3);
  await menuButton(page).click();
  await menuEntry(page, 'reader.page-prev').click();
  await expectPage(page, 2);
  expect(await profileSetting(page, 'quickMenu')).toEqual({});
});

test('quick menu: an action switched on in the section shows, runs, survives a reload, and is the profile’s own', async ({
  page
}) => {
  test.setTimeout(180_000);
  const volume = await setup(page, 'KeyMenuAdd');
  await openReader(page, volume);
  await openShortcuts(page);
  await expect(page.locator('[data-quick-menu-count]')).toContainText('Quick menu: 8 actions');
  await expect(page.locator('#settings button', { hasText: 'Reset quick menu' })).toHaveCount(0);

  // A toggle, a step and a "Set to", found by search; each row has a switch.
  await filterShortcuts(page, 'bold font');
  const bold = await switchOnMenu(page, 'set.bold.toggle');
  await expect(bold).toHaveAttribute('aria-checked', 'true');
  await filterShortcuts(page, 'brightness');
  // The folded setting row opened for the search and lists its three actions.
  await expect(
    page.locator('[data-key-setting="setting:brightness"] [data-key-action]')
  ).toHaveCount(3);
  await switchOnMenu(page, 'set.brightness.up');
  await filterShortcuts(page, 'fit to width');
  await expect(page.locator('[data-key-action]')).toHaveCount(1);
  await switchOnMenu(page, 'set.zoom-paged.to.zoomFitToWidth');
  // A default switched off.
  await filterShortcuts(page, 'fullscreen');
  const full = await switchOnMenu(page, 'reader.fullscreen');
  await expect(full).toHaveAttribute('aria-checked', 'false');
  // An action that can never be on the menu has no switch.
  await filterShortcuts(page, 'open quick menu');
  await expect(row(page, 'reader.quick-menu')).toBeVisible();
  await expect(row(page, 'reader.quick-menu').locator('[data-quick-menu-switch]')).toHaveCount(0);

  await expect(page.locator('[data-quick-menu-count]')).toContainText('Quick menu: 10 actions');
  expect(await profileSetting(page, 'quickMenu')).toEqual({
    'set.bold.toggle': true,
    'set.brightness.up': true,
    'set.zoom-paged.to.zoomFitToWidth': true,
    'reader.fullscreen': false
  });
  // Clearing the search folds the list away again; the closed setting row says what is inside.
  await filterShortcuts(page, '');
  await expect(page.locator('[data-key-action]')).toHaveCount(0);
  await openGroup(page, 'image');
  await expect(
    page.locator('[data-key-setting="setting:brightness"] [data-key-setting-summary]')
  ).toHaveText('3 actions · 1 on the quick menu');
  await expect(page.locator('[data-key-group="image"] [data-key-group-changed]')).toHaveText(
    '1 changed'
  );
  // The filter finds exactly what is on the menu.
  await page.locator('#settings button', { hasText: /^On the quick menu$/ }).click();
  await expect(page.locator('[data-key-action]')).toHaveCount(10);
  await closeDrawer(page);

  // The menu: the defaults in their order (minus Fullscreen), then the additions in registry order.
  const expected = [
    'reader.edit-mode',
    'reader.zoom-fit',
    'reader.page-next',
    'reader.page-prev',
    'set.zoom-paged.to.zoomFitToWidth',
    'set.brightness.up',
    'set.bold.toggle'
  ];
  await menuButton(page).click();
  expect(await menuIds(page)).toEqual(expected);
  await expect(
    menuEntry(page, 'set.brightness.up').locator('[data-quick-action-badge]')
  ).toHaveText('+');
  await expect(
    menuEntry(page, 'set.zoom-paged.to.zoomFitToWidth').locator('[data-quick-action-badge]')
  ).toHaveText('Fit');
  await expect(menuEntry(page, 'set.bold.toggle')).toHaveAttribute('aria-pressed', 'false');

  // A tap runs the generated handler: written, announced in the reader's notification.
  await menuEntry(page, 'set.bold.toggle').click();
  await expect(notification(page)).toHaveText('Bold font: On');
  expect(await profileSetting(page, 'boldFont')).toBe(true);
  await expect(menuEntries(page)).toHaveCount(0);
  await menuButton(page).click();
  await expect(menuEntry(page, 'set.bold.toggle')).toHaveAttribute('aria-pressed', 'true');
  // A step keeps the menu open for the next tap.
  await menuEntry(page, 'set.brightness.up').click();
  await expect(notification(page)).toHaveText('Brightness: 105%');
  await menuEntry(page, 'set.brightness.up').click();
  await expect(notification(page)).toHaveText('Brightness: 110%');
  expect(await profileSetting(page, 'pageBrightness')).toBe(110);
  await expect(menuEntry(page, 'set.brightness.up')).toBeVisible();
  await menuEntry(page, 'set.zoom-paged.to.zoomFitToWidth').click();
  await expect(notification(page)).toHaveText('Paged zoom: Fit to width');
  expect(await profileSetting(page, 'zoomDefault')).toBe('zoomFitToWidth');

  // Reload: the selection is the profile's.
  await page.reload();
  await expect(page.locator('#page-num')).toContainText(`/ ${PAGES}`, { timeout: 30000 });
  await menuButton(page).click();
  expect(await menuIds(page)).toEqual(expected);

  // Another profile has its own menu: today's.
  await page.evaluate(() => localStorage.setItem('currentProfile', 'Mobile'));
  await page.reload();
  await expect(page.locator('#page-num')).toContainText(`/ ${PAGES}`, { timeout: 30000 });
  await menuButton(page).click();
  expect(await menuIds(page)).toEqual(DEFAULT_MENU);
  await menuButton(page).click();

  // Back on the first profile, "Reset quick menu" brings today's back and leaves the keys alone.
  await page.evaluate(() => localStorage.setItem('currentProfile', 'Desktop'));
  await patchProfile(page, { keyBindings: { 'reader.fullscreen': ['KeyX'] } });
  await expect(page.locator('#page-num')).toContainText(`/ ${PAGES}`, { timeout: 30000 });
  await openShortcuts(page);
  await page.locator('#settings button', { hasText: 'Reset quick menu' }).click();
  await page.locator('dialog[open] button', { hasText: /^\s*Yes\s*$/ }).click();
  await expect.poll(() => profileSetting(page, 'quickMenu')).toEqual({});
  expect(await profileSetting(page, 'keyBindings')).toEqual({ 'reader.fullscreen': ['KeyX'] });
  await expect(page.locator('[data-quick-menu-count]')).toContainText('Quick menu: 8 actions');
});

test('quick menu: a scheduled filter’s tap shows the message with “Set to manual”, like its key', async ({
  page
}) => {
  test.setTimeout(150_000);
  const volume = await setup(page, 'KeyMenuSchedule', {
    nightMode: false,
    nightModeSchedule: { enabled: true, startTime: '00:00', endTime: '23:59' },
    quickMenu: { 'reader.night': true }
  });
  await openReader(page, volume);
  const button = notification(page).locator('button', { hasText: 'Set to manual' });

  // A phone's width: the message with its button fits the screen — the
  // message wraps, the button stays whole and inside the edges.
  await page.setViewportSize({ width: 390, height: 844 });
  await menuButton(page).click();
  await menuEntry(page, 'reader.night').click();
  await expect(button).toBeVisible();
  const box = (await notification(page).boundingBox())!;
  const tap = (await button.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(tap.x).toBeGreaterThanOrEqual(box.x);
  expect(tap.x + tap.width).toBeLessThanOrEqual(box.x + box.width);
  // Centred, and one line of button: it did not wrap.
  expect(Math.abs(box.x + box.width / 2 - 195)).toBeLessThanOrEqual(1);
  expect(tap.height).toBeLessThan(40);
  await expect(notification(page)).toContainText('Night Mode is on automatic schedule');
  await page.setViewportSize({ width: 1920, height: 1080 });
  // On a wide screen it is one line, as it always was.
  await menuButton(page).click();
  await menuEntry(page, 'reader.night').click();
  await expect(button).toBeVisible();
  expect((await notification(page).boundingBox())!.height).toBeLessThan(48);

  await menuButton(page).click();
  // On by schedule: the entry shows what is on screen.
  await expect(menuEntry(page, 'reader.night')).toHaveAttribute('aria-pressed', 'true');
  await menuEntry(page, 'reader.night').click();
  await expect(notification(page)).toContainText('Night Mode is on automatic schedule');
  await expect(button).toBeVisible();
  expect(await profileSetting(page, 'nightMode')).toBe(false);
  await button.click();
  await expect(notification(page)).toHaveText('Night mode: On (manual)');
  expect(((await profileSetting(page, 'nightModeSchedule')) as { enabled: boolean }).enabled).toBe(
    false
  );
  expect(await profileSetting(page, 'nightMode')).toBe(true);
  // Now manual: the next tap toggles it.
  await menuButton(page).click();
  await menuEntry(page, 'reader.night').click();
  await expect(notification(page)).toHaveText('Night mode: Off');
  expect(await profileSetting(page, 'nightMode')).toBe(false);
});

test('quick menu: more entries than one column holds wrap toward the centre, all on screen', async ({
  page
}) => {
  test.setTimeout(150_000);
  const extra = [
    'reader.page-left',
    'reader.page-right',
    'reader.page-first',
    'reader.page-last',
    'reader.zoom-in',
    'reader.zoom-out',
    'reader.controls',
    'reader.copy-page-text',
    'reader.timer-pause',
    'app.settings',
    'app.sync',
    'reader.night',
    'reader.invert',
    'reader.grayscale',
    'set.bold.toggle',
    'set.brightness.up',
    'set.brightness.down',
    'set.brightness.reset'
  ];
  const volume = await setup(page, 'KeyMenuWrap', {
    quickMenu: Object.fromEntries(extra.map((id) => [id, true]))
  });
  await page.setViewportSize({ width: 1000, height: 560 });
  await openReader(page, volume);
  await menuButton(page).click();
  await expect(menuEntries(page)).toHaveCount(DEFAULT_MENU.length + extra.length);

  const boxes = await menuEntries(page).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute('data-quick-action'),
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom
      };
    })
  );
  const main = await menuButtonBox(page);
  // Everything is on screen and nothing overlaps the menu's own button.
  for (const b of boxes) {
    expect(b.left, b.id!).toBeGreaterThanOrEqual(0);
    expect(b.top, b.id!).toBeGreaterThanOrEqual(0);
    expect(b.right, b.id!).toBeLessThanOrEqual(1000);
    expect(b.bottom, b.id!).toBeLessThanOrEqual(main.y);
  }
  // No two entries overlap.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const apart =
        a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      expect(apart, `${a.id} over ${b.id}`).toBe(true);
    }
  }
  // Several columns: the first — the defaults — stays above the button, the rest go inward.
  const columns = [...new Set(boxes.map((b) => Math.round(b.left)))].sort((a, b) => b - a);
  expect(columns.length).toBeGreaterThan(1);
  expect(columns[0]).toBe(Math.round(main.x));
  for (const id of DEFAULT_MENU) {
    expect(Math.round(boxes.find((b) => b.id === id)!.left), id).toBe(columns[0]);
  }
  // An entry in a further column is as tappable as any.
  await menuEntry(page, 'set.bold.toggle').click();
  await expect(notification(page)).toHaveText('Bold font: On');
});
