import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/util/sync/providers/google-drive/constants', () => ({
  GOOGLE_DRIVE_CONFIG: {
    STORAGE_KEYS: { HAS_AUTHENTICATED: 'gdrive_has_authenticated', TOKEN: 'gdrive_token' }
  }
}));

import { getConfiguredProviderType } from './provider-detection';

beforeEach(() => {
  localStorage.clear();
});

describe('provider detection (MEGA)', () => {
  it('detects MEGA from a session blob (new key)', () => {
    localStorage.setItem('mega_session', JSON.stringify({ sid: 'S', key: 'K' }));
    expect(getConfiguredProviderType()).toBe('mega');
  });

  it('still detects MEGA from legacy email/password (pre-migration)', () => {
    localStorage.setItem('mega_email', 'a@b.c');
    localStorage.setItem('mega_password', 'p');
    expect(getConfiguredProviderType()).toBe('mega');
  });
});
