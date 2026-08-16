import { beforeEach, describe, expect, test, vi } from 'vitest';
import { currentView, initRouter, nav, parseHash, viewToHash } from '$lib/util/hash-router';
import { get } from 'svelte/store';

vi.mock('$lib/metadata/providers/anilist', () => ({
  anilistRequest: vi.fn().mockResolvedValue({ Viewer: null })
}));

describe('parseHash', () => {
  test('handles merge-series route', () => {
    const result = parseHash('#/merge-series');
    expect(result).toEqual({ type: 'merge-series' });
  });

  test('routes libraries path to catalog while feature is hidden', () => {
    const result = parseHash('#/libraries');
    expect(result).toEqual({ type: 'catalog' });
  });

  test('handles upload route with query params', () => {
    const result = parseHash('#/upload?source=https%3A%2F%2Fexample.com&manga=Foo&volume=Bar');
    expect(result).toEqual({ type: 'upload' });
  });

  test('routes add-library path to catalog while feature is hidden', () => {
    const result = parseHash('#/add-library');
    expect(result).toEqual({ type: 'catalog' });
  });

  test('routes add-library path with params to catalog while feature is hidden', () => {
    const result = parseHash(
      '#/add-library?url=https%3A%2F%2Fexample.com%2Fdav&name=My+Library&path=%2Fmanga'
    );
    expect(result).toEqual({ type: 'catalog' });
  });
});

describe('viewToHash', () => {
  test('generates merge-series hash', () => {
    const result = viewToHash({ type: 'merge-series' });
    expect(result).toBe('#/merge-series');
  });
});

describe('removed libraries routes', () => {
  test('stale #/libraries and #/add-library bookmarks fall back to catalog', () => {
    expect(parseHash('#/libraries')).toEqual({ type: 'catalog' });
    expect(parseHash('#/add-library?url=x')).toEqual({ type: 'catalog' });
  });
});

describe('nav helpers', () => {
  test('nav.toMergeSeries exists and is callable', () => {
    expect(typeof nav.toMergeSeries).toBe('function');
  });
});

describe('AniList implicit-grant callback', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  test('stores the token and restores the pre-login route', () => {
    sessionStorage.setItem('anilist_return', '#/series/One%20Piece');
    window.location.hash = '#access_token=tok123&token_type=Bearer&expires_in=3600';
    const cleanup = initRouter();
    expect(localStorage.getItem('anilist_token')).toBe('tok123');
    expect(window.location.hash).toBe('#/series/One%20Piece');
    cleanup();
  });

  test('falls back to the catalog when no return route was saved', () => {
    window.location.hash = '#access_token=tok123&token_type=Bearer&expires_in=3600';
    const cleanup = initRouter();
    expect(window.location.hash).toBe('#/catalog');
    cleanup();
  });

  test('a normal hash is untouched and still routes', () => {
    window.location.hash = '#/series/some-series';
    const cleanup = initRouter();
    expect(window.location.hash).toBe('#/series/some-series');
    expect(localStorage.getItem('anilist_token')).toBeNull();
    expect(get(currentView)).toEqual({ type: 'series', seriesId: 'some-series' });
    cleanup();
  });
});
