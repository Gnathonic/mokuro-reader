import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata } from './types';

// vi.mock factories are hoisted above imports, so the stores they close over are
// hand-rolled here rather than built with svelte/store's `writable` — see
// catalog-store.test.ts / progress-tracker.test.ts for the same pattern.
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

  return {
    volumesStore: createStore<Record<string, any>>({}),
    metaByKey: new Map<string, SeriesMetadata>()
  };
});

vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('$lib/settings/volume-data', () => ({
  volumes: h.volumesStore,
  archiveAndResetVolumes: vi.fn()
}));

vi.mock('./store', () => ({
  getSeriesMetadataForTitle: vi.fn(async (title: string) =>
    h.metaByKey.get(title.trim().replace(/\s+/g, ' ').toLowerCase())
  ),
  updateSeriesMetadata: vi.fn(async (title: string, patch: any) => patch)
}));

vi.mock('./progress-tracker', () => ({ onSeriesRestarted: vi.fn() }));

import { archiveAndResetVolumes } from '$lib/settings/volume-data';
import { updateSeriesMetadata } from './store';
import { onSeriesRestarted } from './progress-tracker';
import {
  dismissRereadForSession,
  restartSeries,
  shouldOfferReread,
  suppressRereadPrompt
} from './reread';

/** Resolve `updateSeriesMetadata`'s patch arg (plain object or functional patch) against a fake existing record. */
const resolvePatch = (patch: any, existing: Partial<SeriesMetadata> = {}) =>
  typeof patch === 'function' ? patch(existing as SeriesMetadata) : patch;

const vol = (uuid: string, title: string, extra: Partial<VolumeMetadata> = {}): VolumeMetadata =>
  ({
    volume_uuid: uuid,
    volume_title: title,
    series_title: 'One Piece',
    series_uuid: 's',
    ...extra
  }) as VolumeMetadata;
const series = [vol('b', 'Vol 02'), vol('a', 'Vol 01'), vol('c', 'Vol 03')]; // unsorted on purpose
const allDone = { a: { completed: true }, b: { completed: true }, c: { completed: true } };

describe('shouldOfferReread', () => {
  beforeEach(() => sessionStorage.clear());

  const base = {
    seriesVolumes: series,
    volumesData: allDone,
    meta: undefined,
    seriesKey: 'one piece'
  };

  it('offers on the first volume of a fully completed series', () => {
    expect(shouldOfferReread({ ...base, volumeUuid: 'a' })).toBe(true);
  });
  it('never offers on a non-first volume', () => {
    expect(shouldOfferReread({ ...base, volumeUuid: 'b' })).toBe(false);
  });
  it('does not offer when any volume is incomplete', () => {
    expect(
      shouldOfferReread({
        ...base,
        volumeUuid: 'a',
        volumesData: { ...allDone, c: { completed: false } }
      })
    ).toBe(false);
  });
  it('respects the per-series suppression and the session dismissal', () => {
    expect(
      shouldOfferReread({
        ...base,
        volumeUuid: 'a',
        meta: { reread_prompt_suppressed: true } as SeriesMetadata
      })
    ).toBe(false);
    dismissRereadForSession('one piece');
    expect(shouldOfferReread({ ...base, volumeUuid: 'a' })).toBe(false);
  });
  it('is false for an empty series', () => {
    expect(shouldOfferReread({ ...base, volumeUuid: 'a', seriesVolumes: [] })).toBe(false);
  });
  it('offers for a single-volume series that is complete', () => {
    const single = [vol('solo', 'Vol 01')];
    expect(
      shouldOfferReread({
        volumeUuid: 'solo',
        seriesVolumes: single,
        volumesData: { solo: { completed: true } },
        meta: undefined,
        seriesKey: 'one piece'
      })
    ).toBe(true);
  });

  describe('placeholder handling', () => {
    // 'a' (Vol 01) sorts first but is cloud-only; 'b' (Vol 02) is the first LOCAL volume.
    const withLeadingPlaceholder = [
      vol('a', 'Vol 01', { isPlaceholder: true }),
      vol('b', 'Vol 02'),
      vol('c', 'Vol 03')
    ];

    it('treats the first non-placeholder volume as "first" when a placeholder sorts earlier', () => {
      expect(
        shouldOfferReread({
          volumeUuid: 'b',
          seriesVolumes: withLeadingPlaceholder,
          volumesData: { b: { completed: true }, c: { completed: true } },
          meta: undefined,
          seriesKey: 'one piece'
        })
      ).toBe(true);
    });

    it('never offers on the placeholder itself, even though it sorts first', () => {
      expect(
        shouldOfferReread({
          volumeUuid: 'a',
          seriesVolumes: withLeadingPlaceholder,
          volumesData: { b: { completed: true }, c: { completed: true } },
          meta: undefined,
          seriesKey: 'one piece'
        })
      ).toBe(false);
    });

    it('ignores placeholders (no local completion data) when checking "all completed"', () => {
      // Placeholder 'a' has no entry in volumesData at all; it must not block the prompt.
      expect(
        shouldOfferReread({
          volumeUuid: 'b',
          seriesVolumes: withLeadingPlaceholder,
          volumesData: { b: { completed: true }, c: { completed: true } },
          meta: undefined,
          seriesKey: 'one piece'
        })
      ).toBe(true);
    });
  });
});

describe('restartSeries', () => {
  beforeEach(() => {
    vi.mocked(archiveAndResetVolumes).mockClear();
    vi.mocked(updateSeriesMetadata).mockClear();
    vi.mocked(onSeriesRestarted).mockClear();
    h.metaByKey.clear();
    sessionStorage.clear();
  });

  it('archives, bumps read_count when the series was fully read, clears suppression, notifies tracker', async () => {
    h.volumesStore.set(allDone);
    dismissRereadForSession('one piece');

    await restartSeries('One Piece', series);

    expect(archiveAndResetVolumes).toHaveBeenCalledWith(['b', 'a', 'c']);
    const [title, patch] = vi.mocked(updateSeriesMetadata).mock.calls[0];
    expect(title).toBe('One Piece');
    // Race-free: read_count is bumped off the record as read inside the write
    // transaction (simulated here via a fake "existing" record), not a value
    // read earlier.
    expect(resolvePatch(patch, { read_count: 1 })).toEqual({
      read_count: 2,
      reread_prompt_suppressed: undefined
    });
    expect(sessionStorage.getItem('reread_dismissed:one piece')).toBeNull();
    expect(onSeriesRestarted).toHaveBeenCalledWith('one piece');
  });

  it('does not touch read_count for a partially read series, only clears suppression', async () => {
    h.volumesStore.set({ a: { completed: true } });
    await restartSeries('One Piece', series);
    const [, patch] = vi.mocked(updateSeriesMetadata).mock.calls[0];
    const resolved = resolvePatch(patch, { read_count: 5 });
    expect(resolved).toEqual({ reread_prompt_suppressed: undefined });
    expect(resolved).not.toHaveProperty('read_count');
  });

  it('suppressRereadPrompt persists the flag', async () => {
    await suppressRereadPrompt('One Piece');
    expect(updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
      reread_prompt_suppressed: true
    });
  });

  it('calls onSeriesRestarted only after the archive and metadata writes complete', async () => {
    const calls: string[] = [];
    vi.mocked(archiveAndResetVolumes).mockImplementation(() => {
      calls.push('archive');
    });
    vi.mocked(updateSeriesMetadata).mockImplementation(async (...args: any[]) => {
      calls.push('updateMeta');
      return args[1];
    });
    vi.mocked(onSeriesRestarted).mockImplementation(() => {
      calls.push('restarted');
    });
    h.volumesStore.set(allDone);

    await restartSeries('One Piece', series);

    expect(calls).toEqual(['archive', 'updateMeta', 'restarted']);
  });

  it('does not archive placeholder volumes and ignores them when checking full completion', async () => {
    const withPlaceholder = [...series, vol('p', 'Vol 04', { isPlaceholder: true })];
    h.volumesStore.set(allDone); // no entry for 'p' — it's cloud-only, never downloaded

    await restartSeries('One Piece', withPlaceholder);

    expect(archiveAndResetVolumes).toHaveBeenCalledWith(['b', 'a', 'c']);
    const [, patch] = vi.mocked(updateSeriesMetadata).mock.calls[0];
    expect(resolvePatch(patch, { read_count: 0 })).toEqual({
      read_count: 1,
      reread_prompt_suppressed: undefined
    });
  });
});
