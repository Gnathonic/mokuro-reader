import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { createEmptySeriesMetadata, type SeriesMetadata } from '$lib/metadata/types';
import type { VolumeMetadata } from '$lib/types';

// vi.hoisted: `vi.mock` factories are hoisted above every other top-level
// statement (including this file's own imports), so any state a factory
// dereferences while it runs must be created here — same pattern as
// SeriesMetadataBar.test.ts / progress-tracker.test.ts.
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
      },
      get: () => value
    };
  }

  return {
    seriesMetadataMap: createStore(new Map<string, unknown>()),
    volumesData: createStore<Record<string, { completed?: boolean }>>({}),
    catalogSettings: createStore<{ pushProgressToAniList: boolean } | undefined>({
      pushProgressToAniList: true
    }),
    settings: createStore<unknown>({ catalogSettings: { pushProgressToAniList: true } }),
    preferredTitleLanguage: createStore('imported'),
    anilistUser: createStore<{ id: number; name: string } | null>({ id: 1, name: 'nathan' }),
    auth: { clientId: 'client' as string | undefined, token: 'tok' as string | null },
    // Stands in for the Dexie table behind `updateSeriesMetadata`. Deliberately
    // separate from `seriesMetadataMap`: the real store is a liveQuery that lags
    // a write by a round-trip, which is the race the panel's write chain fixes.
    stored: new Map<string, SeriesMetadata>(),
    writeSeq: { n: 0 }
  };
});

vi.mock('$app/environment', () => ({ browser: true }));
// Only reached through the real `computeLocalPassState`'s module graph — the
// panel never touches IndexedDB itself.
vi.mock('$lib/catalog/db', () => ({
  db: { volumes: { toArray: async () => [], get: async () => undefined } }
}));
vi.mock('$lib/metadata/store', () => ({
  seriesMetadataMap: h.seriesMetadataMap,
  updateSeriesMetadata: vi.fn(async (title: string, patch: Partial<SeriesMetadata>) => {
    const key = title.trim().replace(/\s+/g, ' ').toLowerCase();
    const current = h.stored.get(key);
    const next = {
      ...(current ?? createEmptySeriesMetadata(title)),
      ...patch,
      // Strictly newer than anything the (lagging) store holds.
      updated_at: new Date(Date.now() + ++h.writeSeq.n).toISOString()
    } as SeriesMetadata;
    h.stored.set(key, next);
    return next;
  })
}));
vi.mock('$lib/settings/volume-data', () => ({
  volumes: h.volumesData,
  registerCompletionListener: vi.fn(() => () => {})
}));
vi.mock('$lib/settings/settings', () => ({
  catalogSettings: h.catalogSettings,
  settings: h.settings,
  preferredTitleLanguage: h.preferredTitleLanguage
}));
vi.mock('$lib/metadata/anilist-auth', () => ({
  getAniListClientId: () => h.auth.clientId,
  getAniListToken: () => h.auth.token,
  anilistUser: h.anilistUser,
  handleAniListUnauthorized: vi.fn()
}));
// The real pass-state maths is the whole point of "Read N times" matching what
// the tracker pushes, so it is imported for real; only the network call is a spy.
vi.mock('$lib/metadata/progress-tracker', async () => {
  const actual = await vi.importActual<typeof import('$lib/metadata/progress-tracker')>(
    '$lib/metadata/progress-tracker'
  );
  return {
    computeLocalPassState: actual.computeLocalPassState,
    syncSeriesNow: vi.fn(async () => 'pushed')
  };
});
vi.mock('$lib/metadata/reread', () => ({ restartSeries: vi.fn(async () => {}) }));
vi.mock('$lib/util/modals', () => ({ promptConfirmation: vi.fn() }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

import { updateSeriesMetadata } from '$lib/metadata/store';
import { syncSeriesNow } from '$lib/metadata/progress-tracker';
import { restartSeries } from '$lib/metadata/reread';
import { promptConfirmation } from '$lib/util/modals';
import { showSnackbar } from '$lib/util/snackbar';
import SeriesTrackingPanel from '../SeriesTrackingPanel.svelte';

function volume(uuid: string, title: string, isPlaceholder = false): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 'series-uuid',
    series_title: 'One Piece',
    volume_title: title,
    isPlaceholder
  } as VolumeMetadata;
}

const VOLUMES = [volume('a', 'One Piece Volume 1'), volume('b', 'One Piece Volume 2')];

function meta(overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return {
    ...createEmptySeriesMetadata('One Piece'),
    external_ids: { anilist: 30013 },
    tracking: { enabled: true, unit: 'volumes' },
    ...overrides
  };
}

function setMeta(record: SeriesMetadata | undefined) {
  h.stored.clear();
  if (record) h.stored.set('one piece', record);
  h.seriesMetadataMap.set(record ? new Map([['one piece', record]]) : new Map());
}

function renderPanel(volumes: VolumeMetadata[] = VOLUMES) {
  return render(SeriesTrackingPanel, { props: { seriesTitle: 'One Piece', volumes } });
}

describe('SeriesTrackingPanel', () => {
  let consoleError: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    // The failure paths below log on purpose; keep the run's output pristine.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.auth.clientId = 'client';
    h.auth.token = 'tok';
    h.anilistUser.set({ id: 1, name: 'nathan' });
    h.catalogSettings.set({ pushProgressToAniList: true });
    h.preferredTitleLanguage.set('imported');
    h.volumesData.set({ a: { completed: true }, b: { completed: true } });
    setMeta(meta({ read_count: 1 }));
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  describe('read count', () => {
    it('shows timesRead (read_count + 1 while every local volume is completed)', () => {
      const { getByText } = renderPanel();
      expect(getByText('Read 2 times')).toBeTruthy();
    });

    it('ignores cloud placeholders when deciding the pass is complete', () => {
      // The tracker computes its pass state from LOCAL volumes only; a
      // never-downloaded placeholder must not hold "Read N times" back.
      setMeta(meta({ read_count: 0 }));
      h.volumesData.set({ a: { completed: true }, b: { completed: true } });
      const { getByText } = renderPanel([...VOLUMES, volume('c', 'One Piece Volume 3', true)]);
      expect(getByText('Read 1 time')).toBeTruthy();
    });

    it('does not count an unfinished pass', () => {
      setMeta(meta({ read_count: 1 }));
      h.volumesData.set({ a: { completed: true } });
      const { getByText } = renderPanel();
      expect(getByText('Read 1 time')).toBeTruthy();
    });

    it('increments read_count', async () => {
      const { getByLabelText } = renderPanel();
      await fireEvent.click(getByLabelText('Increase read count'));
      expect(updateSeriesMetadata).toHaveBeenCalledWith('One Piece', { read_count: 2 });
    });

    it('decrements read_count', async () => {
      const { getByLabelText } = renderPanel();
      await fireEvent.click(getByLabelText('Decrease read count'));
      expect(updateSeriesMetadata).toHaveBeenCalledWith('One Piece', { read_count: 0 });
    });

    it('clamps read_count at 0', async () => {
      setMeta(meta({ read_count: 0 }));
      const { getByLabelText } = renderPanel();
      const decrease = getByLabelText('Decrease read count').closest('button')!;
      expect(decrease.disabled).toBe(true);
      await fireEvent.click(decrease);
      expect(updateSeriesMetadata).not.toHaveBeenCalled();
    });

    it('lands both of two rapid clicks instead of writing the same value twice', async () => {
      // The store is a liveQuery and lags the write, so the second click must
      // build on the record the first write returned.
      setMeta(meta({ read_count: 0 }));
      const { getByLabelText } = renderPanel();
      const increase = getByLabelText('Increase read count');
      await Promise.all([fireEvent.click(increase), fireEvent.click(increase)]);
      await waitFor(() => expect(updateSeriesMetadata).toHaveBeenCalledTimes(2));
      expect(vi.mocked(updateSeriesMetadata).mock.calls.map((call) => call[1])).toEqual([
        { read_count: 1 },
        { read_count: 2 }
      ]);
    });

    it('reports a failed write', async () => {
      vi.mocked(updateSeriesMetadata).mockRejectedValueOnce(new Error('dexie is out'));
      const { getByLabelText } = renderPanel();
      await fireEvent.click(getByLabelText('Increase read count'));
      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith("Couldn't save the read count")
      );
    });
  });

  describe('tracking controls', () => {
    it('asks for a link instead of tracking controls when the series is unlinked', () => {
      setMeta(meta({ external_ids: {}, tracking: undefined }));
      const { getByText, queryByText } = renderPanel();
      expect(getByText('Link to AniList to track progress')).toBeTruthy();
      expect(queryByText('Sync now')).toBeNull();
    });

    it('hides tracking entirely when no AniList client id is configured', () => {
      h.auth.clientId = undefined;
      const { queryByText } = renderPanel();
      expect(queryByText('Sync now')).toBeNull();
      expect(queryByText('Link to AniList to track progress')).toBeNull();
      // The read-count controls stay: they are local bookkeeping.
      expect(queryByText('Read 2 times')).toBeTruthy();
    });

    it('enables tracking without dropping the unit', async () => {
      setMeta(meta({ tracking: { enabled: false, unit: 'chapters' } }));
      const { getByLabelText } = renderPanel();
      await fireEvent.click(getByLabelText('Push progress to AniList'));
      expect(updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
        tracking: { enabled: true, unit: 'chapters' }
      });
    });

    it('changes the unit without dropping the enabled flag or overrides', async () => {
      setMeta(meta({ tracking: { enabled: true, unit: 'volumes', number_overrides: { a: 4 } } }));
      const { getByDisplayValue } = renderPanel();
      await fireEvent.change(getByDisplayValue('Volumes') as HTMLSelectElement, {
        target: { value: 'chapters' }
      });
      expect(updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
        tracking: { enabled: true, unit: 'chapters', number_overrides: { a: 4 } }
      });
    });

    it('reports a failed tracking write', async () => {
      vi.mocked(updateSeriesMetadata).mockRejectedValueOnce(new Error('dexie is out'));
      const { getByLabelText } = renderPanel();
      await fireEvent.click(getByLabelText('Push progress to AniList'));
      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith("Couldn't save the tracking settings")
      );
    });

    it('shows the last pushed figure', () => {
      setMeta(
        meta({
          tracking: {
            enabled: true,
            unit: 'volumes',
            last_pushed: { n: 2, status: 'CURRENT', at: '2026-08-15T10:00:00.000Z' }
          }
        })
      );
      const { getByText } = renderPanel();
      expect(getByText(/Last pushed vol\. 2 ·/)).toBeTruthy();
    });

    it('keeps the last pushed figure visible next to a hint', () => {
      h.anilistUser.set(null);
      h.auth.token = null;
      setMeta(
        meta({
          tracking: {
            enabled: true,
            unit: 'volumes',
            last_pushed: { n: 3, status: 'CURRENT', at: '2026-08-15T10:00:00.000Z' }
          }
        })
      );
      const { getByText } = renderPanel();
      expect(getByText('Connect AniList in Settings')).toBeTruthy();
      expect(getByText(/Last pushed vol\. 3 ·/)).toBeTruthy();
    });

    it('hints that AniList is not connected', () => {
      h.anilistUser.set(null);
      h.auth.token = null;
      const { getByText } = renderPanel();
      expect(getByText('Connect AniList in Settings')).toBeTruthy();
    });

    it('hints when the global push switch is off', () => {
      h.catalogSettings.set({ pushProgressToAniList: false });
      const { getByText } = renderPanel();
      expect(getByText('Progress pushing is off in Settings')).toBeTruthy();
    });
  });

  describe('sync now', () => {
    it('calls the tracker with the series key', async () => {
      const { getByText } = renderPanel();
      await fireEvent.click(getByText('Sync now'));
      expect(syncSeriesNow).toHaveBeenCalledWith('one piece');
    });

    it.each([
      ['pushed', 'Pushed to AniList'],
      ['nothing', 'Already up to date'],
      ['queued', 'Queued — will push when AniList is reachable'],
      ['disabled', 'Tracking is off for this series'],
      ['failed', 'AniList rejected the update']
    ])('maps the %s outcome to a snackbar', async (outcome, message) => {
      vi.mocked(syncSeriesNow).mockResolvedValueOnce(outcome as 'pushed');
      const { getByText } = renderPanel();
      await fireEvent.click(getByText('Sync now'));
      await waitFor(() => expect(showSnackbar).toHaveBeenCalledWith(message));
    });

    it('reports a thrown sync as an error', async () => {
      vi.mocked(syncSeriesNow).mockRejectedValueOnce(new Error('boom'));
      const { getByText } = renderPanel();
      await fireEvent.click(getByText('Sync now'));
      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith("Couldn't reach AniList — try again")
      );
    });
  });

  describe('restart', () => {
    it('confirms before restarting, then restarts', async () => {
      const { getByText } = renderPanel();
      await fireEvent.click(getByText('Restart series…'));
      expect(restartSeries).not.toHaveBeenCalled();
      expect(promptConfirmation).toHaveBeenCalledWith(
        expect.stringContaining('Restart One Piece?'),
        expect.any(Function)
      );

      const onConfirm = vi.mocked(promptConfirmation).mock.calls[0][1]!;
      await onConfirm();
      expect(restartSeries).toHaveBeenCalledWith('One Piece', VOLUMES);
      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith(
          'Series restarted — your previous read is kept in your stats'
        )
      );
    });

    it('names the series by its display title, but restarts by the folder title', async () => {
      h.preferredTitleLanguage.set('english');
      setMeta(meta({ titles: { english: 'One Piece (en)' }, tag: '[color]' }));
      const { getByText } = renderPanel();
      await fireEvent.click(getByText('Restart series…'));
      expect(promptConfirmation).toHaveBeenCalledWith(
        expect.stringContaining('Restart One Piece (en) [color]?'),
        expect.any(Function)
      );
      await vi.mocked(promptConfirmation).mock.calls[0][1]!();
      expect(restartSeries).toHaveBeenCalledWith('One Piece', VOLUMES);
    });

    it('reports a failed restart', async () => {
      vi.mocked(restartSeries).mockRejectedValueOnce(new Error('nope'));
      const { getByText } = renderPanel();
      await fireEvent.click(getByText('Restart series…'));
      await vi.mocked(promptConfirmation).mock.calls[0][1]!();
      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith('Could not restart the series')
      );
    });

    it('offers nothing to restart when every volume is a cloud placeholder', () => {
      const { getByText } = renderPanel([volume('c', 'One Piece Volume 3', true)]);
      expect((getByText('Restart series…').closest('button') as HTMLButtonElement).disabled).toBe(
        true
      );
    });
  });

  describe('re-read prompt suppression', () => {
    it('offers nothing to reset while the prompt is live', () => {
      const { queryByText } = renderPanel();
      expect(queryByText('Ask again about re-reads')).toBeNull();
    });

    it('clears the suppression flag', async () => {
      setMeta(meta({ read_count: 1, reread_prompt_suppressed: true }));
      const { getByText } = renderPanel();
      await fireEvent.click(getByText('Ask again about re-reads'));
      expect(updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
        reread_prompt_suppressed: undefined
      });
    });

    it('reports a failed reset', async () => {
      vi.mocked(updateSeriesMetadata).mockRejectedValueOnce(new Error('dexie is out'));
      setMeta(meta({ read_count: 1, reread_prompt_suppressed: true }));
      const { getByText } = renderPanel();
      await fireEvent.click(getByText('Ask again about re-reads'));
      await waitFor(() =>
        expect(showSnackbar).toHaveBeenCalledWith("Couldn't reset the re-read prompt")
      );
    });
  });
});
