import { describe, expect, it } from 'vitest';
import {
  accountCanAddFiles,
  accountCanModifyDelete,
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
