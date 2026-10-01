import { describe, expect, it } from 'vitest';
import { cleanupLegacyEngineCredentials } from './engine-credentials-cleanup';

const LEGACY_KEYS = [
  'engine_google_key',
  'engine_anthropic_key',
  'engine_openai_base_url',
  'engine_openai_key',
  'engine_openai_model'
];

describe('cleanupLegacyEngineCredentials', () => {
  it('removes every legacy engine credential key, and is harmless after', () => {
    for (const key of LEGACY_KEYS) localStorage.setItem(key, 'secret');
    localStorage.setItem('unrelated', 'kept');

    cleanupLegacyEngineCredentials();

    for (const key of LEGACY_KEYS) expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('kept');

    // Idempotent: calling again with nothing left to remove does not throw
    // and leaves unrelated data alone.
    cleanupLegacyEngineCredentials();
    expect(localStorage.getItem('unrelated')).toBe('kept');
  });

  it('does nothing when none of the keys were ever set', () => {
    expect(() => cleanupLegacyEngineCredentials()).not.toThrow();
    for (const key of LEGACY_KEYS) expect(localStorage.getItem(key)).toBeNull();
  });
});
