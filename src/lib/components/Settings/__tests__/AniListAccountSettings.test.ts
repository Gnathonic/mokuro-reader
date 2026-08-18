import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';

// vi.hoisted: `vi.mock` factories are hoisted above every other top-level
// statement (including this file's own imports), so any state a factory
// dereferences while it runs must be created here — same pattern as
// SeriesTrackingPanel.test.ts. A hand-rolled store sidesteps hoisting a
// `svelte/store` import above its own use.
const h = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    let value = initial;
    const subs = new Set<(v: T) => void>();
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(value);
        return () => {
          subs.delete(fn);
        };
      },
      set(v: T) {
        value = v;
        subs.forEach((fn) => fn(value));
      }
    };
  }

  return {
    anilistUser: createStore<{ id: number; name: string } | null>(null),
    anilistConnected: createStore<boolean>(false),
    catalogSettings: createStore<{ pushProgressToAniList: boolean } | undefined>({
      pushProgressToAniList: true
    }),
    auth: { clientId: 'client' as string | undefined, token: null as string | null },
    syncAllSeriesNow: vi.fn(async () => ({
      pushed: 3,
      nothing: 8,
      queued: 1,
      failed: 0,
      disabled: 0,
      total: 12
    }))
  };
});

vi.mock('$lib/metadata/anilist-auth', () => ({
  anilistUser: h.anilistUser,
  anilistConnected: h.anilistConnected,
  getAniListClientId: () => h.auth.clientId,
  getAniListToken: () => h.auth.token,
  startAniListLogin: vi.fn(),
  // Mirrors the real clearAniListSession(): flips the reactive connected
  // flag too, so a click's UI effect can actually be asserted (see "shows
  // the connected name and disconnects" below) rather than trusting the mock
  // was told the right thing.
  disconnectAniList: vi.fn(() => {
    h.anilistUser.set(null);
    h.anilistConnected.set(false);
  })
}));
vi.mock('$lib/metadata/progress-tracker', () => ({ syncAllSeriesNow: h.syncAllSeriesNow }));
vi.mock('$lib/settings/settings', () => ({
  catalogSettings: h.catalogSettings,
  updateCatalogSetting: vi.fn()
}));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

import { startAniListLogin, disconnectAniList } from '$lib/metadata/anilist-auth';
import { syncAllSeriesNow } from '$lib/metadata/progress-tracker';
import { updateCatalogSetting } from '$lib/settings/settings';
import { showSnackbar } from '$lib/util/snackbar';
import AniListAccountSettings from '../AniListAccountSettings.svelte';

describe('AniListAccountSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.auth.clientId = 'client';
    h.auth.token = null;
    h.anilistUser.set(null);
    h.anilistConnected.set(false);
    h.catalogSettings.set({ pushProgressToAniList: true });
    vi.mocked(syncAllSeriesNow).mockResolvedValue({
      pushed: 3,
      nothing: 8,
      queued: 1,
      failed: 0,
      disabled: 0,
      total: 12
    });
  });

  afterEach(() => {
    h.anilistUser.set(null);
    h.anilistConnected.set(false);
  });

  it('renders only a dev hint (no account controls) when no AniList client id is configured', () => {
    h.auth.clientId = undefined;
    const { container, queryByText } = render(AniListAccountSettings);
    expect(queryByText(/Connect AniList/)).toBeNull();
    expect(queryByText(/Push progress to AniList when/)).toBeNull();
    expect(queryByText('Sync all linked series now')).toBeNull();
    // Vitest runs with DEV set, so the setup hint shows; production would render nothing.
    expect(container.textContent).toContain('VITE_ANILIST_CLIENT_ID');
  });

  it('shows Connect and calls startAniListLogin when not connected', async () => {
    const { getByText, queryByText } = render(AniListAccountSettings);
    expect(queryByText(/Connected/)).toBeNull();
    await fireEvent.click(getByText('Connect AniList'));
    expect(startAniListLogin).toHaveBeenCalled();
  });

  it('shows the connected name and disconnects', async () => {
    h.anilistUser.set({ id: 1, name: 'nathan' });
    h.anilistConnected.set(true);
    const { getByText, queryByText } = render(AniListAccountSettings);
    expect(getByText('Connected as nathan')).toBeTruthy();
    await fireEvent.click(getByText('Disconnect'));
    expect(disconnectAniList).toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledWith('Disconnected from AniList');
    // The stale-UI bug: this must flip to "Connect AniList" on the same click.
    expect(queryByText(/Connected/)).toBeNull();
    expect(getByText('Connect AniList')).toBeTruthy();
  });

  it('shows a fallback connected label when a token exists but the Viewer lookup has not resolved', () => {
    h.auth.token = 'tok';
    h.anilistUser.set(null);
    h.anilistConnected.set(true);
    const { getByText, queryByText } = render(AniListAccountSettings);
    expect(getByText('Connected')).toBeTruthy();
    expect(queryByText('Connect AniList')).toBeNull();
  });

  it('writes the push-on-completion setting from the current value', async () => {
    const { getByLabelText } = render(AniListAccountSettings);
    await fireEvent.click(getByLabelText('Push progress to AniList when a volume is finished'));
    expect(updateCatalogSetting).toHaveBeenCalledWith('pushProgressToAniList', false);
  });

  it('reflects the synced setting when it is off', () => {
    h.catalogSettings.set({ pushProgressToAniList: false });
    const { getByLabelText } = render(AniListAccountSettings);
    const input = getByLabelText(
      'Push progress to AniList when a volume is finished'
    ) as HTMLInputElement;
    expect(input.checked).toBe(false);
  });
});

describe('AniListAccountSettings — sync all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.auth.clientId = 'client';
    h.anilistUser.set({ id: 1, name: 'nathan' });
    h.anilistConnected.set(true);
    h.catalogSettings.set({ pushProgressToAniList: true });
    vi.mocked(syncAllSeriesNow).mockResolvedValue({
      pushed: 3,
      nothing: 8,
      queued: 1,
      failed: 0,
      disabled: 0,
      total: 12
    });
  });

  it('syncs every linked series and reports the tally', async () => {
    const { getByText } = render(AniListAccountSettings);
    await fireEvent.click(getByText('Sync all linked series now'));
    expect(syncAllSeriesNow).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(showSnackbar).toHaveBeenCalledWith(
        'Synced 12 series — 3 pushed, 8 up to date, 1 queued'
      )
    );
  });

  it('says so when nothing is linked', async () => {
    vi.mocked(syncAllSeriesNow).mockResolvedValue({
      pushed: 0,
      nothing: 0,
      queued: 0,
      failed: 0,
      disabled: 0,
      total: 0
    });
    const { getByText } = render(AniListAccountSettings);
    await fireEvent.click(getByText('Sync all linked series now'));
    await waitFor(() => expect(showSnackbar).toHaveBeenCalledWith('No linked series to sync'));
  });

  it('cannot be clicked while signed out', () => {
    h.anilistConnected.set(false);
    const { getByText } = render(AniListAccountSettings);
    expect(
      (getByText('Sync all linked series now').closest('button') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('cannot be clicked while the master switch is off', () => {
    h.catalogSettings.set({ pushProgressToAniList: false });
    const { getByText } = render(AniListAccountSettings);
    expect(
      (getByText('Sync all linked series now').closest('button') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('reports a thrown pass as an error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.mocked(syncAllSeriesNow).mockRejectedValueOnce(new Error('boom'));
      const { getByText } = render(AniListAccountSettings);
      await fireEvent.click(getByText('Sync all linked series now'));
      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith("Couldn't reach AniList — try again")
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
