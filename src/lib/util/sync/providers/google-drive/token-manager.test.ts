/**
 * The token manager with the interop rig's injected token client: it must
 * answer as Google's sign-in does — after the request returns, never inside
 * it — so `isRefreshing` covers a re-auth in flight the way it does under GIS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/user-gesture', () => ({ onNextUserGesture: vi.fn(() => () => {}) }));
vi.mock('../../provider-manager', () => ({ providerManager: { updateStatus: vi.fn() } }));
vi.mock('../../unified-cloud-manager', () => ({
  unifiedCloudManager: {
    fetchAllCloudVolumes: vi.fn(async () => {}),
    syncProgress: vi.fn(async () => ({ succeeded: 1 }))
  }
}));

import { setCloudTestToken } from '../../cloud-test-hooks';
import { GOOGLE_DRIVE_CONFIG } from './constants';
import { tokenManager } from './token-manager';
import { unifiedCloudManager } from '../../unified-cloud-manager';

const token = (access_token: string) => ({ access_token, expires_in: 3600 });

describe('the injected token client (interop builds)', () => {
  beforeEach(async () => {
    vi.stubGlobal('gapi', { client: { setToken: vi.fn() } });
    localStorage.setItem(GOOGLE_DRIVE_CONFIG.STORAGE_KEYS.HAS_AUTHENTICATED, 'true');
    setCloudTestToken('google', token('T0'));
    await tokenManager.initTokenClient();
    tokenManager.setToken('T0', 3600);
  });

  afterEach(() => {
    vi.mocked(unifiedCloudManager.syncProgress).mockResolvedValue({ succeeded: 1 } as never);
    setCloudTestToken('google', null);
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('answers a burst of re-auths (three requests refused at once) with one sign-in', async () => {
    // T0 expired; the next sign-in hands out T1.
    setCloudTestToken('google', token('T1'));
    tokenManager.reAuthenticate();
    tokenManager.reAuthenticate();
    tokenManager.reAuthenticate();
    // Not inside the request: GIS answers once its popup (or silent frame) returns.
    expect(get(tokenManager.token)).toBe('T0');
    await vi.waitFor(() => expect(get(tokenManager.token)).toBe('T1'));
    expect(get(tokenManager.needsAttention)).toBe(false);
  });

  it('a revoked grant: one re-auth hands the token back, the next is refused', async () => {
    // The rig minted nothing new: T0 is all the sign-in has, and the sync after
    // the re-auth is refused with it.
    vi.mocked(unifiedCloudManager.syncProgress).mockResolvedValue({ succeeded: 0 } as never);
    const granted = gapiSetTokenCalls();
    tokenManager.reAuthenticate();
    await vi.waitFor(() => expect(gapiSetTokenCalls()).toBeGreaterThan(granted));
    expect(get(tokenManager.needsAttention)).toBe(false);
    tokenManager.reAuthenticate();
    await vi.waitFor(() => expect(get(tokenManager.needsAttention)).toBe(true));
    expect(get(tokenManager.token)).toBe('');
  });
});

/** How many tokens the sign-in handed gapi. */
function gapiSetTokenCalls(): number {
  const setToken = (
    globalThis as unknown as { gapi: { client: { setToken: { mock: { calls: unknown[][] } } } } }
  ).gapi.client.setToken;
  return setToken.mock.calls.filter((c) => c[0] !== null).length;
}
