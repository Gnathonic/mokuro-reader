import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';

// VolumeItem sits on top of the whole app (Dexie, the sync stack, the download queue,
// the reading-speed model). None of that decides whether the "not on this device" badge
// is drawn, so it is all stubbed here — the component under test is the template.
const { routeParams, catalogVolumes } = vi.hoisted(() => {
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
    routeParams: createStore<Record<string, string | undefined>>({ manga: 'One Piece' }),
    catalogVolumes: createStore<Record<string, unknown>>({})
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

vi.mock('$lib/settings', () => ({
  deleteVolume: vi.fn(),
  progress: emptyStore<Record<string, number>>({}),
  volumes: emptyStore<Record<string, unknown>>({}),
  settings: emptyStore({ inactivityTimeoutMinutes: 5 }),
  markVolumeAsComplete: vi.fn(),
  markVolumeAsUnread: vi.fn()
}));
vi.mock('$lib/settings/reading-speed', () => ({
  personalizedReadingSpeed: emptyStore({ isPersonalized: false, charsPerMinute: 0 })
}));
vi.mock('$lib/catalog', () => ({ volumes: catalogVolumes }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined) },
    volume_ocr: { get: vi.fn(async () => undefined) }
  }
}));
vi.mock('dexie', () => ({
  liveQuery: () => ({ subscribe: () => ({ unsubscribe: () => {} }) })
}));
vi.mock('$lib/import', () => ({
  removeVolumeFiles: vi.fn(),
  deleteVolumeCompletely: vi.fn()
}));
vi.mock('$lib/util', () => ({ promptConfirmation: vi.fn(), showSnackbar: vi.fn() }));
vi.mock('$lib/util/modals', () => ({ promptExtraction: vi.fn(), promptVolumeEditor: vi.fn() }));
vi.mock('$lib/util/zip', () => ({ zipManga: vi.fn() }));
vi.mock('$lib/util/hash-router', () => ({
  nav: { toReader: vi.fn(), toSeries: vi.fn(), toCatalog: vi.fn(), toVolumeText: vi.fn() },
  routeParams
}));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    cloudFiles: emptyStore(new Map()),
    isFetching: emptyStore(false),
    getDefaultProvider: () => null,
    deleteManagedVolume: vi.fn(),
    deleteFile: vi.fn()
  }
}));
vi.mock('$lib/util/sync', () => ({
  providerManager: {
    status: emptyStore({ hasAnyAuthenticated: false, currentProviderType: null, providers: {} })
  }
}));
vi.mock('$lib/util/backup-queue', () => ({ backupQueue: { queueVolumeForBackup: vi.fn() } }));
vi.mock('$lib/util/download-queue', () => ({
  downloadQueue: {
    subscribe: (fn: (v: unknown[]) => void) => (fn([]), () => {}),
    queueVolume: vi.fn()
  }
}));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: {
    subscribe: (fn: (v: { processes: unknown[] }) => void) => (fn({ processes: [] }), () => {})
  }
}));
vi.mock('../BackupButton.svelte', () => ({ default: () => ({}) }));

import VolumeItem from '../VolumeItem.svelte';
import { promptConfirmation, showSnackbar } from '$lib/util';
import type { VolumeMetadata } from '$lib/types';

function volume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: 'Vol 1',
    mokuro_version: '1.0',
    page_count: 10,
    character_count: 100,
    page_char_counts: [100],
    isPlaceholder: false,
    ...overrides
  } as VolumeMetadata;
}

function badges(container: HTMLElement) {
  return container.querySelectorAll('[data-testid="download-badge"]');
}

describe('VolumeItem "needs download" badge', () => {
  afterEach(() => cleanup());

  for (const variant of ['list', 'grid'] as const) {
    describe(`${variant} variant`, () => {
      it('draws no badge for an installed volume', () => {
        const { container } = render(VolumeItem, { props: { volume: volume(), variant } });
        expect(badges(container)).toHaveLength(0);
      });

      it('draws the badge for a metadata-only volume', () => {
        const { container } = render(VolumeItem, {
          props: { volume: volume({ metadata_only: true }), variant }
        });
        expect(badges(container)).toHaveLength(1);
      });

      it('draws the badge for a placeholder volume', () => {
        const { container } = render(VolumeItem, {
          props: { volume: volume({ isPlaceholder: true }), variant }
        });
        expect(badges(container)).toHaveLength(1);
      });

      it('never intercepts pointer events', () => {
        const { container } = render(VolumeItem, {
          props: { volume: volume({ metadata_only: true }), variant }
        });
        const badge = badges(container)[0] as HTMLElement;
        expect(badge.className).toContain('pointer-events-none');
        expect(badge.className).toContain('absolute');
      });
    });
  }
});

describe('VolumeItem hover + Delete', () => {
  afterEach(() => {
    cleanup();
    document.querySelectorAll('dialog').forEach((el) => el.remove());
    vi.mocked(promptConfirmation).mockClear();
    vi.mocked(showSnackbar).mockClear();
  });

  async function hover(variant: 'list' | 'grid' = 'list', props: Partial<VolumeMetadata> = {}) {
    const { container } = render(VolumeItem, { props: { volume: volume(props), variant } });
    const row = container.querySelector('div') as HTMLElement;
    await fireEvent.mouseEnter(row);
    return container;
  }

  it('raises this volume’s own removal dialog', async () => {
    await hover();
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(promptConfirmation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(promptConfirmation).mock.calls[0][0]).toBe(
      'Remove Vol 1 from this device? Stats, progress and cover are kept.'
    );
  });

  it('asks the forget question for a volume whose pages are already gone', async () => {
    await hover('grid', { metadata_only: true });
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(vi.mocked(promptConfirmation).mock.calls[0][0]).toBe(
      'Forget Vol 1? Its stats, progress and cover will be deleted.'
    );
  });

  it('ignores key repeats', async () => {
    await hover();
    await fireEvent.keyDown(window, { key: 'Delete' });
    await fireEvent.keyDown(window, { key: 'Delete', repeat: true });

    expect(promptConfirmation).toHaveBeenCalledTimes(1);
  });

  it('does not fire while a modal is already open', async () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);

    await hover();
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(promptConfirmation).not.toHaveBeenCalled();
  });

  it('does not fire while a text field has focus', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    await hover();
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(promptConfirmation).not.toHaveBeenCalled();
    input.remove();
  });

  it('does not fire when the row is not hovered', async () => {
    render(VolumeItem, { props: { volume: volume(), variant: 'list' } });
    await fireEvent.keyDown(window, { key: 'Delete' });
    expect(promptConfirmation).not.toHaveBeenCalled();
  });

  it('keeps shift+Delete on the cloud copy, never the device copy', async () => {
    await hover();
    await fireEvent.keyDown(window, { key: 'Delete', shiftKey: true });

    expect(promptConfirmation).not.toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledWith('Volume is not backed up to cloud');
  });
});
