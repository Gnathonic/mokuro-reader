import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

const { catalogStore, miscSettings, queueSeriesVolumes, readingVolumes } = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    const subs = new Set<(v: T) => void>();
    let current = initial;
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(current);
        return () => subs.delete(fn);
      },
      set(v: T) {
        current = v;
        subs.forEach((fn) => fn(current));
      }
    };
  }
  return {
    queueSeriesVolumes: vi.fn(),
    catalogStore: createStore<unknown[] | null>([]),
    miscSettings: createStore({ galleryLayout: 'list', gallerySorting: 'ASC' }),
    // The reading record the smart sort reads completion and recency from.
    readingVolumes: createStore<Record<string, unknown>>({})
  };
});

function emptyStore<T>(value: T) {
  return {
    subscribe(fn: (v: T) => void) {
      fn(value);
      return () => {};
    }
  };
}

vi.mock('$lib/catalog', () => ({
  catalog: catalogStore,
  volumes: emptyStore<Record<string, unknown>>({})
}));
vi.mock('$lib/settings', () => ({
  miscSettings,
  updateMiscSetting: vi.fn(),
  volumes: readingVolumes,
  progress: emptyStore<Record<string, number>>({})
}));
vi.mock('$lib/catalog/db', () => ({ isUpgrading: emptyStore(false) }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getDefaultProvider: () => ({ name: 'Drive' }),
    getActiveProvider: () => ({ name: 'Drive' })
  }
}));
vi.mock('$lib/util/download-queue', () => ({
  queueSeriesVolumes,
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => {
      fn([]);
      return () => {};
    },
    getSeriesQueueStatus: () => ({ hasQueued: false, hasDownloading: false })
  }
}));
vi.mock('$lib/util', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/modals', () => ({ promptSeriesEditor: vi.fn() }));
vi.mock('$lib/catalog/series-delete', () => ({ promptSeriesRemoval: vi.fn() }));
vi.mock('$lib/util/hash-router', () => ({ nav: { toSeries: vi.fn() } }));

import Catalog, { CATALOG_LOAD_STALL_MS } from '../Catalog.svelte';
import type { VolumeMetadata } from '$lib/types';

function volume(series: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: `${series}-1`,
    series_uuid: `uuid-${series}`,
    series_title: series,
    volume_title: 'Vol 1',
    page_count: 10,
    isPlaceholder: false,
    ...overrides
  } as VolumeMetadata;
}

/** A volume that is absent AND has somewhere to download from. */
function downloadable(series: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return volume(series, {
    cloudFileId: `file-${series}-${overrides.volume_uuid ?? '1'}`,
    cloudProvider: 'google-drive',
    ...overrides
  });
}

function series(title: string, volumes: VolumeMetadata[]) {
  return {
    title,
    displayTitle: title,
    searchTerms: [title.toLowerCase()],
    series_uuid: `uuid-${title}`,
    volumes
  };
}

/**
 * Title text AND whether it carries the finished marker, read off the same rendered rows.
 * The two halves of the bug live here together: the ORDER comes from the smart sort's
 * completion predicate, the green from the row's own — and they used to be different code.
 */
function markedTitlesIn(
  container: HTMLElement,
  testId: string
): { title: string; green: boolean }[] {
  const region = container.querySelector(`[data-testid="${testId}"]`);
  if (!region) return [];
  return [...region.querySelectorAll('p.font-semibold')].map((el) => ({
    title: el.textContent?.trim() ?? '',
    green: el.className.includes('text-green-400')
  }));
}

function titlesIn(container: HTMLElement, testId: string): string[] {
  const region = container.querySelector(`[data-testid="${testId}"]`);
  if (!region) return [];
  return [...region.querySelectorAll('p.font-semibold')].map((el) => el.textContent?.trim() ?? '');
}

describe('Catalog always groups not-on-device series into the cloud section', () => {
  afterEach(() => {
    cleanup();
  });

  it('sections absent series with the cloud ones', () => {
    catalogStore.set([
      series('Here', [volume('Here')]),
      series('Gone', [volume('Gone', { metadata_only: true })]),
      series('Cloud', [volume('Cloud', { isPlaceholder: true })])
    ]);

    const { container } = render(Catalog);
    expect(titlesIn(container, 'catalog-library')).toEqual(['Here']);
    expect(titlesIn(container, 'catalog-cloud')).toEqual(['Cloud', 'Gone']);
  });

  it('keeps a partly-installed series in the library', () => {
    catalogStore.set([
      series('Half', [
        volume('Half'),
        volume('Half', { volume_uuid: 'half-2', metadata_only: true })
      ])
    ]);

    const { container } = render(Catalog);
    expect(titlesIn(container, 'catalog-library')).toEqual(['Half']);
    expect(titlesIn(container, 'catalog-cloud')).toEqual([]);
  });
});

describe('Catalog cloud section counts and queues everything it holds', () => {
  afterEach(() => {
    cleanup();
    queueSeriesVolumes.mockClear();
  });

  /** A metadata-only series (2 volumes) plus a cloud-only one (1 volume). */
  function mixedCatalog() {
    catalogStore.set([
      series('Here', [volume('Here')]),
      series('Gone', [
        downloadable('Gone', { metadata_only: true }),
        downloadable('Gone', { volume_uuid: 'Gone-2', metadata_only: true })
      ]),
      series('Cloud', [downloadable('Cloud', { isPlaceholder: true })])
    ]);
  }

  function breakdown(container: HTMLElement): string {
    const region = container.querySelector('[data-testid="catalog-cloud"]');
    return region?.querySelector('p.text-sm')?.textContent?.trim() ?? '';
  }

  function downloadAll(container: HTMLElement): HTMLElement {
    const region = container.querySelector('[data-testid="catalog-cloud"]');
    const button = [...(region?.querySelectorAll('button') ?? [])].find((el) =>
      el.textContent?.includes('Download all')
    );
    if (!button) throw new Error('Download all button not found');
    return button as HTMLElement;
  }

  it('counts what the button will fetch', async () => {
    mixedCatalog();
    const { container } = render(Catalog);

    // Every volume that is off the device and has a cloud copy — the metadata-only ones
    // included.
    expect(breakdown(container)).toBe('3 Drive');
  });

  it('queues every non-local volume in the library, not just the section’s own', async () => {
    // A series that is partly here still has volumes that are not: "Download all" has
    // always meant all of them, and a metadata-only row is one of them.
    catalogStore.set([
      series('Half', [
        volume('Half'),
        downloadable('Half', { volume_uuid: 'Half-2', isPlaceholder: true })
      ]),
      series('Gone', [downloadable('Gone', { metadata_only: true })]),
      series('Cloud', [downloadable('Cloud', { isPlaceholder: true })])
    ]);

    const { container } = render(Catalog);
    await fireEvent.click(downloadAll(container));

    expect(queueSeriesVolumes).toHaveBeenCalledTimes(1);
    expect(queueSeriesVolumes.mock.calls[0][0].map((v: VolumeMetadata) => v.volume_uuid)).toEqual([
      'Cloud-1',
      'Gone-1',
      'Half-2'
    ]);
  });

  it('queues every downloadable volume from the section', async () => {
    mixedCatalog();
    const { container } = render(Catalog);
    await tick();
    await fireEvent.click(downloadAll(container));

    expect(queueSeriesVolumes.mock.calls[0][0].map((v: VolumeMetadata) => v.volume_uuid)).toEqual([
      'Cloud-1',
      'Gone-1',
      'Gone-2'
    ]);
  });

  it('never offers a volume with nowhere to download from', async () => {
    catalogStore.set([
      series('Orphan', [volume('Orphan', { metadata_only: true })]),
      series('Cloud', [downloadable('Cloud', { isPlaceholder: true })])
    ]);
    const { container } = render(Catalog);

    await fireEvent.click(downloadAll(container));

    expect(queueSeriesVolumes.mock.calls[0][0].map((v: VolumeMetadata) => v.volume_uuid)).toEqual([
      'Cloud-1'
    ]);
    expect(breakdown(container)).toBe('1 Drive');
  });

  it('counts every sectioned series in the heading', async () => {
    mixedCatalog();
    const { container } = render(Catalog);
    const heading = () =>
      container.querySelector('[data-testid="catalog-cloud"] h4')?.textContent?.trim() ?? '';

    expect(heading()).toBe('Available in Drive (2 series)');
  });
});

describe('Catalog smart-sorts an all-absent series by its read state', () => {
  afterEach(() => {
    cleanup();
    miscSettings.set({ galleryLayout: 'list', gallerySorting: 'ASC' });
    readingVolumes.set({});
  });

  it('sorts a finished absent series to the bottom, like any series with progress', async () => {
    miscSettings.set({ galleryLayout: 'list', gallerySorting: 'SMART' });
    readingVolumes.set({
      'Read-1': { completed: true, progress: 10, lastProgressUpdate: '2026-08-01T00:00:00.000Z' },
      'Unread-1': { completed: false, progress: 4, lastProgressUpdate: '2026-08-20T00:00:00.000Z' }
    });
    catalogStore.set([
      series('Read', [volume('Read', { metadata_only: true })]),
      series('Cloud', [volume('Cloud', { isPlaceholder: true })]),
      series('Unread', [volume('Unread', { metadata_only: true })])
    ]);

    const { container } = render(Catalog);
    await tick();

    // Read state, not absence, decides the order: most recently read first, finished last —
    // the cloud-only series has no progress at all, so it lands between them.
    expect(titlesIn(container, 'catalog-cloud')).toEqual(['Unread', 'Cloud', 'Read']);
  });

  it('keeps that order when the section holds only absent series', async () => {
    miscSettings.set({ galleryLayout: 'list', gallerySorting: 'SMART' });
    readingVolumes.set({
      'Read-1': { completed: true, progress: 10, lastProgressUpdate: '2026-08-01T00:00:00.000Z' },
      'Unread-1': { completed: false, progress: 4, lastProgressUpdate: '2026-08-20T00:00:00.000Z' }
    });
    catalogStore.set([
      series('Read', [volume('Read', { metadata_only: true })]),
      series('Unread', [volume('Unread', { metadata_only: true })])
    ]);

    const { container } = render(Catalog);
    expect(titlesIn(container, 'catalog-library')).toEqual([]);
    expect(titlesIn(container, 'catalog-cloud')).toEqual(['Unread', 'Read']);
  });
});

/**
 * BUG: the catalog had TWO completion predicates that disagreed.
 *
 * The smart sort read the stored `completed` flag over every volume of the series; the
 * card and the list row recomputed completion from the raw page over the LOCAL volumes
 * only, and required at least one of them to exist. So a finished cloud series sorted to
 * the bottom without ever turning green, and a volume read to the end whose flag had been
 * clobbered by a page-only `updateProgress` turned green without sorting to the bottom.
 *
 * Both now call `isSeriesFinished`. These tests read the ORDER (the sort's answer) and the
 * GREEN (the row's answer) off the same rendered rows, so the two cannot drift apart
 * again without one of them failing.
 */
describe('Catalog sorts and colours a series by the SAME completion rule', () => {
  afterEach(() => {
    cleanup();
    miscSettings.set({ galleryLayout: 'list', gallerySorting: 'ASC' });
    readingVolumes.set({});
  });

  function smartCatalogOfEveryShape() {
    miscSettings.set({ galleryLayout: 'list', gallerySorting: 'SMART' });
    readingVolumes.set({
      // Read to the last page, flag and all.
      'local-done': {
        completed: true,
        progress: 10,
        lastProgressUpdate: '2026-08-05T00:00:00.000Z'
      },
      // Read to the last page, but the flag says otherwise: `updateProgress(volume, page)`
      // defaults its 4th argument, so a page-only caller stores `completed: false`.
      'local-stale': {
        completed: false,
        progress: 10,
        lastProgressUpdate: '2026-08-04T00:00:00.000Z'
      },
      'local-reading': {
        completed: false,
        progress: 4,
        lastProgressUpdate: '2026-08-20T00:00:00.000Z'
      },
      'mixed-local': {
        completed: true,
        progress: 10,
        lastProgressUpdate: '2026-08-03T00:00:00.000Z'
      },
      // The cloud half of the mixed series: marked finished elsewhere, no pages here.
      'mixed-cloud': { completed: true, progress: 0 },
      'cloud-done-1': {
        completed: true,
        progress: 10,
        lastProgressUpdate: '2026-08-01T00:00:00.000Z'
      },
      'cloud-done-2': {
        completed: true,
        progress: 10,
        lastProgressUpdate: '2026-08-01T00:00:00.000Z'
      },
      // A BARE placeholder: the listing knows nothing but that it exists (page_count 0),
      // and the flag synced from the device that read it is the only evidence there is.
      'bare-cloud': { completed: true, progress: 0 },
      'cloud-reading': {
        completed: false,
        progress: 4,
        lastProgressUpdate: '2026-08-19T00:00:00.000Z'
      }
    });
    catalogStore.set([
      series('Local Done', [volume('Local Done', { volume_uuid: 'local-done' })]),
      series('Local Stale Flag', [volume('Local Stale Flag', { volume_uuid: 'local-stale' })]),
      series('Local Reading', [volume('Local Reading', { volume_uuid: 'local-reading' })]),
      series('Mixed Done', [
        volume('Mixed Done', { volume_uuid: 'mixed-local' }),
        volume('Mixed Done', { volume_uuid: 'mixed-cloud', isPlaceholder: true, page_count: 0 })
      ]),
      series('Cloud Done', [
        volume('Cloud Done', { volume_uuid: 'cloud-done-1', isPlaceholder: true }),
        volume('Cloud Done', { volume_uuid: 'cloud-done-2', isPlaceholder: true })
      ]),
      series('Bare Cloud Done', [
        volume('Bare Cloud Done', { volume_uuid: 'bare-cloud', isPlaceholder: true, page_count: 0 })
      ]),
      series('Cloud Reading', [
        volume('Cloud Reading', { volume_uuid: 'cloud-reading', isPlaceholder: true })
      ])
    ]);
  }

  it('agrees for every shape of series, all local through all placeholder', async () => {
    smartCatalogOfEveryShape();
    const { container } = render(Catalog);
    await tick();

    // Library: the unread series first, then the finished ones most-recently-read first.
    // "Local Stale Flag" is one of the finished ones — it was read to the last page, and
    // the derivation outranks the flag that says otherwise.
    expect(markedTitlesIn(container, 'catalog-library')).toEqual([
      { title: 'Local Reading', green: false },
      { title: 'Local Done', green: true },
      { title: 'Local Stale Flag', green: true },
      { title: 'Mixed Done', green: true }
    ]);

    // Cloud: same rule, no rows anywhere in it. "Bare Cloud Done" has no page turn to date
    // it by, so it lands after the finished series that does.
    expect(markedTitlesIn(container, 'catalog-cloud')).toEqual([
      { title: 'Cloud Reading', green: false },
      { title: 'Cloud Done', green: true },
      { title: 'Bare Cloud Done', green: true }
    ]);
  });

  it('puts every green series after every ungreen one, in both sections', async () => {
    // The invariant behind the two lists above, stated on its own: whatever the rule
    // decides, the sort and the colour decide it together.
    smartCatalogOfEveryShape();
    const { container } = render(Catalog);
    await tick();

    for (const testId of ['catalog-library', 'catalog-cloud']) {
      const rows = markedTitlesIn(container, testId);
      expect(rows.length).toBeGreaterThan(1);
      const firstGreen = rows.findIndex((row) => row.green);
      expect(firstGreen).toBeGreaterThan(-1);
      expect(rows.slice(firstGreen).every((row) => row.green)).toBe(true);
    }
  });
});

describe('Catalog loading stall surface', () => {
  afterEach(() => {
    cleanup();
    catalogStore.set([]);
  });

  it('explains itself once the spinner outlives the stall deadline, and recovers when data lands', async () => {
    vi.useFakeTimers();
    try {
      catalogStore.set(null);
      const { container } = render(Catalog);
      await tick();

      // Fresh spinner: no diagnosis yet.
      expect(container.textContent).toContain('Loading catalog...');
      expect(container.querySelector('[data-testid="catalog-load-stalled"]')).toBeNull();

      // The deadline passes with the catalog still null (live repro: Chrome's
      // storage service wedged under quota pressure, holding the first read
      // queued indefinitely) — the loader must now say what is wrong.
      vi.advanceTimersByTime(CATALOG_LOAD_STALL_MS);
      await tick();
      const stalled = container.querySelector('[data-testid="catalog-load-stalled"]');
      expect(stalled).not.toBeNull();
      expect(stalled?.textContent).toContain('restarting the browser');
      // No quota stub in this test: the pressure line must not render on
      // guesswork when the estimate is unavailable.
      expect(container.querySelector('[data-testid="catalog-quota-pressure"]')).toBeNull();

      // The queued read finally lands (the lock freed): the message must not
      // outlive the condition it describes.
      catalogStore.set([]);
      await tick();
      expect(container.querySelector('[data-testid="catalog-load-stalled"]')).toBeNull();
      expect(container.textContent).toContain('currently empty');

      // A LATER return to the loading state starts a fresh stall clock: the
      // old verdict must not flash back instantly (this is what pins the
      // flag RESET, which the template branch above cannot distinguish).
      catalogStore.set(null);
      await tick();
      expect(container.textContent).toContain('Loading catalog...');
      expect(container.querySelector('[data-testid="catalog-load-stalled"]')).toBeNull();

      // The flag reset alone proves nothing if the clock was never re-armed:
      // advance the FULL deadline again and confirm the message actually
      // comes back. An implementation that resets `loadStalled` but forgets
      // to schedule a fresh timer would pass every assertion above while
      // leaving the spinner stuck unexplained forever.
      vi.advanceTimersByTime(CATALOG_LOAD_STALL_MS);
      await tick();
      expect(container.querySelector('[data-testid="catalog-load-stalled"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('names storage-quota pressure when the estimate shows the origin nearly full', async () => {
    // The condition the stall was actually diagnosed under (110 of 120 GB).
    Object.defineProperty(navigator, 'storage', {
      value: { estimate: async () => ({ usage: 110e9, quota: 120e9 }) },
      configurable: true
    });
    vi.useFakeTimers();
    try {
      catalogStore.set(null);
      const { container } = render(Catalog);
      await tick();
      await vi.advanceTimersByTimeAsync(CATALOG_LOAD_STALL_MS);
      await tick();
      const pressure = container.querySelector('[data-testid="catalog-quota-pressure"]');
      expect(pressure).not.toBeNull();
      expect(pressure?.textContent).toContain('110 of 120 GB');
    } finally {
      vi.useRealTimers();
      delete (navigator as { storage?: unknown }).storage;
    }
  });

  it('stays quiet about quota when usage is comfortably below it', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { estimate: async () => ({ usage: 50e9, quota: 120e9 }) },
      configurable: true
    });
    vi.useFakeTimers();
    try {
      catalogStore.set(null);
      const { container } = render(Catalog);
      await tick();
      await vi.advanceTimersByTimeAsync(CATALOG_LOAD_STALL_MS);
      await tick();
      // Positive control: the stall itself fired...
      expect(container.querySelector('[data-testid="catalog-load-stalled"]')).not.toBeNull();
      // ...but no pressure line for a healthy quota.
      expect(container.querySelector('[data-testid="catalog-quota-pressure"]')).toBeNull();
    } finally {
      vi.useRealTimers();
      delete (navigator as { storage?: unknown }).storage;
    }
  });

  it('re-measures quota on a later stall instead of replaying the previous reading', async () => {
    // First stall: genuine pressure. Then recovery, quota freed, and a SECOND
    // stall — the old "110 of 120 GB" line must not survive into it. The line
    // must describe the stall it belongs to, not the previous incident.
    let estimate = { usage: 110e9, quota: 120e9 };
    Object.defineProperty(navigator, 'storage', {
      value: { estimate: async () => estimate },
      configurable: true
    });
    vi.useFakeTimers();
    try {
      catalogStore.set(null);
      const { container } = render(Catalog);
      await tick();
      await vi.advanceTimersByTimeAsync(CATALOG_LOAD_STALL_MS);
      await tick();
      expect(
        container.querySelector('[data-testid="catalog-quota-pressure"]')?.textContent
      ).toContain('110 of 120 GB');

      // Recovery, and the user frees space.
      catalogStore.set([]);
      await tick();
      estimate = { usage: 50e9, quota: 120e9 };

      // A later, unrelated stall in the same tab.
      catalogStore.set(null);
      await tick();
      await vi.advanceTimersByTimeAsync(CATALOG_LOAD_STALL_MS);
      await tick();
      // Positive control: the stall message itself is back...
      expect(container.querySelector('[data-testid="catalog-load-stalled"]')).not.toBeNull();
      // ...but the stale pressure line is not, and no new one renders for a
      // healthy quota.
      expect(container.querySelector('[data-testid="catalog-quota-pressure"]')).toBeNull();
    } finally {
      vi.useRealTimers();
      delete (navigator as { storage?: unknown }).storage;
    }
  });

  it('never shows the stall message when the catalog arrives before the deadline', async () => {
    vi.useFakeTimers();
    try {
      catalogStore.set(null);
      const { container } = render(Catalog);
      await tick();
      catalogStore.set([]);
      await tick();

      // Positive control that the wait is real: the full deadline (twice
      // over) elapses after data arrived, and nothing stalls.
      vi.advanceTimersByTime(CATALOG_LOAD_STALL_MS * 2);
      await tick();
      expect(container.querySelector('[data-testid="catalog-load-stalled"]')).toBeNull();
      expect(container.textContent).toContain('currently empty');

      // Return to the loading state — with the fake clock already TWO
      // deadlines ahead of where this loading period starts. The absence
      // check above is vacuous on its own: the loader isn't even rendered
      // while `$catalog` is `[]`, so it would hold even if a leaked timer
      // had left `loadStalled` permanently true. Re-entering `null` makes
      // the loader render again, so a leaked/instant stall would show up
      // immediately here.
      catalogStore.set(null);
      await tick();
      expect(container.textContent).toContain('Loading catalog...');
      expect(container.querySelector('[data-testid="catalog-load-stalled"]')).toBeNull();

      // Only a genuine fresh wait of the full deadline explains the spinner —
      // proving the clock actually restarted rather than the message being
      // permanently suppressed.
      vi.advanceTimersByTime(CATALOG_LOAD_STALL_MS);
      await tick();
      expect(container.querySelector('[data-testid="catalog-load-stalled"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
