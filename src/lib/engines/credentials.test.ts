import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';

describe('engine credentials', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads and writes each key through localStorage only', async () => {
    const { engineCredentials, setEngineCredential, ENGINE_STORAGE_KEYS } = await import(
      './credentials'
    );
    setEngineCredential('googleKey', 'g-123');
    setEngineCredential('openaiBaseUrl', 'https://api.example.com/v1');
    expect(get(engineCredentials).googleKey).toBe('g-123');
    expect(localStorage.getItem(ENGINE_STORAGE_KEYS.googleKey)).toBe('g-123');
    expect(localStorage.getItem(ENGINE_STORAGE_KEYS.openaiBaseUrl)).toBe(
      'https://api.example.com/v1'
    );
    setEngineCredential('googleKey', '   ');
    expect(localStorage.getItem(ENGINE_STORAGE_KEYS.googleKey)).toBeNull();
    expect(get(engineCredentials).googleKey).toBe('');
  });

  it('hasGoogleKey / hasTranslationKey follow the keys and the chosen engine', async () => {
    const { hasGoogleKey, hasTranslationKey, setEngineCredential } = await import('./credentials');
    const { updateMiscSetting } = await import('$lib/settings/misc');
    updateMiscSetting('translationEngine', 'gemini');
    expect(get(hasGoogleKey)).toBe(false);
    setEngineCredential('googleKey', 'g');
    expect(get(hasGoogleKey)).toBe(true);
    // gemini is the default engine: the Google key is its key
    expect(get(hasTranslationKey)).toBe(true);
    updateMiscSetting('translationEngine', 'anthropic');
    expect(get(hasTranslationKey)).toBe(false);
    setEngineCredential('anthropicKey', 'a');
    expect(get(hasTranslationKey)).toBe(true);
    updateMiscSetting('translationEngine', 'openai');
    expect(get(hasTranslationKey)).toBe(false);
    setEngineCredential('openaiKey', 'o');
    expect(get(hasTranslationKey)).toBe(true);
  });

  it('never leaks a key into the profiles store, misc settings, or their persisted JSON', async () => {
    const { setEngineCredential } = await import('./credentials');
    const { profilesWithTrash, updateSetting } = await import('$lib/settings/settings');
    const { miscSettings } = await import('$lib/settings/misc');
    setEngineCredential('googleKey', 'SECRET-GOOGLE');
    setEngineCredential('anthropicKey', 'SECRET-ANTHROPIC');
    setEngineCredential('openaiKey', 'SECRET-OPENAI');
    updateSetting('boldFont', true); // force a profiles write
    const persisted = localStorage.getItem('profiles') ?? '';
    const inMemory = JSON.stringify(get(profilesWithTrash));
    const misc = JSON.stringify(get(miscSettings)) + (localStorage.getItem('miscSettings') ?? '');
    for (const blob of [persisted, inMemory, misc]) {
      expect(blob).not.toContain('SECRET-GOOGLE');
      expect(blob).not.toContain('SECRET-ANTHROPIC');
      expect(blob).not.toContain('SECRET-OPENAI');
    }
  });
});
