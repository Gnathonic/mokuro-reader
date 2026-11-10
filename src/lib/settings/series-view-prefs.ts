/**
 * The series page's sort and layout (#55). They were component state in
 * `SeriesView.svelte`; a store lets a setting definition (and so a key) read
 * and write them. Same localStorage keys and values as before, so nobody's
 * choice is lost.
 */
import { browser } from '$app/environment';
import { writable, type Writable } from 'svelte/store';

export type SeriesViewMode = 'grid' | 'list';
export type SeriesSortMode = 'unread-first' | 'alphabetical' | 'reverse-alphabetical';

export const SERIES_VIEW_MODES: readonly SeriesViewMode[] = ['grid', 'list'];
/** In the order the sort button walks them. */
export const SERIES_SORT_MODES: readonly SeriesSortMode[] = [
  'unread-first',
  'alphabetical',
  'reverse-alphabetical'
];

const VIEW_KEY = 'series-view-mode';
const SORT_KEY = 'series-sort-mode';

function read<T extends string>(key: string, allowed: readonly T[]): T | undefined {
  if (!browser) return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
  } catch {
    // Storage unavailable: the default, unsaved.
  }
  return undefined;
}

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): Writable<T> {
  const store = writable<T>(read(key, allowed) ?? fallback);
  if (browser) {
    store.subscribe((value) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Not saved; the page still works.
      }
    });
  }
  return store;
}

export const seriesViewMode = stored<SeriesViewMode>(VIEW_KEY, SERIES_VIEW_MODES, 'grid');
export const seriesSortMode = stored<SeriesSortMode>(SORT_KEY, SERIES_SORT_MODES, 'unread-first');

/**
 * Take up what is in storage now. The series page calls this when it mounts,
 * as it always read both keys then: a choice made in another tab applies to
 * the next series opened here, without a reload.
 */
export function refreshSeriesViewPrefs(): void {
  const view = read(VIEW_KEY, SERIES_VIEW_MODES);
  if (view) seriesViewMode.set(view);
  const sort = read(SORT_KEY, SERIES_SORT_MODES);
  if (sort) seriesSortMode.set(sort);
}
