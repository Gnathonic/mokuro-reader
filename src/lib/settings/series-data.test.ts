import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

import {
  SERIES_SECTION_KEY,
  clearSeriesReadingState,
  detectBogusSeriesKeys,
  mergeSeriesSections,
  moveSeriesReadingStateKey,
  parseSeriesSection,
  readingStateFor,
  seriesReadingState,
  updateSeriesReadingState
} from './series-data';

describe('series reading state', () => {
  beforeEach(() => {
    clearSeriesReadingState();
    window.localStorage.clear();
  });

  it('reserves the section key so it can never collide with a volume uuid', () => {
    expect(SERIES_SECTION_KEY).toBe('series');
  });

  it('defaults to a zeroed state for an unknown series', () => {
    const state = readingStateFor(get(seriesReadingState), 'one piece');
    expect(state.read_count).toBe(0);
    expect(state.reread_prompt_suppressed).toBeUndefined();
    expect(state.tracking).toBeUndefined();
  });

  it('stamps every write and resolves a functional patch against the stored state', () => {
    const first = updateSeriesReadingState('one piece', { read_count: 1 });
    const second = updateSeriesReadingState('one piece', (existing) => ({
      read_count: existing.read_count + 1
    }));

    expect(second.read_count).toBe(2);
    expect(second.lastUpdated > first.lastUpdated).toBe(true);
    expect(get(seriesReadingState)['one piece'].read_count).toBe(2);
  });

  it('steps past a stored stamp that sits in the future (clock skew)', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    seriesReadingState.set({
      'one piece': { read_count: 1, lastUpdated: future }
    });

    const written = updateSeriesReadingState('one piece', { read_count: 2 });

    expect(written.lastUpdated > future).toBe(true);
  });

  it('clears a flag by patching it to undefined', () => {
    updateSeriesReadingState('one piece', { reread_prompt_suppressed: true });
    const cleared = updateSeriesReadingState('one piece', {
      reread_prompt_suppressed: undefined
    });

    expect('reread_prompt_suppressed' in cleared).toBe(false);
  });

  it('persists to localStorage under the volume-data section key', () => {
    updateSeriesReadingState('one piece', { read_count: 3 });
    expect(JSON.parse(window.localStorage.getItem('series-data')!)).toEqual({
      'one piece': { read_count: 3, lastUpdated: expect.any(String) }
    });
  });

  it('sanitizes an untrusted section: junk counts, junk flags, junk tracking', () => {
    const parsed = parseSeriesSection({
      'one piece': {
        read_count: -3,
        reread_prompt_suppressed: 'yes',
        tracking: { number_overrides: { 'vol-1': 2.5, 'vol-2': 4 }, enabled: true },
        lastUpdated: '2026-08-01T00:00:00.000Z'
      },
      berserk: { read_count: 2, lastUpdated: 'not a date' },
      '': { read_count: 9, lastUpdated: '2026-08-01T00:00:00.000Z' },
      nope: 'not an object'
    });

    expect(parsed).toEqual({
      'one piece': {
        read_count: 0,
        tracking: { number_overrides: { 'vol-2': 4 } },
        lastUpdated: '2026-08-01T00:00:00.000Z'
      },
      berserk: { read_count: 2, lastUpdated: new Date(0).toISOString() }
    });
  });

  it('merges newest-lastUpdated-wins per series, keeping local on a tie', () => {
    const local = {
      'one piece': { read_count: 2, lastUpdated: '2026-08-10T00:00:00.000Z' },
      berserk: { read_count: 1, lastUpdated: '2026-08-10T00:00:00.000Z' }
    };
    const cloud = {
      'one piece': { read_count: 5, lastUpdated: '2026-08-20T00:00:00.000Z' },
      berserk: { read_count: 9, lastUpdated: '2026-08-10T00:00:00.000Z' },
      vinland: { read_count: 1, lastUpdated: '2026-08-05T00:00:00.000Z' }
    };

    expect(mergeSeriesSections(local, cloud)).toEqual({
      'one piece': { read_count: 5, lastUpdated: '2026-08-20T00:00:00.000Z' },
      berserk: { read_count: 1, lastUpdated: '2026-08-10T00:00:00.000Z' },
      vinland: { read_count: 1, lastUpdated: '2026-08-05T00:00:00.000Z' }
    });
  });

  it('does not let a bogus cloud key out-rank an existing local entry — FORFEIT-ON-BOGUS', () => {
    // The cloud entry here is already-clamped (as `parseSeriesSection` would
    // hand it over), so on stamps alone it looks newer than local. `bogusKeys`
    // is how the caller (`syncVolumeData`, which has the RAW section) tells
    // this function the clamp is masking a poisoned stamp — local must win
    // outright rather than by a stamp comparison the clamp already rigged.
    const local = { 'one piece': { read_count: 9, lastUpdated: '2026-08-23T11:59:00.000Z' } };
    const cloud = { 'one piece': { read_count: 2, lastUpdated: '2026-08-23T12:00:00.000Z' } };

    expect(mergeSeriesSections(local, cloud, new Set(['one piece']))).toEqual(local);
  });

  it('still adopts a bogus cloud key (healed) when local has no entry for it', () => {
    // No local content to protect — the clamped/healed cloud value is the
    // only copy of this series' state, so it is adopted rather than dropped.
    const cloud = { 'one piece': { read_count: 2, lastUpdated: '2026-08-23T12:00:00.000Z' } };

    expect(mergeSeriesSections({}, cloud, new Set(['one piece']))).toEqual(cloud);
  });

  describe('detectBogusSeriesKeys', () => {
    const now = Date.parse('2026-08-23T12:00:00.000Z');

    it('flags a key whose RAW lastUpdated is more than 5 minutes ahead of now', () => {
      const bogus = detectBogusSeriesKeys(
        { 'one piece': { lastUpdated: '2999-01-01T00:00:00.000Z' } },
        now
      );
      expect(bogus).toEqual(new Set(['one piece']));
    });

    it('does not flag an ordinary stamp or one within the 5-minute tolerance', () => {
      const bogus = detectBogusSeriesKeys(
        {
          'one piece': { lastUpdated: '2026-08-20T00:00:00.000Z' },
          berserk: { lastUpdated: new Date(now + 60_000).toISOString() }
        },
        now
      );
      expect(bogus.size).toBe(0);
    });

    it('ignores non-record input and malformed entries', () => {
      expect(detectBogusSeriesKeys(null, now)).toEqual(new Set());
      expect(
        detectBogusSeriesKeys({ '': { lastUpdated: '2999-01-01T00:00:00.000Z' } }, now)
      ).toEqual(new Set());
      expect(detectBogusSeriesKeys({ key: 'not an object' }, now)).toEqual(new Set());
    });
  });

  describe('moveSeriesReadingStateKey', () => {
    const state = (read_count: number, lastUpdated: string) => ({ read_count, lastUpdated });

    it('carries the state to the renamed series', () => {
      seriesReadingState.set({ 'one piece': state(3, '2026-08-10T00:00:00.000Z') });

      moveSeriesReadingStateKey('One Piece', 'One Piece Digital');

      expect(get(seriesReadingState)).toEqual({
        'one piece digital': state(3, '2026-08-10T00:00:00.000Z')
      });
    });

    it('does nothing when the old series has no state at all', () => {
      seriesReadingState.set({ berserk: state(1, '2026-08-10T00:00:00.000Z') });

      moveSeriesReadingStateKey('Nothing Here', 'Something');

      expect(get(seriesReadingState)).toEqual({ berserk: state(1, '2026-08-10T00:00:00.000Z') });
    });

    it('keeps the state when only case/whitespace changed (same key)', () => {
      seriesReadingState.set({ 'one piece': state(3, '2026-08-10T00:00:00.000Z') });

      moveSeriesReadingStateKey('one piece', 'One  Piece');

      expect(get(seriesReadingState)).toEqual({
        'one piece': state(3, '2026-08-10T00:00:00.000Z')
      });
    });

    it('keeps the newer state on a collision, in both directions', () => {
      seriesReadingState.set({
        old: state(1, '2026-08-01T00:00:00.000Z'),
        new: state(9, '2026-08-20T00:00:00.000Z')
      });

      moveSeriesReadingStateKey('old', 'new');

      expect(get(seriesReadingState)).toEqual({ new: state(9, '2026-08-20T00:00:00.000Z') });

      seriesReadingState.set({
        old: state(4, '2026-08-22T00:00:00.000Z'),
        new: state(9, '2026-08-20T00:00:00.000Z')
      });

      moveSeriesReadingStateKey('old', 'new');

      expect(get(seriesReadingState)).toEqual({ new: state(4, '2026-08-22T00:00:00.000Z') });
    });
  });
});
