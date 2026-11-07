import { expect, type Page } from '@playwright/test';
import type { SyntheticVolume } from './synthetic-volume';

/**
 * Import `volume` through the real upload modal and wait until its images are
 * saved. Reads IndexedDB directly, so it works on a production build too (which
 * has no `/src/...` module to import).
 */
export async function importVolume(page: Page, volume: SyntheticVolume) {
  // The navbar's upload icon (stats, progress tracker, settings, upload, cloud).
  await page.locator('nav div.md\\:order-2 > button').nth(3).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('dialog button', { hasText: 'choose files' }).click();
  await (await chooser).setFiles([volume.mokuro, volume.cbz]);
  await page.locator('dialog button', { hasText: /^\s*Import\s*$/ }).click();
  // Saved = its image row exists.
  await expect
    .poll(
      () =>
        page.evaluate(
          (uuid) =>
            new Promise<boolean>((resolve) => {
              const open = indexedDB.open('mokuro_v3');
              open.onerror = () => resolve(false);
              open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains('volume_files')) return resolve(false);
                const get = db.transaction('volume_files').objectStore('volume_files').get(uuid);
                get.onsuccess = () => resolve(get.result != null);
                get.onerror = () => resolve(false);
              };
            }),
          volume.volumeUuid
        ),
      { timeout: 60_000, message: 'the import never saved the volume' }
    )
    .toBe(true);
}
