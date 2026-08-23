import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// SeriesView sits on top of the whole app; everything below the placement decision is
// stubbed. What is under test is where a volume whose pages are gone gets DRAWN.
const { currentSeries, notOnDeviceDisplay, routeParams } = vi.hoisted(() => {
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
    currentSeries: createStore<unknown[]>([]),
    notOnDeviceDisplay: createStore<'mixed' | 'cloud-section'>('mixed'),
    routeParams: createStore<Record<string, string | undefined>>({ manga: 'One Piece' })
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
  catalog: emptyStore<unknown[]>([]),
  currentSeries,
  volumes: emptyStore<Record<string, unknown>>({})
}));
vi.mock('$lib/settings/settings', () => ({
  notOnDeviceDisplay,
  preferredTitleLanguage: emptyStore('imported')
}));
vi.mock('$lib/settings', () => ({
  deleteVolume: vi.fn(),
  volumes: emptyStore<Record<string, unknown>>({ 'uuid-1': { progress: 1 } }),
  progress: emptyStore<Record<string, number>>({}),
  settings: emptyStore({ inactivityTimeoutMinutes: 5 }),
  markVolumeAsComplete: vi.fn(),
  markVolumeAsUnread: vi.fn()
}));
vi.mock('$lib/settings/reading-speed', () => ({
  personalizedReadingSpeed: emptyStore({ isPersonalized: false, charsPerMinute: 0 })
}));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined) },
    volume_ocr: { get: vi.fn(async () => undefined) }
  }
}));
vi.mock('dexie', () => ({ liveQuery: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }) }));
vi.mock('$lib/import', () => ({ removeVolumeFiles: vi.fn(), deleteVolumeCompletely: vi.fn() }));
vi.mock('$lib/util', () => ({
  promptConfirmation: vi.fn(),
  showSnackbar: vi.fn(),
  zipManga: vi.fn()
}));
vi.mock('$lib/util/zip', () => ({ zipManga: vi.fn() }));
vi.mock('$lib/util/modals', () => ({
  promptExtraction: vi.fn(),
  promptSeriesEditor: vi.fn(),
  promptVolumeEditor: vi.fn()
}));
vi.mock('$lib/util/hash-router', () => ({
  nav: {
    toReader: vi.fn(),
    toSeries: vi.fn(),
    toCatalog: vi.fn(),
    toVolumeText: vi.fn(),
    toSeriesText: vi.fn()
  },
  routeParams,
  navigateBack: vi.fn()
}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    cloudFiles: emptyStore(new Map()),
    isFetching: emptyStore(false),
    getDefaultProvider: () => null,
    getActiveProvider: () => ({ name: 'Drive' }),
    getAllCloudVolumes: () => [],
    getCloudVolumesBySeries: () => [],
    existsInCloud: () => false,
    deleteManagedVolume: vi.fn(),
    deleteFile: vi.fn()
  }
}));
vi.mock('$lib/util/sync', () => ({
  providerManager: {
    status: emptyStore({
      hasAnyAuthenticated: false,
      currentProviderType: null,
      providers: {},
      needsAttention: false
    })
  }
}));
vi.mock('$lib/util/backup-queue', () => ({
  backupQueue: { queueVolumeForBackup: vi.fn(), queueSeriesVolumesForBackup: vi.fn() }
}));
vi.mock('$lib/util/download-queue', () => ({
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => (fn([]), () => {}),
    queueVolume: vi.fn()
  },
  queueSeriesVolumes: vi.fn()
}));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: {
    subscribe: (fn: (v: { processes: unknown[] }) => void) => (fn({ processes: [] }), () => {})
  }
}));
vi.mock('$lib/metadata/store', () => ({ seriesMetadataMap: emptyStore(new Map()) }));
vi.mock('$lib/metadata/series-file-sync', () => ({ reconcileMissingMetadataFiles: vi.fn() }));
vi.mock('$lib/metadata/series-open', () => ({ openSeries: vi.fn(async () => {}) }));
vi.mock('$lib/catalog/series-delete', () => ({
  promptSeriesRemoval: vi.fn(),
  deleteSeriesFromCloudByTitle: vi.fn()
}));
vi.mock('$lib/components/Series/SeriesMetadataBar.svelte', () => ({ default: () => ({}) }));
vi.mock('$lib/components/BackupButton.svelte', () => ({ default: () => ({}) }));

import SeriesView from '../SeriesView.svelte';
import type { VolumeMetadata } from '$lib/types';

function volume(title: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: `uuid-${title.replace(/\s+/g, '-')}`,
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: title,
    mokuro_version: '1.0',
    page_count: 10,
    character_count: 100,
    page_char_counts: [100],
    isPlaceholder: false,
    ...overrides
  } as VolumeMetadata;
}

/**
 * Volume titles and section headings in document order — enough to say which side of the
 * "Available in …" heading a row was drawn on.
 */
function pageOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll('h4, p.font-semibold')].map(
    (el) => el.textContent?.trim() ?? ''
  );
}

describe('SeriesView places not-on-device volumes by the display setting', () => {
  beforeEach(() => {
    // The list layout is the one whose rows carry a plain title element to read order from.
    localStorage.setItem('series-view-mode', 'list');
  });

  afterEach(() => {
    cleanup();
    notOnDeviceDisplay.set('mixed');
  });

  it('lists a removed volume in place, with no section of its own, in mixed mode', () => {
    currentSeries.set([volume('Vol 1'), volume('Vol 2', { metadata_only: true })]);
    const { container } = render(SeriesView);

    expect(pageOrder(container)).toEqual(['Vol 1', 'Vol 2']);
  });

  it('moves it under "Available in …" the moment the setting flips', async () => {
    currentSeries.set([volume('Vol 1'), volume('Vol 2', { metadata_only: true })]);
    const { container } = render(SeriesView);

    notOnDeviceDisplay.set('cloud-section');
    await tick();
    expect(pageOrder(container)).toEqual(['Vol 1', 'Available in Drive (1)', 'Vol 2']);

    notOnDeviceDisplay.set('mixed');
    await tick();
    expect(pageOrder(container)).toEqual(['Vol 1', 'Vol 2']);
  });

  it('keeps the moved row a real volume row — badge, download and delete included', async () => {
    currentSeries.set([volume('Vol 1'), volume('Vol 2', { metadata_only: true })]);
    const { container } = render(SeriesView);

    notOnDeviceDisplay.set('cloud-section');
    await tick();

    // The badge is the "not on this device" mark VolumeItem draws; a PlaceholderVolumeItem
    // stand-in would carry no progress line for the row's real history.
    expect(container.querySelectorAll('[data-testid="download-badge"]')).toHaveLength(1);
    expect(container.textContent).toContain('Not on this device');
  });

  it('never hides a removed volume that has nowhere to download from', async () => {
    currentSeries.set([volume('Vol 1', { metadata_only: true })]);
    const { container } = render(SeriesView);

    notOnDeviceDisplay.set('cloud-section');
    await tick();
    expect(pageOrder(container)).toEqual(['Available in Drive (1)', 'Vol 1']);
  });
});
