import { test, expect } from '@playwright/test';
import { gotoApp } from './helpers/app';

/**
 * A volume card's menu stays open after a slow press. The popper opens it on
 * mousedown after a ~200 ms debounce; the trigger's own click used to close
 * every card's menu, its own included, so a press held past the debounce (a
 * slow tap, a busy page) opened the menu and closed it again on release.
 */
test('a slow press on a card’s menu button leaves the menu open', async ({ browser }) => {
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  await gotoApp(page);
  await page.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    await db.open();
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 30;
    const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
    await db.volumes.put({
      volume_uuid: 'menu-vol',
      series_uuid: 'menu-series',
      series_title: 'Menu Series',
      volume_title: 'Vol 1',
      mokuro_version: '0.2.1',
      page_count: 10,
      character_count: 1000,
      thumbnail: new File([blob], 'cover.png', { type: 'image/png' }),
      thumbnail_width: 20,
      thumbnail_height: 30
    });
    window.location.hash = '#/series/Menu%20Series';
  });
  const trigger = page.locator('#volume-menu-menu-vol');
  await expect(trigger).toBeVisible({ timeout: 30000 });
  const box = (await trigger.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.mouse.up();
  const item = page.getByRole('button', { name: 'Mark as read', exact: true });
  await expect(item).toBeVisible();
  // Still open a while later: nothing closed it on release.
  await page.waitForTimeout(500);
  await expect(item).toBeVisible();
});
