import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

async function load() {
  vi.resetModules();
  return import('./series-view-prefs');
}

beforeEach(() => localStorage.clear());

describe('series page preferences', () => {
  it('default to the grid, unread first', async () => {
    const { seriesViewMode, seriesSortMode } = await load();
    expect(get(seriesViewMode)).toBe('grid');
    expect(get(seriesSortMode)).toBe('unread-first');
  });

  it('read what SeriesView stored under the same two keys', async () => {
    localStorage.setItem('series-view-mode', 'list');
    localStorage.setItem('series-sort-mode', 'reverse-alphabetical');
    const { seriesViewMode, seriesSortMode } = await load();
    expect(get(seriesViewMode)).toBe('list');
    expect(get(seriesSortMode)).toBe('reverse-alphabetical');
  });

  it('write through to the same keys', async () => {
    const { seriesViewMode, seriesSortMode } = await load();
    seriesViewMode.set('list');
    seriesSortMode.set('alphabetical');
    expect(localStorage.getItem('series-view-mode')).toBe('list');
    expect(localStorage.getItem('series-sort-mode')).toBe('alphabetical');
  });

  it('ignore a stored value that is not one of the modes', async () => {
    localStorage.setItem('series-view-mode', 'carousel');
    localStorage.setItem('series-sort-mode', '');
    const { seriesViewMode, seriesSortMode } = await load();
    expect(get(seriesViewMode)).toBe('grid');
    expect(get(seriesSortMode)).toBe('unread-first');
  });

  it('take up a value another tab stored when the series page mounts', async () => {
    const { seriesViewMode, seriesSortMode, refreshSeriesViewPrefs } = await load();
    localStorage.setItem('series-view-mode', 'list');
    localStorage.setItem('series-sort-mode', 'bogus');
    expect(get(seriesViewMode)).toBe('grid');
    refreshSeriesViewPrefs();
    expect(get(seriesViewMode)).toBe('list');
    // An invalid stored value changes nothing.
    expect(get(seriesSortMode)).toBe('unread-first');
  });
});
