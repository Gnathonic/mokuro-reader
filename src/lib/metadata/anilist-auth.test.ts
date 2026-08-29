import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
vi.mock('./providers/anilist', async () => {
  // Keep the real AniListError class (tests need to throw/inspect real
  // instances) while replacing only the network call itself.
  const actual = await vi.importActual<typeof import('./providers/anilist')>('./providers/anilist');
  return { ...actual, anilistRequest: vi.fn() };
});

import { anilistRequest, AniListError } from './providers/anilist';
import { showSnackbar } from '$lib/util/snackbar';
import {
  anilistUser,
  buildAniListAuthorizeUrl,
  consumeAniListReturnHash,
  disconnectAniList,
  getAniListToken,
  handleAniListCallbackHash,
  isAniListCallbackHash,
  parseAniListCallbackHash,
  startAniListLogin
} from './anilist-auth';

describe('parseAniListCallbackHash', () => {
  it('parses the implicit-grant fragment', () => {
    expect(
      parseAniListCallbackHash('#access_token=abc.def&token_type=Bearer&expires_in=31536000')
    ).toEqual({ accessToken: 'abc.def', expiresInSec: 31536000 });
  });
  it('parses the fragment whatever order the parameters arrive in', () => {
    // The provider chooses the order; a `#access_token=` prefix test would miss this.
    expect(
      parseAniListCallbackHash('#token_type=Bearer&expires_in=31536000&access_token=abc.def')
    ).toEqual({ accessToken: 'abc.def', expiresInSec: 31536000 });
  });
  it('rejects unrelated hashes', () => {
    expect(parseAniListCallbackHash('#/catalog')).toBeNull();
    expect(parseAniListCallbackHash('#access_token=')).toBeNull();
  });
});

describe('isAniListCallbackHash', () => {
  it('accepts a callback fragment in any parameter order', () => {
    expect(isAniListCallbackHash('#access_token=abc&token_type=Bearer')).toBe(true);
    expect(isAniListCallbackHash('#token_type=Bearer&access_token=abc')).toBe(true);
  });
  it('rejects app routes and fragments without a token', () => {
    expect(isAniListCallbackHash('#/catalog')).toBe(false);
    expect(isAniListCallbackHash('#/reader/a/b')).toBe(false);
    expect(isAniListCallbackHash('#token_type=Bearer')).toBe(false);
    expect(isAniListCallbackHash('')).toBe(false);
  });
});

describe('handleAniListCallbackHash', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(anilistRequest).mockReset();
    vi.mocked(showSnackbar).mockClear();
  });

  it('stores token + expiry synchronously and the viewer once fetched', async () => {
    vi.mocked(anilistRequest).mockResolvedValue({ Viewer: { id: 42, name: 'nathan' } });
    const promise = handleAniListCallbackHash(
      '#access_token=tok&token_type=Bearer&expires_in=3600'
    );
    // token must be readable before the Viewer round-trip resolves
    expect(localStorage.getItem('anilist_token')).toBe('tok');
    expect(Number(localStorage.getItem('anilist_token_expires_at'))).toBeGreaterThan(Date.now());
    await expect(promise).resolves.toBe(true);
    expect(anilistRequest).toHaveBeenCalledWith(expect.stringContaining('Viewer'), {}, 'tok');
    expect(get(anilistUser)).toEqual({ id: 42, name: 'nathan' });
    expect(getAniListToken()).toBe('tok');
  });

  it('returns false for a non-callback hash and stores nothing', async () => {
    await expect(handleAniListCallbackHash('#/series/x')).resolves.toBe(false);
    expect(localStorage.getItem('anilist_token')).toBeNull();
  });

  it('expired tokens read back as null and are cleared', () => {
    localStorage.setItem('anilist_token', 'old');
    localStorage.setItem('anilist_token_expires_at', String(Date.now() - 1));
    expect(getAniListToken()).toBeNull();
    expect(localStorage.getItem('anilist_token')).toBeNull();
  });

  it('a corrupt (non-numeric) expiry is treated as invalid, not "never expires"', () => {
    localStorage.setItem('anilist_token', 'old');
    localStorage.setItem('anilist_token_expires_at', 'not-a-number');
    expect(getAniListToken()).toBeNull();
    expect(localStorage.getItem('anilist_token')).toBeNull();
  });

  it('a zero or negative expiry is treated as invalid, not "never expires"', () => {
    localStorage.setItem('anilist_token', 'old');
    localStorage.setItem('anilist_token_expires_at', '0');
    expect(getAniListToken()).toBeNull();
    expect(localStorage.getItem('anilist_token')).toBeNull();

    localStorage.setItem('anilist_token', 'old');
    localStorage.setItem('anilist_token_expires_at', '-5');
    expect(getAniListToken()).toBeNull();
    expect(localStorage.getItem('anilist_token')).toBeNull();
  });

  it('a missing expiry (token set, expiry never written) is treated as invalid', () => {
    localStorage.setItem('anilist_token', 'old');
    expect(getAniListToken()).toBeNull();
    expect(localStorage.getItem('anilist_token')).toBeNull();
  });

  it('returns false and stores nothing when localStorage throws (e.g. quota exceeded)', async () => {
    // This project's jsdom localStorage is a plain-object polyfill (see
    // src/test-setup.ts), not a real Storage instance, so spy on the
    // instance directly rather than Storage.prototype.
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('exceeded the quota', 'QuotaExceededError');
    });
    await expect(
      handleAniListCallbackHash('#access_token=tok&token_type=Bearer&expires_in=3600')
    ).resolves.toBe(false);
    setItemSpy.mockRestore();
    expect(getAniListToken()).toBeNull();
    expect(anilistRequest).not.toHaveBeenCalled();
  });

  it('keeps the token when the Viewer lookup fails with a network error', async () => {
    vi.mocked(anilistRequest).mockRejectedValue(new AniListError('NETWORK', 'offline'));
    await expect(
      handleAniListCallbackHash('#access_token=tok&token_type=Bearer&expires_in=3600')
    ).resolves.toBe(true);
    expect(getAniListToken()).toBe('tok');
  });

  it('drops the token and shows a snackbar when the Viewer lookup is unauthorized', async () => {
    vi.mocked(anilistRequest).mockRejectedValue(new AniListError('UNAUTHORIZED', 'rejected'));
    await expect(
      handleAniListCallbackHash('#access_token=tok&token_type=Bearer&expires_in=3600')
    ).resolves.toBe(true);
    expect(getAniListToken()).toBeNull();
    expect(showSnackbar).toHaveBeenCalledWith('AniList session expired — reconnect in Settings');
  });

  it('disconnect clears everything', async () => {
    vi.mocked(anilistRequest).mockResolvedValue({ Viewer: { id: 1, name: 'x' } });
    await handleAniListCallbackHash('#access_token=tok&token_type=Bearer&expires_in=3600');
    disconnectAniList();
    expect(getAniListToken()).toBeNull();
    expect(get(anilistUser)).toBeNull();
    expect(localStorage.getItem('anilist_user')).toBeNull();
  });
});

describe('anilistConnected', () => {
  // Unlike the rest of this file, these tests need to observe the store's
  // state at specific points relative to module load (freshly booted, no
  // token yet) — something the shared singleton imported at the top of this
  // file can't give once other tests have already mutated it. Each test
  // resets the module registry and re-imports both `./anilist-auth` and its
  // `./providers/anilist` dependency together, so the `anilistRequest` mock
  // it configures is the exact one the fresh module instance calls. This
  // never touches the statically-imported bindings the other 16 tests in
  // this file use (those keep pointing at the original module instance
  // resolved when the file first loaded), so it can't destabilize them.
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it('is false initially when there is no stored token', async () => {
    const fresh = await import('./anilist-auth');
    expect(get(fresh.anilistConnected)).toBe(false);
  });

  it('is true immediately after a successful callback, even before the Viewer resolves', async () => {
    const providers = await import('./providers/anilist');
    let resolveViewer!: (v: { Viewer: { id: number; name: string } }) => void;
    vi.mocked(providers.anilistRequest).mockReturnValue(
      new Promise((resolve) => {
        resolveViewer = resolve;
      })
    );
    const fresh = await import('./anilist-auth');

    const promise = fresh.handleAniListCallbackHash(
      '#access_token=tok&token_type=Bearer&expires_in=3600'
    );
    // Token is stored (and the flag flipped) synchronously, before the
    // Viewer round-trip settles.
    expect(get(fresh.anilistConnected)).toBe(true);

    resolveViewer({ Viewer: { id: 1, name: 'nathan' } });
    await promise;
    expect(get(fresh.anilistConnected)).toBe(true);
  });

  it('is false after disconnectAniList()', async () => {
    const providers = await import('./providers/anilist');
    vi.mocked(providers.anilistRequest).mockResolvedValue({ Viewer: { id: 1, name: 'nathan' } });
    const fresh = await import('./anilist-auth');

    await fresh.handleAniListCallbackHash('#access_token=tok&token_type=Bearer&expires_in=3600');
    expect(get(fresh.anilistConnected)).toBe(true);

    fresh.disconnectAniList();
    expect(get(fresh.anilistConnected)).toBe(false);
  });

  it('is false after handleAniListUnauthorized()', async () => {
    const providers = await import('./providers/anilist');
    vi.mocked(providers.anilistRequest).mockResolvedValue({ Viewer: { id: 1, name: 'nathan' } });
    const fresh = await import('./anilist-auth');

    await fresh.handleAniListCallbackHash('#access_token=tok&token_type=Bearer&expires_in=3600');
    expect(get(fresh.anilistConnected)).toBe(true);

    fresh.handleAniListUnauthorized();
    expect(get(fresh.anilistConnected)).toBe(false);
  });

  it('is false once getAniListToken() detects an expired token', async () => {
    const providers = await import('./providers/anilist');
    vi.mocked(providers.anilistRequest).mockResolvedValue({ Viewer: { id: 1, name: 'nathan' } });
    const fresh = await import('./anilist-auth');

    await fresh.handleAniListCallbackHash('#access_token=tok&token_type=Bearer&expires_in=3600');
    expect(get(fresh.anilistConnected)).toBe(true);

    // Simulate the token expiring without another callback happening — the
    // flag should only flip on the next actual check, exercising the
    // detection branch inside getAniListToken() itself (not just the
    // module-load initializer).
    localStorage.setItem('anilist_token_expires_at', String(Date.now() - 1));
    expect(fresh.getAniListToken()).toBeNull();
    expect(get(fresh.anilistConnected)).toBe(false);
  });
});

describe('return hash', () => {
  it('consumes the saved return hash once', () => {
    sessionStorage.setItem('anilist_return', '#/series/One%20Piece');
    expect(consumeAniListReturnHash()).toBe('#/series/One%20Piece');
    expect(consumeAniListReturnHash()).toBeNull();
  });
});

describe('buildAniListAuthorizeUrl', () => {
  it('uses the implicit grant', () => {
    expect(buildAniListAuthorizeUrl('123')).toBe(
      'https://anilist.co/api/v2/oauth/authorize?client_id=123&response_type=token'
    );
  });
});

describe('startAniListLogin', () => {
  let assignMock: ReturnType<typeof vi.fn>;
  const originalLocation = window.location;

  beforeEach(() => {
    sessionStorage.clear();
    vi.unstubAllEnvs();
    assignMock = vi.fn();
    // jsdom's location.assign is a non-configurable, non-writable own property,
    // so neither vi.spyOn nor direct assignment can replace it. Swap the whole
    // `window.location` object instead (its own defineProperty IS configurable).
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign: assignMock }
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('saves the current hash and navigates to the authorize URL', () => {
    vi.stubEnv('VITE_ANILIST_CLIENT_ID', '123');
    window.location.hash = '#/series/One%20Piece';
    startAniListLogin();
    expect(sessionStorage.getItem('anilist_return')).toBe('#/series/One%20Piece');
    expect(assignMock).toHaveBeenCalledWith(
      'https://anilist.co/api/v2/oauth/authorize?client_id=123&response_type=token'
    );
  });

  it('does nothing when no client id is configured', () => {
    vi.stubEnv('VITE_ANILIST_CLIENT_ID', '');
    startAniListLogin();
    expect(sessionStorage.getItem('anilist_return')).toBeNull();
    expect(assignMock).not.toHaveBeenCalled();
  });
});
