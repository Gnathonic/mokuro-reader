import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';

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
    catalogSettings: createStore<{ pushProgressToAniList: boolean } | undefined>({
      pushProgressToAniList: true
    }),
    auth: { clientId: 'client' as string | undefined, token: null as string | null }
  };
});

vi.mock('$lib/metadata/anilist-auth', () => ({
  anilistUser: h.anilistUser,
  getAniListClientId: () => h.auth.clientId,
  getAniListToken: () => h.auth.token,
  startAniListLogin: vi.fn(),
  disconnectAniList: vi.fn()
}));
vi.mock('$lib/settings/settings', () => ({
  catalogSettings: h.catalogSettings,
  updateCatalogSetting: vi.fn()
}));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

import { startAniListLogin, disconnectAniList } from '$lib/metadata/anilist-auth';
import { updateCatalogSetting } from '$lib/settings/settings';
import { showSnackbar } from '$lib/util/snackbar';
import AniListAccountSettings from '../AniListAccountSettings.svelte';

describe('AniListAccountSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.auth.clientId = 'client';
    h.auth.token = null;
    h.anilistUser.set(null);
    h.catalogSettings.set({ pushProgressToAniList: true });
  });

  afterEach(() => {
    h.anilistUser.set(null);
  });

  it('renders nothing when no AniList client id is configured', () => {
    h.auth.clientId = undefined;
    const { container } = render(AniListAccountSettings);
    expect(container.textContent?.trim()).toBe('');
  });

  it('shows Connect and calls startAniListLogin when not connected', async () => {
    const { getByText, queryByText } = render(AniListAccountSettings);
    expect(queryByText(/Connected/)).toBeNull();
    await fireEvent.click(getByText('Connect AniList'));
    expect(startAniListLogin).toHaveBeenCalled();
  });

  it('shows the connected name and disconnects', async () => {
    h.anilistUser.set({ id: 1, name: 'nathan' });
    const { getByText } = render(AniListAccountSettings);
    expect(getByText('Connected as nathan')).toBeTruthy();
    await fireEvent.click(getByText('Disconnect'));
    expect(disconnectAniList).toHaveBeenCalled();
    expect(showSnackbar).toHaveBeenCalledWith('Disconnected from AniList');
  });

  it('shows a fallback connected label when a token exists but the Viewer lookup has not resolved', () => {
    h.auth.token = 'tok';
    h.anilistUser.set(null);
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
