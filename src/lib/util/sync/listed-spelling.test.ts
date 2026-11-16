import { describe, expect, it, vi } from 'vitest';

// Each cache imports its provider for fetch(); none is reached here.
vi.mock('./providers/webdav/webdav-provider', () => ({ webdavProvider: {} }));
vi.mock('./providers/onedrive/onedrive-provider', () => ({ onedriveProvider: {} }));
vi.mock('./providers/mega/mega-provider', () => ({ megaProvider: {} }));
vi.mock('./providers/filesystem/filesystem-provider', () => ({ filesystemProvider: {} }));
vi.mock('./providers/google-drive/google-drive-provider', () => ({
  googleDriveProvider: { type: 'google-drive', isAuthenticated: () => false }
}));
vi.mock('./providers/google-drive/api-client', () => ({
  driveApiClient: {},
  escapeNameForDriveQuery: (name: string) => name,
  isDriveAuthFailure: () => false
}));

import {
  listedCopies,
  listedEntry,
  listedPathOn,
  resolveListedPath,
  resolveListedSpelling
} from './listed-spelling';
import { webdavCache } from './providers/webdav/webdav-cache';
import { onedriveCache } from './providers/onedrive/onedrive-cache';
import { megaCache } from './providers/mega/mega-cache';
import { filesystemCache } from './providers/filesystem/filesystem-cache';
import { driveFilesCache } from './providers/google-drive/drive-files-cache';
import type { CloudCache } from './cloud-cache-interface';
import type { CloudFileMetadata } from './provider-interface';

function grouped(paths: string[]): Map<string, Array<{ path: string; id: number }>> {
  const map = new Map<string, Array<{ path: string; id: number }>>();
  paths.forEach((path, id) => {
    const key = path.split('/')[0];
    map.set(key, [...(map.get(key) ?? []), { path, id }]);
  });
  return map;
}

describe('resolveListedSpelling (R9: a write goes onto the listed spelling)', () => {
  it('keeps a name that is listed or that nothing lists', () => {
    expect(resolveListedSpelling(['Vol 1.cbz', 'VOL 1.cbz'], 'Vol 1.cbz')).toBe('Vol 1.cbz');
    expect(resolveListedSpelling(['Vol 2.cbz'], 'Vol 1.cbz')).toBe('Vol 1.cbz');
    expect(resolveListedSpelling([], 'Vol 1.cbz')).toBe('Vol 1.cbz');
  });

  it('writes onto the one listed spelling of the fold', () => {
    expect(resolveListedSpelling(['VOL 1.mokuro'], 'Vol 1.mokuro')).toBe('VOL 1.mokuro');
    expect(resolveListedSpelling(['Straße.cbz'], 'STRASSE.cbz')).toBe('Straße.cbz');
    expect(resolveListedSpelling(['Café.webp'], 'Café.webp')).toBe('Café.webp');
    expect(resolveListedSpelling(['V​.edit.mokuro'], 'V.EDIT.mokuro')).toBe('V​.edit.mokuro');
  });

  it('picks the code-point-smallest of a fold group, never UTF-16 order (R6)', () => {
    // Both fold to `v.cbz` (a default-ignorable each). U+FE0F is below U+E0100
    // in code points, above its surrogates in UTF-16 units.
    const bmp = 'v\uFE0F.cbz';
    const astral = 'v\u{E0100}.cbz';
    expect(bmp < astral).toBe(false); // UTF-16 order would pick the astral one
    expect(resolveListedSpelling([astral, bmp], 'V.cbz')).toBe(bmp);
    expect(resolveListedSpelling([bmp, astral], 'V.cbz')).toBe(bmp);
    expect(resolveListedSpelling(['VOL.cbz', 'Vol.cbz', 'vol.cbz'], 'vOL.cbz')).toBe('VOL.cbz');
  });
});

describe('listedCopies / listedEntry over a grouped listing', () => {
  const groups = grouped([
    'One Piece/Vol 1.cbz',
    'one piece/VOL 1.cbz',
    'One Piece/Vol 2.cbz',
    'Volume-Data.json',
    'volume-data.json'
  ]);

  it('finds every spelling of the entry, exact first, then code-point order', () => {
    expect(listedCopies(groups, 'one piece/vol 1.cbz').map((f) => f.path)).toEqual([
      'One Piece/Vol 1.cbz',
      'one piece/VOL 1.cbz'
    ]);
    expect(listedCopies(groups, 'one piece/VOL 1.cbz').map((f) => f.path)).toEqual([
      'one piece/VOL 1.cbz',
      'One Piece/Vol 1.cbz'
    ]);
    expect(listedCopies(groups, 'volume-data.json').map((f) => f.path)).toEqual([
      'volume-data.json',
      'Volume-Data.json'
    ]);
  });

  it('answers the exact spelling without folding, else the R6 pick, else null', () => {
    expect(listedEntry(groups, 'One Piece/Vol 2.cbz')?.path).toBe('One Piece/Vol 2.cbz');
    expect(listedEntry(groups, 'ONE PIECE/VOL 2.CBZ')?.path).toBe('One Piece/Vol 2.cbz');
    expect(listedEntry(groups, 'One Piece/Vol 3.cbz')).toBeNull();
  });

  it('memoises the group fold per revision', () => {
    const revision = {};
    expect(listedEntry(groups, 'ONE PIECE/vol 2.cbz', revision)?.path).toBe('One Piece/Vol 2.cbz');
    expect(listedEntry(groups, 'ONE PIECE/vol 2.cbz', revision)?.path).toBe('One Piece/Vol 2.cbz');
  });
});

describe('resolveListedPath: every segment onto the listing', () => {
  const groups = grouped([
    'One Piece/Vol 1.cbz',
    'One Piece/VOL 2.mokuro',
    'history/Device A/2026.events',
    'Goals.json'
  ]);

  it('resolves the folder, then the file in it', () => {
    expect(resolveListedPath(groups, 'one piece/Vol 2.mokuro')).toBe('One Piece/VOL 2.mokuro');
    expect(resolveListedPath(groups, 'ONE PIECE/Vol 3.cbz')).toBe('One Piece/Vol 3.cbz');
    expect(resolveListedPath(groups, 'HISTORY/device a/2026.events')).toBe(
      'history/Device A/2026.events'
    );
    expect(resolveListedPath(groups, 'goals.json')).toBe('Goals.json');
  });

  it('keeps what nothing lists, spelled as given', () => {
    expect(resolveListedPath(groups, 'Berserk/Vol 1.cbz')).toBe('Berserk/Vol 1.cbz');
    expect(resolveListedPath(groups, 'history/Device B/x.events')).toBe(
      'history/Device B/x.events'
    );
    expect(resolveListedPath(groups, 'profiles.json')).toBe('profiles.json');
  });

  it('a cache that cannot list writes the path as given', () => {
    expect(listedPathOn(undefined, 'A/b.cbz')).toBe('A/b.cbz');
    expect(listedPathOn({}, 'A/b.cbz')).toBe('A/b.cbz');
    expect(listedPathOn({ listedPath: () => 'X/b.cbz' }, 'A/b.cbz')).toBe('X/b.cbz');
  });
});

describe.each([
  ['webdav', webdavCache],
  ['onedrive', onedriveCache],
  ['mega', megaCache],
  ['filesystem', filesystemCache],
  ['google-drive', driveFilesCache]
] as Array<[string, CloudCache<CloudFileMetadata>]>)('the %s cache (R1, R9)', (provider, cache) => {
  function entry(path: string, fileId: string) {
    return {
      provider,
      fileId,
      path,
      name: path.split('/').pop(),
      modifiedTime: '2026-11-01T00:00:00.000Z',
      size: 1,
      modifiedTimeProvisional: false
    } as never;
  }

  it('finds a listed entry by any spelling of its fold, and adds onto it', () => {
    cache.clear();
    cache.add!('One Piece/VOL 1.mokuro', entry('One Piece/VOL 1.mokuro', 'm1'));
    cache.add!('volume-data.json', entry('volume-data.json', 'vd1'));

    expect(cache.has('one piece/Vol 1.mokuro')).toBe(true);
    expect(cache.get('ONE PIECE/vol 1.MOKURO')?.fileId).toBe('m1');
    expect(cache.getAll('Volume-Data.json').map((f) => f.fileId)).toEqual(['vd1']);
    expect(cache.has('One Piece/Vol 2.mokuro')).toBe(false);

    // A write of another spelling goes onto the listed one…
    expect(cache.listedPath!('one piece/Vol 1.mokuro')).toBe('One Piece/VOL 1.mokuro');
    expect(cache.listedPath!('one piece/Vol 1.cbz')).toBe('One Piece/Vol 1.cbz');
    expect(cache.listedPath!('Berserk/Vol 1.cbz')).toBe('Berserk/Vol 1.cbz');
    // …and so does the receipt it is cached under: one entry, the listed spelling.
    cache.add!('one piece/Vol 1.mokuro', entry('one piece/Vol 1.mokuro', 'm1'));
    expect(cache.getAll('One Piece/VOL 1.mokuro').map((f) => f.path)).toEqual([
      'One Piece/VOL 1.mokuro'
    ]);
    expect(cache.getBySeries('one piece')).toEqual([]);
    cache.clear();
  });
});
