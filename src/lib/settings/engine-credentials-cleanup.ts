/**
 * The experimental OCR/translation engines (`$lib/engines/`, removed) stored
 * their API keys in these exact localStorage keys (`engines/credentials.ts`,
 * `ENGINE_STORAGE_KEYS`) — never in `miscSettings` or any synced file. Now
 * that the feature is gone, any key a user configured still sits in their
 * browser forever unless swept once here. Idempotent: safe to call on every
 * app start.
 */

const LEGACY_ENGINE_CREDENTIAL_KEYS = [
  'engine_google_key',
  'engine_anthropic_key',
  'engine_openai_base_url',
  'engine_openai_key',
  'engine_openai_model'
] as const;

export function cleanupLegacyEngineCredentials(): void {
  try {
    for (const key of LEGACY_ENGINE_CREDENTIAL_KEYS) {
      globalThis.localStorage?.removeItem(key);
    }
  } catch {
    // Storage unavailable: nothing to clean.
  }
}
