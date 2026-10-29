import { expect, type Browser, type Page } from '@playwright/test';
import { gotoApp } from './app';
import { WebDavStub } from './webdav-stub';

/**
 * Devices (browser contexts) sharing an in-memory WebDAV server, each with one
 * installed 50-page volume — for the `positions.json` specs.
 */

const STUB = 'http://stub.test';
export const ROOT = '/mokuro-reader';
export const POSITIONS = `${ROOT}/positions.json`;
export const SERIES = 'Swap Series';
export const SERIES_UUID = 'e2e-swap-series';
export const VOL = 'e2e-swap-volume';
export const PAGES = 50;

export async function device(browser: Browser, stub: WebDavStub): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route(`${STUB}/**`, stub.handle);
  await gotoApp(page);
  await page.evaluate(async (serverUrl) => {
    const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
    const provider = await providerManager.getOrLoadProvider('webdav');
    await provider.login({ serverUrl, username: '', password: '' });
    await providerManager.setCurrentProvider(provider);
  }, STUB);
  return page;
}

export async function sync(page: Page) {
  const result = await page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    await unifiedCloudManager.fetchAllCloudVolumes();
    return unifiedCloudManager.syncProgress({ silent: false });
  });
  expect(result.succeeded).toBe(1);
}

/** Install a 50-page volume locally (as a download would have left it). */
export async function installVolume(page: Page) {
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOL, PAGES }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 300;
      canvas.getContext('2d')!.fillRect(0, 0, 200, 300);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const pages = Array.from({ length: PAGES }, (_, i) => ({
        version: '0.2.1',
        img_width: 200,
        img_height: 300,
        img_path: `${String(i + 1).padStart(3, '0')}.png`,
        blocks: []
      }));
      const files: Record<string, File> = {};
      for (const p of pages)
        files[p.img_path] = new File([blob], p.img_path, { type: 'image/png' });
      await db.volumes.put({
        volume_uuid: VOL,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.2.1',
        page_count: PAGES,
        character_count: 0,
        page_char_counts: pages.map(() => 0),
        thumbnail: new File([blob], 'thumb.webp', { type: 'image/webp' })
      });
      await db.volume_ocr.put({ volume_uuid: VOL, pages });
      await db.volume_files.put({ volume_uuid: VOL, files });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('singlePageView', 'single');
    },
    { SERIES, SERIES_UUID, VOL, PAGES }
  );
}

/** Read pages the way the reader records them: a view each, and the position. */
export async function read(page: Page, pages: number[]) {
  await page.evaluate(
    async ({ VOL, pages }) => {
      const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
      const { recordEvent } = await import('/src/lib/reading-history/record.ts');
      for (const p of pages) {
        await recordEvent({
          kind: 'page',
          volume: VOL,
          first_page: p,
          last_page: p,
          page_chars: [0],
          chars_before: 0,
          dwell_ms: 5,
          layout: 'single',
          orientation: 'portrait',
          viewport: { w: 400, h: 800 }
        });
        updateProgress(VOL, p, 0);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    { VOL, pages }
  );
}

export async function progress(page: Page) {
  return page.evaluate(async (VOL) => {
    const { volumesWithTrash } = await import('/src/lib/settings/volume-data.ts');
    let all: Record<string, { progress: number }> = {};
    volumesWithTrash.subscribe((v) => (all = v))();
    return all[VOL]?.progress ?? null;
  }, VOL);
}

export function positionsFile(stub: WebDavStub): Record<string, [number, number, number, string]> {
  const entry = stub.files.get(POSITIONS);
  return entry ? JSON.parse(entry.body.toString()).positions : {};
}

export const positionPuts = (stub: WebDavStub) =>
  stub.log.filter((l) => l.method === 'PUT' && l.path === POSITIONS).length;

export async function openVolume(page: Page) {
  await page.evaluate(
    ({ SERIES_UUID, VOL }) => {
      window.location.hash = `#/reader/${SERIES_UUID}/${VOL}`;
    },
    { SERIES_UUID, VOL }
  );
}

export const counter = (page: Page, n: number) =>
  page.getByText(`${n} / ${PAGES}`, { exact: true });
