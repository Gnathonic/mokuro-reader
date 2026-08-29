import { test, expect, type Page } from '@playwright/test';

/**
 * The catalog card's covers, against the REAL app.
 *
 * Regression for the long-standing "freshly-downloaded series render NO covers until I
 * navigate away and back" report. The card asks for each cloud cover once, and used to
 * spend that request even when it produced nothing — so a provider saturated by a bulk
 * download (or one still connecting) blanked the card until it remounted.
 *
 * No cloud account is involved: the Local Folder provider reads OPFS, with its directory
 * picker stubbed, exactly as `catalog-distribution.spec.ts` does. The saturation is
 * injected by failing every cover download for a fixed window and then letting the
 * provider recover — which is the whole point: the covers must land afterwards.
 */

const OPFS_PICKER_STUB = `(() => {
  const patch = (h) => {
    try { if (typeof h.queryPermission !== 'function') h.queryPermission = async () => 'granted'; } catch {}
    try { if (typeof h.requestPermission !== 'function') h.requestPermission = async () => 'granted'; } catch {}
    return h;
  };
  window.showDirectoryPicker = async () => patch(await navigator.storage.getDirectory());
})();`;

async function boot(page: Page) {
  await page.addInitScript(OPFS_PICKER_STUB);
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 20000 })
    .toBe('#/catalog');
}

async function goHash(page: Page, hash: string) {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await page.waitForTimeout(400);
}

test('covers land after the downloads that failed while the provider was saturated', async ({
  page
}) => {
  test.setTimeout(300000);
  page.on('pageerror', (e) => console.log('[pageerror]', String(e)));

  await boot(page);
  await page.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    await db.open();
    await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_files.clear()]);
    const root = await navigator.storage.getDirectory();
    // @ts-expect-error entries() is not in every lib.dom
    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  });

  // 6 series only, all above the fold.
  await page.evaluate(async () => {
    const cvs = document.createElement('canvas');
    cvs.width = 250;
    cvs.height = 350;
    const c = cvs.getContext('2d')!;
    c.fillStyle = '#2a6';
    c.fillRect(0, 0, 250, 350);
    const cover: Blob = await new Promise((r) => cvs.toBlob((b) => r(b!), 'image/webp'));
    const root = await navigator.storage.getDirectory();
    for (let s = 0; s < 6; s++) {
      const dir = await root.getDirectoryHandle(`Cloud Series ${s}`, { create: true });
      for (let v = 0; v < 2; v++) {
        const cbz = await dir.getFileHandle(`Volume ${v + 1}.cbz`, { create: true });
        let w = await cbz.createWritable();
        await w.write(new Uint8Array(1024).fill(65));
        await w.close();
        const webp = await dir.getFileHandle(`Volume ${v + 1}.webp`, { create: true });
        w = await webp.createWritable();
        await w.write(cover);
        await w.close();
      }
    }
  });

  // Fault injection BEFORE the catalog ever renders a card: every cover download fails
  // for the first 6 seconds — what a provider saturated by a 500-task download queue
  // does — and the provider is healthy again after that. Before the fix all six cards
  // stayed on their download boxes for good; the retries were never made because the
  // request had already been spent.
  await page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    const mgr = unifiedCloudManager as unknown as {
      downloadFile: (a: { path: string }) => Promise<Blob>;
    };
    const real = mgr.downloadFile.bind(mgr);
    const until = Date.now() + 6000;
    let failures = 0;
    mgr.downloadFile = async (args: { path: string }) => {
      if (/\.webp$/i.test(args.path) && Date.now() < until) {
        failures++;
        (window as unknown as { __coverFailures: number }).__coverFailures = failures;
        throw new Error('injected: provider saturated');
      }
      return real(args);
    };
  });

  await goHash(page, '#/cloud');
  const button = page.getByRole('button', { name: /Local Folder/ });
  await button.waitFor({ state: 'visible', timeout: 20000 });
  await button.click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
          const { cacheManager } = await import('/src/lib/util/sync/cache-manager.ts');
          const p = providerManager.getActiveProvider?.();
          return p?.type === 'filesystem' && !!cacheManager.getCache('filesystem')?.isLoaded()
            ? 'loaded'
            : 'waiting';
        }),
      { timeout: 60000 }
    )
    .toBe('loaded');
  await goHash(page, '#/catalog');

  const report = () =>
    page.evaluate(() => {
      const anchors = Array.from(
        document.querySelectorAll('[data-testid="catalog-cloud"] a')
      ) as HTMLElement[];
      return {
        failures: (window as unknown as { __coverFailures?: number }).__coverFailures ?? 0,
        cards: anchors.map((a) => {
          const title = a.querySelector('p')?.textContent?.trim() ?? '?';
          const canvases = Array.from(a.querySelectorAll('canvas')) as HTMLCanvasElement[];
          let painted = false;
          for (const cv of canvases) {
            const ctx = cv.getContext('2d');
            if (!ctx || !cv.width || !cv.height) continue;
            const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
            for (let i = 3; i < d.length; i += 4 * 53)
              if (d[i] !== 0) {
                painted = true;
                break;
              }
            if (painted) break;
          }
          const box = a.textContent?.includes('Click to download') ?? false;
          return `${painted ? 'painted' : box ? 'DOWNLOAD-BOX' : canvases.length ? 'BLANK' : 'NOTHING'}|${title}`;
        })
      };
    });

  let final = await report();
  for (let i = 0; i < 25; i++) {
    final = await report();
    if (final.cards.length > 0 && final.cards.every((card) => card.startsWith('painted'))) break;
    await page.waitForTimeout(1000);
  }

  expect(final.failures, 'the fault injection never fired').toBeGreaterThan(0);
  expect(
    final.cards.filter((card) => !card.startsWith('painted')),
    `cards that never drew a cover:\n${final.cards.join('\n')}`
  ).toEqual([]);
});
