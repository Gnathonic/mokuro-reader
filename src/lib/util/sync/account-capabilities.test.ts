import { describe, expect, it } from 'vitest';
import {
  accountCanAddFiles,
  accountCanModifyDelete,
  canPublishCurated,
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
});
