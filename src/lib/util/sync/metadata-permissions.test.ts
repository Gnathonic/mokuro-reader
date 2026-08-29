import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: the vi.mock factory below is hoisted above this file's own imports, so the
// store it closes over has to be built here — same hand-rolled store pattern used by
// SeriesEditorModal.test.ts / SeriesTitlesEditor.test.ts.
const h = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    let value = initial;
    return {
      subscribe(fn: (v: T) => void) {
        fn(value);
        return () => {};
      },
      set(v: T) {
        value = v;
      }
    };
  }
  return {
    status: createStore<{
      providers: Record<
        string,
        { metadataPermissions?: unknown; canModifyDelete?: boolean } | null
      >;
      currentProviderType: string | null;
    }>({ providers: {}, currentProviderType: null })
  };
});

vi.mock('$lib/util/sync', () => ({ providerManager: { status: h.status } }));

import { canDeleteSeriesOnServer, canEditSeriesMetadata } from './metadata-permissions';

function setPermissions(
  providerType: string | null,
  metadataPermissions?: { scope: 'all' | 'owned' | 'none'; ownedSeries?: string[] },
  canModifyDelete?: boolean
) {
  h.status.set({
    currentProviderType: providerType,
    providers: providerType ? { [providerType]: { metadataPermissions, canModifyDelete } } : {}
  });
}

describe('canEditSeriesMetadata', () => {
  beforeEach(() => {
    h.status.set({ providers: {}, currentProviderType: null });
  });

  it('allows everything when there is no active provider', () => {
    expect(canEditSeriesMetadata('One Piece')).toEqual({ allowed: true });
  });

  it('allows everything when the active provider reports no metadataPermissions field', () => {
    setPermissions('webdav', undefined);
    expect(canEditSeriesMetadata('One Piece')).toEqual({ allowed: true });
  });

  it('allows everything under scope "all"', () => {
    setPermissions('webdav', { scope: 'all' });
    expect(canEditSeriesMetadata('One Piece')).toEqual({ allowed: true });
    expect(canEditSeriesMetadata('Anything Else')).toEqual({ allowed: true });
  });

  it('blocks everything under scope "none", with a reason', () => {
    setPermissions('webdav', { scope: 'none' });
    expect(canEditSeriesMetadata('One Piece')).toEqual({
      allowed: false,
      reason: "This account can't edit series details on this server"
    });
  });

  it('allows only listed series under scope "owned"', () => {
    setPermissions('webdav', { scope: 'owned', ownedSeries: ['One Piece', 'Berserk'] });
    expect(canEditSeriesMetadata('One Piece')).toEqual({ allowed: true });
    expect(canEditSeriesMetadata('Chainsaw Man')).toEqual({
      allowed: false,
      reason: 'Editing this series requires ownership on this server'
    });
  });

  it('folds both sides through normalizeVolumeTitleKey, so an NFD folder name still matches', () => {
    // A cloud folder name that made the round trip through a filesystem can come back
    // decomposed (NFD) while the identity response stays composed (NFC) — byte-different,
    // same series. See $lib/metadata/series-key.ts.
    const composed = 'ポケモン';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);

    setPermissions('webdav', { scope: 'owned', ownedSeries: [decomposed] });
    expect(canEditSeriesMetadata(composed)).toEqual({ allowed: true });
  });

  it('treats scope "owned" with no ownedSeries as owning nothing', () => {
    setPermissions('webdav', { scope: 'owned' });
    expect(canEditSeriesMetadata('One Piece').allowed).toBe(false);
  });

  it('reads permissions for whichever provider is currently active', () => {
    h.status.set({
      currentProviderType: 'webdav',
      providers: {
        webdav: { metadataPermissions: { scope: 'none' } },
        'google-drive': { metadataPermissions: { scope: 'all' } }
      }
    });
    expect(canEditSeriesMetadata('One Piece').allowed).toBe(false);
  });
});

describe('canDeleteSeriesOnServer', () => {
  beforeEach(() => {
    h.status.set({ providers: {}, currentProviderType: null });
  });

  it('allows everything when there is no active provider', () => {
    expect(canDeleteSeriesOnServer('One Piece')).toEqual({ allowed: true });
  });

  it('allows everything when the server does not report canModifyDelete', () => {
    // A plain WebDAV server, or a provider with no permission concept.
    setPermissions('webdav', undefined, undefined);
    expect(canDeleteSeriesOnServer('One Piece')).toEqual({ allowed: true });
  });

  it('allows everything for a modify/delete role', () => {
    setPermissions('webdav', { scope: 'all' }, true);
    expect(canDeleteSeriesOnServer('One Piece')).toEqual({ allowed: true });
  });

  it('allows an uploader to delete a series it owns — the server permits it', () => {
    setPermissions('webdav', { scope: 'owned', ownedSeries: ['One Piece'] }, false);
    expect(canDeleteSeriesOnServer('One Piece').allowed).toBe(true);
  });

  it('blocks an uploader from deleting a series it does not own, with a reason', () => {
    setPermissions('webdav', { scope: 'owned', ownedSeries: ['One Piece'] }, false);
    const check = canDeleteSeriesOnServer('Berserk');
    expect(check.allowed).toBe(false);
    expect(check.reason).toBeTruthy();
  });

  it('blocks a registered account everywhere, with a reason', () => {
    setPermissions('webdav', { scope: 'none' }, false);
    const check = canDeleteSeriesOnServer('One Piece');
    expect(check.allowed).toBe(false);
    expect(check.reason).toBeTruthy();
  });

  it('matches owned series across Unicode composition, like the edit gate', () => {
    setPermissions('webdav', { scope: 'owned', ownedSeries: ['Pok\u00e9mon'] }, false);
    expect(canDeleteSeriesOnServer('Poke\u0301mon').allowed).toBe(true);
  });
});
