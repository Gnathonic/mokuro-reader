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

import Catalog from '../Catalog.svelte';
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
