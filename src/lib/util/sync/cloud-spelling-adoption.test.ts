import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudFileMetadata } from './provider-interface';

const localRows = vi.fn(async (): Promise<unknown[]> => []);
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      orderBy: (_index: string) => ({
        uniqueKeys: async () =>
          [
            ...new Set(
              ((await localRows()) as { series_title?: string }[]).map((v) => v.series_title)
            )
          ].filter((t): t is string => !!t)
      }),
      where: (_index: string) => ({
        anyOf: (values: string[]) => ({
          toArray: async () =>
            ((await localRows()) as { series_title?: string }[]).filter((v) =>
              values.includes(v.series_title as string)
            )
        })
      })
    }
  }
}));

const getActiveProvider = vi.fn();
vi.mock('./provider-manager', () => ({
  providerManager: { getActiveProvider: () => getActiveProvider() }
}));

/** The volume on screen (reader or text view), if any — what `isVolumeOpen` answers. */
const openVolume = vi.hoisted(() => ({ uuid: null as string | null }));
vi.mock('$lib/util/hash-router', () => ({
  isVolumeOpen: (uuid: string) => uuid === openVolume.uuid
}));

const commitLocalSeriesRename = vi.fn(async (..._args: unknown[]) => {});
const generateRenameSeriesPreview = vi.fn(async (_from: string, _to: string) => ({
  indexedDbChanges: [] as unknown[],
  localStorageChanges: [] as Array<{ volumeUuid: string }>
}));
vi.mock('$lib/util/series-rename', () => ({
  commitLocalSeriesRename: (...args: unknown[]) => commitLocalSeriesRename(...args),
  generateRenameSeriesPreview: (from: string, to: string) => generateRenameSeriesPreview(from, to)
}));

import { adoptCloudSeriesSpellings, planCloudSpellingAdoptions } from './cloud-spelling-adoption';

function file(path: string): CloudFileMetadata {
  return {
    provider: 'webdav',
    fileId: path,
    path,
    modifiedTime: '2026-10-29T00:00:00.000Z',
    size: 100
  };
}

function row(uuid: string, series: string, volume: string) {
  return { volume_uuid: uuid, series_title: series, volume_title: volume };
}

describe('planCloudSpellingAdoptions', () => {
  it("adopts the cloud's spelling when one folded folder holds a matching volume", () => {
    const plans = planCloudSpellingAdoptions(
      [row('u1', 'one piece', 'Vol 1'), row('u2', 'one piece', 'Vol 2')],
      [file('One Piece/Vol 1.cbz'), file('One Piece/Vol 1.mokuro')]
    );
    expect(plans).toEqual([{ from: 'one piece', to: 'One Piece', volumeUuids: ['u1', 'u2'] }]);
  });

  it('matches the volume by fold too', () => {
    const plans = planCloudSpellingAdoptions(
      [row('u1', 'one piece', 'vol 1')],
      [file('/One Piece/Vol 1.CBZ')]
    );
    expect(plans).toEqual([{ from: 'one piece', to: 'One Piece', volumeUuids: ['u1'] }]);
  });

  it('plans nothing when two cloud folders fold alike', () => {
    expect(
      planCloudSpellingAdoptions(
        [row('u1', 'one piece', 'Vol 1')],
        [file('One Piece/Vol 1.cbz'), file('ONE PIECE/Vol 2.cbz')]
      )
    ).toEqual([]);
  });

  it('plans nothing when no local volume is in the cloud folder', () => {
    expect(
      planCloudSpellingAdoptions([row('u1', 'one piece', 'Vol 3')], [file('One Piece/Vol 1.cbz')])
    ).toEqual([]);
  });

  it('plans nothing when the local spelling also exists exactly', () => {
    expect(
      planCloudSpellingAdoptions(
        [row('u1', 'one piece', 'Vol 1')],
        [file('One Piece/Vol 1.cbz'), file('one piece/Vol 1.cbz')]
      )
    ).toEqual([]);
  });

  it('only counts folders holding an archive', () => {
    // A folder of sidecars alone is not a series the cloud holds.
    expect(
      planCloudSpellingAdoptions(
        [row('u1', 'one piece', 'Vol 1')],
        [file('One Piece/Vol 1.mokuro'), file('One Piece/series.json')]
      )
    ).toEqual([]);
  });

  it('never plans for a title already spelled like its folder', () => {
    expect(
      planCloudSpellingAdoptions([row('u2', 'One Piece', 'Vol 1')], [file('One Piece/Vol 1.cbz')])
    ).toEqual([]);
  });

  it('a metadata-only row is renamed with its series — its title is what the catalog shows', () => {
    const removed = { ...row('u1', 'one piece', 'Vol 1'), metadata_only: true as const };
    expect(
      planCloudSpellingAdoptions(
        [removed, row('u2', 'one piece', 'Vol 2')],
        [file('One Piece/Vol 1.cbz')]
      )
    ).toEqual([{ from: 'one piece', to: 'One Piece', volumeUuids: ['u1', 'u2'] }]);
  });
});

describe('adoptCloudSeriesSpellings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openVolume.uuid = null;
    localRows.mockResolvedValue([row('u1', 'one piece', 'Vol 1'), row('u9', 'Other', 'Vol 1')]);
    generateRenameSeriesPreview.mockResolvedValue({
      indexedDbChanges: [],
      // A stats-only entry (no row on this device) rides along, as in a rename.
      localStorageChanges: [{ volumeUuid: 'u1' }, { volumeUuid: 'stats-only' }]
    });
  });

  const listing = [file('One Piece/Vol 1.cbz'), file('Other/Vol 1.cbz')];

  function provider(serverCompilesMetadata: boolean | undefined, type = 'webdav') {
    return { type, getStatus: () => ({ serverCompilesMetadata }) };
  }

  it('commits the rename locally on a provider that compiles its own metadata', async () => {
    getActiveProvider.mockReturnValue(provider(true));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const plans = await adoptCloudSeriesSpellings(listing, 'webdav');

    expect(plans).toEqual([{ from: 'one piece', to: 'One Piece', volumeUuids: ['u1'] }]);
    expect(commitLocalSeriesRename).toHaveBeenCalledTimes(1);
    expect(commitLocalSeriesRename).toHaveBeenCalledWith(
      'one piece',
      'One Piece',
      ['u1'],
      ['u1', 'stats-only']
    );
    expect(log).toHaveBeenCalledWith("[cloud-spelling] adopted 'one piece' -> 'One Piece'");
    log.mockRestore();
  });

  it('does nothing on plain storage', async () => {
    getActiveProvider.mockReturnValue(provider(undefined));
    expect(await adoptCloudSeriesSpellings(listing, 'webdav')).toEqual([]);
    getActiveProvider.mockReturnValue(provider(false));
    expect(await adoptCloudSeriesSpellings(listing, 'webdav')).toEqual([]);
    expect(commitLocalSeriesRename).not.toHaveBeenCalled();
  });

  it('does nothing when the listing belongs to another provider', async () => {
    getActiveProvider.mockReturnValue(provider(true, 'google-drive'));
    expect(await adoptCloudSeriesSpellings(listing, 'webdav')).toEqual([]);
    getActiveProvider.mockReturnValue(null);
    expect(await adoptCloudSeriesSpellings(listing, 'webdav')).toEqual([]);
    expect(commitLocalSeriesRename).not.toHaveBeenCalled();
  });

  it('plans nothing when every local title is spelled like its folder', async () => {
    getActiveProvider.mockReturnValue(provider(true));
    localRows.mockResolvedValue([row('u1', 'One Piece', 'Vol 1')]);
    const plans = await adoptCloudSeriesSpellings(listing, 'webdav');
    expect(plans).toEqual([]);
    expect(commitLocalSeriesRename).not.toHaveBeenCalled();
  });

  it('defers a series with a volume open in the reader; the next listing retries it', async () => {
    // The rename writes every row of the series, and the open volume's data
    // reloads on any change to its row — every page image swapped under the
    // user. The OCR upgrade defers for the same reason.
    getActiveProvider.mockReturnValue(provider(true));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    openVolume.uuid = 'u1';

    expect(await adoptCloudSeriesSpellings(listing, 'webdav')).toEqual([]);
    expect(commitLocalSeriesRename).not.toHaveBeenCalled();
    expect(generateRenameSeriesPreview).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith("[cloud-spelling] 'one piece' deferred: a volume is open");

    // Back in the catalog, the same listing adopts.
    openVolume.uuid = null;
    expect(await adoptCloudSeriesSpellings(listing, 'webdav')).toEqual([
      { from: 'one piece', to: 'One Piece', volumeUuids: ['u1'] }
    ]);
    expect(commitLocalSeriesRename).toHaveBeenCalledTimes(1);
    debug.mockRestore();
  });

  it('an open volume of ANOTHER series holds nothing back', async () => {
    getActiveProvider.mockReturnValue(provider(true));
    localRows.mockResolvedValue([
      row('u1', 'one piece', 'Vol 1'),
      row('u2', 'berserk', 'Vol 1'),
      row('u9', 'Other', 'Vol 1')
    ]);
    const files = [...listing, file('Berserk/Vol 1.cbz')];
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    openVolume.uuid = 'u2';

    expect(await adoptCloudSeriesSpellings(files, 'webdav')).toEqual([
      { from: 'one piece', to: 'One Piece', volumeUuids: ['u1'] }
    ]);
    expect(commitLocalSeriesRename).toHaveBeenCalledTimes(1);
    expect(commitLocalSeriesRename).toHaveBeenCalledWith(
      'one piece',
      'One Piece',
      ['u1'],
      ['u1', 'stats-only']
    );
    debug.mockRestore();
  });
});
