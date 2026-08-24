import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesReadingState } from '$lib/settings/series-data';
import type { SeriesMetadata } from './types';

// vi.hoisted: `vi.mock` factories are hoisted above every other top-level
// statement (including this file's own imports), so any state a factory
// dereferences while it runs must be created here — see
// SeriesMetadataBar.test.ts / webdav-provider.test.ts for the same pattern.
const h = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => {
          subs.delete(fn);
        };
      },
      set(v: T) {
        value = v;
        subs.forEach((fn) => fn(value));
      }
    };
  }

  class FakeAniListError extends Error {
    code: string;
    retryAfterMs?: number;
    constructor(code: string, retryAfterMs?: number) {
      super(code);
      this.name = 'AniListError';
      this.code = code;
      this.retryAfterMs = retryAfterMs;
    }
  }

  return {
    createStore,
    FakeAniListError,
    volumesStore: createStore<Record<string, { completed?: boolean }>>({}),
    settingsStore: createStore<any>({ catalogSettings: { pushProgressToAniList: true } }),
    userStore: createStore<{ id: number; name: string } | null>({ id: 1, name: 'n' }),
    connectedStore: createStore<boolean>(true),
    dbVolumes: [] as VolumeMetadata[],
    metaByKey: new Map<string, SeriesMetadata>(),
    completionListeners: [] as ((uuid: string) => void)[],
    /** The cached `series.json` index, keyed by series — cloud-only volumes. */
    seriesIndex: new Map<
      string,
      { file: { volumes: { volume_uuid: string; volume_title: string }[] } }
    >(),
    unregisterCompletion: vi.fn(),
    auth: { token: 'tok' as string | null }
  };
});

vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('$lib/settings/volume-data', () => ({
  volumes: h.volumesStore,
  registerCompletionListener: vi.fn((fn: (uuid: string) => void) => {
    h.completionListeners.push(fn);
    return h.unregisterCompletion;
  })
}));

vi.mock('$lib/settings/settings', () => ({ settings: h.settingsStore }));

vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      toArray: vi.fn(async () => h.dbVolumes),
      get: vi.fn(async (uuid: string) => h.dbVolumes.find((v) => v.volume_uuid === uuid))
    }
  }
}));

vi.mock('./store', () => ({
  getSeriesMetadata: vi.fn(async (key: string) => h.metaByKey.get(key)),
  getAllSeriesMetadata: vi.fn(async () => Object.fromEntries(h.metaByKey)),
  updateSeriesMetadata: vi.fn(
    async (
      title: string,
      patch: Partial<SeriesMetadata> | ((existing: SeriesMetadata) => Partial<SeriesMetadata>)
    ) => {
      const key = title.trim().replace(/\s+/g, ' ').toLowerCase();
      // Mirrors the real store: a functional patch sees the stored record.
      const existing = h.metaByKey.get(key)!;
      const next = { ...existing, ...(typeof patch === 'function' ? patch(existing) : patch) };
      h.metaByKey.set(key, next);
      return next;
    }
  )
}));

vi.mock('./series-index', () => ({
  getSeriesIndex: vi.fn(async (key: string) => h.seriesIndex.get(key))
}));

vi.mock('./providers/anilist', () => ({
  anilistRequest: vi.fn(),
  AniListError: h.FakeAniListError
}));

vi.mock('./anilist-auth', () => ({
  getAniListToken: () => h.auth.token,
  anilistUser: h.userStore,
  anilistConnected: h.connectedStore,
  handleAniListUnauthorized: vi.fn()
}));

import { registerCompletionListener } from '$lib/settings/volume-data';
// The reading state is the real store: a plain synchronous store over
// localStorage, so seeding it and reading it back needs no double.
import {
  clearSeriesReadingState,
  getSeriesReadingState,
  updateSeriesReadingState
} from '$lib/settings/series-data';
import { db } from '$lib/catalog/db';
import { handleAniListUnauthorized } from './anilist-auth';
import { getSeriesIndex } from './series-index';
import { anilistRequest } from './providers/anilist';
import {
  _resetTrackerStateForTests,
  computeLocalPassState,
  flushPendingPushes,
  initProgressTracker,
  onReadCountChanged,
  onSeriesRestarted,
  onVolumeCompleted,
  readPendingPushes,
  syncAllSeriesNow,
  syncSeriesNow,
  volumeNumberFor
} from './progress-tracker';

const FakeAniListError = h.FakeAniListError;

const vol = (uuid: string, title: string): VolumeMetadata =>
  ({
    volume_uuid: uuid,
    volume_title: title,
    series_title: 'One Piece',
    series_uuid: 's',
    mokuro_version: '',
    page_count: 10,
    character_count: 100,
    page_char_counts: []
  }) as VolumeMetadata;

const meta = (over: Partial<SeriesMetadata> = {}): SeriesMetadata => ({
  series_key: 'one piece',
  series_title: 'One Piece',
  external_ids: { anilist: 30013 },
  titles: {},
  synonyms: [],
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over
});

/** The reading state of the series under test, as the tracker stored it. */
const trackedState = () => getSeriesReadingState('one piece');

/** Reset every piece of shared state between test cases. */
function resetWorld() {
  localStorage.clear();
  clearSeriesReadingState();
  _resetTrackerStateForTests();
  h.dbVolumes.splice(0, h.dbVolumes.length, vol('a', 'Vol 01'), vol('b', 'Vol 02'));
  h.volumesStore.set({ a: { completed: true }, b: { completed: true } });
  h.metaByKey.clear();
  h.metaByKey.set('one piece', meta());
  h.seriesIndex.clear();
  vi.mocked(getSeriesIndex).mockClear();
  h.settingsStore.set({ catalogSettings: { pushProgressToAniList: true } });
  h.completionListeners.length = 0;
  h.auth.token = 'tok';
  h.connectedStore.set(true);
  vi.mocked(anilistRequest).mockReset();
  vi.mocked(handleAniListUnauthorized).mockReset();
  vi.mocked(db.volumes.get).mockClear();
  vi.mocked(db.volumes.toArray).mockClear();
  vi.mocked(registerCompletionListener).mockClear();
  h.unregisterCompletion.mockClear();
}

describe('volumeNumberFor', () => {
  const sorted = [vol('a', 'Vol 01'), vol('b', 'Vol 02'), vol('c', 'Extras')];
  it('prefers overrides, then parsed numbers, then sort position', () => {
    const tracking = { number_overrides: { b: 7 } };
    expect(volumeNumberFor(sorted[1], sorted, tracking, 'volumes')).toBe(7);
    expect(volumeNumberFor(sorted[0], sorted, tracking, 'volumes')).toBe(1);
    expect(volumeNumberFor(sorted[2], sorted, tracking, 'volumes')).toBe(3);
  });

  it('reads the title in the unit it is given instead of re-detecting one', () => {
    const chapters = [vol('a', 'One Piece 0007')];
    // Detection would say volumes here (no markers, no totals); the caller's
    // answer wins — that is what keeps this off the O(n²) path.
    expect(volumeNumberFor(chapters[0], chapters, undefined, 'chapters')).toBe(7);
  });
});

describe('computeLocalPassState', () => {
  const series = [vol('a', 'Vol 01'), vol('b', 'Vol 02'), vol('c', 'Vol 03')];
  const readingState = (read_count: number, tracking?: SeriesReadingState['tracking']) => ({
    read_count,
    ...(tracking ? { tracking } : {}),
    lastUpdated: '2026-01-01T00:00:00.000Z'
  });

  it('first read in progress', () => {
    const state = computeLocalPassState(
      series,
      { a: { completed: true }, b: { completed: true } },
      undefined,
      'volumes'
    );
    expect(state).toEqual({
      passProgress: 2,
      allCompleted: false,
      passComplete: false,
      timesRead: 0,
      rereading: false
    });
  });
  it('counts the pass as read once every local volume is completed', () => {
    const state = computeLocalPassState(
      series,
      { a: { completed: true }, b: { completed: true }, c: { completed: true } },
      undefined,
      'volumes'
    );
    expect(state).toEqual({
      passProgress: 3,
      allCompleted: true,
      // No totals were supplied, and nothing stores them: `passComplete` is
      // decided by the push, against the totals it fetches with the list entry.
      passComplete: false,
      timesRead: 1,
      rereading: false
    });
  });

  it('completes the pass against the totals the caller fetched', () => {
    const state = computeLocalPassState(
      series,
      { a: { completed: true }, b: { completed: true }, c: { completed: true } },
      undefined,
      'volumes',
      { volumes: 3, chapters: 900 }
    );
    expect(state).toMatchObject({ passProgress: 3, passComplete: true });

    // One short of the total: complete locally, not complete on AniList.
    expect(
      computeLocalPassState(
        series,
        { a: { completed: true }, b: { completed: true }, c: { completed: true } },
        undefined,
        'volumes',
        { volumes: 4 }
      ).passComplete
    ).toBe(false);
  });

  it('measures a chapters folder against the chapter total, and volumes against the volume total', () => {
    const chapters = [vol('a', 'Chapter 1'), vol('b', 'Chapter 2')];
    const completed = { a: { completed: true }, b: { completed: true } };
    const totals = { volumes: 2, chapters: 900 };

    // Read as chapters: 2 of 900, nowhere near done.
    expect(
      computeLocalPassState(chapters, completed, undefined, 'chapters', totals).passComplete
    ).toBe(false);
    // Chapter-titled files someone corrected to volumes: 2 of 2 is the whole series.
    expect(
      computeLocalPassState(chapters, completed, undefined, 'volumes', totals).passComplete
    ).toBe(true);
    // A total for the OTHER unit says nothing about this pass.
    expect(
      computeLocalPassState(chapters, completed, undefined, 'volumes', { chapters: 2 }).passComplete
    ).toBe(false);
  });
  it('re-read in flight after a restart', () => {
    const state = computeLocalPassState(
      series,
      { a: { completed: true } },
      readingState(1),
      'volumes'
    );
    expect(state).toMatchObject({
      passProgress: 1,
      timesRead: 1,
      rereading: true,
      passComplete: false
    });
  });
  it('reads chapter titles in the unit the caller resolved', () => {
    const chapters = [vol('a', 'Chapter 1'), vol('b', 'Chapter 2')];
    const state = computeLocalPassState(
      chapters,
      { a: { completed: true }, b: { completed: true } },
      undefined,
      'chapters'
    );
    expect(state).toMatchObject({ passProgress: 2, allCompleted: true });
  });

  it("applies the reading state's number overrides", () => {
    const state = computeLocalPassState(
      series,
      { a: { completed: true } },
      readingState(0, { number_overrides: { a: 9 } }),
      'volumes'
    );
    expect(state.passProgress).toBe(9);
  });
  it('is empty for a series with no local volumes', () => {
    expect(computeLocalPassState([], {}, undefined, 'volumes')).toEqual({
      passProgress: 0,
      allCompleted: false,
      passComplete: false,
      timesRead: 0,
      rereading: false
    });
  });
});

describe('syncSeriesNow', () => {
  beforeEach(resetWorld);

  it('reads the remote entry, sends the plan and records last_pushed', async () => {
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 1, repeat: 0 } }
      })
      .mockResolvedValueOnce({
        SaveMediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 2, repeat: 0 }
      });

    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');

    const [, mutationCall] = vi.mocked(anilistRequest).mock.calls;
    expect(mutationCall[0]).toContain('SaveMediaListEntry');
    expect(mutationCall[1]).toEqual({ mediaId: 30013, status: 'CURRENT', progressVolumes: 2 });
    expect(mutationCall[2]).toBe('tok');
    expect(trackedState().tracking!.last_pushed).toMatchObject({
      n: 2,
      status: 'CURRENT'
    });
    expect(readPendingPushes()).toEqual({});
  });

  it('asks AniList for the series totals in the same request as the entry', async () => {
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({ Media: { volumes: 5, chapters: 100, mediaListEntry: null } })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    await syncSeriesNow('one piece');

    const query = String(vi.mocked(anilistRequest).mock.calls[0][0]);
    expect(query).toContain('volumes');
    expect(query).toContain('chapters');
  });

  it('marks a pass COMPLETED from the fetched totals, never from a stored count', async () => {
    // Five volumes locally, all completed; AniList says the series has five.
    const five = ['01', '02', '03', '04', '05'].map((n, i) => vol(`v${i}`, `Vol ${n}`));
    h.dbVolumes.splice(0, h.dbVolumes.length, ...five);
    h.volumesStore.set(Object.fromEntries(five.map((v) => [v.volume_uuid, { completed: true }])));
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({ Media: { volumes: 5, chapters: null, mediaListEntry: null } })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');

    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toMatchObject({
      status: 'COMPLETED',
      progressVolumes: 5
    });
  });

  it('is "nothing" when remote is already ahead', async () => {
    vi.mocked(anilistRequest).mockResolvedValueOnce({
      Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 5, repeat: 0 } }
    });
    await expect(syncSeriesNow('one piece')).resolves.toBe('nothing');
    expect(anilistRequest).toHaveBeenCalledTimes(1);
  });

  it('is "disabled" when the series is unlinked or the master switch is off', async () => {
    h.metaByKey.set('one piece', meta({ external_ids: {} }));
    await expect(syncSeriesNow('one piece')).resolves.toBe('disabled');
    h.metaByKey.set('one piece', meta());
    h.settingsStore.set({ catalogSettings: { pushProgressToAniList: false } });
    await expect(syncSeriesNow('one piece')).resolves.toBe('disabled');
    expect(anilistRequest).not.toHaveBeenCalled();
  });

  it('pushes a linked series that has no tracking block at all', async () => {
    // There is no per-series opt-in any more: linking the series IS the opt-in.
    h.metaByKey.set('one piece', meta());
    clearSeriesReadingState(); // never read, never pushed: no tracking block at all
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({ Media: { mediaListEntry: null } })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });
    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');
    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toMatchObject({ progressVolumes: 2 });
  });

  it('pushes chapter-titled archives into the chapter field', async () => {
    h.dbVolumes.splice(
      0,
      h.dbVolumes.length,
      vol('a', 'One Piece Chapter 1'),
      vol('b', 'One Piece Chapter 2')
    );
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({ Media: { mediaListEntry: null } })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });
    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');
    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({
      mediaId: 30013,
      status: 'CURRENT',
      progress: 2
    });
  });

  it('re-resolves the unit against the totals it fetched, over the cloud index too', async () => {
    // One chapter installed out of a thousand: detecting from `db.volumes`
    // alone would call it volumes and push chapter 1 as volume 1. The 1050
    // cloud titles overshoot AniList's 108 volumes and fit inside its 1100
    // chapters — and those totals only exist because the push fetched them.
    h.dbVolumes.splice(0, h.dbVolumes.length, vol('a', 'One Piece 0001'));
    h.volumesStore.set({ a: { completed: true } });
    h.seriesIndex.set('one piece', {
      file: {
        volumes: Array.from({ length: 1050 }, (_, i) => ({
          volume_uuid: `cloud-${i + 1}`,
          volume_title: `One Piece ${String(i + 1).padStart(4, '0')}`
        }))
      }
    });

    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({ Media: { volumes: 108, chapters: 1100, mediaListEntry: null } })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });
    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');
    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({
      mediaId: 30013,
      status: 'CURRENT',
      progress: 1
    });
    // The index was read once, before the request — the re-resolve reuses the
    // titles it collected rather than reading it again.
    expect(getSeriesIndex).toHaveBeenCalledTimes(1);
  });

  it('skips the index read when the unit is already a stated fact', async () => {
    h.metaByKey.set('one piece', meta({ unit: 'volumes' }));
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({ Media: { mediaListEntry: null } })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });
    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');
    expect(getSeriesIndex).not.toHaveBeenCalled();
  });

  it('lets a corrected unit override the titles', async () => {
    h.dbVolumes.splice(
      0,
      h.dbVolumes.length,
      vol('a', 'One Piece Chapter 1'),
      vol('b', 'One Piece Chapter 2')
    );
    h.metaByKey.set('one piece', meta({ unit: 'volumes' }));
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({ Media: { mediaListEntry: null } })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });
    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');
    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({
      mediaId: 30013,
      status: 'CURRENT',
      progressVolumes: 2
    });
  });

  it('drops a queued intent when the series is no longer pushable', async () => {
    // The series was unlinked after the intent was queued: replaying it can only
    // ever return "disabled", so it must not linger in the queue forever.
    localStorage.setItem(
      'anilist_pending_pushes',
      JSON.stringify({
        'one piece': { seriesKey: 'one piece', event: 'sync', at: '2026-01-01T00:00:00.000Z' }
      })
    );
    h.metaByKey.set('one piece', meta({ external_ids: {} }));
    await expect(syncSeriesNow('one piece')).resolves.toBe('disabled');
    expect(readPendingPushes()).toEqual({});
  });

  it('is "disabled" for an unknown series key', async () => {
    await expect(syncSeriesNow('nope')).resolves.toBe('disabled');
    expect(anilistRequest).not.toHaveBeenCalled();
  });

  it('queues when there is no token', async () => {
    h.auth.token = null;
    await expect(syncSeriesNow('one piece')).resolves.toBe('queued');
    expect(readPendingPushes()['one piece']).toMatchObject({ event: 'sync' });
    expect(anilistRequest).not.toHaveBeenCalled();
  });

  it('queues on network errors and clears the session on 401', async () => {
    vi.mocked(anilistRequest).mockRejectedValueOnce(new FakeAniListError('NETWORK'));
    await expect(syncSeriesNow('one piece')).resolves.toBe('queued');
    expect(readPendingPushes()['one piece']).toBeDefined();

    vi.mocked(anilistRequest).mockRejectedValueOnce(new FakeAniListError('UNAUTHORIZED'));
    await expect(syncSeriesNow('one piece')).resolves.toBe('queued');
    expect(handleAniListUnauthorized).toHaveBeenCalled();
    expect(readPendingPushes()['one piece']).toBeDefined();
  });

  it('reports "failed" and drops the intent when AniList rejects the document', async () => {
    localStorage.setItem(
      'anilist_pending_pushes',
      JSON.stringify({
        'one piece': { seriesKey: 'one piece', event: 'sync', at: '2026-01-01T00:00:00.000Z' }
      })
    );
    vi.mocked(anilistRequest).mockRejectedValueOnce(new FakeAniListError('GRAPHQL'));
    await expect(syncSeriesNow('one piece')).resolves.toBe('failed');
    expect(readPendingPushes()).toEqual({});
    expect(handleAniListUnauthorized).not.toHaveBeenCalled();
  });

  it('keeps a concurrent tracking edit when it records last_pushed', async () => {
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({ Media: { mediaListEntry: null } })
      .mockImplementationOnce((async () => {
        // The series settings UI edits tracking while the push is in flight.
        updateSeriesReadingState('one piece', (existing) => ({
          tracking: { ...(existing.tracking ?? {}), number_overrides: { b: 9 } }
        }));
        return { SaveMediaListEntry: {} };
      }) as never);

    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');

    const tracking = trackedState().tracking!;
    expect(tracking.number_overrides).toEqual({ b: 9 });
    expect(tracking.last_pushed).toMatchObject({ n: 2, status: 'CURRENT' });
  });

  it('records the progress actually sent for a status-only push', async () => {
    // A re-read in flight: local progress (1) is behind what AniList already
    // holds (5), so only the status moves — and what gets recorded is the local
    // pass, which is the figure this push stood for.
    updateSeriesReadingState('one piece', { read_count: 1 });
    h.volumesStore.set({ a: { completed: true } });
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 5, repeat: 0 } }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');
    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({
      mediaId: 30013,
      status: 'REPEATING'
    });
    expect(trackedState().tracking!.last_pushed).toMatchObject({
      n: 1,
      status: 'REPEATING'
    });
  });

  it('pushes progress with no remote list entry at all', async () => {
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({ Media: { mediaListEntry: null } })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });
    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');
    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({
      mediaId: 30013,
      status: 'CURRENT',
      progressVolumes: 2
    });
  });
});

describe('completion fires are idempotent', () => {
  beforeEach(resetWorld);

  it('pushes once and then skips identical repeats without touching the network', async () => {
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 1, repeat: 0 } }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    onVolumeCompleted('b');
    await vi.waitFor(() => expect(anilistRequest).toHaveBeenCalledTimes(2));

    // The reader re-fires completion on every page turn at the end of a volume.
    onVolumeCompleted('b');
    onVolumeCompleted('b');
    onVolumeCompleted('a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(anilistRequest).toHaveBeenCalledTimes(2);
  });

  it('costs no catalog read at all when the same volume re-fires', async () => {
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 1, repeat: 0 } }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    onVolumeCompleted('b');
    await vi.waitFor(() => expect(anilistRequest).toHaveBeenCalledTimes(2));
    expect(db.volumes.toArray).toHaveBeenCalledTimes(1);

    onVolumeCompleted('b');
    onVolumeCompleted('b');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.volumes.get).toHaveBeenCalledTimes(1);
    expect(db.volumes.toArray).toHaveBeenCalledTimes(1);
  });

  it('skips repeats even when the first attempt found nothing to push', async () => {
    vi.mocked(anilistRequest).mockResolvedValue({
      Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 9, repeat: 0 } }
    });
    onVolumeCompleted('b');
    await vi.waitFor(() => expect(anilistRequest).toHaveBeenCalledTimes(1));
    onVolumeCompleted('b');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(anilistRequest).toHaveBeenCalledTimes(1);
    expect(trackedState().tracking?.last_pushed).toBeUndefined();
  });

  it('pushes COMPLETED from a completion fire once the fetched totals say the pass is done', async () => {
    const five = ['01', '02', '03', '04', '05'].map((n, i) => vol(`v${i}`, `Vol ${n}`));
    h.dbVolumes.splice(0, h.dbVolumes.length, ...five);
    h.volumesStore.set(Object.fromEntries(five.map((v) => [v.volume_uuid, { completed: true }])));
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({ Media: { volumes: 5, chapters: null, mediaListEntry: null } })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    onVolumeCompleted('v4');
    await vi.waitFor(() => expect(anilistRequest).toHaveBeenCalledTimes(2));

    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toMatchObject({
      status: 'COMPLETED',
      progressVolumes: 5
    });
  });

  it('upgrades an already-pushed pass to COMPLETED when the totals arrive later', async () => {
    // The last push went out before AniList carried a volume count, so it said
    // CURRENT at 5 of an unknown total. The totals ride the next fetch — the
    // replay must be made against them, not against the totals-blind state
    // (which can never be `passComplete` and so would call this settled).
    const five = ['01', '02', '03', '04', '05'].map((n, i) => vol(`v${i}`, `Vol ${n}`));
    h.dbVolumes.splice(0, h.dbVolumes.length, ...five);
    h.volumesStore.set(Object.fromEntries(five.map((v) => [v.volume_uuid, { completed: true }])));
    updateSeriesReadingState('one piece', {
      tracking: { last_pushed: { n: 5, status: 'CURRENT', at: '2026-08-01T00:00:00.000Z' } }
    });
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: {
          volumes: 5,
          chapters: null,
          mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 5, repeat: 0 }
        }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    onVolumeCompleted('v4');
    await vi.waitFor(() => expect(anilistRequest).toHaveBeenCalledTimes(2));

    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({
      mediaId: 30013,
      status: 'COMPLETED'
    });
  });

  it('replays last_pushed in the unit the fetched totals resolved, not the totals-blind one', async () => {
    // Bare-numbered chapter archives. Without AniList's totals the detector calls
    // them volumes and reads their numbers off sort position (1), while
    // `last_pushed.n` was recorded in chapters (1000) by an earlier push: a
    // replay across those two scales says "nothing could have changed" and
    // swallows every later completion until someone hits Sync by hand.
    h.dbVolumes.splice(0, h.dbVolumes.length, vol('a', 'One Piece 1050'));
    h.volumesStore.set({ a: { completed: true } });
    updateSeriesReadingState('one piece', {
      tracking: { last_pushed: { n: 1000, status: 'CURRENT', at: '2026-08-01T00:00:00.000Z' } }
    });
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: {
          volumes: 108,
          chapters: 1100,
          mediaListEntry: { status: 'CURRENT', progress: 1000, progressVolumes: 0, repeat: 0 }
        }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    onVolumeCompleted('a');
    await vi.waitFor(() => expect(anilistRequest).toHaveBeenCalledTimes(2));

    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({
      mediaId: 30013,
      status: 'CURRENT',
      progress: 1050
    });
  });

  it('still settles without a write when the replay agrees in the resolved unit', async () => {
    // Same shape as above, but the chapter already pushed IS the newest one: the
    // fetch happens (the replay needs the totals), and nothing is written.
    h.dbVolumes.splice(0, h.dbVolumes.length, vol('a', 'One Piece 1050'));
    h.volumesStore.set({ a: { completed: true } });
    updateSeriesReadingState('one piece', {
      tracking: { last_pushed: { n: 1050, status: 'CURRENT', at: '2026-08-01T00:00:00.000Z' } }
    });
    vi.mocked(anilistRequest).mockResolvedValue({
      Media: {
        volumes: 108,
        chapters: 1100,
        mediaListEntry: { status: 'CURRENT', progress: 1050, progressVolumes: 0, repeat: 0 }
      }
    });

    onVolumeCompleted('a');
    await vi.waitFor(() => expect(anilistRequest).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(anilistRequest).toHaveBeenCalledTimes(1);
  });

  it('pushes again once local progress actually moves', async () => {
    h.volumesStore.set({ a: { completed: true } });
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({ Media: { mediaListEntry: null } })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} })
      .mockResolvedValueOnce({
        Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 1, repeat: 0 } }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    onVolumeCompleted('a');
    await vi.waitFor(() => expect(anilistRequest).toHaveBeenCalledTimes(2));

    h.volumesStore.set({ a: { completed: true }, b: { completed: true } });
    onVolumeCompleted('b');
    await vi.waitFor(() => expect(anilistRequest).toHaveBeenCalledTimes(4));
    expect(vi.mocked(anilistRequest).mock.calls[3][1]).toMatchObject({ progressVolumes: 2 });
  });

  it('ignores completions of volumes that are not in the catalog', async () => {
    onVolumeCompleted('gone');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(anilistRequest).not.toHaveBeenCalled();
  });
});

describe('flushPendingPushes', () => {
  beforeEach(resetWorld);
  afterEach(() => {
    vi.useRealTimers();
  });

  const seedPending = (event: 'restart' | 'read_count' | 'sync') =>
    localStorage.setItem(
      'anilist_pending_pushes',
      JSON.stringify({
        'one piece': { seriesKey: 'one piece', event, at: '2026-01-01T00:00:00.000Z' }
      })
    );

  it('replays a queued restart before the follow-up sync', async () => {
    h.metaByKey.set('one piece', meta());
    updateSeriesReadingState('one piece', { read_count: 1 });
    h.volumesStore.set({});
    seedPending('restart');

    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'COMPLETED', progress: 0, progressVolumes: 20, repeat: 0 }
        }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} })
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'REPEATING', progress: 0, progressVolumes: 0, repeat: 0 }
        }
      });

    await flushPendingPushes();

    const calls = vi.mocked(anilistRequest).mock.calls;
    expect(calls[1][0]).toContain('SaveMediaListEntry');
    expect(calls[1][1]).toEqual({ mediaId: 30013, status: 'REPEATING', progressVolumes: 0 });
    // The follow-up sync re-plans against the live remote and finds nothing left.
    expect(calls).toHaveLength(3);
    expect(readPendingPushes()).toEqual({});
  });

  it('replays a queued read_count as a read_count, then syncs', async () => {
    h.metaByKey.set('one piece', meta());
    h.volumesStore.set({});
    seedPending('read_count');

    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 5, repeat: 4 }
        }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} })
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 5, repeat: 0 }
        }
      });

    await flushPendingPushes();

    // The decrease survived the round trip through the queue.
    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({ mediaId: 30013, repeat: 0 });
    expect(readPendingPushes()).toEqual({});
  });

  it('replays a restart AND the read-count correction queued behind it', async () => {
    // Offline: the user restarts the series and then corrects "Read N times"
    // downwards. Collapsing both into one restart would lose the decrease.
    h.metaByKey.set('one piece', meta());
    updateSeriesReadingState('one piece', { read_count: 1 });
    h.volumesStore.set({});
    h.auth.token = null;

    onSeriesRestarted('one piece');
    await vi.waitFor(() =>
      expect(readPendingPushes()['one piece']).toMatchObject({ event: 'restart' })
    );
    await onReadCountChanged('one piece');
    expect(readPendingPushes()['one piece']).toMatchObject({
      event: 'restart',
      alsoReadCount: true
    });

    h.auth.token = 'tok';
    vi.mocked(anilistRequest)
      // restart: remote is a finished read with 3 repeats
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'COMPLETED', progress: 0, progressVolumes: 20, repeat: 3 }
        }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} })
      // read_count: progress is reset now, but repeat is still the old 3
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'REPEATING', progress: 0, progressVolumes: 0, repeat: 3 }
        }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} })
      // follow-up sync: nothing left to do
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'REPEATING', progress: 0, progressVolumes: 0, repeat: 0 }
        }
      });

    await flushPendingPushes();

    const calls = vi.mocked(anilistRequest).mock.calls;
    expect(calls[1][1]).toEqual({ mediaId: 30013, status: 'REPEATING', progressVolumes: 0 });
    // The decrease survived the restart instead of being swallowed by it.
    expect(calls[3][1]).toEqual({ mediaId: 30013, repeat: 0 });
    expect(calls).toHaveLength(5);
    expect(readPendingPushes()).toEqual({});
  });

  it('keeps the queued intent when the replay still fails', async () => {
    seedPending('restart');
    vi.mocked(anilistRequest).mockRejectedValue(new FakeAniListError('NETWORK'));
    await flushPendingPushes();
    expect(readPendingPushes()['one piece']).toMatchObject({ event: 'restart' });
    expect(anilistRequest).toHaveBeenCalledTimes(1);
  });

  it('does nothing while signed out', async () => {
    seedPending('sync');
    h.auth.token = null;
    await flushPendingPushes();
    expect(anilistRequest).not.toHaveBeenCalled();
    expect(readPendingPushes()['one piece']).toBeDefined();
  });

  it('honours Retry-After after a 429 and retries when it expires', async () => {
    vi.useFakeTimers();
    seedPending('sync');
    vi.mocked(anilistRequest).mockRejectedValueOnce(new FakeAniListError('RATE_LIMITED', 5000));

    await flushPendingPushes();
    expect(anilistRequest).toHaveBeenCalledTimes(1);
    expect(readPendingPushes()['one piece']).toBeDefined();

    // Inside the Retry-After window nothing else is sent.
    await flushPendingPushes();
    expect(anilistRequest).toHaveBeenCalledTimes(1);

    vi.mocked(anilistRequest).mockResolvedValue({
      Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 9, repeat: 0 } }
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect(anilistRequest).toHaveBeenCalledTimes(2);
    expect(readPendingPushes()).toEqual({});
  });
});

describe('onSeriesRestarted', () => {
  beforeEach(resetWorld);

  it('pushes a restart for a linked series that never had a tracking block', async () => {
    // The reported bug: re-reads never reached AniList because a per-series
    // toggle nobody had switched on gated every push.
    h.metaByKey.set('one piece', meta());
    updateSeriesReadingState('one piece', { read_count: 1 });
    h.volumesStore.set({});
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'COMPLETED', progress: 0, progressVolumes: 20, repeat: 0 }
        }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    onSeriesRestarted('one piece');
    await vi.waitFor(() => expect(trackedState().tracking?.last_pushed).toBeDefined());
    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({
      mediaId: 30013,
      status: 'REPEATING',
      progressVolumes: 0
    });
  });

  it('records the 0 it actually sent, not the local pass', async () => {
    // A restart queued while offline is replayed after the next pass already
    // started: the plan sends 0, so last_pushed must say 0 — recording the
    // local pass (1) would make the fast-path swallow the next completion.
    h.metaByKey.set('one piece', meta());
    updateSeriesReadingState('one piece', { read_count: 1 });
    h.volumesStore.set({ a: { completed: true } });
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'COMPLETED', progress: 0, progressVolumes: 20, repeat: 0 }
        }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    onSeriesRestarted('one piece');
    await vi.waitFor(() => expect(trackedState().tracking!.last_pushed).toBeDefined());

    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({
      mediaId: 30013,
      status: 'REPEATING',
      progressVolumes: 0
    });
    expect(trackedState().tracking!.last_pushed).toMatchObject({
      n: 0,
      status: 'REPEATING'
    });
  });
});

describe('onReadCountChanged', () => {
  beforeEach(resetWorld);

  it('raises the repeat count without touching progress or status', async () => {
    h.metaByKey.set('one piece', meta());
    updateSeriesReadingState('one piece', { read_count: 2 });
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 2, repeat: 0 }
        }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    await expect(onReadCountChanged('one piece')).resolves.toBe('pushed');
    // read_count 2 + a completed pass = 3 reads = repeat 2.
    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({ mediaId: 30013, repeat: 2 });
  });

  it('lowers the repeat count and records the progress AniList already holds', async () => {
    h.metaByKey.set('one piece', meta());
    h.volumesStore.set({});
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 7, repeat: 3 }
        }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    await expect(onReadCountChanged('one piece')).resolves.toBe('pushed');
    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({ mediaId: 30013, repeat: 0 });
    // No progress moved, so last_pushed must not invent one from the local pass.
    expect(trackedState().tracking!.last_pushed).toMatchObject({ n: 7 });
  });

  it('is "nothing" when the remote repeat already agrees', async () => {
    // read_count 0 + a completed pass = 1 read = repeat 0, which is what the
    // remote already says.
    vi.mocked(anilistRequest).mockResolvedValueOnce({
      Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 2, repeat: 0 } }
    });
    await expect(onReadCountChanged('one piece')).resolves.toBe('nothing');
    expect(anilistRequest).toHaveBeenCalledTimes(1);
  });

  it('queues as read_count so a decrease is not downgraded to a sync', async () => {
    h.auth.token = null;
    await expect(onReadCountChanged('one piece')).resolves.toBe('queued');
    expect(readPendingPushes()['one piece']).toMatchObject({ event: 'read_count' });

    // A later completion must not collapse the queued correction into a sync.
    h.volumesStore.set({ a: { completed: true } });
    onVolumeCompleted('a');
    await vi.waitFor(() =>
      expect(readPendingPushes()['one piece']).toMatchObject({ event: 'read_count' })
    );
  });
});

describe('readPendingPushes', () => {
  beforeEach(resetWorld);

  it('drops entries that could never be replayed or cleared', () => {
    localStorage.setItem(
      'anilist_pending_pushes',
      JSON.stringify({
        'one piece': { seriesKey: 'one piece', event: 'sync', at: '2026-01-01T00:00:00.000Z' },
        bleach2: {
          seriesKey: 'bleach2',
          event: 'sync',
          alsoReadCount: true,
          at: '2026-01-01T00:00:00.000Z'
        },
        naruto: { seriesKey: 'naruto', event: 'nope', at: 'x' },
        bleach: null,
        undefined: undefined,
        mismatched: { seriesKey: 'other', event: 'sync', at: 'x' },
        keyless: { event: 'restart', at: 'x' }
      })
    );
    expect(readPendingPushes()).toEqual({
      'one piece': { seriesKey: 'one piece', event: 'sync', at: '2026-01-01T00:00:00.000Z' },
      // `alsoReadCount` only means anything behind a restart; the flush would
      // never look at it here, so it is not carried through.
      bleach2: { seriesKey: 'bleach2', event: 'sync', at: '2026-01-01T00:00:00.000Z' }
    });
  });

  it('defaults a missing timestamp and survives a corrupt payload', () => {
    localStorage.setItem(
      'anilist_pending_pushes',
      JSON.stringify({ naruto: { seriesKey: 'naruto', event: 'restart' } })
    );
    expect(readPendingPushes().naruto).toEqual({
      seriesKey: 'naruto',
      event: 'restart',
      at: new Date(0).toISOString()
    });

    localStorage.setItem('anilist_pending_pushes', '{not json');
    expect(readPendingPushes()).toEqual({});
  });
});

describe('initProgressTracker', () => {
  beforeEach(resetWorld);

  it('registers the completion listener exactly once and unwires cleanly', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    try {
      const dispose = initProgressTracker();
      const disposeAgain = initProgressTracker();
      expect(registerCompletionListener).toHaveBeenCalledTimes(1);
      expect(disposeAgain).toBe(dispose);
      expect(addSpy).toHaveBeenCalledWith('online', expect.any(Function));
      expect(h.completionListeners).toHaveLength(1);

      dispose();
      expect(h.unregisterCompletion).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledWith('online', expect.any(Function));

      // A later init re-registers rather than staying dead.
      const third = initProgressTracker();
      expect(registerCompletionListener).toHaveBeenCalledTimes(2);
      third();
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('flushes the queue when a signed-out session connects', async () => {
    // The flush hangs off the session flag, not the resolved user: a login whose
    // Viewer lookup failed still holds a usable token.
    localStorage.setItem(
      'anilist_pending_pushes',
      JSON.stringify({
        'one piece': { seriesKey: 'one piece', event: 'sync', at: '2026-01-01T00:00:00.000Z' }
      })
    );
    h.auth.token = null;
    h.connectedStore.set(false);
    h.userStore.set(null);
    const dispose = initProgressTracker();
    expect(anilistRequest).not.toHaveBeenCalled();

    h.auth.token = 'tok';
    vi.mocked(anilistRequest).mockResolvedValue({
      Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 9, repeat: 0 } }
    });
    // Still no user (the Viewer query failed) — connecting alone must flush.
    h.connectedStore.set(true);
    await vi.waitFor(() => expect(anilistRequest).toHaveBeenCalledTimes(1));
    dispose();
    h.connectedStore.set(true);
  });

  it('does not flush again while the session merely stays connected', async () => {
    localStorage.setItem(
      'anilist_pending_pushes',
      JSON.stringify({
        'one piece': { seriesKey: 'one piece', event: 'sync', at: '2026-01-01T00:00:00.000Z' }
      })
    );
    h.auth.token = null;
    h.connectedStore.set(true);
    const dispose = initProgressTracker();
    h.connectedStore.set(true);
    expect(anilistRequest).not.toHaveBeenCalled();
    dispose();
  });
});

describe('syncAllSeriesNow', () => {
  beforeEach(resetWorld);
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A second linked series, with its own volumes in the catalog. */
  function addNaruto(over: Partial<SeriesMetadata> = {}) {
    h.metaByKey.set(
      'naruto',
      meta({
        series_key: 'naruto',
        series_title: 'Naruto',
        external_ids: { anilist: 30011 },
        ...over
      })
    );
    const narutoVol = { ...vol('n1', 'Vol 01'), series_title: 'Naruto' } as VolumeMetadata;
    h.dbVolumes.push(narutoVol);
    h.volumesStore.set({ a: { completed: true }, b: { completed: true }, n1: { completed: true } });
  }

  it('tallies every linked series and never touches the unlinked ones', async () => {
    vi.useFakeTimers();
    addNaruto();
    // A series with no AniList id at all: not part of the pass.
    h.metaByKey.set(
      'bleach',
      meta({ series_key: 'bleach', series_title: 'Bleach', external_ids: {} })
    );

    vi.mocked(anilistRequest)
      // One Piece: remote is behind → a push.
      .mockResolvedValueOnce({
        Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 1, repeat: 0 } }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} })
      // Naruto: remote is already ahead → nothing to do.
      .mockResolvedValueOnce({
        Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 9, repeat: 0 } }
      });

    const pending = syncAllSeriesNow();
    await vi.advanceTimersByTimeAsync(2000);
    const tally = await pending;

    expect(tally).toEqual({ pushed: 1, nothing: 1, queued: 0, failed: 0, disabled: 0, total: 2 });
    // Serialized: One Piece's read + write, then Naruto's read — never interleaved.
    expect(
      vi
        .mocked(anilistRequest)
        .mock.calls.map(
          (c) => (c[1] as { mediaId?: number }).mediaId ?? (c[1] as { id?: number }).id
        )
    ).toEqual([30013, 30013, 30011]);
  });

  it('waits the rate-limit gap before the second series', async () => {
    vi.useFakeTimers();
    addNaruto();
    vi.mocked(anilistRequest).mockResolvedValue({
      Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 9, repeat: 0 } }
    });

    const pending = syncAllSeriesNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(anilistRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(anilistRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(anilistRequest).toHaveBeenCalledTimes(2);
    await pending;
  });

  it('answers for the whole library at once when the master switch is off', async () => {
    // No requests, and no rate-limit gaps either: this resolves without a
    // single timer having to run.
    addNaruto();
    h.settingsStore.set({ catalogSettings: { pushProgressToAniList: false } });

    expect(await syncAllSeriesNow()).toEqual({
      pushed: 0,
      nothing: 0,
      queued: 0,
      failed: 0,
      disabled: 2,
      total: 2
    });
    expect(anilistRequest).not.toHaveBeenCalled();
  });

  it('counts a queued series without stopping the pass', async () => {
    vi.useFakeTimers();
    addNaruto();
    h.auth.token = null;

    const pending = syncAllSeriesNow();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({
      pushed: 0,
      nothing: 0,
      queued: 2,
      failed: 0,
      disabled: 0,
      total: 2
    });
    expect(anilistRequest).not.toHaveBeenCalled();
  });

  it('joins the pass already running instead of doubling the traffic', async () => {
    vi.useFakeTimers();
    addNaruto();
    vi.mocked(anilistRequest).mockResolvedValue({
      Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 9, repeat: 0 } }
    });

    const first = syncAllSeriesNow();
    const second = syncAllSeriesNow();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await first).toMatchObject({ total: 2 });
    expect(anilistRequest).toHaveBeenCalledTimes(2);

    // Finished: a later click starts a fresh pass.
    const third = syncAllSeriesNow();
    expect(third).not.toBe(first);
    await vi.advanceTimersByTimeAsync(2000);
    await third;
  });

  it('is an empty pass when nothing is linked', async () => {
    h.metaByKey.clear();
    expect(await syncAllSeriesNow()).toEqual({
      pushed: 0,
      nothing: 0,
      queued: 0,
      failed: 0,
      disabled: 0,
      total: 0
    });
    expect(anilistRequest).not.toHaveBeenCalled();
  });
});
