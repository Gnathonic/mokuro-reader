import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeriesFile } from './series-file';

const refreshSeriesIndexForSeries = vi.fn(
  async (_title: string): Promise<SeriesFile | undefined> => file
);
const cloudVolumeTitlesFor = vi.fn((_title: string) => new Set(['Volume 1']));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    refreshSeriesIndexForSeries: (t: string) => refreshSeriesIndexForSeries(t),
    cloudVolumeTitlesFor: (t: string) => cloudVolumeTitlesFor(t)
  }
}));

const materializeSeriesVolumes = vi.fn(async (_args: unknown): Promise<number> => 1);
vi.mock('$lib/catalog/materialize', () => ({
  materializeSeriesVolumes: (args: unknown) => materializeSeriesVolumes(args as never)
}));

const installCoversForSeries = vi.fn(async (_title: string): Promise<number> => 1);
vi.mock('$lib/catalog/cover-install', () => ({
  installCoversForSeries: (t: string) => installCoversForSeries(t)
}));

const backfillSeriesEntries = vi.fn(async (_title: string) => {});
vi.mock('./series-backfill', () => ({
  backfillSeriesEntries: (t: string) => backfillSeriesEntries(t)
}));

import { openSeries } from './series-open';

const file: SeriesFile = {
  version: 2,
  series_title: 'Dr Stone',
  external_ids: {},
  titles: {},
  synonyms: [],
  updated_at: '2026-08-18T19:36:24.324Z',
  volumes: [
    {
      volume_uuid: 'uuid-1',
      volume_title: 'Volume 1',
      page_count: 200,
      character_count: 5000,
      mokuro_version: '0.4.11'
    }
  ]
};

beforeEach(() => {
  vi.clearAllMocks();
  refreshSeriesIndexForSeries.mockResolvedValue(file);
  cloudVolumeTitlesFor.mockReturnValue(new Set(['Volume 1']));
  materializeSeriesVolumes.mockResolvedValue(1);
  // clearAllMocks keeps implementations, so restore the default explicitly —
  // the cover tests below install a deliberately pending one.
  installCoversForSeries.mockResolvedValue(1);
});

describe('openSeries', () => {
  it('refreshes, materializes, then installs covers', async () => {
    await openSeries('Dr Stone');
    expect(refreshSeriesIndexForSeries).toHaveBeenCalledWith('Dr Stone');
    expect(materializeSeriesVolumes).toHaveBeenCalledWith({
      seriesTitle: 'Dr Stone',
      entries: file.volumes,
      cloudVolumeTitles: new Set(['Volume 1'])
    });
    expect(installCoversForSeries).toHaveBeenCalledWith('Dr Stone');
  });

  it('still installs covers when there was nothing new to materialize', async () => {
    materializeSeriesVolumes.mockResolvedValue(0);
    await openSeries('Dr Stone');
    expect(installCoversForSeries).toHaveBeenCalledWith('Dr Stone');
  });

  it('does nothing when there is no index for the series', async () => {
    refreshSeriesIndexForSeries.mockResolvedValue(undefined);
    await openSeries('Bare Share');
    expect(materializeSeriesVolumes).not.toHaveBeenCalled();
    expect(installCoversForSeries).not.toHaveBeenCalled();
  });

  it('kicks off the sidecar gap-fill backfill for the series, without waiting on it', async () => {
    let releaseBackfill!: () => void;
    backfillSeriesEntries.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseBackfill = resolve;
      })
    );

    await openSeries('Dr Stone');

    expect(backfillSeriesEntries).toHaveBeenCalledWith('Dr Stone');
    releaseBackfill();
  });

  it('de-duplicates concurrent opens of the same series', async () => {
    const a = openSeries('Dr Stone');
    const b = openSeries('dr  stone');
    await Promise.all([a, b]);
    expect(refreshSeriesIndexForSeries).toHaveBeenCalledTimes(1);
  });

  it('resolves once the volumes are materialized, without waiting on covers', async () => {
    // The view clears its spinner on this promise, and cover install is network
    // I/O for every volume — the spinner must not span it.
    let releaseCovers!: (installed: number) => void;
    installCoversForSeries.mockReturnValue(
      new Promise<number>((resolve) => {
        releaseCovers = resolve;
      })
    );

    await openSeries('Dr Stone');

    expect(materializeSeriesVolumes).toHaveBeenCalled();
    expect(installCoversForSeries).toHaveBeenCalledWith('Dr Stone');
    releaseCovers(1);
  });

  it('is not pinned by a cover install that never settles', async () => {
    // The dedupe entry covers the materialization window only. Cover install is
    // per-volume network I/O that can hang for minutes; holding the entry over
    // it would make every later open of this series a silent no-op, so the page
    // would keep showing whatever it had. Task 9's installCoversForSeries owns
    // its own per-series dedupe instead.
    installCoversForSeries.mockReturnValue(new Promise<number>(() => {}));

    await openSeries('Dr Stone');
    await openSeries('Dr Stone');

    expect(refreshSeriesIndexForSeries).toHaveBeenCalledTimes(2);
    expect(materializeSeriesVolumes).toHaveBeenCalledTimes(2);
  });

  it('does not let a late cover install evict a newer pass', async () => {
    let releaseCovers!: (installed: number) => void;
    installCoversForSeries.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        releaseCovers = resolve;
      })
    );
    await openSeries('Dr Stone'); // pass A: materialized, covers still pending

    let releaseRefresh!: (value: SeriesFile) => void;
    refreshSeriesIndexForSeries.mockReturnValueOnce(
      new Promise<SeriesFile>((resolve) => {
        releaseRefresh = resolve;
      })
    );
    const passB = openSeries('Dr Stone'); // owns the dedupe slot now

    releaseCovers(1); // pass A ends here — it must not take B's slot with it
    await new Promise((resolve) => setTimeout(resolve, 0));

    const passC = openSeries('Dr Stone');
    expect(refreshSeriesIndexForSeries).toHaveBeenCalledTimes(2); // C joined B

    releaseRefresh(file);
    await Promise.all([passB, passC]);
  });

  it('contains a cover-install failure', async () => {
    installCoversForSeries.mockRejectedValueOnce(new Error('boom'));
    await expect(openSeries('Dr Stone')).resolves.toBeUndefined();
  });

  it('never rejects', async () => {
    refreshSeriesIndexForSeries.mockRejectedValueOnce(new Error('offline'));
    await expect(openSeries('Dr Stone')).resolves.toBeUndefined();
  });
});
