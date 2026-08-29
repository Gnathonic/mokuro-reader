import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

// SeriesView sits on top of the whole app; everything below the placement decision is
// stubbed. What is under test is where a volume whose pages are gone gets DRAWN.
const { currentSeries, routeParams, providerStatus, queueSeriesVolumes, readingProgress } =
  vi.hoisted(() => {
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
      readingProgress: createStore<Record<string, number>>({}),
      providerStatus: createStore({
        hasAnyAuthenticated: false,
        currentProviderType: null as string | null,
        providers: {} as Record<string, unknown>,
        needsAttention: false
      }),
      currentSeries: createStore<unknown[]>([]),
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
  preferredTitleLanguage: emptyStore('imported'),
  // `cover-persist.ts` now imports `volumes` directly from
  // `$lib/settings/volume-data` (bypassing the `$lib/settings` barrel mock
  // below), and that module's own top-level `totalStats` derived store reads
  // `settings` from THIS module — so the binding must exist here too, even
  // though nothing in this suite exercises it.
  settings: emptyStore({ inactivityTimeoutMinutes: 5 })
}));
vi.mock('$lib/settings', () => ({
  deleteVolume: vi.fn(),
  volumes: emptyStore<Record<string, unknown>>({ 'uuid-1': { progress: 1 } }),
  progress: readingProgress,
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
    // `getStatus` because a VolumeItem list row now claims its own cloud cover, and
    // `activeAccountScope()` asks the active provider for its scope.
    getActiveProvider: () => ({ name: 'Drive', getStatus: () => ({ accountScope: null }) }),
    getAllCloudVolumes: () => [],
    getCloudVolumesBySeries: () => [],
    existsInCloud: () => false,
    deleteManagedVolume: vi.fn(),
    deleteFile: vi.fn()
  }
}));
vi.mock('$lib/util/sync', () => ({ providerManager: { status: providerStatus } }));
vi.mock('$lib/util/backup-queue', () => ({
  backupQueue: { queueVolumeForBackup: vi.fn(), queueSeriesVolumesForBackup: vi.fn() }
}));
vi.mock('$lib/util/download-queue', () => ({
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => (fn([]), () => {}),
    queueVolume: vi.fn()
  },
  queueSeriesVolumes
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
    providerStatus.set({
      hasAnyAuthenticated: false,
      currentProviderType: null,
      providers: {},
      needsAttention: false
    });
  });

  it('draws a removed volume under "Available in …"', () => {
    currentSeries.set([volume('Vol 1'), volume('Vol 2', { metadata_only: true })]);
    const { container } = render(SeriesView);

    expect(pageOrder(container)).toEqual(['Vol 1', 'Available in Drive (1)', 'Vol 2']);
  });

  it('keeps the moved row a real volume row — badge, download and delete included', async () => {
    currentSeries.set([volume('Vol 1'), volume('Vol 2', { metadata_only: true })]);
    const { container } = render(SeriesView);
    await tick();

    // The badge is the "not on this device" mark VolumeItem draws; a PlaceholderVolumeItem
    // stand-in would carry no progress line for the row's real history.
    expect(container.querySelectorAll('[data-testid="download-badge"]')).toHaveLength(1);
    expect(container.textContent).toContain('Not on this device');
  });

  it('never hides a removed volume that has nowhere to download from', async () => {
    currentSeries.set([volume('Vol 1', { metadata_only: true })]);
    const { container } = render(SeriesView);
    await tick();
    expect(pageOrder(container)).toEqual(['Available in Drive (1)', 'Vol 1']);
  });
});

describe('SeriesView draws a placeholder as richly as its data allows', () => {
  beforeEach(() => {
    localStorage.setItem('series-view-mode', 'list');
  });
  afterEach(() => cleanup());

  /** A cloud-only volume with no `series.json` behind it: derived uuid, zero counts. */
  function bareShare(title: string): VolumeMetadata {
    return volume(title, {
      isPlaceholder: true,
      mokuro_version: 'unknown',
      page_count: 0,
      character_count: 0,
      page_char_counts: [],
      cloudProvider: 'webdav',
      cloudFileId: `file-${title}`,
      cloudSize: 193_000_000
    });
  }

  /** The same file once its series' index has been read: real uuid, real counts. */
  function indexed(title: string): VolumeMetadata {
    return {
      ...bareShare(title),
      mokuro_version: '0.4.11',
      page_count: 180,
      character_count: 5000
    };
  }

  it('gives an indexed placeholder the full volume row, size included', () => {
    currentSeries.set([indexed('Vol 1')]);
    const { container } = render(SeriesView);

    expect(container.textContent).toContain('Not on this device');
    expect(container.textContent).toContain('184 MB');
    // The minimal card's wording — proof the thin fallback did not draw this row.
    expect(container.textContent).not.toContain('In Cloud •');
    expect(container.querySelectorAll('[data-testid="download-badge"]')).toHaveLength(1);
  });

  it('keeps the minimal card for a bare share, which has nothing to fill a row with', () => {
    currentSeries.set([bareShare('Vol 1')]);
    const { container } = render(SeriesView);

    expect(container.textContent).toContain('In Cloud •');
    expect(container.querySelectorAll('[data-testid="download-badge"]')).toHaveLength(1);
  });

  it('mixes both kinds under the cloud section of a series that is partly here', () => {
    currentSeries.set([volume('Vol 1'), indexed('Vol 2'), bareShare('Vol 3')]);
    const { container } = render(SeriesView);

    expect(pageOrder(container)).toEqual(['Vol 1', 'Available in Drive (2)', 'Vol 2', 'Vol 3']);
    expect(container.textContent).toContain('184 MB');
    expect(container.textContent).toContain('In Cloud •');
  });
});

describe('SeriesView only offers a cloud section there is something to offer in', () => {
  beforeEach(() => {
    localStorage.setItem('series-view-mode', 'grid');
  });

  afterEach(() => {
    cleanup();
    providerStatus.set({
      hasAnyAuthenticated: false,
      currentProviderType: null,
      providers: {},
      needsAttention: false
    });
  });

  function heading(container: HTMLElement): string | null {
    return container.querySelector('h4')?.textContent?.trim() ?? null;
  }

  /** A removed row still carrying the cloud id of its last known backup. */
  const removedWithCachedId = () =>
    volume('Vol 1', {
      metadata_only: true,
      cloudFileId: 'file-1',
      cloudProvider: 'google-drive'
    });

  it('draws it again once a provider is connected', async () => {
    currentSeries.set([volume('Vol 0'), removedWithCachedId()]);
    const { container } = render(SeriesView);

    providerStatus.set({
      hasAnyAuthenticated: true,
      currentProviderType: 'google-drive',
      providers: {},
      needsAttention: false
    });
    await tick();

    expect(heading(container)).toBe('Available in Drive (1)');
  });

  it('still shows the section for a moved row with no provider — it is the only place it is drawn', async () => {
    currentSeries.set([volume('Vol 0'), removedWithCachedId()]);
    const { container } = render(SeriesView);
    await tick();

    expect(heading(container)).toBe('Available in Drive (1)');
  });
});

describe('SeriesView downloads every volume of the series that is not here', () => {
  beforeEach(() => {
    localStorage.setItem('series-view-mode', 'list');
    queueSeriesVolumes.mockClear();
    providerStatus.set({
      hasAnyAuthenticated: true,
      currentProviderType: 'google-drive',
      providers: {},
      needsAttention: false
    });
  });

  afterEach(() => {
    cleanup();
    providerStatus.set({
      hasAnyAuthenticated: false,
      currentProviderType: null,
      providers: {},
      needsAttention: false
    });
  });

  function downloadAll(container: HTMLElement): HTMLElement {
    const button = [...container.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('Download all')
    );
    if (!button) throw new Error('Download all button not found');
    return button as HTMLElement;
  }

  /** A row whose files were removed, still matched to its cloud archive. */
  const removed = (title: string) =>
    volume(title, {
      metadata_only: true,
      cloudFileId: `file-${title}`,
      cloudProvider: 'google-drive'
    });

  it('queues the metadata-only rows, not just the cloud-only placeholders', async () => {
    currentSeries.set([
      volume('Vol 1'),
      removed('Vol 2'),
      volume('Vol 3', { isPlaceholder: true, cloudFileId: 'file-3', cloudProvider: 'google-drive' })
    ]);

    const { container } = render(SeriesView);
    await fireEvent.click(downloadAll(container));
    // The handler imports the queue module lazily; wait for that to land.
    await vi.waitFor(() => expect(queueSeriesVolumes).toHaveBeenCalledTimes(1));

    expect(queueSeriesVolumes.mock.calls[0][0].map((v: VolumeMetadata) => v.volume_title)).toEqual([
      'Vol 2',
      'Vol 3'
    ]);
  });

  it('still queues them once the display setting has moved them into the section', async () => {
    currentSeries.set([volume('Vol 1'), removed('Vol 2')]);

    const { container } = render(SeriesView);
    await tick();
    await fireEvent.click(downloadAll(container));
    await vi.waitFor(() => expect(queueSeriesVolumes).toHaveBeenCalledTimes(1));

    expect(queueSeriesVolumes.mock.calls[0][0].map((v: VolumeMetadata) => v.volume_title)).toEqual([
      'Vol 2'
    ]);
  });
});

describe('SeriesView keeps a partly-downloaded series whole', () => {
  beforeEach(() => {
    localStorage.setItem('series-view-mode', 'list');
  });

  afterEach(() => {
    cleanup();
  });

  const mixedSeries = () => [
    volume('Vol 1'),
    volume('Vol 2', { metadata_only: true }),
    volume('Vol 3', { isPlaceholder: true, cloudFileId: 'file-3', cloudProvider: 'google-drive' })
  ];

  it('lists every volume, absent ones under the section', () => {
    currentSeries.set(mixedSeries());
    const { container } = render(SeriesView);

    expect(pageOrder(container)).toEqual(['Vol 1', 'Available in Drive (2)', 'Vol 2', 'Vol 3']);
  });
});

describe('SeriesView orders a cloud-only series by volume, not by page count', () => {
  beforeEach(() => {
    localStorage.setItem('series-view-mode', 'list');
    localStorage.setItem('series-sort-mode', 'unread-first');
  });

  afterEach(() => {
    cleanup();
  });

  /** A bare share: nothing is known about it until it is downloaded. */
  const bare = (title: string) =>
    volume(title, { isPlaceholder: true, page_count: 0, character_count: 0 });
  /** A placeholder that adopted a series.json entry: real counts. */
  const indexed = (title: string) =>
    volume(title, { isPlaceholder: true, indexed: true, page_count: 180 });

  it('keeps bare shares in volume order beside indexed ones', () => {
    currentSeries.set([indexed('Vol 2'), bare('Vol 3'), bare('Vol 1')]);
    const { container } = render(SeriesView);

    // A volume with no page count is not a volume you finished — reading "0 pages, at
    // page 0" as complete used to sort every bare share to the end of the series.
    expect(pageOrder(container)).toEqual(['Vol 1', 'Vol 2', 'Vol 3']);
  });

  it('still sorts unread before finished for volumes that have progress', () => {
    currentSeries.set([volume('Vol 1', { page_count: 10 }), volume('Vol 2', { page_count: 10 })]);
    readingProgress.set({ 'uuid-Vol-1': 10 });
    const { container } = render(SeriesView);

    expect(pageOrder(container)).toEqual(['Vol 2', 'Vol 1']);
    readingProgress.set({});
  });
});
