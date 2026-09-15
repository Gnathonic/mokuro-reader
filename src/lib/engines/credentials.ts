/**
 * API keys for the experimental OCR / translation engines. localStorage ONLY:
 * these never enter `profiles`, `miscSettings` or any synced file — a key in
 * `profiles.json` would ride to every device and every cloud folder.
 */
import { browser } from '$app/environment';
import { derived, writable, type Readable } from 'svelte/store';
import { miscSettings } from '$lib/settings/misc';

export interface EngineCredentials {
  googleKey: string;
  anthropicKey: string;
  openaiBaseUrl: string;
  openaiKey: string;
  openaiModel: string;
}

export const ENGINE_STORAGE_KEYS: Record<keyof EngineCredentials, string> = {
  googleKey: 'engine_google_key',
  anthropicKey: 'engine_anthropic_key',
  openaiBaseUrl: 'engine_openai_base_url',
  openaiKey: 'engine_openai_key',
  openaiModel: 'engine_openai_model'
};

function read(): EngineCredentials {
  const get = (k: keyof EngineCredentials) =>
    (browser ? window.localStorage.getItem(ENGINE_STORAGE_KEYS[k]) : null) ?? '';
  return {
    googleKey: get('googleKey'),
    anthropicKey: get('anthropicKey'),
    openaiBaseUrl: get('openaiBaseUrl'),
    openaiKey: get('openaiKey'),
    openaiModel: get('openaiModel')
  };
}

const store = writable<EngineCredentials>(read());
export const engineCredentials: Readable<EngineCredentials> = { subscribe: store.subscribe };

export function setEngineCredential(key: keyof EngineCredentials, value: string): void {
  const v = value.trim();
  if (browser) {
    if (v) window.localStorage.setItem(ENGINE_STORAGE_KEYS[key], v);
    else window.localStorage.removeItem(ENGINE_STORAGE_KEYS[key]);
  }
  store.update((c) => ({ ...c, [key]: v }));
}

export const hasGoogleKey = derived(engineCredentials, ($c) => $c.googleKey !== '');

/** Whether the engine chosen in `miscSettings.translationEngine` has its key. */
export const hasTranslationKey = derived([engineCredentials, miscSettings], ([$c, $m]) => {
  switch ($m.translationEngine) {
    case 'anthropic':
      return $c.anthropicKey !== '';
    case 'openai':
      return $c.openaiKey !== '';
    default:
      return $c.googleKey !== '';
  }
});
