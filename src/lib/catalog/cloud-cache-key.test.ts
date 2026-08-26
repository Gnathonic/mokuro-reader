import { describe, it, expect, vi } from 'vitest';

const { getActiveProvider } = vi.hoisted(() => ({ getActiveProvider: vi.fn() }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider }
}));

import { activeAccountScope, normalizeCachePath } from './cloud-cache-key';

describe('normalizeCachePath', () => {
  it('folds leading slashes and duplicate separators', () => {
    expect(normalizeCachePath('//Dr Stone//Volume 01.cbz')).toBe('Dr Stone/Volume 01.cbz');
    expect(normalizeCachePath('/Dr Stone/Volume 01.cbz')).toBe('Dr Stone/Volume 01.cbz');
  });

  it('NFC-normalizes so a decomposed listing matches a composed one', () => {
    const nfd = 'ポケモン/Volume 01.cbz'.normalize('NFD');
    expect(normalizeCachePath(nfd)).toBe('ポケモン/Volume 01.cbz'.normalize('NFC'));
  });

  it('preserves case — cloud paths are case-sensitive', () => {
    expect(normalizeCachePath('Dr Stone/VOLUME 01.cbz')).toBe('Dr Stone/VOLUME 01.cbz');
  });
});

describe('activeAccountScope', () => {
  it('returns null when no provider is connected', () => {
    getActiveProvider.mockReturnValue(null);
    expect(activeAccountScope()).toBeNull();
  });

  it('returns null when the provider reports no account scope', () => {
    getActiveProvider.mockReturnValue({ getStatus: () => ({ isAuthenticated: true }) });
    expect(activeAccountScope()).toBeNull();
  });

  it('returns the provider-reported scope', () => {
    getActiveProvider.mockReturnValue({
      getStatus: () => ({ isAuthenticated: true, accountScope: 'webdav:https://h/dav|nathan' })
    });
    expect(activeAccountScope()).toBe('webdav:https://h/dav|nathan');
  });
});
