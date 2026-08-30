import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  currentView,
  initRouter,
  nav,
  navigateBack,
  parseHash,
  viewToHash
} from '$lib/util/hash-router';
import { get } from 'svelte/store';

vi.mock('$lib/metadata/providers/anilist', () => ({
  anilistRequest: vi.fn().mockResolvedValue({ Viewer: null })
}));

describe('parseHash', () => {
  test('handles merge-series route', () => {
    const result = parseHash('#/merge-series');
    expect(result).toEqual({ type: 'merge-series' });
  });

  test('handles progress-tracker route', () => {
    const result = parseHash('#/progress-tracker');
    expect(result).toEqual({ type: 'progress-tracker' });
  });

  test('handles manage-goals route', () => {
    const result = parseHash('#/manage-goals');
    expect(result).toEqual({ type: 'manage-goals' });
  });

  test('ignores trailing segments on the parameterless tracker route', () => {
    // The tracker takes no params, so a stale deep link must still land on the
    // tracker rather than falling through to the catalog.
    expect(parseHash('#/progress-tracker/anything')).toEqual({ type: 'progress-tracker' });
    expect(parseHash('#/manage-goals/anything')).toEqual({ type: 'manage-goals' });
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

  test('generates progress-tracker hash', () => {
    const result = viewToHash({ type: 'progress-tracker' });
    expect(result).toBe('#/progress-tracker');
  });

  test('generates manage-goals hash', () => {
    const result = viewToHash({ type: 'manage-goals' });
    expect(result).toBe('#/manage-goals');
  });

  test('the tracker views survive a hash round trip', () => {
    // A bookmarked or reloaded tracker URL has to come back as the same view.
    for (const view of [{ type: 'progress-tracker' }, { type: 'manage-goals' }] as const) {
      expect(parseHash(viewToHash(view))).toEqual(view);
    }
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

describe('navigateBack', () => {
  test('manage-goals goes up to the tracker, matching its own "Back to Progress" button', () => {
    // Escape and the on-screen button must land in the same place; sending
    // Escape to the catalog would skip the level the button returns to.
    currentView.set({ type: 'manage-goals' });
    navigateBack();
    expect(get(currentView)).toEqual({ type: 'progress-tracker' });
  });

  test('progress-tracker goes up to the catalog', () => {
    currentView.set({ type: 'progress-tracker' });
    navigateBack();
    expect(get(currentView)).toEqual({ type: 'catalog' });
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

  test('accepts the callback whatever order AniList orders the fragment in', () => {
    // AniList picks the parameter order; a `#access_token=` prefix test would
    // silently drop this login and strand the user on the catalog.
    sessionStorage.setItem('anilist_return', '#/series/One%20Piece');
    window.location.hash = '#token_type=Bearer&expires_in=3600&access_token=tok456';
    const cleanup = initRouter();
    expect(localStorage.getItem('anilist_token')).toBe('tok456');
    expect(window.location.hash).toBe('#/series/One%20Piece');
    cleanup();
  });

  test('still rejects an unsolicited callback in that order (CSRF gate holds)', () => {
    window.location.hash = '#token_type=Bearer&access_token=attacker-token&expires_in=3600';
    const cleanup = initRouter();
    expect(window.location.hash).toBe('#/catalog');
    expect(localStorage.getItem('anilist_token')).toBeNull();
    cleanup();
  });

  test('rejects an unsolicited callback: no token is stored and the fragment is scrubbed', () => {
    // No `anilist_return` was saved — this tab never called startAniListLogin(),
    // so this hash can only be an attacker-crafted link (login-CSRF). It must
    // be discarded, not treated as a real AniList login.
    window.location.hash = '#access_token=attacker-token&token_type=Bearer&expires_in=3600';
    const cleanup = initRouter();
    expect(window.location.hash).toBe('#/catalog');
    expect(localStorage.getItem('anilist_token')).toBeNull();
    cleanup();
  });

  test('sanitizes an unsafe saved return route before restoring it', () => {
    // The saved return route still proves this tab initiated the login, so the
    // token is trusted — but the route value itself must be validated before
    // it's fed into history.replaceState (a protocol-relative `//host` value
    // could otherwise navigate cross-origin or throw a SecurityError).
    sessionStorage.setItem('anilist_return', '//evil.example.com');
    window.location.hash = '#access_token=tok123&token_type=Bearer&expires_in=3600';
    const cleanup = initRouter();
    expect(window.location.hash).toBe('#/catalog');
    expect(localStorage.getItem('anilist_token')).toBe('tok123');
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
