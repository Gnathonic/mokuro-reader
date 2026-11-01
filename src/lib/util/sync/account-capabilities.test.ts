import { describe, expect, it } from 'vitest';
import {
  accountCanAddFiles,
  accountCanAddToSeries,
  accountCanModifyDelete,
  closedSeriesNotice,
  canPublishCurated,
  canPublishCuratedVolume,
  renameRefusalMessage
} from './account-capabilities';
import { ProviderError } from './provider-interface';

describe('account capabilities', () => {
  it('absent capabilities (generic WebDAV, every other provider) read as unrestricted', () => {
    expect(accountCanAddFiles(undefined)).toBe(true);
    expect(accountCanAddFiles({})).toBe(true);
    expect(accountCanModifyDelete({})).toBe(true);
  });

  it('only an explicit false restricts', () => {
    expect(accountCanAddFiles({ canAddFiles: false })).toBe(false);
    expect(accountCanAddFiles({ canAddFiles: true })).toBe(true);
    expect(accountCanModifyDelete({ canModifyDelete: false })).toBe(false);
  });

  it('a rename refused by permissions says so, never "check your connection"', () => {
    for (const code of ['NOT_PERMITTED', 'PERMISSION_DENIED']) {
      expect(renameRefusalMessage(new ProviderError('403', 'webdav', code))).toMatch(
        /can't rename on this server/
      );
    }
    expect(renameRefusalMessage(new ProviderError('x', 'webdav', 'READ_ONLY'))).toMatch(
      /read-only/
    );
    expect(renameRefusalMessage(new ProviderError('x', 'webdav', 'RENAME_FAILED'))).toBeNull();
    expect(renameRefusalMessage(new Error('Failed to fetch'))).toBeNull();
  });
});

describe('canPublishCurated', () => {
  const owned = { scope: 'owned' as const, ownedSeries: ['One Piece', 'Pokémon'.normalize('NFD')] };

  it.each([
    ['all', undefined, 'Anything', true],
    ['owned', owned, 'One Piece', true],
    ['owned', owned, 'one piece', true],
    // The folder name may come back decomposed: folded like the metadata gate.
    ['owned', owned, 'Pokémon'.normalize('NFC'), true],
    ['owned', owned, 'Naruto', false],
    ['owned', undefined, 'One Piece', false],
    ['owned', { scope: 'owned' as const }, 'One Piece', false],
    ['none', owned, 'One Piece', false],
    [undefined, owned, 'One Piece', false]
  ] as const)('scope %s, metadata %j, series %s -> %s', (scope, metadata, series, expected) => {
    expect(
      canPublishCurated({ curatedPublish: scope, metadataPermissions: metadata }, series)
    ).toBe(expected);
  });

  it('no status (no provider) cannot publish', () => {
    expect(canPublishCurated(null, 'One Piece')).toBe(false);
    expect(canPublishCurated(undefined, 'One Piece')).toBe(false);
  });

  // bunko 0.8: in a SHARED folder, the uploader of a volume may publish that volume.
  describe('per volume (curated.volumes)', () => {
    const status = {
      curatedPublish: 'owned' as const,
      metadataPermissions: { scope: 'owned' as const, ownedSeries: ['One Piece'] },
      curatedVolumes: [
        { series: 'Shared Series', volume: 'VOL 2' },
        { series: 'Café'.normalize('NFD'), volume: 'Tome 1' }
      ]
    };

    it.each([
      ['Shared Series', 'VOL 2', true],
      // Folded like every series-folder and archive-stem match.
      ['shared series', 'Vol 2', true],
      ['Café'.normalize('NFC'), 'tome 1', true],
      // Another volume of the shared folder: somebody else's upload.
      ['Shared Series', 'VOL 3', false],
      // The same stem in another folder is another archive.
      ['Other Series', 'VOL 2', false],
      // An owned folder still covers every volume in it.
      ['One Piece', 'Anything', true]
    ])('series %s, volume %s -> %s', (series, volume, expected) => {
      expect(canPublishCurated(status, series, volume)).toBe(expected);
    });

    it('needs the volume: a series alone matches no listed volume', () => {
      expect(canPublishCurated(status, 'Shared Series')).toBe(false);
    });

    it('only under scope owned: none never, all always', () => {
      expect(
        canPublishCurated({ ...status, curatedPublish: 'none' }, 'Shared Series', 'VOL 2')
      ).toBe(false);
      expect(
        canPublishCurated({ ...status, curatedPublish: 'all' }, 'Shared Series', 'VOL 3')
      ).toBe(true);
    });

    it('an older bunko (no volumes) offers only the owned series, as before', () => {
      const older = { ...status, curatedVolumes: undefined };
      expect(canPublishCurated(older, 'Shared Series', 'VOL 2')).toBe(false);
      expect(canPublishCurated(older, 'One Piece', 'VOL 2')).toBe(true);
    });

    // The reader's layer picker asks with the open volume's row: its series AND
    // volume title, so a shared-folder upload keeps its Publish button.
    it('canPublishCuratedVolume asks with the row: series and volume title', () => {
      const row = (series_title: string, volume_title: string) => ({ series_title, volume_title });
      expect(canPublishCuratedVolume(status, row('shared series', 'Vol 2'))).toBe(true);
      expect(canPublishCuratedVolume(status, row('Shared Series', 'VOL 3'))).toBe(false);
      expect(canPublishCuratedVolume(status, row('One Piece', 'Anything'))).toBe(true);
      expect(canPublishCuratedVolume(null, row('Shared Series', 'VOL 2'))).toBe(false);
    });
  });
});

// bunko 0.8 closes a series another account owns to this one's uploads.
describe('accountCanAddToSeries', () => {
  const open = (closedSeries: string[]) => ({
    canAddFiles: true,
    addFilesPermissions: { scope: 'open' as const, closedSeries }
  });

  it('absent permissions (older bunko, any other provider) close nothing', () => {
    expect(accountCanAddToSeries(undefined, 'Berserk')).toBe(true);
    expect(accountCanAddToSeries({}, 'Berserk')).toBe(true);
    expect(accountCanAddToSeries({ canAddFiles: true }, 'Berserk')).toBe(true);
  });

  it('a closed series is closed under any spelling that folds onto it', () => {
    const status = open(['Dr. Stone', 'Café Series']);
    expect(accountCanAddToSeries(status, 'Dr. Stone')).toBe(false);
    expect(accountCanAddToSeries(status, 'dr.  STONE ')).toBe(false);
    expect(accountCanAddToSeries(status, 'Cafe\u0301 Series')).toBe(false);
    expect(accountCanAddToSeries(status, 'Berserk')).toBe(true);
  });

  it('an account that cannot add files cannot add to any series', () => {
    expect(accountCanAddToSeries({ canAddFiles: false }, 'Berserk')).toBe(false);
    expect(
      accountCanAddToSeries(
        { canAddFiles: false, addFilesPermissions: { scope: 'all' } },
        'Berserk'
      )
    ).toBe(false);
  });

  it('scope all opens every series, none closes every one', () => {
    expect(
      accountCanAddToSeries({ canAddFiles: true, addFilesPermissions: { scope: 'all' } }, 'X')
    ).toBe(true);
    expect(
      accountCanAddToSeries({ canAddFiles: true, addFilesPermissions: { scope: 'none' } }, 'X')
    ).toBe(false);
  });

  it('a fresh identity (a new permissions object) is read afresh', () => {
    expect(accountCanAddToSeries(open([]), 'Berserk')).toBe(true);
    expect(accountCanAddToSeries(open(['Berserk']), 'Berserk')).toBe(false);
    expect(accountCanAddToSeries(open([]), 'Berserk')).toBe(true);
  });

  it('the notice counts series and volumes', () => {
    expect(closedSeriesNotice(1, 1)).toBe(
      'Skipped 1 volume: its series belongs to another account on this server'
    );
    expect(closedSeriesNotice(2, 5)).toBe(
      'Skipped 5 volumes in 2 series that belong to another account on this server'
    );
    expect(closedSeriesNotice(1, 3)).toBe(
      'Skipped 3 volumes: their series belongs to another account on this server'
    );
  });
});
