import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  currentView,
  initRouter,
  isVolumeOpen,
  nav,
  navigateBack,
  parseHash,
  viewToHash
} from '$lib/util/hash-router';
import { get } from 'svelte/store';
import { snackbarStore } from '$lib/util/snackbar';

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

describe('isVolumeOpen', () => {
  test('is true for the volume in the reader or its text view, and for no other', () => {
    currentView.set({ type: 'reader', seriesId: 's', volumeId: 'v1' });
    expect(isVolumeOpen('v1')).toBe(true);
    expect(isVolumeOpen('v2')).toBe(false);

    currentView.set({ type: 'volume-text', seriesId: 's', volumeId: 'v1' });
    expect(isVolumeOpen('v1')).toBe(true);

    // The series page shows covers, not pages: a row write there reloads nothing.
    currentView.set({ type: 'series', seriesId: 's' });
    expect(isVolumeOpen('v1')).toBe(false);
    currentView.set({ type: 'catalog' });
    expect(isVolumeOpen('v1')).toBe(false);
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
    snackbarStore.set(undefined);
  });

  test('stores the token and restores the pre-login route', () => {
    sessionStorage.setItem(
      'anilist_return',
      JSON.stringify({ hash: '#/series/One%20Piece', at: Date.now() })
    );
    window.location.hash = '#access_token=tok123&token_type=Bearer&expires_in=3600';
    const cleanup = initRouter();
    expect(localStorage.getItem('anilist_token')).toBe('tok123');
    expect(window.location.hash).toBe('#/series/One%20Piece');
    cleanup();
  });

  test('accepts the callback whatever order AniList orders the fragment in', () => {
    // AniList picks the parameter order; a `#access_token=` prefix test would
    // silently drop this login and strand the user on the catalog.
    sessionStorage.setItem(
      'anilist_return',
      JSON.stringify({ hash: '#/series/One%20Piece', at: Date.now() })
    );
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
    sessionStorage.setItem(
      'anilist_return',
      JSON.stringify({ hash: '//evil.example.com', at: Date.now() })
    );
    window.location.hash = '#access_token=tok123&token_type=Bearer&expires_in=3600';
    const cleanup = initRouter();
    expect(window.location.hash).toBe('#/catalog');
    expect(localStorage.getItem('anilist_token')).toBe('tok123');
    cleanup();
  });

  test('rejects a callback for a login abandoned more than 10 minutes ago', () => {
    // The user left for AniList, gave up, and later opened an attacker's
    // link in the same tab: the stale marker must not let it log them in.
    sessionStorage.setItem(
      'anilist_return',
      JSON.stringify({ hash: '#/series/One%20Piece', at: Date.now() - 10 * 60 * 1000 - 1 })
    );
    window.location.hash = '#access_token=attacker-token&token_type=Bearer&expires_in=3600';
    const cleanup = initRouter();
    expect(localStorage.getItem('anilist_token')).toBeNull();
    expect(sessionStorage.getItem('anilist_return')).toBeNull();
    cleanup();
  });

  test('a login that took over 10 minutes says so, and goes back where it started', () => {
    // A slow sign-in (2FA, a password reset, the page left open) is refused
    // like an abandoned one, but the user is told why instead of landing
    // on the catalog with AniList still disconnected and no word.
    sessionStorage.setItem(
      'anilist_return',
      JSON.stringify({ hash: '#/series/One%20Piece', at: Date.now() - 11 * 60 * 1000 })
    );
    window.location.hash = '#access_token=x&expires_in=1';
    const cleanup = initRouter();
    expect(localStorage.getItem('anilist_token')).toBeNull();
    expect(window.location.hash).toBe('#/series/One%20Piece');
    expect(get(snackbarStore)?.message).toContain('took over 10 minutes');
    expect(get(snackbarStore)?.message).toContain('Connect again from Settings');
    cleanup();
  });

  test('a callback this tab never asked for is refused out loud', () => {
    window.location.hash = '#access_token=attacker-token&token_type=Bearer&expires_in=3600';
    const cleanup = initRouter();
    expect(localStorage.getItem('anilist_token')).toBeNull();
    expect(get(snackbarStore)?.message).toContain('was not started in this tab');
    cleanup();
  });

  test('an expired marker that holds an unsafe route still lands on the catalog', () => {
    sessionStorage.setItem(
      'anilist_return',
      JSON.stringify({ hash: '//evil.example.com', at: Date.now() - 11 * 60 * 1000 })
    );
    window.location.hash = '#access_token=x&expires_in=1';
    const cleanup = initRouter();
    expect(window.location.hash).toBe('#/catalog');
    expect(localStorage.getItem('anilist_token')).toBeNull();
    cleanup();
  });

  test('a login this tab started is not refused', () => {
    sessionStorage.setItem('anilist_return', JSON.stringify({ hash: '#/catalog', at: Date.now() }));
    window.location.hash = '#access_token=tok789&expires_in=3600';
    const cleanup = initRouter();
    expect(localStorage.getItem('anilist_token')).toBe('tok789');
    expect(get(snackbarStore)?.message ?? '').not.toContain('was not used');
    cleanup();
  });

  test('coming back without a token ends the pending login', () => {
    sessionStorage.setItem(
      'anilist_return',
      JSON.stringify({ hash: '#/series/One%20Piece', at: Date.now() })
    );
    // Back on AniList's page: the app loads on an ordinary route.
    window.location.hash = '#/series/One%20Piece';
    const cleanup = initRouter();
    expect(sessionStorage.getItem('anilist_return')).toBeNull();
    cleanup();

    // So a forged callback opened next in this tab is refused.
    window.location.hash = '#access_token=attacker-token&token_type=Bearer&expires_in=3600';
    const again = initRouter();
    expect(localStorage.getItem('anilist_token')).toBeNull();
    again();
  });

  test('a back/forward-cache restore without a token ends the pending login too', () => {
    window.location.hash = '#/catalog';
    const cleanup = initRouter();
    sessionStorage.setItem('anilist_return', JSON.stringify({ hash: '#/catalog', at: Date.now() }));
    // A normal pageshow (first load) leaves it; a restored page does not.
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    expect(sessionStorage.getItem('anilist_return')).not.toBeNull();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(sessionStorage.getItem('anilist_return')).toBeNull();
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

/**
 * A link can only OPEN a view: the query a link carries never reaches the view
 * object, so no route can be told to log in, log out, delete or sync. The two
 * views that read their own query (`#/upload`, `#/cloud`) ask or only fill a
 * form — see UploadView.confirm.test.ts and link-safety.test.ts.
 */
describe('deep links carry no actions', () => {
  test.each([
    ['#/cloud?server=https://dav.example.com&action=logout', { type: 'cloud' }],
    ['#/cloud?login=1&sync=1', { type: 'cloud' }],
    ['#/upload?cbz=https://e.example.com/a.cbz&confirm=1', { type: 'upload' }],
    ['#/series/One%20Piece?delete=1', { type: 'series', seriesId: 'One Piece' }],
    [
      '#/reader/One%20Piece/uuid-1?deleteCloud=1',
      { type: 'reader', seriesId: 'One Piece', volumeId: 'uuid-1' }
    ],
    ['#/merge-series?execute=1', { type: 'merge-series' }],
    ['#/catalog?clear=1', { type: 'catalog' }]
  ])('%s opens the view and nothing more', (hash, view) => {
    expect(parseHash(hash)).toEqual(view);
  });
});
