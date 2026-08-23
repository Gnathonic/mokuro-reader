import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

const { catalogStore, notOnDeviceDisplay, miscSettings } = vi.hoisted(() => {
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
    catalogStore: createStore<unknown[] | null>([]),
    notOnDeviceDisplay: createStore<'mixed' | 'cloud-section'>('mixed'),
    miscSettings: createStore({ galleryLayout: 'list', gallerySorting: 'ASC' })
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
vi.mock('$lib/settings/settings', () => ({ notOnDeviceDisplay }));
vi.mock('$lib/settings', () => ({
  miscSettings,
  updateMiscSetting: vi.fn(),
  volumes: emptyStore<Record<string, unknown>>({}),
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
  queueSeriesVolumes: vi.fn(),
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

describe('Catalog groups not-on-device series by the display setting', () => {
  afterEach(() => {
    cleanup();
    notOnDeviceDisplay.set('mixed');
  });

  it('mixes absent series into the library by default', () => {
    catalogStore.set([
      series('Here', [volume('Here')]),
      series('Gone', [volume('Gone', { metadata_only: true })]),
      series('Cloud', [volume('Cloud', { isPlaceholder: true })])
    ]);

    const { container } = render(Catalog);
    expect(titlesIn(container, 'catalog-library')).toEqual(['Gone', 'Here']);
    expect(titlesIn(container, 'catalog-cloud')).toEqual(['Cloud']);
  });

  it('regroups instantly when the setting flips — no reload, no data change', async () => {
    catalogStore.set([
      series('Here', [volume('Here')]),
      series('Gone', [volume('Gone', { metadata_only: true })]),
      series('Cloud', [volume('Cloud', { isPlaceholder: true })])
    ]);

    const { container } = render(Catalog);
    notOnDeviceDisplay.set('cloud-section');
    await tick();

    expect(titlesIn(container, 'catalog-library')).toEqual(['Here']);
    expect(titlesIn(container, 'catalog-cloud')).toEqual(['Cloud', 'Gone']);

    notOnDeviceDisplay.set('mixed');
    await tick();
    expect(titlesIn(container, 'catalog-library')).toEqual(['Gone', 'Here']);
  });

  it('keeps a partly-installed series in the library in either mode', async () => {
    catalogStore.set([
      series('Half', [
        volume('Half'),
        volume('Half', { volume_uuid: 'half-2', metadata_only: true })
      ])
    ]);

    const { container } = render(Catalog);
    expect(titlesIn(container, 'catalog-library')).toEqual(['Half']);

    notOnDeviceDisplay.set('cloud-section');
    await tick();
    expect(titlesIn(container, 'catalog-library')).toEqual(['Half']);
    expect(titlesIn(container, 'catalog-cloud')).toEqual([]);
  });
});
