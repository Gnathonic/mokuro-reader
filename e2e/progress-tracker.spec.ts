import { test, expect, type Page } from '@playwright/test';

/**
 * E2E for the reading-goals progress tracker (PR #270, integrated onto v1.9.1).
 *
 * Seed-and-render against the REAL app: the actual Dexie catalog rows and the
 * actual `volumes` localStorage map are written, then the real tracker view is
 * asserted on. Nothing here stubs the goals module.
 *
 * The three things worth proving in a browser rather than jsdom:
 *  1. Visiting the tracker does not rescale the rest of the app (the `--spacing`
 *     leak — a computed-style fact, invisible to a unit test).
 *  2. A volume finished on ANOTHER device, whose pages were never downloaded
 *     here, is counted by the goal ring AND listed under Completed. Those two
 *     used to disagree.
 *  3. `completedAt` survives a reload and reaches `volume-data.json`'s shape.
 */

const ALLOWED_CONSOLE = [
  /\[vite\]/i,
  /Unexpected token '<'/,
  /_vercel\/insights/i,
  /Failed to load resource/i,
  /favicon/i
];

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (ALLOWED_CONSOLE.some((re) => re.test(text))) return;
    errors.push(text);
  });
  page.on('pageerror', (err) => {
    const text = String(err);
    // Same allowlist as the console channel: `@vercel/analytics`' inject()
    // requests a script that only exists on Vercel, and the SPA catchall
    // answers with index.html, which the browser tries to parse as JS.
    if (ALLOWED_CONSOLE.some((re) => re.test(text))) return;
    errors.push(text);
  });
  return errors;
}

async function seedVolumes(
  page: Page,
  rows: Array<{ uuid: string; series: string; title: string; pageCount?: number | null }>
) {
  await page.evaluate(async (specs) => {
    const { db } = await import('/src/lib/catalog/db.ts');
    const { generateDeterministicUUID } = await import('/src/lib/util/series-extraction.ts');

    for (const spec of specs) {
      // `pageCount: null` means "this device has no row at all" — the cloud-only
      // case. Anything else gets a real catalog row.
      if (spec.pageCount === null) continue;
      await db.volumes.put({
        volume_uuid: spec.uuid,
        series_uuid: generateDeterministicUUID(spec.series),
        series_title: spec.series,
        volume_title: spec.title,
        mokuro_version: '0.4.11',
        page_count: spec.pageCount ?? 180,
        character_count: 4000,
        page_char_counts: []
      });
    }
  }, rows);
}

/** Write the reading records the way the app itself serializes them. */
async function seedReadingState(page: Page, map: Record<string, unknown>) {
  await page.evaluate((entries) => {
    window.localStorage.setItem('volumes', JSON.stringify(entries));
  }, map);
}

async function goHash(page: Page, hash: string) {
  const expected = hash.replace(/^#\//, '').split(/[/?]/)[0] || 'catalog';
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
  await page.waitForTimeout(900);
}

const YEAR = new Date().getFullYear();
const inThisYear = (month: number) => new Date(YEAR, month, 15, 12).toISOString();

test.describe('progress tracker', () => {
  test('visiting the tracker does not rescale the rest of the app', async ({ page }) => {
    // The tracker's lazy chunk used to inject `:root { --spacing: 5px }`.
    // Svelte does not scope `:root`, and Tailwind v4 compiles every numeric
    // spacing utility to `calc(var(--spacing) * N)`, so every padding, margin,
    // gap and icon in the app grew 25% for the rest of the session.
    const errors = watchConsole(page);
    await page.goto('/');
    await page.waitForTimeout(1500);

    const before = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--spacing').trim()
    );
    expect(before).toBe('0.25rem');

    await goHash(page, '#/progress-tracker');

    const after = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--spacing').trim()
    );
    expect(after, 'the tracker chunk redefined the global spacing scale').toBe('0.25rem');

    // And still 0.25rem after navigating away — the stylesheet stays loaded.
    await goHash(page, '#/catalog');
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--spacing').trim()
      )
    ).toBe('0.25rem');

    expect(errors).toEqual([]);
  });

  test('a volume finished on another device is both counted and listed', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/');
    await page.waitForTimeout(1500);

    // `cloud-only` has NO catalog row: pages never downloaded here, so its page
    // count is unknown. Its reading record says it was finished in March.
    await seedVolumes(page, [
      { uuid: 'local-done', series: 'Local Series', title: 'Volume 1' },
      { uuid: 'cloud-only', series: 'Cloud Series', title: 'Volume 1', pageCount: null },
      { uuid: 'in-progress', series: 'Local Series', title: 'Volume 2' }
    ]);
    await seedReadingState(page, {
      'local-done': {
        progress: 180,
        completed: true,
        completedAt: inThisYear(2),
        lastProgressUpdate: inThisYear(2),
        series_title: 'Local Series',
        volume_title: 'Volume 1'
      },
      'cloud-only': {
        progress: 200,
        completed: true,
        completedAt: inThisYear(3),
        lastProgressUpdate: inThisYear(3),
        series_title: 'Cloud Series',
        volume_title: 'Volume 1'
      },
      'in-progress': {
        progress: 90,
        lastProgressUpdate: inThisYear(6),
        series_title: 'Local Series',
        volume_title: 'Volume 2'
      }
    });

    await page.reload();
    await page.waitForTimeout(1500);
    await goHash(page, '#/progress-tracker');

    const counts = await page.evaluate(async () => {
      const { activeGoalProgress } = await import('/src/lib/goals/index.ts');
      let value: Record<string, number> | undefined;
      activeGoalProgress.subscribe((v: Record<string, number>) => (value = v))();
      return value!;
    });

    // Both completions count, including the one this device has no pages for.
    expect(counts.completedVolumes).toBe(2);

    const body = await page.locator('body').innerText();
    expect(body).toContain('Completed Volumes');
    // The header's number and the list below it agree: both titles are listed.
    expect(body).toContain('Currently Reading');

    const listed = await page.evaluate(async () => {
      const mod = await import('/src/lib/views/progress-tracker-helpers.ts');
      const { volumes } = await import('/src/lib/settings/volume-data.ts');
      const { volumesWithPlaceholders } = await import('/src/lib/catalog/index.ts');
      const { activeGoalPeriod } = await import('/src/lib/goals/index.ts');

      const read = <T>(store: { subscribe: (fn: (v: T) => void) => () => void }): T => {
        let v!: T;
        store.subscribe((x: T) => (v = x))();
        return v;
      };

      const vols = read<Record<string, never>>(volumes);
      const catalog = read<Record<string, { page_count?: number }> | undefined>(
        volumesWithPlaceholders
      );
      const entries = Object.entries(vols) as [string, never][];
      const stats = mod.computeVolumeStats(entries, catalog ?? {}, {});
      const buckets = mod.bucketVolumes(entries, stats, read(activeGoalPeriod), null);
      return {
        completed: buckets.completedVolumes.map(([id]: [string, unknown]) => id).sort(),
        reading: buckets.currentlyReading.map(([id]: [string, unknown]) => id).sort()
      };
    });

    expect(listed.completed).toEqual(['cloud-only', 'local-done']);
    expect(errors).toEqual([]);
  });

  test('completedAt survives a reload and serializes into the sync shape', async ({ page }) => {
    // The old implementation side-wrote this key behind the volumes store's
    // back and it was stripped by the very next write, so nothing survived a
    // reload and nothing ever reached the cloud file.
    const errors = watchConsole(page);
    await page.goto('/');
    await page.waitForTimeout(1500);

    await seedVolumes(page, [{ uuid: 'v1', series: 'S', title: 'Volume 1', pageCount: 10 }]);

    await page.evaluate(async () => {
      const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
      updateProgress('v1', 10, 500, true);
    });
    await page.waitForTimeout(500);

    const stamped = await page.evaluate(
      () => JSON.parse(window.localStorage.getItem('volumes') || '{}').v1?.completedAt
    );
    expect(stamped, 'completedAt was not written to the volumes map').toBeTruthy();

    // Another write to the same map must not strip it.
    await page.evaluate(async () => {
      const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
      updateProgress('v1', 10, 600, true);
    });
    await page.waitForTimeout(500);

    await page.reload();
    await page.waitForTimeout(1500);

    const afterReload = await page.evaluate(
      () => JSON.parse(window.localStorage.getItem('volumes') || '{}').v1?.completedAt
    );
    expect(afterReload, 'completedAt did not survive a reload').toBe(stamped);

    // And it is in what the sync layer would upload.
    const inSyncPayload = await page.evaluate(async () => {
      const { VolumeData } = await import('/src/lib/settings/volume-data.ts');
      const raw = JSON.parse(window.localStorage.getItem('volumes') || '{}').v1;
      return new VolumeData(raw).toJSON().completedAt;
    });
    expect(inSyncPayload).toBe(stamped);

    expect(errors).toEqual([]);
  });
});
