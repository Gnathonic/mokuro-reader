import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

import {
  SERIES_SECTION_KEY,
  clearSeriesReadingState,
  mergeSeriesSections,
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
});
