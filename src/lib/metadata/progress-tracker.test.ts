import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
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
    dbVolumes: [] as VolumeMetadata[],
    metaByKey: new Map<string, SeriesMetadata>(),
    completionListeners: [] as ((uuid: string) => void)[],
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
  updateSeriesMetadata: vi.fn(async (title: string, patch: Partial<SeriesMetadata>) => {
    const key = title.trim().replace(/\s+/g, ' ').toLowerCase();
    const next = { ...h.metaByKey.get(key)!, ...patch };
    h.metaByKey.set(key, next);
    return next;
  })
}));

vi.mock('./providers/anilist', () => ({
  anilistRequest: vi.fn(),
  AniListError: h.FakeAniListError
}));

vi.mock('./anilist-auth', () => ({
  getAniListToken: () => h.auth.token,
  anilistUser: h.userStore,
  handleAniListUnauthorized: vi.fn()
}));

import { registerCompletionListener } from '$lib/settings/volume-data';
import { db } from '$lib/catalog/db';
import { handleAniListUnauthorized } from './anilist-auth';
import { anilistRequest } from './providers/anilist';
import {
  _resetTrackerStateForTests,
  computeLocalPassState,
  flushPendingPushes,
  initProgressTracker,
  onSeriesRestarted,
  onVolumeCompleted,
  readPendingPushes,
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
  read_count: 0,
  tracking: { enabled: true, unit: 'volumes' },
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over
});

/** Reset every piece of shared state between test cases. */
function resetWorld() {
  localStorage.clear();
  _resetTrackerStateForTests();
  h.dbVolumes.splice(0, h.dbVolumes.length, vol('a', 'Vol 01'), vol('b', 'Vol 02'));
  h.volumesStore.set({ a: { completed: true }, b: { completed: true } });
  h.metaByKey.clear();
  h.metaByKey.set('one piece', meta({ total_volumes: 20 }));
  h.settingsStore.set({ catalogSettings: { pushProgressToAniList: true } });
  h.completionListeners.length = 0;
  h.auth.token = 'tok';
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
    const m = meta({ tracking: { enabled: true, unit: 'volumes', number_overrides: { b: 7 } } });
    expect(volumeNumberFor(sorted[1], sorted, m)).toBe(7);
    expect(volumeNumberFor(sorted[0], sorted, m)).toBe(1);
    expect(volumeNumberFor(sorted[2], sorted, m)).toBe(3);
  });
});

describe('computeLocalPassState', () => {
  const series = [vol('a', 'Vol 01'), vol('b', 'Vol 02'), vol('c', 'Vol 03')];
  it('first read in progress', () => {
    const state = computeLocalPassState(
      series,
      { a: { completed: true }, b: { completed: true } },
      meta()
    );
    expect(state).toEqual({
      passProgress: 2,
      allCompleted: false,
      passComplete: false,
      timesRead: 0,
      rereading: false
    });
  });
  it('all local volumes completed and total reached', () => {
    const state = computeLocalPassState(
      series,
      { a: { completed: true }, b: { completed: true }, c: { completed: true } },
      meta({ total_volumes: 3 })
    );
    expect(state).toEqual({
      passProgress: 3,
      allCompleted: true,
      passComplete: true,
      timesRead: 1,
      rereading: false
    });
  });
  it('re-read in flight after a restart', () => {
    const state = computeLocalPassState(
      series,
      { a: { completed: true } },
      meta({ read_count: 1, total_volumes: 3 })
    );
    expect(state).toMatchObject({
      passProgress: 1,
      timesRead: 1,
      rereading: true,
      passComplete: false
    });
  });
  it('uses total_chapters for the chapters unit', () => {
    const chapters = [vol('a', 'Chapter 1'), vol('b', 'Chapter 2')];
    const state = computeLocalPassState(
      chapters,
      { a: { completed: true }, b: { completed: true } },
      meta({ tracking: { enabled: true, unit: 'chapters' }, total_chapters: 2 })
    );
    expect(state.passComplete).toBe(true);
  });
  it('is empty for a series with no local volumes', () => {
    expect(computeLocalPassState([], {}, meta())).toEqual({
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
    expect(h.metaByKey.get('one piece')!.tracking!.last_pushed).toMatchObject({
      n: 2,
      status: 'CURRENT'
    });
    expect(readPendingPushes()).toEqual({});
  });

  it('is "nothing" when remote is already ahead', async () => {
    vi.mocked(anilistRequest).mockResolvedValueOnce({
      Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 5, repeat: 0 } }
    });
    await expect(syncSeriesNow('one piece')).resolves.toBe('nothing');
    expect(anilistRequest).toHaveBeenCalledTimes(1);
  });

  it('is "disabled" when tracking is off, unlinked, or the master switch is off', async () => {
    h.metaByKey.set('one piece', meta({ tracking: { enabled: false, unit: 'volumes' } }));
    await expect(syncSeriesNow('one piece')).resolves.toBe('disabled');
    h.metaByKey.set('one piece', meta({ external_ids: {} }));
    await expect(syncSeriesNow('one piece')).resolves.toBe('disabled');
    h.metaByKey.set('one piece', meta());
    h.settingsStore.set({ catalogSettings: { pushProgressToAniList: false } });
    await expect(syncSeriesNow('one piece')).resolves.toBe('disabled');
    expect(anilistRequest).not.toHaveBeenCalled();
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
        const current = h.metaByKey.get('one piece')!;
        h.metaByKey.set('one piece', {
          ...current,
          tracking: { ...current.tracking!, unit: 'chapters', number_overrides: { b: 9 } }
        });
        return { SaveMediaListEntry: {} };
      }) as never);

    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');

    const tracking = h.metaByKey.get('one piece')!.tracking!;
    expect(tracking.unit).toBe('chapters');
    expect(tracking.number_overrides).toEqual({ b: 9 });
    expect(tracking.last_pushed).toMatchObject({ n: 2, status: 'CURRENT' });
  });

  it('records the progress actually sent for a status-only push', async () => {
    h.metaByKey.set('one piece', meta({ total_volumes: 2 }));
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 5, repeat: 0 } }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');
    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({
      mediaId: 30013,
      status: 'COMPLETED'
    });
    expect(h.metaByKey.get('one piece')!.tracking!.last_pushed).toMatchObject({
      n: 2,
      status: 'COMPLETED'
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
    expect(h.metaByKey.get('one piece')!.tracking!.last_pushed).toBeUndefined();
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

  const seedPending = (event: 'restart' | 'sync') =>
    localStorage.setItem(
      'anilist_pending_pushes',
      JSON.stringify({
        'one piece': { seriesKey: 'one piece', event, at: '2026-01-01T00:00:00.000Z' }
      })
    );

  it('replays a queued restart before the follow-up sync', async () => {
    h.metaByKey.set('one piece', meta({ total_volumes: 20, read_count: 1 }));
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

  it('records the 0 it actually sent, not the local pass', async () => {
    // A restart queued while offline is replayed after the next pass already
    // started: the plan sends 0, so last_pushed must say 0 — recording the
    // local pass (1) would make the fast-path swallow the next completion.
    h.metaByKey.set('one piece', meta({ total_volumes: 20, read_count: 1 }));
    h.volumesStore.set({ a: { completed: true } });
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: {
          mediaListEntry: { status: 'COMPLETED', progress: 0, progressVolumes: 20, repeat: 0 }
        }
      })
      .mockResolvedValueOnce({ SaveMediaListEntry: {} });

    onSeriesRestarted('one piece');
    await vi.waitFor(() =>
      expect(h.metaByKey.get('one piece')!.tracking!.last_pushed).toBeDefined()
    );

    expect(vi.mocked(anilistRequest).mock.calls[1][1]).toEqual({
      mediaId: 30013,
      status: 'REPEATING',
      progressVolumes: 0
    });
    expect(h.metaByKey.get('one piece')!.tracking!.last_pushed).toMatchObject({
      n: 0,
      status: 'REPEATING'
    });
  });
});

describe('readPendingPushes', () => {
  beforeEach(resetWorld);

  it('drops entries that could never be replayed or cleared', () => {
    localStorage.setItem(
      'anilist_pending_pushes',
      JSON.stringify({
        'one piece': { seriesKey: 'one piece', event: 'sync', at: '2026-01-01T00:00:00.000Z' },
        naruto: { seriesKey: 'naruto', event: 'nope', at: 'x' },
        bleach: null,
        undefined: undefined,
        mismatched: { seriesKey: 'other', event: 'sync', at: 'x' },
        keyless: { event: 'restart', at: 'x' }
      })
    );
    expect(readPendingPushes()).toEqual({
      'one piece': { seriesKey: 'one piece', event: 'sync', at: '2026-01-01T00:00:00.000Z' }
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

  it('flushes the queue when a signed-out session logs in', async () => {
    localStorage.setItem(
      'anilist_pending_pushes',
      JSON.stringify({
        'one piece': { seriesKey: 'one piece', event: 'sync', at: '2026-01-01T00:00:00.000Z' }
      })
    );
    h.auth.token = null;
    h.userStore.set(null);
    const dispose = initProgressTracker();
    expect(anilistRequest).not.toHaveBeenCalled();

    h.auth.token = 'tok';
    vi.mocked(anilistRequest).mockResolvedValue({
      Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 9, repeat: 0 } }
    });
    h.userStore.set({ id: 1, name: 'n' });
    await vi.waitFor(() => expect(anilistRequest).toHaveBeenCalledTimes(1));
    dispose();
    h.userStore.set({ id: 1, name: 'n' });
  });
});
