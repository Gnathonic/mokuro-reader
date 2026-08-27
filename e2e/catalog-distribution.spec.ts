import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * E2E for the catalog distribution client (spec:
 * docs/superpowers/specs/2026-08-23-catalog-distribution-design.md, plan:
 * docs/superpowers/plans/2026-08-23-catalog-distribution-client.md).
 *
 * No cloud account is involved. Two techniques, both against the REAL app:
 *
 * 1. Module drive-through — `await import('/src/lib/…')` inside `page.evaluate`,
 *    the technique `e2e/zoom.spec.ts` already uses, so the assertions run over
 *    the production modules the browser actually loaded.
 * 2. Seed-and-render — the REAL Dexie tables the cloud layer would have filled
 *    are written directly, then the actual catalog / series / editor views are
 *    asserted on. Where a provider is genuinely required (the reconcile
 *    backfill, download queueing, hole patching) the Local Folder provider is
 *    connected against OPFS, which needs no account and no server: the
 *    directory picker is stubbed to hand back `navigator.storage.getDirectory()`.
 */

const CATALOG_JSON = {
  version: 1,
  updated_at: '2026-08-23T00:00:00.000Z',
  series: [
    {
      series_title: 'Dr Stone (HD Scan)',
      external_ids: { anilist: 98416 },
      titles: { native: 'Dr.STONE', english: 'Dr. STONE' },
      synonyms: ['Doctor Stone'],
      tag: 'HD Scan',
      updated_at: '2026-08-18T19:36:24.324Z'
    },
    {
      series_title: 'Bare Folder',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '1970-01-01T00:00:00.000Z'
    }
  ]
};

/**
 * The documented dev-server artifacts. Anything else on the console fails
 * `expectCleanConsole`, so this list stays short and each entry says why.
 *
 * - `Unexpected token '<'` — `@vercel/analytics`' `inject()` in `+layout.svelte`
 *   requests `/_vercel/insights/script.js`, which only exists on Vercel; the SPA
 *   catchall answers with `index.html` and the browser tries to parse HTML as JS.
 *   Verified as the sole source: it is the only `text/html` response served to a
 *   `script` request on a clean boot.
 * - `Failed to load resource` — the same request, plus the production service
 *   worker's precache manifest pointing at `https://reader.mokuro.app/...`.
 */
const ALLOWED_CONSOLE = [
  /\[vite\]/i,
  /Unexpected token '<'/,
  /_vercel\/insights/i,
  /Failed to load resource/i,
  /favicon/i,
  /net::ERR_/i
];

type ConsoleWatch = { errors: string[]; all: string[] };

function watchConsole(page: Page): ConsoleWatch {
  const watch: ConsoleWatch = { errors: [], all: [] };
  page.on('console', (msg: ConsoleMessage) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    watch.all.push(line);
    if (msg.type() === 'error') watch.errors.push(line);
  });
  page.on('pageerror', (error) => {
    const line = `[pageerror] ${String(error)}`;
    watch.all.push(line);
    watch.errors.push(line);
  });
  return watch;
}

function expectCleanConsole(watch: ConsoleWatch) {
  const unexpected = watch.errors.filter((line) => !ALLOWED_CONSOLE.some((re) => re.test(line)));
  expect(unexpected, `unexpected console errors:\n${unexpected.join('\n')}`).toEqual([]);
  // Svelte 5's runaway-reactivity guard. It must never fire anywhere: the
  // catalog card and the spine shelf both run effects that write the state
  // their own targets are selected from (see the cover-fetch fix).
  const depth = watch.all.filter((line) => /effect_update_depth_exceeded/.test(line));
  expect(depth, `effect_update_depth_exceeded seen:\n${depth.join('\n')}`).toEqual([]);
}

/**
 * Hand the Local Folder provider the origin's OPFS root instead of a real
 * directory picker. OPFS handles are the same `FileSystemDirectoryHandle` API
 * minus the permission methods the provider calls, so those are patched on.
 * This is the only stub in the file: everything downstream is the real provider.
 */
const OPFS_PICKER_STUB = `(() => {
  const patch = (h) => {
    try { if (typeof h.queryPermission !== 'function') h.queryPermission = async () => 'granted'; } catch {}
    try { if (typeof h.requestPermission !== 'function') h.requestPermission = async () => 'granted'; } catch {}
    return h;
  };
  window.showDirectoryPicker = async () => patch(await navigator.storage.getDirectory());
})();`;

/**
 * Boot the app and wait until it has finished taking over the URL.
 *
 * SvelteKit's client router `replaceState`s the bare origin during hydration
 * (wiping any fragment), and only afterwards does `initRouter()` default the
 * hash to `#/catalog`. A hash written before that lands is silently reverted —
 * so every test waits for the default to appear before navigating anywhere.
 */
async function boot(page: Page) {
  await page.addInitScript(OPFS_PICKER_STUB);
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => window.location.hash), {
      timeout: 20000,
      message: 'the app never claimed the URL'
    })
    .toBe('#/catalog');
  await page.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    await db.open();
  });
}

/** Create files in OPFS — the "cloud folder" the Local Folder provider reads. */
async function seedOpfs(page: Page, files: Array<{ path: string; text?: string; bytes?: number }>) {
  await page.evaluate(async (specs) => {
    const root = await navigator.storage.getDirectory();
    for (const spec of specs) {
      const parts = spec.path.split('/');
      let dir = root;
      for (const segment of parts.slice(0, -1)) {
        dir = await dir.getDirectoryHandle(segment, { create: true });
      }
      const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await handle.createWritable();
      await writable.write(spec.text ?? new Uint8Array(spec.bytes ?? 1024).fill(65));
      await writable.close();
    }
  }, files);
}

/**
 * Run a probe that must survive the app reloading under it.
 *
 * The shell reloads itself on a completed DB migration and on a service-worker
 * `controllerchange`, either of which can land mid-poll and destroy the
 * execution context. A poll that sees that should retry, not fail.
 */
async function probe<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (/Execution context was destroyed|frame was detached|Target closed/i.test(String(error))) {
      return null;
    }
    throw error;
  }
}

/** Recursive listing of the OPFS root, as relative paths. */
const opfsTree = (page: Page) =>
  page.evaluate(async () => {
    const out: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      const entries: Array<[string, FileSystemHandle]> = [];
      // @ts-expect-error - entries() is not in every lib.dom
      for await (const pair of dir.entries()) entries.push(pair);
      entries.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, handle] of entries) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') {
          out.push(`${path}/`);
          await walk(handle as FileSystemDirectoryHandle, path);
        } else out.push(path);
      }
    };
    await walk(await navigator.storage.getDirectory(), '');
    return out;
  });

/** Read a text file out of OPFS by relative path, or `null`. */
const opfsRead = (page: Page, relative: string) =>
  probe(() =>
    page.evaluate(async (rel) => {
      const parts = rel.split('/');
      let dir = await navigator.storage.getDirectory();
      try {
        for (const segment of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
        const handle = await dir.getFileHandle(parts[parts.length - 1]);
        return await (await handle.getFile()).text();
      } catch {
        return null;
      }
    }, relative)
  );

/**
 * Connect the REAL Local Folder provider (`filesystem`) through the cloud view,
 * then wait until its listing is loaded — everything downstream (search
 * enrichment, the reconcile backfill, download queueing) is gated on the cache
 * actually having been filled, never merely on a non-null provider.
 */
async function connectLocalFolder(page: Page) {
  await goHash(page, '#/cloud');
  const button = page.getByRole('button', { name: /Local Folder/ });
  // The cloud view is a dynamic import and only renders the option once
  // `isFilesystemProviderSupported()` has run in its onMount.
  await button.waitFor({ state: 'visible', timeout: 20000 });
  await button.click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
          const { cacheManager } = await import('/src/lib/util/sync/cache-manager.ts');
          const provider = providerManager.getActiveProvider?.();
          return provider?.type === 'filesystem' &&
            !!cacheManager.getCache('filesystem')?.isLoaded()
            ? 'loaded'
            : 'waiting';
        }),
      { timeout: 30000, message: 'the Local Folder provider never finished loading its listing' }
    )
    .toBe('loaded');
}

/** Wipe every table this spec writes, so tests never inherit each other's rows. */
async function resetDb(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    await db.open();
    await Promise.all([
      db.volumes.clear(),
      db.volume_ocr.clear(),
      db.volume_files.clear(),
      db.catalog_index.clear(),
      db.series_index.clear(),
      db.series_metadata.clear()
    ]);
  });
}

/**
 * The state one `catalog.json` download leaves behind: the parsed entries cached
 * in `catalog_index` (one row holding the whole file), and their FACTS merged
 * into `series_metadata` through the
 * same `upsertFromSeriesFile` the real refresh routes them through (which is
 * what makes a REAL, locally-present series searchable by a synonym or
 * alternate title delivered through catalog.json, and what declines to create
 * a record for a factless entry).
 */
async function seedCatalogIndex(
  page: Page,
  { catalog = CATALOG_JSON as unknown, provider = 'webdav' } = {}
) {
  await page.evaluate(
    async ({ raw, provider }) => {
      const { parseCatalogFile, catalogEntryToSeriesFile } = await import(
        '/src/lib/metadata/catalog-file.ts'
      );
      const { upsertFromSeriesFile } = await import('/src/lib/metadata/store.ts');
      const { db } = await import('/src/lib/catalog/db.ts');
      const parsed = parseCatalogFile(raw)!;
      await db.catalog_index.clear();
      await db.catalog_index.put({
        id: 'catalog',
        file: parsed,
        source: {
          provider,
          path: 'catalog.json',
          size: 123,
          modifiedTime: '2026-08-23T00:00:00.000Z'
        },
        fetched_at: new Date().toISOString()
      });
      for (const entry of parsed.series) {
        await upsertFromSeriesFile(entry.series_title, catalogEntryToSeriesFile(entry));
      }
    },
    { raw: catalog, provider }
  );
}

/**
 * Write `volumes` rows straight into Dexie — the state a download, an import or
 * a materialization leaves behind, minus the archives. Every row gets a real
 * (tiny) PNG thumbnail, because the not-on-device marks on the card stack are
 * only drawn over volumes that have pixels.
 */
async function seedVolumes(
  page: Page,
  rows: Array<{
    uuid: string;
    series: string;
    title: string;
    metadataOnly?: boolean;
    archiveSize?: number;
    cloudThumbnailFileId?: string;
    cloudThumbnailPath?: string;
    cloudProvider?: string;
    thumbnail?: boolean;
  }>
) {
  await page.evaluate(async (specs) => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const { generateDeterministicUUID } = await import('/src/lib/util/series-extraction.ts');

    async function makeThumb(seed: number): Promise<File> {
      const canvas = document.createElement('canvas');
      canvas.width = 50;
      canvas.height = 70;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = `hsl(${(seed * 37) % 360} 60% 50%)`;
      ctx.fillRect(0, 0, 50, 70);
      const blob: Blob = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/png')
      );
      return new File([blob], 'thumb.png', { type: 'image/png' });
    }

    for (const [i, spec] of specs.entries()) {
      const row: Record<string, unknown> = {
        volume_uuid: spec.uuid,
        series_uuid: generateDeterministicUUID(spec.series),
        series_title: spec.series,
        volume_title: spec.title,
        mokuro_version: '0.4.11',
        page_count: 180,
        character_count: 4000,
        page_char_counts: []
      };
      if (spec.thumbnail !== false) {
        row.thumbnail = await makeThumb(i);
        row.thumbnail_width = 50;
        row.thumbnail_height = 70;
      }
      if (spec.metadataOnly) row.metadata_only = true;
      if (spec.archiveSize !== undefined) row.archive_size = spec.archiveSize;
      if (spec.cloudThumbnailFileId) row.cloudThumbnailFileId = spec.cloudThumbnailFileId;
      if (spec.cloudThumbnailPath) row.cloudThumbnailPath = spec.cloudThumbnailPath;
      if (spec.cloudProvider) row.cloudProvider = spec.cloudProvider;
      await db.volumes.put(row);
    }
  }, rows);
}

/**
 * Navigate by hash and wait for the router to actually be on that view.
 *
 * `currentView` is computed once at module load and only tracks the hash after
 * `initRouter()` runs in the app shell's `onMount`, so a hash written during the
 * boot window is silently dropped. Re-applied until the router agrees.
 */
async function goHash(page: Page, hash: string) {
  const expected =
    hash === '#/' || hash === '#/catalog'
      ? 'catalog'
      : hash.startsWith('#/series/')
        ? 'series'
        : hash.replace(/^#\//, '').split(/[/?]/)[0];

  await expect
    .poll(
      async () => {
        await page.evaluate((h) => {
          if (window.location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange'));
          else window.location.hash = h;
        }, hash);
        return page.evaluate(async () => {
          const { currentView } = await import('/src/lib/util/hash-router.ts');
          let view: { type?: string } | undefined;
          currentView.subscribe((v: { type?: string }) => (view = v))();
          return view?.type ?? null;
        });
      },
      { timeout: 20000, message: `the router never navigated to ${hash}` }
    )
    .toBe(expected);
  // The view itself is a dynamic import behind the route change.
  await page.waitForTimeout(700);
}

const seriesHash = (title: string) => `#/series/${encodeURIComponent(title)}`;

test.describe('catalog.json', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await resetDb(page);
  });

  test('build → stringify → parse is a lossless, compact round trip', async ({ page }) => {
    const watch = watchConsole(page);
    const observed = await page.evaluate(async () => {
      const { buildCatalogFile, stringifyCatalogFile, parseCatalogFile, catalogSeriesEqual } =
        await import('/src/lib/metadata/catalog-file.ts');

      const built = buildCatalogFile({
        entries: [
          {
            series_title: 'Dr Stone (HD Scan)',
            external_ids: { anilist: 98416 },
            titles: { native: 'Dr.STONE', english: 'Dr. STONE' },
            synonyms: ['Doctor Stone'],
            tag: 'HD Scan',
            updated_at: '2026-08-18T19:36:24.324Z'
          },
          {
            series_title: 'Bare Folder',
            external_ids: {},
            titles: {},
            synonyms: [],
            updated_at: '1970-01-01T00:00:00.000Z'
          }
        ],
        cloudSeriesTitles: new Set(['Dr Stone (HD Scan)', 'Bare Folder']),
        now: '2026-08-23T00:00:00.000Z'
      })!;

      const text = stringifyCatalogFile(built);
      const parsed = parseCatalogFile(JSON.parse(text))!;

      return {
        text,
        pretty: /\n|\s{2}/.test(text),
        order: built.series.map((e) => e.series_title),
        parsedOrder: parsed.series.map((e) => e.series_title),
        equal: catalogSeriesEqual(built.series, parsed.series),
        factless: parsed.series.find((e) => e.series_title === 'Bare Folder'),
        linked: parsed.series.find((e) => e.series_title === 'Dr Stone (HD Scan)'),
        // A rebuild that changed nothing must produce the same bytes.
        rebuiltSame:
          stringifyCatalogFile(
            buildCatalogFile({
              entries: [],
              existing: built,
              cloudSeriesTitles: new Set(['Dr Stone (HD Scan)', 'Bare Folder']),
              now: '2026-08-23T00:00:00.000Z'
            })!
          ) === text,
        // Junk is dropped entry-by-entry, not file-wide.
        junkSurvivors: parseCatalogFile({
          version: 1,
          updated_at: '2026-08-23T00:00:00.000Z',
          series: [
            { series_title: 'Good', external_ids: {}, titles: {}, synonyms: [], updated_at: 'x' },
            { nope: true },
            {
              series_title: 'Real',
              external_ids: { anilist: 1 },
              titles: {},
              synonyms: [],
              updated_at: '2026-01-01T00:00:00.000Z',
              rogue_key: 'per-user state'
            }
          ]
        })!.series,
        wrongVersion: parseCatalogFile({ version: 2, updated_at: '2026-01-01T00:00:00.000Z' })
      };
    });

    expect(observed.pretty).toBe(false);
    // Sorted by normalized key, so a no-op rebuild is byte-identical.
    expect(observed.order).toEqual(['Bare Folder', 'Dr Stone (HD Scan)']);
    expect(observed.parsedOrder).toEqual(['Bare Folder', 'Dr Stone (HD Scan)']);
    expect(observed.equal).toBe(true);
    expect(observed.rebuiltSame).toBe(true);
    expect(observed.factless).toMatchObject({
      series_title: 'Bare Folder',
      updated_at: '1970-01-01T00:00:00.000Z'
    });
    expect(observed.linked).toMatchObject({
      external_ids: { anilist: 98416 },
      tag: 'HD Scan',
      synonyms: ['Doctor Stone']
    });
    expect(observed.junkSurvivors.map((e) => e.series_title)).toEqual(['Real']);
    expect(observed.junkSurvivors[0]).not.toHaveProperty('rogue_key');
    expect(observed.wrongVersion).toBeUndefined();
    expectCleanConsole(watch);
  });

  test('the cached catalog never renders as cards, connected or not', async ({ page }) => {
    // catalog.json never mints cards (a stale file would otherwise produce
    // dead-end "Open to load volumes" cards for deleted folders) — its facts
    // only enrich search/mapping for series that exist locally or in a cloud
    // listing. The cached copy outlives a disconnect on purpose (reconnecting
    // must not re-download a whole catalog), so it stays cached here with
    // nothing connected; the search-enrichment path is exercised in the Local
    // Folder suite below, where a provider really is connected.
    const watch = watchConsole(page);
    await seedCatalogIndex(page);
    await goHash(page, '#/');
    await expect(page.getByText('Open to load volumes')).toHaveCount(0);
    await expect(page.getByText('Dr Stone (HD Scan)')).toHaveCount(0);
    expectCleanConsole(watch);
  });

  test('a factless entry never creates a series_metadata record', async ({ page }) => {
    const record = await page.evaluate(async () => {
      const { catalogEntryToSeriesFile } = await import('/src/lib/metadata/catalog-file.ts');
      const { upsertFromSeriesFile } = await import('/src/lib/metadata/store.ts');
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.series_metadata.delete('bare folder');
      await upsertFromSeriesFile(
        'Bare Folder',
        catalogEntryToSeriesFile({
          series_title: 'Bare Folder',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '1970-01-01T00:00:00.000Z'
        })
      );
      return db.series_metadata.get('bare folder');
    });
    expect(record).toBeUndefined();
  });

  test('the catalog_index cache only refetches when size or mtime moves', async ({ page }) => {
    await seedCatalogIndex(page);
    const observed = await page.evaluate(async () => {
      const { catalogNeedsRefresh, getCatalogIndex } = await import(
        '/src/lib/metadata/catalog-index.ts'
      );
      const cached = await getCatalogIndex();
      const same = { size: 123, modifiedTime: '2026-08-23T00:00:00.000Z' };
      return {
        cachedSeries: cached?.file.series.length ?? 0,
        unchanged: catalogNeedsRefresh(cached, same, 'webdav'),
        sizeMoved: catalogNeedsRefresh(cached, { ...same, size: 124 }, 'webdav'),
        mtimeMoved: catalogNeedsRefresh(
          cached,
          { ...same, modifiedTime: '2026-08-24T00:00:00.000Z' },
          'webdav'
        ),
        otherProvider: catalogNeedsRefresh(cached, same, 'filesystem'),
        noCache: catalogNeedsRefresh(undefined, same, 'webdav')
      };
    });
    expect(observed.cachedSeries).toBe(2);
    expect(observed.unchanged).toBe(false);
    expect(observed.sizeMoved).toBe(true);
    expect(observed.mtimeMoved).toBe(true);
    expect(observed.otherProvider).toBe(true);
    expect(observed.noCache).toBe(true);
  });
});

test.describe('materialization', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await resetDb(page);
  });

  test('index entries become metadata-only rows the series view lists as not installed', async ({
    page
  }) => {
    const watch = watchConsole(page);
    await seedCatalogIndex(page);
    const created = await page.evaluate(async () => {
      const { materializeSeriesVolumes } = await import('/src/lib/catalog/materialize.ts');
      return materializeSeriesVolumes({
        seriesTitle: 'Dr Stone (HD Scan)',
        entries: [
          {
            volume_uuid: 'e2e-uuid-1',
            volume_title: 'Volume 1',
            page_count: 200,
            character_count: 5000,
            mokuro_version: '0.4.11'
          },
          {
            volume_uuid: 'e2e-uuid-2',
            volume_title: 'Volume 2',
            page_count: 190,
            character_count: 4800,
            mokuro_version: '0.4.11'
          }
        ],
        cloudVolumeTitles: new Set(['Volume 1', 'Volume 2'])
      });
    });
    expect(created).toBe(2);

    await goHash(page, seriesHash('Dr Stone (HD Scan)'));
    await expect(page.getByText('Volume 1').first()).toBeVisible();
    await expect(page.getByText('Volume 2').first()).toBeVisible();
    expect(await page.getByText('Not on this device').count()).toBeGreaterThanOrEqual(2);
    expectCleanConsole(watch);
  });

  test('a second materialization pass never duplicates or downgrades', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { materializeSeriesVolumes } = await import('/src/lib/catalog/materialize.ts');
      const { db } = await import('/src/lib/catalog/db.ts');
      const rich = [
        {
          volume_uuid: 'e2e-uuid-1',
          volume_title: 'Volume 1',
          page_count: 200,
          character_count: 5000,
          mokuro_version: '0.4.11'
        }
      ];
      const first = await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone (HD Scan)',
        entries: rich,
        cloudVolumeTitles: new Set(['Volume 1'])
      });
      // A poorer index arriving second must not overwrite anything.
      const second = await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone (HD Scan)',
        entries: [{ ...rich[0], page_count: 1, character_count: 1 }],
        cloudVolumeTitles: new Set(['Volume 1'])
      });
      const rows = await db.volumes
        .where('series_title')
        .equalsIgnoreCase('Dr Stone (HD Scan)')
        .toArray();
      const row = rows.find((r: { volume_uuid: string }) => r.volume_uuid === 'e2e-uuid-1');
      return { first, second, count: rows.length, pageCount: row?.page_count };
    });
    expect(result.first).toBe(1);
    expect(result.second).toBe(0);
    expect(result.count).toBe(1);
    expect(result.pageCount).toBe(200); // never downgraded to the index's 1
  });

  test('an installed row is never replaced and a stale index cannot resurrect a volume', async ({
    page
  }) => {
    await seedVolumes(page, [
      { uuid: 'installed-1', series: 'Dr Stone (HD Scan)', title: 'Volume 1' }
    ]);
    const result = await page.evaluate(async () => {
      const { materializeSeriesVolumes } = await import('/src/lib/catalog/materialize.ts');
      const { db } = await import('/src/lib/catalog/db.ts');
      const changed = await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone (HD Scan)',
        entries: [
          {
            volume_uuid: 'installed-1',
            volume_title: 'Volume 1',
            page_count: 3,
            character_count: 3,
            mokuro_version: 'unknown'
          },
          {
            volume_uuid: 'deleted-2',
            volume_title: 'Volume 2',
            page_count: 100,
            character_count: 100,
            mokuro_version: '0.4.11'
          }
        ],
        // Volume 2 is gone from the folder: the listing does not show it.
        cloudVolumeTitles: new Set(['Volume 1'])
      });
      const row = await db.volumes.get('installed-1');
      return {
        changed,
        pageCount: row?.page_count,
        metadataOnly: !!row?.metadata_only,
        resurrected: !!(await db.volumes.get('deleted-2'))
      };
    });
    expect(result.changed).toBe(0);
    expect(result.pageCount).toBe(180); // the seeded, measured value
    expect(result.metadataOnly).toBe(false);
    expect(result.resurrected).toBe(false);
  });
});

test.describe('write tolerance', () => {
  test('the compiled metadata files are classified as best-effort', async ({ page }) => {
    await boot(page);
    const flags = await page.evaluate(async () => {
      const { isBestEffortMetadataPath, isRootConfigFile } = await import(
        '/src/lib/util/sync/syncable-file.ts'
      );
      return {
        catalog: isBestEffortMetadataPath('catalog.json'),
        series: isBestEffortMetadataPath('Dr Stone/series.json'),
        progress: isBestEffortMetadataPath('volume-data.json'),
        archive: isBestEffortMetadataPath('Dr Stone/Volume 1.cbz'),
        listed: isRootConfigFile('catalog.json')
      };
    });
    expect(flags).toEqual({
      catalog: true,
      series: true,
      progress: false,
      archive: false,
      listed: true
    });
  });
});

test.describe('Local Folder provider (OPFS)', () => {
  // Connecting a provider, loading its listing and waiting out a 2 s debounced
  // write is more than the 30 s default allows on a cold dev server.
  test.describe.configure({ timeout: 60_000 });

  test.beforeEach(async ({ page }) => {
    await boot(page);
    await resetDb(page);
  });

  test('reconcile backfills series.json + catalog.json for a library uploaded without them', async ({
    page
  }) => {
    const watch = watchConsole(page);
    // A folder full of archives and nothing else: the state an older build (or
    // a hand-copied library) leaves behind. No series.json, no catalog.json.
    await seedOpfs(page, [
      { path: 'Reconcile Series/Reconcile Series Vol 1.cbz', bytes: 2048 },
      { path: 'Reconcile Series/Reconcile Series Vol 2.cbz', bytes: 4096 }
    ]);
    await seedVolumes(page, [
      { uuid: 'rec-1', series: 'Reconcile Series', title: 'Reconcile Series Vol 1' },
      { uuid: 'rec-2', series: 'Reconcile Series', title: 'Reconcile Series Vol 2' }
    ]);

    const before = await opfsTree(page);
    expect(before).not.toContain('catalog.json');
    expect(before).not.toContain('Reconcile Series/series.json');

    await connectLocalFolder(page);

    // The backfill is debounced (2 s) behind the listing that triggers it.
    await expect
      .poll(() => opfsRead(page, 'Reconcile Series/series.json'), {
        timeout: 30000,
        message: 'series.json was never backfilled'
      })
      .not.toBeNull();
    await expect
      .poll(() => opfsRead(page, 'catalog.json'), {
        timeout: 30000,
        message: 'catalog.json was never backfilled'
      })
      .not.toBeNull();

    const seriesFile = JSON.parse((await opfsRead(page, 'Reconcile Series/series.json'))!);
    expect(seriesFile.series_title).toBe('Reconcile Series');
    expect(seriesFile.volumes.map((v: { volume_title: string }) => v.volume_title).sort()).toEqual([
      'Reconcile Series Vol 1',
      'Reconcile Series Vol 2'
    ]);
    expect(seriesFile.volumes.map((v: { volume_uuid: string }) => v.volume_uuid).sort()).toEqual([
      'rec-1',
      'rec-2'
    ]);

    const catalogText = (await opfsRead(page, 'catalog.json'))!;
    expect(catalogText).not.toMatch(/\n/); // compact, as the serializer promises
    const catalog = JSON.parse(catalogText);
    expect(catalog.version).toBe(1);
    expect(catalog.series.map((e: { series_title: string }) => e.series_title)).toEqual([
      'Reconcile Series'
    ]);
    expectCleanConsole(watch);
  });

  test('catalog.json enriches search for a real series without minting a card for a catalog-index-only one', async ({
    page
  }) => {
    const watch = watchConsole(page);
    await connectLocalFolder(page);
    // A REAL, locally-installed series (matches the 'Dr Stone (HD Scan)' entry
    // in CATALOG_JSON by title) alongside a catalog-only entry with nothing
    // local behind it at all ('Bare Folder').
    await seedVolumes(page, [{ uuid: 'real-1', series: 'Dr Stone (HD Scan)', title: 'Volume 1' }]);
    await seedCatalogIndex(page, { provider: 'filesystem' });

    await goHash(page, '#/');
    // (a) No stub card for the catalog-index-only entry: a stale catalog.json
    // listing a deleted folder must never produce a dead-end
    // "Open to load volumes" card.
    await expect(page.getByText('Open to load volumes')).toHaveCount(0);
    await expect(page.getByText('Bare Folder')).toHaveCount(0);
    // The real series still renders its normal card.
    await expect(page.getByText('Dr Stone (HD Scan)').first()).toBeVisible();

    // (b) The real series IS searchable by a synonym and an alternate-language
    // title delivered through catalog.json — its facts still merge into
    // series_metadata even though nothing was minted from them.
    const search = page.locator('input[type="search"]').first();
    await search.fill('doctor stone');
    await page.waitForTimeout(400);
    await expect(page.getByText('Dr Stone (HD Scan)').first()).toBeVisible();
    await search.fill('Dr.STONE');
    await page.waitForTimeout(400);
    await expect(page.getByText('Dr Stone (HD Scan)').first()).toBeVisible();

    // A query that could only ever match the catalog-only, no-local-presence
    // entry finds nothing — there was never a card to search.
    await search.fill('Bare Folder');
    await page.waitForTimeout(400);
    await expect(page.getByText('Dr Stone (HD Scan)')).toHaveCount(0);
    await expect(page.getByText('Bare Folder')).toHaveCount(0);

    await search.fill('');
    await page.waitForTimeout(300);
    expectCleanConsole(watch);
  });

  test('Download all queues metadata-only rows and placeholders alike', async ({ page }) => {
    const watch = watchConsole(page);
    await seedOpfs(page, [
      { path: 'Mixed Series/Mixed Series Vol 1.cbz', bytes: 2048 },
      { path: 'Mixed Series/Mixed Series Vol 2.cbz', bytes: 2048 },
      { path: 'Mixed Series/Mixed Series Vol 3.cbz', bytes: 2048 }
    ]);
    // Vol 1 is a row whose files were removed; Vol 2 has no row at all
    // (a placeholder); Vol 3 likewise. Download all must take all three.
    await seedVolumes(page, [
      {
        uuid: 'mix-1',
        series: 'Mixed Series',
        title: 'Mixed Series Vol 1',
        metadataOnly: true,
        archiveSize: 2048
      }
    ]);
    await connectLocalFolder(page);
    await goHash(page, seriesHash('Mixed Series'));
    await page.waitForTimeout(1500);

    // Record every title that ever enters the queue: the worker drains it as it
    // goes, so a single read after the click races the download it started.
    await page.evaluate(async () => {
      const { downloadQueue } = await import('/src/lib/util/download-queue.ts');
      const seen: string[] = [];
      (window as unknown as { __queued: string[] }).__queued = seen;
      downloadQueue.subscribe((items: Array<{ volumeTitle?: string }>) => {
        for (const item of items) {
          if (item.volumeTitle && !seen.includes(item.volumeTitle)) seen.push(item.volumeTitle);
        }
      });
    });

    await page.getByRole('button', { name: /Download all/i }).click();
    await expect
      .poll(
        () =>
          page.evaluate(() => [...(window as unknown as { __queued: string[] }).__queued].sort()),
        { timeout: 15000, message: 'Download all never queued all three volumes' }
      )
      .toEqual(['Mixed Series Vol 1', 'Mixed Series Vol 2', 'Mixed Series Vol 3']);
    expectCleanConsole(watch);
  });

  test('a progress hole is patched from the cloud series.json after a catalog open', async ({
    page
  }) => {
    const watch = watchConsole(page);
    await seedOpfs(page, [
      { path: 'Hole Series/Hole Series Vol 1.cbz', bytes: 2048 },
      {
        path: 'Hole Series/series.json',
        text: JSON.stringify({
          version: 2,
          series_title: 'Hole Series',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2026-08-20T00:00:00.000Z',
          volumes: [
            {
              volume_uuid: 'hole-v1',
              volume_title: 'Hole Series Vol 1',
              page_count: 150,
              character_count: 3300,
              mokuro_version: '0.4.11'
            }
          ]
        })
      }
    ]);
    await connectLocalFolder(page);

    // The hole is the state where progress names a series this device has no
    // row and no cached index for. A whole-folder provider like Local Folder
    // reads every `series.json` it can see on connect, which is exactly what a
    // catalog-distribution backend does NOT do (one `catalog.json`, names
    // only), so the index cache is emptied here to reproduce that client's
    // state. Everything after this line is the real path.
    await page.evaluate(async () => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.series_index.clear();
      const { resetHolePatchSessionForTests } = await import('/src/lib/metadata/hole-patch.ts');
      resetHolePatchSessionForTests();
      const { volumesWithTrash, VolumeData } = await import('/src/lib/settings/volume-data.ts');
      volumesWithTrash.set({
        'hole-v1': new VolumeData({
          progress: 40,
          chars: 900,
          timeReadInMinutes: 12,
          series_title: 'Hole Series',
          series_uuid: 'hole-series-uuid',
          volume_title: 'Hole Series Vol 1',
          lastProgressUpdate: new Date().toISOString()
        })
      });
    });

    // The catalog open is what runs the patcher (CatalogView's onMount).
    await goHash(page, '#/cloud');
    await goHash(page, '#/');

    await expect
      .poll(
        () =>
          probe(() =>
            page.evaluate(async () => {
              const { db } = await import('/src/lib/catalog/db.ts');
              const row = await db.volumes.get('hole-v1');
              return row ? `${row.series_title}|${row.volume_title}|${row.page_count}` : null;
            })
          ),
        { timeout: 30000, message: 'the dangling progress record was never patched' }
      )
      .toBe('Hole Series|Hole Series Vol 1|150');

    await goHash(page, '#/');
    await expect(page.getByText('Hole Series').first()).toBeVisible();
    expectCleanConsole(watch);
  });
});

/**
 * The affordances that landed with the metadata-only work, after the plan was
 * written: one badge for both absent states, the archive size beside it, the
 * hover + Delete flow on a row whose pages are gone, and the display setting
 * that regroups them.
 */
test.describe('metadata-only volumes in the UI', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await resetDb(page);
  });

  test('removing a volume from the device leaves a badged, sized row in list and grid', async ({
    page
  }) => {
    const watch = watchConsole(page);
    await seedVolumes(page, [
      {
        uuid: 'ux-1',
        series: 'UX Series',
        title: 'UX Series Vol 1',
        archiveSize: 52_428_800 // 50 MB exactly
      },
      { uuid: 'ux-2', series: 'UX Series', title: 'UX Series Vol 2' }
    ]);
    await page.evaluate(() => window.localStorage.setItem('series-view-mode', 'list'));
    await goHash(page, seriesHash('UX Series'));

    // Nothing is absent yet.
    await expect(page.getByTestId('download-badge')).toHaveCount(0);

    // Hover the row and use its remove action; the confirmation names the volume
    // and promises the history is kept.
    const row = page.locator('div', { hasText: 'UX Series Vol 1' }).last();
    await row.hover();
    await page.locator('button[title="Remove from this device"]').first().click();
    await expect(
      page.getByText('Remove UX Series Vol 1 from this device? Stats, progress and cover are kept.')
    ).toBeVisible();
    await page.getByRole('button', { name: 'Yes', exact: true }).click();

    // List view: the badge sits on the cover, "Not on this device" beside it,
    // and the archive size is spelled out.
    await expect(page.getByText('Not on this device').first()).toBeVisible();
    await expect(page.getByTestId('download-badge')).toHaveCount(1);
    await expect(page.getByTestId('archive-size')).toHaveText('50 MB');
    const listBadgeClass = await page.getByTestId('download-badge').getAttribute('class');
    expect(listBadgeClass).toContain('right-0.5');
    expect(listBadgeClass).toContain('bottom-0.5');

    const removed = await page.evaluate(async () => {
      const { db } = await import('/src/lib/catalog/db.ts');
      const row = await db.volumes.get('ux-1');
      return {
        metadataOnly: !!row?.metadata_only,
        keptThumbnail: !!row?.thumbnail,
        ocr: !!(await db.volume_ocr.get('ux-1')),
        files: !!(await db.volume_files.get('ux-1'))
      };
    });
    expect(removed).toEqual({ metadataOnly: true, keptThumbnail: true, ocr: false, files: false });

    // Grid view: same badge, bottom-right of the cover, same size text.
    await page.evaluate(() => window.localStorage.setItem('series-view-mode', 'grid'));
    await page.reload();
    await goHash(page, seriesHash('UX Series'));
    await expect(page.getByTestId('download-badge')).toHaveCount(1);
    const gridBadgeClass = await page.getByTestId('download-badge').getAttribute('class');
    expect(gridBadgeClass).toContain('right-1');
    expect(gridBadgeClass).toContain('bottom-1');
    await expect(page.getByTestId('archive-size')).toHaveText('50 MB');

    // Hover + Delete on the absent row raises the FORGET confirmation, not the
    // remove one — there are no pages left to remove.
    await page.locator('#volume-menu-ux-1').hover();
    await page.locator('#volume-menu-ux-1').click();
    await page.getByText('Delete', { exact: true }).click();
    await expect(
      page.getByText('Forget UX Series Vol 1? Its stats, progress and cover will be deleted.')
    ).toBeVisible();
    await page.getByRole('button', { name: 'No', exact: true }).click();
    expectCleanConsole(watch);
  });

  test('notOnDeviceDisplay regroups absent volumes and series without a reload', async ({
    page
  }) => {
    const watch = watchConsole(page);
    await seedVolumes(page, [
      { uuid: 'grp-1', series: 'Grouped Series', title: 'Grouped Series Vol 1' },
      {
        uuid: 'grp-2',
        series: 'Grouped Series',
        title: 'Grouped Series Vol 2',
        metadataOnly: true
      },
      { uuid: 'gone-1', series: 'Gone Series', title: 'Gone Series Vol 1', metadataOnly: true }
    ]);
    await page.evaluate(() => window.localStorage.setItem('series-view-mode', 'list'));
    await goHash(page, seriesHash('Grouped Series'));

    const setDisplay = (mode: string) =>
      page.evaluate(async (value) => {
        const { updateCatalogSetting } = await import('/src/lib/settings/settings.ts');
        updateCatalogSetting('notOnDeviceDisplay', value);
      }, mode);

    // mixed: the absent volume sits in the main list, no cloud section.
    await expect(page.getByText('Available in', { exact: false })).toHaveCount(0);
    await expect(page.getByTestId('download-badge')).toHaveCount(1);

    await setDisplay('cloud-section');
    await expect(page.getByText('Available in', { exact: false }).first()).toBeVisible();
    await expect(page.getByTestId('download-badge')).toHaveCount(1);

    await setDisplay('mixed');
    await expect(page.getByText('Available in', { exact: false })).toHaveCount(0);

    // The same setting regroups whole series on the catalog.
    await goHash(page, '#/');
    await expect(page.getByTestId('catalog-cloud')).toHaveCount(0);
    await setDisplay('cloud-section');
    await expect(page.getByTestId('catalog-cloud')).toBeVisible();
    await expect(
      page.getByTestId('catalog-cloud').getByText('Gone Series', { exact: true })
    ).toBeVisible();
    await expect(
      page.getByTestId('catalog-library').getByText('Grouped Series', { exact: true })
    ).toBeVisible();
    await setDisplay('mixed');
    await expect(page.getByTestId('catalog-cloud')).toHaveCount(0);
    expectCleanConsole(watch);
  });

  test('a partly-downloaded series stacks every volume, each absent one badged', async ({
    page
  }) => {
    const watch = watchConsole(page);
    const VOLUMES = 30;
    await seedVolumes(
      page,
      Array.from({ length: VOLUMES }, (_, i) => ({
        uuid: `long-${i + 1}`,
        series: 'Long Series',
        title: `Long Series Vol ${i + 1}`,
        // Only the first volume is actually here.
        metadataOnly: i > 0
      }))
    );
    await page.evaluate(async () => {
      const { updateCatalogSetting } = await import('/src/lib/settings/settings.ts');
      // "All volumes": the mode where the 25-volume cloud cap used to truncate
      // a mixed series' stack and leave the rest of it cover-less.
      updateCatalogSetting('stackCount', 0);
      updateCatalogSetting('hideReadVolumes', false);
    });
    await goHash(page, '#/');

    // Scoped to the card itself: every spine badge carries an sr-only name that
    // also contains the series title.
    const card = page.locator('a[href="#/series/Long%20Series"]');
    await expect(card.getByText('Long Series', { exact: true })).toBeVisible();
    // 29 absent volumes, every one of them marked — no 25-volume cliff.
    await expect
      .poll(() => card.getByTestId('download-badge').count(), {
        timeout: 15000,
        message: 'the card stack did not badge every absent volume'
      })
      .toBe(VOLUMES - 1);
    // Partly here, so it is a library card and NOT the cloud card.
    await expect(page.getByTestId('cloud-card-mark')).toHaveCount(0);
    expectCleanConsole(watch);
  });

  test('a wholly absent series keeps the cloud card mark and no per-spine badges', async ({
    page
  }) => {
    const watch = watchConsole(page);
    await seedVolumes(
      page,
      Array.from({ length: 4 }, (_, i) => ({
        uuid: `absent-${i + 1}`,
        series: 'Absent Series',
        title: `Absent Series Vol ${i + 1}`,
        metadataOnly: true
      }))
    );
    await goHash(page, '#/');
    await expect(page.getByText('Absent Series')).toBeVisible();
    await expect(page.getByTestId('cloud-card-mark')).toHaveCount(1);
    await expect(page.getByTestId('cloud-card-mark')).toContainText('Not on this device');
    // One mark for the series, never one per spine on top of it.
    await expect(page.getByTestId('download-badge')).toHaveCount(0);
    expectCleanConsole(watch);
  });
});

/**
 * The series editor's spine shelf. It was the surface that hung: its cover-fetch
 * effect selected its targets from state the fetch itself writes, so every cover
 * that landed re-ran it and it never settled.
 */
test.describe('spine showcase', () => {
  // The hang check deliberately sits with the shelf on screen for eight seconds.
  test.describe.configure({ timeout: 60_000 });

  test.beforeEach(async ({ page }) => {
    await boot(page);
    await resetDb(page);
  });

  /** Open the series editor from the series page and wait for the shelf. */
  async function openShelf(page: Page, seriesTitle: string) {
    await goHash(page, seriesHash(seriesTitle));
    await page.locator('button[title="Edit series"]').first().click();
    await expect(page.getByRole('group', { name: 'Spine shelf' })).toBeVisible();
  }

  test('opens for a partly-downloaded series of cover-less volumes without hanging', async ({
    page
  }) => {
    // Waits out two full cover-retry schedules (see `requestCoverOnce`) plus a quiet
    // window on top, which is more than the file's default budget.
    test.setTimeout(90000);
    const watch = watchConsole(page);
    await connectLocalFolder(page);

    // Volume 1 is here with a cover; the rest are metadata-only rows whose
    // covers live in the cloud — and whose sidecars do not actually exist, so
    // no cover ever lands. That is the shape that used to spin forever: a
    // target list that can never shrink.
    await seedVolumes(page, [
      { uuid: 'shelf-1', series: 'Shelf Series', title: 'Shelf Series Vol 1' },
      ...Array.from({ length: 8 }, (_, i) => ({
        uuid: `shelf-${i + 2}`,
        series: 'Shelf Series',
        title: `Shelf Series Vol ${i + 2}`,
        metadataOnly: true,
        thumbnail: false,
        cloudProvider: 'filesystem',
        cloudThumbnailFileId: `Shelf Series/Shelf Series Vol ${i + 2}.webp`,
        cloudThumbnailPath: `Shelf Series/Shelf Series Vol ${i + 2}.webp`
      }))
    ]);

    // Count the cover requests the shelf issues, without changing what they do.
    await page.evaluate(async () => {
      const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
      const counts: Record<string, number> = {};
      (window as unknown as { __coverRequests: Record<string, number> }).__coverRequests = counts;
      const original = unifiedCloudManager.downloadFile.bind(unifiedCloudManager);
      unifiedCloudManager.downloadFile = (file: { path: string }) => {
        counts[file.path] = (counts[file.path] ?? 0) + 1;
        return original(file);
      };
    });

    await openShelf(page, 'Shelf Series');

    const coverRequests = async () => {
      const all = await page.evaluate(
        () => (window as unknown as { __coverRequests: Record<string, number> }).__coverRequests
      );
      return Object.fromEntries(Object.entries(all).filter(([path]) => path.endsWith('.webp')));
    };

    // Give every cover request time to fail and any re-request storm time to start.
    await page.waitForTimeout(4000);
    const first = await coverRequests();
    expect(Object.keys(first).length).toBeGreaterThan(0);
    // Two independent surfaces ask for these covers — the shelf and the volume list's
    // placeholder thumbnails — and each runs ONE bounded retry schedule (see
    // `requestCoverOnce`: the first ask plus two retries, 2s and 8s apart, because a
    // cover that produced nothing has to stay retryable). Four seconds in, that is at
    // most two asks per surface. What must never happen is a request PER FAILURE: an
    // effect that re-runs itself once for every answer it gets.
    for (const [path, count] of Object.entries(first)) {
      expect(count, `${path} was requested ${count} times on first settle`).toBeLessThanOrEqual(4);
    }

    // Long enough for both schedules to be spent…
    await page.waitForTimeout(9000);
    const settled = await coverRequests();
    for (const [path, count] of Object.entries(settled)) {
      expect(count, `${path} was requested ${count} times in all`).toBeLessThanOrEqual(6);
    }

    // …and then it stops: the shelf is on screen and asks for nothing more.
    await page.waitForTimeout(4000);
    expect(await coverRequests()).toEqual(settled);

    // The main thread is not pegged: frames still tick.
    const frames = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let n = 0;
          const start = performance.now();
          const tick = () => {
            n += 1;
            if (performance.now() - start < 1000) requestAnimationFrame(tick);
            else resolve(n);
          };
          requestAnimationFrame(tick);
        })
    );
    expect(frames, 'the page rendered too few frames to be responsive').toBeGreaterThan(10);

    // And the shelf's own controls still respond.
    const zoom2x = page.getByRole('button', { name: '2×', exact: true });
    await zoom2x.click({ timeout: 5000 });
    await expect(zoom2x).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });
    await page.getByRole('button', { name: 'Reset all volume offsets' }).click({ timeout: 5000 });
    await expect(page.getByRole('group', { name: 'Spine shelf' })).toBeVisible();
    expectCleanConsole(watch);
  });

  test('lays a wholly cloud-only series out in natural volume order', async ({ page }) => {
    const watch = watchConsole(page);
    // 1, 2, 10, 11 — the order that separates natural sorting from lexicographic.
    const titles = Array.from({ length: 12 }, (_, i) => `Order Series Vol ${i + 1}`);
    await seedVolumes(
      page,
      titles.map((title, i) => ({
        uuid: `order-${i + 1}`,
        series: 'Order Series',
        title,
        metadataOnly: true
      }))
    );
    await openShelf(page, 'Order Series');

    // Hover across the strip and read the title it reports under the cursor.
    const strip = page.getByRole('group', { name: 'Spine shelf' });
    const box = (await strip.boundingBox())!;
    const seen: number[] = [];
    for (let i = 0; i <= 20; i++) {
      await page.mouse.move(box.x + (box.width * i) / 20 - 1, box.y + box.height / 2);
      const readout = await strip.locator('xpath=following-sibling::p[1]').innerText();
      const match = readout.match(/Order Series Vol (\d+)/);
      if (!match) continue;
      const n = Number(match[1]);
      if (seen[seen.length - 1] !== n) seen.push(n);
    }

    expect(seen.length, 'no spine ever reported a title under the cursor').toBeGreaterThan(2);
    // Left to right is 1, 2, 3 … 12 — never 1, 10, 11, 12, 2.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[0]).toBe(1);
    expect(seen.at(-1)).toBe(12);
    expectCleanConsole(watch);
  });
});
