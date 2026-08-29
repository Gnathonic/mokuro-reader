import { appendFileSync, mkdirSync } from 'node:fs';
import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * E2E for the `series-metadata.json` retirement (spec:
 * docs/superpowers/specs/2026-08-23-catalog-distribution-design.md, amendment
 * 2026-08-23; plan: docs/superpowers/plans/2026-08-23-series-metadata-retirement.md).
 *
 * Two techniques, both against the REAL app, exactly as
 * `e2e/catalog-distribution.spec.ts` uses them:
 *
 * 1. Module drive-through — `await import('/src/lib/…')` inside `page.evaluate`,
 *    so the assertions run over the production modules the browser loaded, with
 *    the real Dexie database and the real localStorage.
 * 2. Real provider — the Local Folder (`filesystem`) provider connected against
 *    OPFS, which needs no account and no server: the directory picker is stubbed
 *    to hand back `navigator.storage.getDirectory()`. Everything downstream (the
 *    sidecar writer, `unifiedSyncService`, the merges) is the shipped code, and
 *    the files it produces are read back byte for byte.
 *
 * What the retirement claims, and where each claim is checked:
 *
 * | Claim                                                        | Test                        |
 * | ------------------------------------------------------------ | --------------------------- |
 * | Facts + shelf alignment travel in `series.json` only          | `record shape`, `offsets`   |
 * | An offset edit never moves the facts stamp                    | `record shape`, `shelf`     |
 * | An explicit zero resets what another device published         | `record shape`, `offsets`   |
 * | Reading state travels in `volume-data.json`'s `series` section | `reading state`, `read count` |
 * | `series-metadata.json` is written nowhere, read nowhere       | `stale file`                |
 * | `profiles.json` syncs automatically, with no button           | `profiles`                  |
 * | A future-stamped cloud file heals; local edits survive        | `clock skew`                |
 * | The unit label only names a unit it is confident about        | `unit label`                |
 */

/**
 * The documented dev-server artifacts (identical list to
 * `e2e/catalog-distribution.spec.ts` — same dev server, same noise). Anything
 * else on the console fails `expectCleanConsole`.
 *
 * - `Unexpected token '<'` — `@vercel/analytics`' `inject()` requests
 *   `/_vercel/insights/script.js`, which only exists on Vercel; the SPA
 *   catchall answers with `index.html`.
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

/**
 * Evidence sink for a manual verification run: set `VERIFY_ARTIFACTS_DIR` and
 * the spec drops screenshots and the values it actually observed there
 * (`observed.jsonl`). Unset — the normal case, including CI — both helpers are
 * no-ops and the run costs nothing.
 */
const ARTIFACTS = process.env.VERIFY_ARTIFACTS_DIR;
if (ARTIFACTS) mkdirSync(ARTIFACTS, { recursive: true });

function record(label: string, observed: unknown) {
  if (!ARTIFACTS) return;
  appendFileSync(`${ARTIFACTS}/observed.jsonl`, `${JSON.stringify({ label, observed })}\n`);
}

async function shot(page: Page, name: string) {
  if (!ARTIFACTS) return;
  await page.screenshot({ path: `${ARTIFACTS}/${name}.png` });
}

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
  record('console', {
    lines: watch.all.length,
    errors: watch.errors.length,
    allowed: watch.errors.filter((line) => ALLOWED_CONSOLE.some((re) => re.test(line))),
    unexpected
  });
  expect(unexpected, `unexpected console errors:\n${unexpected.join('\n')}`).toEqual([]);
  const depth = watch.all.filter((line) => /effect_update_depth_exceeded/.test(line));
  expect(depth, `effect_update_depth_exceeded seen:\n${depth.join('\n')}`).toEqual([]);
}

/** Hand the Local Folder provider the origin's OPFS root instead of a real picker. */
const OPFS_PICKER_STUB = `(() => {
  const patch = (h) => {
    try { if (typeof h.queryPermission !== 'function') h.queryPermission = async () => 'granted'; } catch {}
    try { if (typeof h.requestPermission !== 'function') h.requestPermission = async () => 'granted'; } catch {}
    return h;
  };
  window.showDirectoryPicker = async () => patch(await navigator.storage.getDirectory());
})();`;

/**
 * Boot the app and wait until it has finished taking over the URL — SvelteKit
 * `replaceState`s the bare origin during hydration and only then defaults the
 * hash, so anything written before that lands is silently reverted.
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

/** Wipe every table and store this spec writes, so tests never inherit each other's state. */
async function resetState(page: Page) {
  await page.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const { clearSeriesReadingState } = await import('/src/lib/settings/series-data.ts');
    await db.open();
    await Promise.all([
      db.volumes.clear(),
      db.volume_ocr.clear(),
      db.volume_files.clear(),
      db.catalog_index.clear(),
      db.series_index.clear(),
      db.series_metadata.clear()
    ]);
    clearSeriesReadingState();
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

/** Run a probe that must survive the app reloading under it. */
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
 * Connect the REAL Local Folder provider through the cloud view and wait until
 * its listing is loaded. Connecting also runs the app's own post-login sync —
 * which is the point of several tests here: nothing is pressed afterwards.
 */
async function connectLocalFolder(page: Page) {
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

/** Run one sync through the real service, the way the sync button does. */
async function syncNow(page: Page) {
  return page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    const result = await unifiedCloudManager.syncProgress();
    return { succeeded: result.succeeded, failed: result.failed };
  });
}

/** Write `volumes` rows straight into Dexie — the state an import leaves behind. */
async function seedVolumes(
  page: Page,
  rows: Array<{ uuid: string; series: string; title: string }>
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
      await db.volumes.put({
        volume_uuid: spec.uuid,
        series_uuid: generateDeterministicUUID(spec.series),
        series_title: spec.series,
        volume_title: spec.title,
        mokuro_version: '0.4.11',
        page_count: 180,
        character_count: 4000,
        page_char_counts: [],
        thumbnail: await makeThumb(i),
        thumbnail_width: 50,
        thumbnail_height: 70
      });
    }
  }, rows);
}

/** Navigate by hash and wait for the router to actually be on that view. */
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

/** Open the series editor from the series page (it hosts both panels this spec drives). */
async function openSeriesEditor(page: Page, seriesTitle: string) {
  await goHash(page, seriesHash(seriesTitle));
  await page.locator('button[title="Edit series"]').first().click();
}

/** The parsed `<Series>/series.json`, or null while it does not exist yet. */
async function readSeriesFile(page: Page, seriesTitle: string) {
  const text = await opfsRead(page, `${seriesTitle}/series.json`);
  return text === null ? null : { text, json: JSON.parse(text) };
}

// ── 1. The record and the files, driven through the production modules ────────

test.describe('record and file shape', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await resetState(page);
  });

  test('the shelf alignment rides series.json and never moves the facts stamp', async ({
    page
  }) => {
    const result = await page.evaluate(async () => {
      const { buildSeriesFile, parseSeriesFile, stringifySeriesFile } = await import(
        '/src/lib/metadata/series-file.ts'
      );
      const { updateSeriesMetadata, upsertFromSeriesFile } = await import(
        '/src/lib/metadata/store.ts'
      );
      const { db } = await import('/src/lib/catalog/db.ts');

      const localVolumes = [
        {
          volume_uuid: 'vol-1',
          series_uuid: 's',
          series_title: 'Dr Stone',
          volume_title: 'Vol 1',
          mokuro_version: '0.4.11',
          page_count: 10,
          character_count: 100,
          page_char_counts: [10]
        }
      ];

      // A library that linked the series AND nudged its shelf.
      await updateSeriesMetadata('Dr Stone', { external_ids: { anilist: 98416 } });
      const linked = await db.series_metadata.get('dr stone');
      await updateSeriesMetadata('Dr Stone', {
        spine_offset: 12,
        volume_offsets: { 'vol-1': -30 }
      });
      const nudged = await db.series_metadata.get('dr stone');

      const file = buildSeriesFile({ seriesTitle: 'Dr Stone', meta: nudged, localVolumes });

      // A second library, which has never seen this series, inherits it.
      await db.series_metadata.delete('dr stone');
      await upsertFromSeriesFile(
        'Dr Stone',
        parseSeriesFile(JSON.parse(stringifySeriesFile(file)))
      );
      const inherited = await db.series_metadata.get('dr stone');

      // …and then resets its shelf: an explicit zero, which must SUPPRESS the
      // published alignment rather than inherit it back, and must not appear in
      // the republished file (build → parse stays an identity).
      await updateSeriesMetadata('Dr Stone', {
        spine_offset: 0,
        volume_offsets: { 'vol-1': 0 }
      });
      const reset = await db.series_metadata.get('dr stone');
      const republished = buildSeriesFile({
        seriesTitle: 'Dr Stone',
        meta: reset,
        localVolumes,
        existing: file
      });

      return {
        publishedSpine: file.spine_offset,
        publishedVolume: file.volumes[0].offset,
        factsStampUnchanged: linked.facts_updated_at === nudged.facts_updated_at,
        inheritedSpine: inherited.spine_offset,
        inheritedVolume: inherited.volume_offsets?.['vol-1'],
        inheritedFactsStamp: inherited.facts_updated_at,
        resetFactsStamp: reset.facts_updated_at,
        republishedSpine: republished.spine_offset,
        republishedVolume: republished.volumes[0].offset,
        republishedFactsStamp: republished.updated_at,
        republishedStillLinked: republished.external_ids.anilist
      };
    });

    record('module: offsets round-trip', result);
    expect(result.publishedSpine).toBe(12);
    expect(result.publishedVolume).toBe(-30);
    expect(result.factsStampUnchanged).toBe(true);
    expect(result.inheritedSpine).toBe(12);
    expect(result.inheritedVolume).toBe(-30);
    // The file carried a real link, so the facts stamp is the link's — not the
    // offsets', which have none.
    expect(result.inheritedFactsStamp).toBeTruthy();
    // The reset neither moved the facts clock nor dropped the link…
    expect(result.resetFactsStamp).toBe(result.inheritedFactsStamp);
    expect(result.republishedFactsStamp).toBe(result.inheritedFactsStamp);
    expect(result.republishedStillLinked).toBe(98416);
    // …and it erased the alignment from the file instead of inheriting it back.
    expect(result.republishedSpine).toBeUndefined();
    expect(result.republishedVolume).toBeUndefined();
  });

  test('a spine nudge schedules a sidecar write through the non-facts trigger', async ({
    page
  }) => {
    const fired = await page.evaluate(async () => {
      const { registerIndexChangeListener, registerFactsChangeListener } = await import(
        '/src/lib/metadata/store.ts'
      );
      const { scheduleSpineOffsetWrite, flushSpineOffsetWrites } = await import(
        '/src/lib/metadata/spine-offsets.ts'
      );

      const index: string[] = [];
      const facts: string[] = [];
      const offIndex = registerIndexChangeListener((title: string) => index.push(title));
      const offFacts = registerFactsChangeListener((title: string) => facts.push(title));
      try {
        scheduleSpineOffsetWrite('Dr Stone', { spineOffset: 7 });
        await flushSpineOffsetWrites();
        return { index, facts };
      } finally {
        offIndex();
        offFacts();
      }
    });

    record('module: index vs facts listeners', fired);
    expect(fired.index).toEqual(['Dr Stone']);
    // The whole point of the second trigger: the sidecar is republished, but
    // nothing about the FACTS changed.
    expect(fired.facts).toEqual([]);
  });

  test('series reading state lives in the volume-data section and survives a reload', async ({
    page
  }) => {
    await page.evaluate(async () => {
      const { updateSeriesReadingState } = await import('/src/lib/settings/series-data.ts');
      updateSeriesReadingState('dr stone', { read_count: 3, reread_prompt_suppressed: true });
    });

    await page.reload();
    await expect
      .poll(() => page.evaluate(() => window.location.hash), { timeout: 20000 })
      .toBe('#/catalog');

    const after = await page.evaluate(async () => {
      const { getSeriesReadingState, SERIES_SECTION_KEY } = await import(
        '/src/lib/settings/series-data.ts'
      );
      const { parseVolumesFromJson } = await import('/src/lib/settings/volume-data.ts');
      const state = getSeriesReadingState('dr stone');
      // The section must never read back as a volume.
      const volumes = parseVolumesFromJson(
        JSON.stringify({ 'vol-1': { progress: 2 }, [SERIES_SECTION_KEY]: { 'dr stone': state } })
      );
      return { state, volumeKeys: Object.keys(volumes) };
    });

    record('module: reading state after reload', after);
    expect(after.state.read_count).toBe(3);
    expect(after.state.reread_prompt_suppressed).toBe(true);
    expect(after.volumeKeys).toEqual(['vol-1']);
  });

  test('the record no longer carries reading state or AniList display data', async ({ page }) => {
    const keys = await page.evaluate(async () => {
      const { updateSeriesMetadata } = await import('/src/lib/metadata/store.ts');
      const { toSeriesMetadataPatch } = await import('/src/lib/metadata/providers/anilist.ts');
      const written = await updateSeriesMetadata('Dr Stone', {
        ...toSeriesMetadataPatch({
          id: 98416,
          idMal: 103897,
          titles: { native: 'Dr.STONE', romaji: 'Dr. STONE', english: 'Dr. STONE' },
          synonyms: [],
          format: 'MANGA',
          status: 'FINISHED',
          volumes: 26,
          chapters: 232,
          coverUrl: 'https://example.invalid/cover.jpg',
          year: 2017
        })
      });
      return Object.keys(written).sort();
    });

    record('module: series_metadata record keys', keys);
    for (const dead of [
      'read_count',
      'reread_prompt_suppressed',
      'tracking',
      'format',
      'status',
      'total_volumes',
      'total_chapters',
      'cover_url',
      'title_preference'
    ]) {
      expect(keys).not.toContain(dead);
    }
    expect(keys).toContain('external_ids');
    expect(keys).toContain('titles');
  });

  test('series-metadata.json is not a syncable root file any more', async ({ page }) => {
    const verdict = await page.evaluate(async () => {
      const { isRootConfigFile, isSyncableFile } = await import(
        '/src/lib/util/sync/syncable-file.ts'
      );
      let mergeModuleGone = false;
      try {
        await import('/src/lib/metadata/merge.ts');
      } catch {
        mergeModuleGone = true;
      }
      return {
        root: isRootConfigFile('series-metadata.json'),
        syncable: isSyncableFile('series-metadata.json'),
        volumeData: isRootConfigFile('volume-data.json'),
        profiles: isRootConfigFile('profiles.json'),
        mergeModuleGone
      };
    });

    record('module: syncable-file verdict', verdict);
    expect(verdict.root).toBe(false);
    expect(verdict.syncable).toBe(false);
    // The files that DO sync are untouched.
    expect(verdict.volumeData).toBe(true);
    expect(verdict.profiles).toBe(true);
    expect(verdict.mergeModuleGone).toBe(true);
  });
});

// ── 2. The real provider: what actually lands in the cloud folder ─────────────

test.describe('Local Folder provider (OPFS)', () => {
  // Connecting a provider, loading its listing, waiting out a 2 s debounced
  // sidecar write and a sync is more than the 30 s default allows.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await boot(page);
    await resetState(page);
  });

  test('offsets round-trip through the published series.json, and an explicit zero resets them', async ({
    page
  }) => {
    const watch = watchConsole(page);
    await seedOpfs(page, [
      { path: 'Offset Series/Offset Series Vol 1.cbz', bytes: 2048 },
      { path: 'Offset Series/Offset Series Vol 2.cbz', bytes: 2048 }
    ]);
    await seedVolumes(page, [
      { uuid: 'off-1', series: 'Offset Series', title: 'Offset Series Vol 1' },
      { uuid: 'off-2', series: 'Offset Series', title: 'Offset Series Vol 2' }
    ]);
    await connectLocalFolder(page);

    // The reconcile backfill publishes the sidecar for a folder that has none.
    await expect
      .poll(() => readSeriesFile(page, 'Offset Series'), {
        timeout: 40000,
        message: 'series.json was never published'
      })
      .not.toBeNull();
    const baseline = (await readSeriesFile(page, 'Offset Series'))!;
    expect(baseline.json.spine_offset).toBeUndefined();

    // A shelf nudge, through the same debounced writer the catalog card uses.
    await page.evaluate(async () => {
      const { scheduleSpineOffsetWrite, flushSpineOffsetWrites } = await import(
        '/src/lib/metadata/spine-offsets.ts'
      );
      scheduleSpineOffsetWrite('Offset Series', {
        spineOffset: 12,
        volumeOffsets: { 'off-1': -30 }
      });
      await flushSpineOffsetWrites();
    });

    await expect
      .poll(async () => (await readSeriesFile(page, 'Offset Series'))?.json.spine_offset ?? null, {
        timeout: 30000,
        message: 'the nudge never reached series.json'
      })
      .toBe(12);

    const nudged = (await readSeriesFile(page, 'Offset Series'))!;
    const nudgedVol1 = nudged.json.volumes.find(
      (v: { volume_uuid: string }) => v.volume_uuid === 'off-1'
    );
    const nudgedVol2 = nudged.json.volumes.find(
      (v: { volume_uuid: string }) => v.volume_uuid === 'off-2'
    );
    expect(nudgedVol1.offset).toBe(-30);
    // A volume nobody nudged carries no offset at all.
    expect(nudgedVol2.offset).toBeUndefined();
    // Index data mints no facts clock: the file is still factless.
    expect(nudged.json.updated_at).toBe(baseline.json.updated_at);

    // A second library reads the published file and inherits the alignment.
    const inherited = await page.evaluate(async (text) => {
      const { parseSeriesFile } = await import('/src/lib/metadata/series-file.ts');
      const { upsertFromSeriesFile } = await import('/src/lib/metadata/store.ts');
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.series_metadata.delete('offset series');
      await upsertFromSeriesFile('Offset Series', parseSeriesFile(JSON.parse(text)));
      const record = await db.series_metadata.get('offset series');
      return { spine: record?.spine_offset, volume: record?.volume_offsets?.['off-1'] };
    }, nudged.text);
    record('opfs: nudged series.json', {
      spine_offset: nudged.json.spine_offset,
      volumes: nudged.json.volumes,
      updated_at: nudged.json.updated_at,
      inherited
    });
    expect(inherited).toEqual({ spine: 12, volume: -30 });

    // An explicit zero is a reset, not "no opinion": it suppresses what the file
    // publishes and disappears from the republished file.
    await page.evaluate(async () => {
      const { scheduleSpineOffsetWrite, flushSpineOffsetWrites } = await import(
        '/src/lib/metadata/spine-offsets.ts'
      );
      scheduleSpineOffsetWrite('Offset Series', { spineOffset: 0, volumeOffsets: {} });
      await flushSpineOffsetWrites();
    });

    await expect
      .poll(
        async () => (await readSeriesFile(page, 'Offset Series'))?.json.spine_offset ?? 'gone',
        { timeout: 30000, message: 'the reset never reached series.json' }
      )
      .toBe('gone');
    const cleared = (await readSeriesFile(page, 'Offset Series'))!;
    expect(
      cleared.json.volumes.find((v: { volume_uuid: string }) => v.volume_uuid === 'off-1').offset
    ).toBeUndefined();
    expect(cleared.json.updated_at).toBe(baseline.json.updated_at);
    record('opfs: series.json after the explicit-zero reset', cleared.json);

    expectCleanConsole(watch);
  });

  test('a spine nudge in the shelf republishes series.json without moving the facts stamp', async ({
    page
  }) => {
    const watch = watchConsole(page);
    await seedOpfs(page, [
      { path: 'Shelf Nudge/Shelf Nudge Vol 1.cbz', bytes: 2048 },
      { path: 'Shelf Nudge/Shelf Nudge Vol 2.cbz', bytes: 2048 },
      { path: 'Shelf Nudge/Shelf Nudge Vol 3.cbz', bytes: 2048 }
    ]);
    await seedVolumes(page, [
      { uuid: 'nudge-1', series: 'Shelf Nudge', title: 'Shelf Nudge Vol 1' },
      { uuid: 'nudge-2', series: 'Shelf Nudge', title: 'Shelf Nudge Vol 2' },
      { uuid: 'nudge-3', series: 'Shelf Nudge', title: 'Shelf Nudge Vol 3' }
    ]);
    // A REAL fact, so the file carries a real facts stamp to hold still.
    await page.evaluate(async () => {
      const { updateSeriesMetadata } = await import('/src/lib/metadata/store.ts');
      await updateSeriesMetadata('Shelf Nudge', {
        external_ids: { anilist: 98416 },
        titles: { native: 'シェルフ' }
      });
    });
    await connectLocalFolder(page);

    await expect
      .poll(
        async () => (await readSeriesFile(page, 'Shelf Nudge'))?.json.external_ids?.anilist ?? null,
        { timeout: 40000, message: 'the linked series.json was never published' }
      )
      .toBe(98416);
    const before = (await readSeriesFile(page, 'Shelf Nudge'))!;
    expect(before.json.updated_at).not.toBe('1970-01-01T00:00:00.000Z');

    // The real gesture, on the real shelf: shift+wheel over the spine strip.
    await openSeriesEditor(page, 'Shelf Nudge');
    const strip = page.getByRole('group', { name: 'Spine shelf' });
    await expect(strip).toBeVisible();
    const box = (await strip.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Shift');
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -120);
    await page.keyboard.up('Shift');

    // The readout next to the slider is what the user sees move.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const { db } = await import('/src/lib/catalog/db.ts');
            const record = await db.series_metadata.get('shelf nudge');
            return record?.spine_offset ?? 0;
          }),
        { timeout: 20000, message: 'shift+wheel never moved the stored spine offset' }
      )
      .toBeGreaterThan(0);

    await expect
      .poll(async () => (await readSeriesFile(page, 'Shelf Nudge'))?.json.spine_offset ?? null, {
        timeout: 30000,
        message: 'the shelf nudge never republished series.json'
      })
      .toBeGreaterThan(0);

    const after = (await readSeriesFile(page, 'Shelf Nudge'))!;
    // The bytes moved…
    expect(after.text).not.toBe(before.text);
    // …but the facts did not: same stamp, same link, same titles.
    expect(after.json.updated_at).toBe(before.json.updated_at);
    expect(after.json.external_ids).toEqual(before.json.external_ids);
    expect(after.json.titles).toEqual(before.json.titles);
    const recordStamps = await page.evaluate(async () => {
      const { db } = await import('/src/lib/catalog/db.ts');
      const record = await db.series_metadata.get('shelf nudge');
      return { facts: record?.facts_updated_at, updated: record?.updated_at };
    });
    record('shelf: series.json before/after the nudge', {
      before: { text: before.text, updated_at: before.json.updated_at },
      after: { text: after.text, updated_at: after.json.updated_at },
      recordStamps
    });
    await shot(page, 'shelf-nudge');
    expect(recordStamps.facts).toBe(before.json.updated_at);
    // The record's general clock DID move — only the facts clock is pinned.
    expect(recordStamps.updated! > recordStamps.facts!).toBe(true);

    expectCleanConsole(watch);
  });

  test('series-metadata.json is written nowhere, and a planted one is ignored inertly', async ({
    page
  }) => {
    const watch = watchConsole(page);
    // A stale root file from a dev build that shipped the retired format, with
    // a far-future stamp and an empty link: if anything still read it, it would
    // unlink the series everywhere.
    const STALE = JSON.stringify({
      version: 1,
      updated_at: '2099-01-01T00:00:00.000Z',
      series: {
        'stale series': {
          series_key: 'stale series',
          series_title: 'Stale Series',
          external_ids: {},
          titles: {},
          synonyms: [],
          updated_at: '2099-01-01T00:00:00.000Z',
          read_count: 99
        }
      }
    });
    await seedOpfs(page, [
      { path: 'Stale Series/Stale Series Vol 1.cbz', bytes: 2048 },
      { path: 'series-metadata.json', text: STALE },
      { path: 'Stale Series/series-metadata.json', text: STALE }
    ]);
    await seedVolumes(page, [
      { uuid: 'stale-1', series: 'Stale Series', title: 'Stale Series Vol 1' }
    ]);
    await page.evaluate(async () => {
      const { updateSeriesMetadata } = await import('/src/lib/metadata/store.ts');
      await updateSeriesMetadata('Stale Series', { external_ids: { anilist: 4242 } });
    });

    await connectLocalFolder(page);
    await expect
      .poll(() => readSeriesFile(page, 'Stale Series'), {
        timeout: 40000,
        message: 'series.json was never published'
      })
      .not.toBeNull();
    await syncNow(page);
    await page.waitForTimeout(1500);

    // (a) Nothing wrote one, anywhere — including under the series folder.
    const tree = await opfsTree(page);
    expect(tree.filter((path) => /series-metadata\.json$/.test(path)).sort()).toEqual([
      'Stale Series/series-metadata.json',
      'series-metadata.json'
    ]);
    // (b) The planted copies are inert: byte-identical, neither rewritten nor deleted.
    expect(await opfsRead(page, 'series-metadata.json')).toBe(STALE);
    expect(await opfsRead(page, 'Stale Series/series-metadata.json')).toBe(STALE);
    // (c) The provider does not even list them.
    const listed = await page.evaluate(async () => {
      const { cacheManager } = await import('/src/lib/util/sync/cache-manager.ts');
      const cache = cacheManager.getCache('filesystem')!;
      return cache
        .getAllFiles()
        .map((f: { path: string }) => f.path)
        .filter((path: string) => /series-metadata/.test(path));
    });
    expect(listed).toEqual([]);
    // (d) Its contents reached nothing: the link stands, and its read_count of
    //     99 never became reading state.
    const local = await page.evaluate(async () => {
      const { db } = await import('/src/lib/catalog/db.ts');
      const { getSeriesReadingState } = await import('/src/lib/settings/series-data.ts');
      const record = await db.series_metadata.get('stale series');
      return {
        anilist: record?.external_ids?.anilist,
        readCount: getSeriesReadingState('stale series').read_count,
        keys: Object.keys(record ?? {}).sort()
      };
    });
    record('stale: series-metadata.json is inert', {
      tree,
      listedByProvider: listed,
      local
    });
    expect(local.anilist).toBe(4242);
    expect(local.readCount).toBe(0);
    expect(local.keys).not.toContain('read_count');

    expectCleanConsole(watch);
  });

  test('the read count and Restart travel in volume-data.json, and survive a reload', async ({
    page
  }) => {
    const watch = watchConsole(page);
    await seedOpfs(page, [
      { path: 'Count Series/Count Series Vol 1.cbz', bytes: 2048 },
      { path: 'Count Series/Count Series Vol 2.cbz', bytes: 2048 }
    ]);
    await seedVolumes(page, [
      { uuid: 'count-1', series: 'Count Series', title: 'Count Series Vol 1' },
      { uuid: 'count-2', series: 'Count Series', title: 'Count Series Vol 2' }
    ]);
    // Both volumes finished, so Restart archives a completed pass and the count
    // it bumps is the one this test is about.
    await page.evaluate(async () => {
      const { markVolumeAsComplete } = await import('/src/lib/settings/volume-data.ts');
      markVolumeAsComplete('count-1', 180, 4000);
      markVolumeAsComplete('count-2', 180, 4000);
    });
    await connectLocalFolder(page);

    await openSeriesEditor(page, 'Count Series');
    const plus = page.getByRole('button', { name: 'Increase read count' });
    const minus = page.getByRole('button', { name: 'Decrease read count' });
    await expect(plus).toBeVisible();

    await plus.click();
    await plus.click();
    await plus.click();
    await minus.click();
    // "Read N times" counts the completed pass on screen too, so the panel says
    // one more than the stored `read_count`.
    await expect(page.getByText(/Read 3 times/)).toBeVisible();
    await shot(page, 'read-count-panel');
    expect(
      await page.evaluate(async () => {
        const { getSeriesReadingState } = await import('/src/lib/settings/series-data.ts');
        return getSeriesReadingState('count series').read_count;
      })
    ).toBe(2);

    // Restart: archives the completed pass, so the stored count goes to 3.
    await page.getByRole('button', { name: /Restart series/ }).click();
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { getSeriesReadingState } = await import('/src/lib/settings/series-data.ts');
          return getSeriesReadingState('count series').read_count;
        })
      )
      .toBe(3);

    await syncNow(page);

    // The state is in volume-data.json's reserved `series` section — and
    // nowhere else.
    const cloud = JSON.parse((await opfsRead(page, 'volume-data.json'))!);
    expect(Object.keys(cloud)).toContain('series');
    record('read count: volume-data.json', {
      topLevelKeys: Object.keys(cloud).sort(),
      series: cloud.series
    });
    expect(cloud.series['count series'].read_count).toBe(3);
    expect(typeof cloud.series['count series'].lastUpdated).toBe('string');
    expect(cloud['count-1']).toBeTruthy();
    // A parser reading the file back never mistakes the section for a volume.
    const volumeKeys = await page.evaluate(async (text) => {
      const { parseVolumesFromJson } = await import('/src/lib/settings/volume-data.ts');
      return Object.keys(parseVolumesFromJson(text)).sort();
    }, JSON.stringify(cloud));
    expect(volumeKeys).toEqual(['count-1', 'count-2']);
    // No series.json carries reading state — the reconcile pass publishes one
    // for this folder, and none of it is the user's.
    await expect
      .poll(() => opfsRead(page, 'Count Series/series.json'), {
        timeout: 40000,
        message: 'series.json was never published'
      })
      .not.toBeNull();
    const sidecar = (await opfsRead(page, 'Count Series/series.json'))!;
    for (const dead of ['read_count', 'reread_prompt_suppressed', 'tracking', 'lastUpdated']) {
      expect(sidecar).not.toContain(dead);
    }

    // And the state survives a reload of the app. (The reload keeps the hash it
    // was on, so this waits for the series view, not the catalog default.)
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => window.location.hash), { timeout: 20000 })
      .toBe(seriesHash('Count Series'));
    expect(
      await page.evaluate(async () => {
        const { getSeriesReadingState } = await import('/src/lib/settings/series-data.ts');
        return getSeriesReadingState('count series').read_count;
      })
    ).toBe(3);

    expectCleanConsole(watch);
  });

  test('a settings change uploads profiles.json on the next sync, with no button to press', async ({
    page
  }) => {
    const watch = watchConsole(page);
    await seedOpfs(page, [{ path: 'Profile Series/Profile Series Vol 1.cbz', bytes: 2048 }]);
    await seedVolumes(page, [
      { uuid: 'prof-1', series: 'Profile Series', title: 'Profile Series Vol 1' }
    ]);

    // A real settings change, through the store the settings UI writes.
    await page.evaluate(async () => {
      const { updateSetting, currentProfile } = await import('/src/lib/settings/settings.ts');
      currentProfile.set('Desktop');
      updateSetting('charCount', true);
    });

    // Connecting runs the app's own post-login sync. Nothing else is pressed.
    await connectLocalFolder(page);
    await expect
      .poll(() => opfsRead(page, 'profiles.json'), {
        timeout: 40000,
        message: 'profiles.json was never uploaded by the automatic sync'
      })
      .not.toBeNull();

    const uploaded = JSON.parse((await opfsRead(page, 'profiles.json'))!);
    record('profiles: uploaded by the automatic sync', {
      charCount: uploaded.Desktop.charCount,
      lastUpdated: uploaded.Desktop.lastUpdated
    });
    expect(uploaded.Desktop.charCount).toBe(true);
    expect(typeof uploaded.Desktop.lastUpdated).toBe('string');

    // The duplicate button is gone; the one remaining sync button covers both.
    await goHash(page, '#/cloud');
    await expect(page.getByRole('button', { name: /Sync profiles/i })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Sync read progress', exact: true })
    ).toBeVisible();
    await shot(page, 'cloud-view-no-profiles-button');

    // A later change rides the next ordinary sync, still with nothing pressed.
    await page.evaluate(async () => {
      const { updateSetting } = await import('/src/lib/settings/settings.ts');
      updateSetting('charCount', false);
    });
    await syncNow(page);
    await expect
      .poll(async () => JSON.parse((await opfsRead(page, 'profiles.json'))!).Desktop.charCount, {
        timeout: 20000,
        message: 'the second settings change never reached profiles.json'
      })
      .toBe(false);

    expectCleanConsole(watch);
  });

  test('a future-stamped cloud file is healed and the pending local edits survive', async ({
    page
  }) => {
    const watch = watchConsole(page);
    await seedOpfs(page, [{ path: 'Skew Series/Skew Series Vol 1.cbz', bytes: 2048 }]);
    await seedVolumes(page, [
      { uuid: 'skew-1', series: 'Skew Series', title: 'Skew Series Vol 1' }
    ]);

    // A cloud folder poisoned by a device with a fast clock: the series entry
    // and the profile are both stamped a day into the future.
    const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await page.evaluate(
      async ({ future }) => {
        const { profilesWithTrash } = await import('/src/lib/settings/settings.ts');
        // `svelte/store`'s `get` is not resolvable as a bare specifier in the
        // page, so every store read here is a one-shot subscribe.
        let profiles: Record<string, Record<string, unknown>> = {};
        profilesWithTrash.subscribe((v: Record<string, Record<string, unknown>>) => {
          profiles = v;
        })();
        const desktop = profiles.Desktop;
        const root = await navigator.storage.getDirectory();
        const write = async (name: string, text: string) => {
          const handle = await root.getFileHandle(name, { create: true });
          const writable = await handle.createWritable();
          await writable.write(text);
          await writable.close();
        };
        await write(
          'volume-data.json',
          JSON.stringify({
            series: {
              // Poisoned, and this device has a pending edit for it.
              'skew series': { read_count: 99, lastUpdated: future },
              // Honest, and unknown here: this is the ordinary inbound case —
              // another device's read count arriving, tracking and all.
              'inbound series': {
                read_count: 5,
                reread_prompt_suppressed: true,
                tracking: {
                  last_pushed: { at: '2026-08-01T00:00:00.000Z', n: 7, status: 'CURRENT' }
                },
                lastUpdated: '2026-08-01T00:00:00.000Z'
              },
              // Junk from a hand-edited file: the entry survives, the malformed
              // tracking (no `status`) does not — it steers writes to AniList.
              'junk series': {
                read_count: 'lots',
                tracking: { last_pushed: { n: 3 } },
                lastUpdated: '2026-08-01T00:00:00.000Z'
              },
              // Poisoned, but nothing local to protect: adopted, healed.
              'orphan series': { read_count: 4, lastUpdated: future }
            }
          })
        );
        await write(
          'profiles.json',
          JSON.stringify({ Desktop: { ...desktop, charCount: false, lastUpdated: future } })
        );
      },
      { future: FUTURE }
    );

    // The honest local edits, made now — both would lose to a future stamp.
    await page.evaluate(async () => {
      const { updateSeriesReadingState } = await import('/src/lib/settings/series-data.ts');
      const { updateSetting, currentProfile } = await import('/src/lib/settings/settings.ts');
      updateSeriesReadingState('skew series', { read_count: 2 });
      currentProfile.set('Desktop');
      updateSetting('charCount', true);
    });

    await connectLocalFolder(page);
    await syncNow(page);
    await page.waitForTimeout(1000);

    // FORFEIT-ON-BOGUS: the poisoned entries lose outright, local content stands.
    const local = await page.evaluate(async () => {
      const { getSeriesReadingState } = await import('/src/lib/settings/series-data.ts');
      const { profilesWithTrash } = await import('/src/lib/settings/settings.ts');
      const state = getSeriesReadingState('skew series');
      let profiles: Record<string, Record<string, unknown>> = {};
      profilesWithTrash.subscribe((v: Record<string, Record<string, unknown>>) => {
        profiles = v;
      })();
      return {
        readCount: state.read_count,
        stateStamp: state.lastUpdated,
        charCount: profiles.Desktop.charCount as boolean,
        profileStamp: profiles.Desktop.lastUpdated as string,
        inbound: getSeriesReadingState('inbound series'),
        orphan: getSeriesReadingState('orphan series'),
        junk: getSeriesReadingState('junk series')
      };
    });
    record('clock skew: planted stamp and what survived', {
      planted: FUTURE,
      local
    });
    expect(local.readCount).toBe(2);
    expect(local.charCount).toBe(true);
    // The ordinary inbound case still works: an honest cloud entry this device
    // has never seen arrives whole — count, flag and tracking bookkeeping.
    expect(local.inbound.read_count).toBe(5);
    expect(local.inbound.reread_prompt_suppressed).toBe(true);
    expect(local.inbound.tracking).toEqual({
      last_pushed: { at: '2026-08-01T00:00:00.000Z', n: 7, status: 'CURRENT' }
    });
    // Junk is coerced field by field, never adopted whole.
    expect(local.junk.read_count).toBe(0);
    expect(local.junk.tracking).toBeUndefined();
    // A poisoned entry with no local edit to protect is adopted rather than
    // dropped — there is nothing to lose, and the stamp is healed on the way in.
    expect(local.orphan.read_count).toBe(4);
    expect(Date.parse(local.orphan.lastUpdated)).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000);

    // And the healed files were uploaded, so the poison is gone after one sync.
    const cloudVolumeData = JSON.parse((await opfsRead(page, 'volume-data.json'))!);
    const cloudProfiles = JSON.parse((await opfsRead(page, 'profiles.json'))!);
    record('clock skew: healed cloud files', {
      series: cloudVolumeData.series,
      desktopProfile: {
        charCount: cloudProfiles.Desktop.charCount,
        lastUpdated: cloudProfiles.Desktop.lastUpdated
      }
    });
    expect(cloudVolumeData.series['skew series'].read_count).toBe(2);
    expect(cloudProfiles.Desktop.charCount).toBe(true);
    const tolerance = Date.now() + 5 * 60 * 1000;
    expect(Date.parse(cloudVolumeData.series['skew series'].lastUpdated)).toBeLessThanOrEqual(
      tolerance
    );
    expect(Date.parse(cloudProfiles.Desktop.lastUpdated)).toBeLessThanOrEqual(tolerance);
    // The local stamps are honest too — nothing adopted the future clock.
    expect(Date.parse(local.stateStamp)).toBeLessThanOrEqual(tolerance);
    expect(Date.parse(local.profileStamp)).toBeLessThanOrEqual(tolerance);

    expectCleanConsole(watch);
  });
});

// ── 3. The confidence-aware unit label ───────────────────────────────────────

test.describe('tracking unit label', () => {
  test.describe.configure({ timeout: 60_000 });

  test.beforeEach(async ({ page }) => {
    await boot(page);
    await resetState(page);
  });

  test('a marker-decided series names its unit; a bare-numbered one does not', async ({ page }) => {
    const watch = watchConsole(page);
    // "Vol 1" names its unit outright; "Marker Series 1" is a bare number, which
    // only AniList's totals (which this page never has) could settle.
    await seedVolumes(page, [
      { uuid: 'mk-1', series: 'Marker Series', title: 'Marker Series Vol 1' },
      { uuid: 'mk-2', series: 'Marker Series', title: 'Marker Series Vol 2' },
      { uuid: 'br-1', series: 'Bare Series', title: 'Bare Series 1' },
      { uuid: 'br-2', series: 'Bare Series', title: 'Bare Series 2' }
    ]);
    // The unit control only renders for a LINKED series — there is nothing to
    // push a unit to otherwise.
    await page.evaluate(async () => {
      const { updateSeriesMetadata } = await import('/src/lib/metadata/store.ts');
      await updateSeriesMetadata('Marker Series', { external_ids: { anilist: 1 } });
      await updateSeriesMetadata('Bare Series', { external_ids: { anilist: 2 } });
    });

    // What the detector itself says, before looking at any pixels.
    const detection = await page.evaluate(async () => {
      const { resolveTrackingUnit } = await import('/src/lib/metadata/tracking-unit.ts');
      return {
        marker: resolveTrackingUnit(undefined, [
          { volume_title: 'Marker Series Vol 1' },
          { volume_title: 'Marker Series Vol 2' }
        ]),
        bare: resolveTrackingUnit(undefined, [
          { volume_title: 'Bare Series 1' },
          { volume_title: 'Bare Series 2' }
        ])
      };
    });
    record('unit label: detector', detection);
    expect(detection.marker).toEqual({ unit: 'volumes', source: 'detected', confident: true });
    expect(detection.bare.confident).toBe(false);

    await openSeriesEditor(page, 'Marker Series');
    const markerSelect = page.getByLabel('Tracking unit');
    await expect(markerSelect).toBeVisible();
    // The modal fades in; a screenshot taken mid-transition is unreadable.
    await page.waitForTimeout(500);
    const markerLabel = await markerSelect.locator('option').first().innerText();
    record('unit label: marker-decided series', {
      autoOption: markerLabel,
      title: await markerSelect.getAttribute('title')
    });
    await shot(page, 'unit-label-marker');
    expect(markerLabel).toBe('Auto (volumes)');
    // A marker-decided unit is an answer, so nothing is hedged.
    expect(await markerSelect.getAttribute('title')).toBeNull();

    await page.keyboard.press('Escape');
    await openSeriesEditor(page, 'Bare Series');
    const bareSelect = page.getByLabel('Tracking unit');
    await expect(bareSelect).toBeVisible();
    await page.waitForTimeout(500);
    const bareLabel = await bareSelect.locator('option').first().innerText();
    record('unit label: bare-numbered series', {
      autoOption: bareLabel,
      title: await bareSelect.getAttribute('title')
    });
    await shot(page, 'unit-label-bare');
    expect(bareLabel).toBe('Auto');
    expect(await bareSelect.getAttribute('title')).toBe(
      'Determined at push time from AniList totals'
    );

    expectCleanConsole(watch);
  });
});
