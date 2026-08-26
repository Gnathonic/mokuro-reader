import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';

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
    // Nothing connected: a VolumeItem list row asks `activeAccountScope()` before it
    // claims a cover, and with no provider the claim is skipped entirely.
    getActiveProvider: () => null,
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
// VolumeItem renders `PlaceholderThumbnail`, which only REQUESTS a cover now
// (`$lib/catalog/cover-service`) — delivery/fetch mechanics are that
// module's own contract, covered end to end in `cover-service.test.ts`. The
// real module pulls in db/materialize/unified-cloud-manager, a graph this
// file's "stub everything below the template" philosophy deliberately does
// not load, so it is mocked the same way as the other cover-drawing
// surfaces (CatalogItem.test.ts, SeriesSpineShowcase.test.ts).
const { requestCoverMock, isCoverFetchTargetMock } = vi.hoisted(() => ({
  requestCoverMock: vi.fn(),
  isCoverFetchTargetMock: vi.fn(
    (vol: { thumbnail?: unknown; isPlaceholder?: boolean; cloudThumbnailFileId?: string }) => {
      if (vol.thumbnail) return false;
      if (vol.isPlaceholder) return true;
      return !!vol.cloudThumbnailFileId;
    }
  )
}));
vi.mock('$lib/catalog/cover-service', () => ({
  requestCover: (...a: Parameters<typeof requestCoverMock>) => requestCoverMock(...a),
  isCoverFetchTarget: (...a: Parameters<typeof isCoverFetchTargetMock>) =>
    isCoverFetchTargetMock(...a)
}));

import VolumeItem from '../VolumeItem.svelte';
import { promptConfirmation, showSnackbar } from '$lib/util';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
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

      it('leaves the badge out of the accessibility tree — the row already says so', () => {
        const { container } = render(VolumeItem, {
          props: { volume: volume({ metadata_only: true }), variant }
        });
        const badge = badges(container)[0] as HTMLElement;
        expect(badge.getAttribute('aria-hidden')).toBe('true');
        expect(badge.getAttribute('title')).toBeNull();
        expect(container.textContent).toContain('Not on this device');
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

describe('VolumeItem archive size', () => {
  afterEach(() => cleanup());

  function sizeText(container: HTMLElement) {
    return Array.from(container.querySelectorAll('[data-testid="archive-size"]')).map((el) =>
      el.textContent?.trim()
    );
  }

  for (const variant of ['list', 'grid'] as const) {
    describe(`${variant} variant`, () => {
      it('shows how big the download is for a volume that is not on the device', () => {
        const { container } = render(VolumeItem, {
          props: {
            volume: volume({ metadata_only: true, archive_size: 193_000_000 }),
            variant
          }
        });
        expect(sizeText(container)).toEqual(['184 MB']);
      });

      it('prefers the size the connected provider is listing', () => {
        const { container } = render(VolumeItem, {
          props: {
            volume: volume({
              isPlaceholder: true,
              cloudSize: 1_610_612_736,
              archive_size: 193_000_000
            }),
            variant
          }
        });
        expect(sizeText(container)).toEqual(['1.5 GB']);
      });

      it('says nothing when nobody has measured the archive', () => {
        const { container } = render(VolumeItem, {
          props: { volume: volume({ metadata_only: true }), variant }
        });
        expect(sizeText(container)).toEqual([]);
      });

      it('never shows a size for an installed volume — there is nothing to download', () => {
        const { container } = render(VolumeItem, {
          props: { volume: volume({ archive_size: 193_000_000 }), variant }
        });
        expect(sizeText(container)).toEqual([]);
      });
    });
  }
});

describe('VolumeItem drawing a cloud-only placeholder', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(promptConfirmation).mockClear();
    vi.mocked(showSnackbar).mockClear();
    requestCoverMock.mockClear();
  });

  function placeholder(overrides: Partial<VolumeMetadata> = {}) {
    return volume({
      isPlaceholder: true,
      cloudProvider: 'webdav',
      cloudFileId: 'file-1',
      ...overrides
    });
  }

  it('never raises the volume removal dialog — there is no row to remove', async () => {
    const { container } = render(VolumeItem, {
      props: { volume: placeholder(), variant: 'list' }
    });
    await fireEvent.mouseEnter(container.querySelector('div') as HTMLElement);
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(promptConfirmation).not.toHaveBeenCalled();
    // Silence would read as a broken shortcut; say which key does mean the cloud copy.
    expect(showSnackbar).toHaveBeenCalledWith(
      'Nothing on this device to remove — shift+Delete deletes the cloud copy'
    );
  });

  it('deletes the cloud copy even when the listing files it under another folder', async () => {
    // A `Series:` description renames the series for display, so the row's
    // series_title is not the cloud folder and the by-folder listing lookup
    // misses. The volume still carries the file id it was built from.
    vi.mocked(unifiedCloudManager.deleteFile).mockClear();
    const { container } = render(VolumeItem, {
      props: {
        volume: placeholder({
          series_title: 'Renamed By Description',
          cloudPath: 'Cloud Folder/Vol 1.cbz',
          cloudModifiedTime: '2026-08-17T00:00:00.000Z'
        }),
        variant: 'list'
      }
    });

    await fireEvent.click(container.querySelector('[title="Delete from cloud"]') as HTMLElement);

    expect(showSnackbar).not.toHaveBeenCalledWith('Volume is not backed up to cloud');
    expect(promptConfirmation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(promptConfirmation).mock.calls[0][0]).toBe('Delete Vol 1 from cloud?');

    await (vi.mocked(promptConfirmation).mock.calls[0][1] as () => Promise<void>)();
    expect(unifiedCloudManager.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'webdav',
        fileId: 'file-1',
        path: 'Cloud Folder/Vol 1.cbz'
      })
    );
  });

  it('sends its delete button at the cloud copy, the only copy there is', async () => {
    const { container } = render(VolumeItem, {
      props: { volume: placeholder(), variant: 'list' }
    });
    const button = container.querySelector('[title="Delete from cloud"]') as HTMLElement;
    expect(button).toBeTruthy();

    await fireEvent.click(button);
    // The cloud dialog, never the "remove from this device"/"forget" one: there
    // is no row here to remove and no history to forget.
    expect(vi.mocked(promptConfirmation).mock.calls[0][0]).toBe('Delete Vol 1 from cloud?');
  });

  it('still requests the cloud cover for its grid card', () => {
    render(VolumeItem, {
      props: {
        volume: placeholder({ cloudThumbnailFileId: 'thumb-1', cloudThumbnailPath: 'S/V.webp' }),
        variant: 'grid'
      }
    });

    expect(requestCoverMock).toHaveBeenCalledTimes(1);
    expect(requestCoverMock.mock.calls[0][0]).toMatchObject({
      volume_uuid: 'uuid-1',
      cloudThumbnailFileId: 'thumb-1'
    });
  });

  it('leaves the device-copy wording alone for a real row whose pages are gone', async () => {
    const { container } = render(VolumeItem, {
      props: { volume: volume({ metadata_only: true }), variant: 'list' }
    });
    await fireEvent.mouseEnter(container.querySelector('div') as HTMLElement);
    await fireEvent.keyDown(window, { key: 'Delete' });

    expect(vi.mocked(promptConfirmation).mock.calls[0][0]).toBe(
      'Forget Vol 1? Its stats, progress and cover will be deleted.'
    );
  });
});

describe('VolumeItem completion', () => {
  afterEach(() => cleanup());

  it('does not call a one-page volume nobody has opened read', () => {
    // The progress store has no entry: the row displays "page 1", but page 1 of 1 with no
    // record is a volume that has never been opened, not one that was finished.
    const { container } = render(VolumeItem, {
      props: { volume: volume({ page_count: 1 }), variant: 'list' }
    });

    expect(container.querySelector('[title="Mark as read"]')).not.toBeNull();
    expect(container.querySelector('[title="Mark as unread"]')).toBeNull();
  });
});

describe('VolumeItem cover object-URL identity (mirrors CatalogListItem.svelte)', () => {
  const originalCreate = globalThis.URL.createObjectURL;
  const originalRevoke = globalThis.URL.revokeObjectURL;
  let created: string[] = [];
  let revoked: string[] = [];

  beforeEach(() => {
    created = [];
    revoked = [];
    globalThis.URL.createObjectURL = vi.fn(() => {
      const url = `blob:cover-${created.length + 1}`;
      created.push(url);
      return url;
    }) as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
  });

  afterEach(() => {
    cleanup();
    catalogVolumes.set({});
    globalThis.URL.createObjectURL = originalCreate;
    globalThis.URL.revokeObjectURL = originalRevoke;
  });

  it('PIN: a catalog re-derive that hands back an equivalent-but-new File for the SAME cover never churns the object URL', async () => {
    // `liveVolume` is `$catalogVolumes?.[uuid] ?? volume` — a whole-table
    // liveQuery re-derive replaces the WHOLE map with fresh row objects
    // (and IndexedDB gives a fresh File instance per read) even for a row
    // whose own cover never changed. Object identity alone would tear down
    // and recreate the object URL (forcing a real browser re-decode/
    // re-paint) on every unrelated re-derive.
    const lastModified = 1_700_000_000_000;
    const coverA = new File(['same-bytes'], 'cover.jpg', { type: 'image/jpeg', lastModified });
    const v = volume({ thumbnail: coverA });
    const { container } = render(VolumeItem, { props: { volume: v, variant: 'list' } });
    await tick();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1');

    const coverAAgain = new File(['same-bytes'], 'cover.jpg', {
      type: 'image/jpeg',
      lastModified
    });
    catalogVolumes.set({ [v.volume_uuid]: { ...v, thumbnail: coverAAgain } });
    await tick();

    expect(created).toEqual(['blob:cover-1']); // no second createObjectURL call
    expect(revoked).toEqual([]); // the live URL was never revoked
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1');
  });

  it('still swaps the object URL for a GENUINELY new cover on the same uuid', async () => {
    const coverOld = new File(['old'], 'cover.jpg', {
      type: 'image/jpeg',
      lastModified: 1_700_000_000_000
    });
    const v = volume({ thumbnail: coverOld });
    const { container } = render(VolumeItem, { props: { volume: v, variant: 'list' } });
    await tick();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-1');

    const coverNew = new File(['new-bytes-different-size'], 'cover.jpg', {
      type: 'image/jpeg',
      lastModified: 1_700_000_005_000
    });
    catalogVolumes.set({ [v.volume_uuid]: { ...v, thumbnail: coverNew } });
    await tick();

    expect(created).toEqual(['blob:cover-1', 'blob:cover-2']);
    expect(revoked).toEqual(['blob:cover-1']);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:cover-2');
  });
});
