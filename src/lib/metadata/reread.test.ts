import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

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
    volumesStore: createStore<Record<string, any>>({})
  };
});

vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('$lib/settings/volume-data', () => ({
  volumes: h.volumesStore,
  archiveAndResetVolumes: vi.fn()
}));

vi.mock('./progress-tracker', () => ({ onSeriesRestarted: vi.fn() }));

import { archiveAndResetVolumes } from '$lib/settings/volume-data';
// The reading-state store is the real one: it is a plain synchronous store over
// localStorage, and its write semantics (functional patch, cleared flags
// dropped) are exactly what these tests are about.
import {
  clearSeriesReadingState,
  getSeriesReadingState,
  seriesReadingState,
  updateSeriesReadingState
} from '$lib/settings/series-data';
import { onSeriesRestarted } from './progress-tracker';
import {
  dismissRereadForSession,
  restartSeries,
  shouldOfferReread,
  suppressRereadPrompt
} from './reread';

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
    suppressed: false,
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
    expect(shouldOfferReread({ ...base, volumeUuid: 'a', suppressed: true })).toBe(false);
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
        suppressed: false,
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
          suppressed: false,
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
          suppressed: false,
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
          suppressed: false,
          seriesKey: 'one piece'
        })
      ).toBe(true);
    });
  });
});

describe('restartSeries', () => {
  beforeEach(() => {
    vi.mocked(archiveAndResetVolumes).mockClear();
    vi.mocked(onSeriesRestarted).mockClear();
    clearSeriesReadingState();
    sessionStorage.clear();
  });

  it('archives, bumps read_count when the series was fully read, clears suppression, notifies tracker', async () => {
    updateSeriesReadingState('one piece', { read_count: 1, reread_prompt_suppressed: true });
    h.volumesStore.set(allDone);
    dismissRereadForSession('one piece');

    await restartSeries('One Piece', series);

    expect(archiveAndResetVolumes).toHaveBeenCalledWith(['b', 'a', 'c']);
    // Race-free: the bump is applied to the state as stored at write time (a
    // functional patch), not to a value read before the archive ran.
    expect(getSeriesReadingState('one piece').read_count).toBe(2);
    expect(getSeriesReadingState('one piece').reread_prompt_suppressed).toBeUndefined();
    expect(sessionStorage.getItem('reread_dismissed:one piece')).toBeNull();
    expect(onSeriesRestarted).toHaveBeenCalledWith('one piece');
  });

  it('bumps read_count in the reading-state store, not on the metadata record', async () => {
    h.volumesStore.set(allDone);

    await restartSeries('One Piece', series);

    expect(getSeriesReadingState('one piece').read_count).toBe(1);
    expect(getSeriesReadingState('one piece').reread_prompt_suppressed).toBeUndefined();
  });

  it('does not touch read_count for a partially read series, only clears suppression', async () => {
    updateSeriesReadingState('one piece', { read_count: 5, reread_prompt_suppressed: true });
    h.volumesStore.set({ a: { completed: true } });

    await restartSeries('One Piece', series);

    const state = getSeriesReadingState('one piece');
    expect(state.read_count).toBe(5);
    expect('reread_prompt_suppressed' in state).toBe(false);
  });

  it('suppressRereadPrompt writes the flag to the reading-state store', () => {
    suppressRereadPrompt('One Piece');

    expect(getSeriesReadingState('one piece').reread_prompt_suppressed).toBe(true);
  });

  it('calls onSeriesRestarted only after the archive and state writes complete', async () => {
    const calls: string[] = [];
    vi.mocked(archiveAndResetVolumes).mockImplementation(() => {
      calls.push('archive');
    });
    const unsubscribe = seriesReadingState.subscribe(() => calls.push('state'));
    calls.length = 0; // drop the subscription's immediate first emission
    vi.mocked(onSeriesRestarted).mockImplementation(() => {
      calls.push('restarted');
    });
    h.volumesStore.set(allDone);

    await restartSeries('One Piece', series);
    unsubscribe();

    expect(calls).toEqual(['archive', 'state', 'restarted']);
  });

  it('does not archive placeholder volumes and ignores them when checking full completion', async () => {
    const withPlaceholder = [...series, vol('p', 'Vol 04', { isPlaceholder: true })];
    h.volumesStore.set(allDone); // no entry for 'p' — it's cloud-only, never downloaded

    await restartSeries('One Piece', withPlaceholder);

    expect(archiveAndResetVolumes).toHaveBeenCalledWith(['b', 'a', 'c']);
    expect(getSeriesReadingState('one piece').read_count).toBe(1);
  });
});
