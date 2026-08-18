import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';

// Regression test for the reactive-`anilistConnected` fix: this file uses the
// REAL `$lib/metadata/anilist-auth` module (only the network call and the
// unrelated settings/snackbar modules are mocked), unlike
// AniListAccountSettings.test.ts's fully-mocked stores. A fully mocked store
// trivially reflects whatever a test tells it to, so it can't reproduce the
// original bug — a stale "Connected" label that survived Disconnect because
// `connected` was computed as `!!$anilistUser || !!getAniListToken()`
// (a store read OR'd with a non-reactive localStorage read) and `$anilistUser`
// was already null in the token-only state, so the derived never re-ran.
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/settings/settings', () => ({
  catalogSettings: {
    subscribe(fn: (v: { pushProgressToAniList: boolean }) => void) {
      fn({ pushProgressToAniList: true });
      return () => {};
    }
  },
  updateCatalogSetting: vi.fn()
}));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
// "Sync all linked series now" pulls the tracker, which pulls IndexedDB and the
// (mocked-out) settings store at module load. This file is about the auth UI.
vi.mock('$lib/metadata/progress-tracker', () => ({
  syncAllSeriesNow: vi.fn(async () => ({
    pushed: 0,
    nothing: 0,
    queued: 0,
    failed: 0,
    disabled: 0,
    total: 0
  }))
}));
vi.mock('$lib/metadata/providers/anilist', async () => {
  // Keep the real AniListError class (needed to simulate a failed Viewer
  // lookup) while replacing only the network call itself.
  const actual = await vi.importActual<typeof import('$lib/metadata/providers/anilist')>(
    '$lib/metadata/providers/anilist'
  );
  return { ...actual, anilistRequest: vi.fn() };
});

import { anilistRequest, AniListError } from '$lib/metadata/providers/anilist';
import { handleAniListCallbackHash } from '$lib/metadata/anilist-auth';
import AniListAccountSettings from '../AniListAccountSettings.svelte';

describe('AniListAccountSettings (real anilist-auth module)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_ANILIST_CLIENT_ID', 'client');
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(anilistRequest).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('updates the UI immediately when Disconnect is clicked in the token-only (no user) state', async () => {
    // Viewer lookup fails (network error), so the callback leaves a session
    // with a token but no `anilistUser` — the exact state the reported bug
    // left stuck on screen after Disconnect.
    vi.mocked(anilistRequest).mockRejectedValue(new AniListError('NETWORK', 'offline'));
    await handleAniListCallbackHash('#access_token=tok&token_type=Bearer&expires_in=3600');

    const { getByText, queryByText } = render(AniListAccountSettings);
    expect(getByText('Connected')).toBeTruthy();

    await fireEvent.click(getByText('Disconnect'));

    expect(queryByText('Connected')).toBeNull();
    expect(getByText('Connect AniList')).toBeTruthy();
  });
});
