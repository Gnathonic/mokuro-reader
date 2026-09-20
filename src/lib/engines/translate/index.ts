/**
 * Picks the translation adapter the user configured, and runs one page
 * through it: the provider's raw reply is parsed here so a malformed reply
 * (a model that ignored "JSON only") is retried exactly once in one place.
 */
import type { EngineCredentials } from '../credentials';
import type { TranslationEngineId, TranslationModelOverrides } from '$lib/settings/misc';
import { MalformedTranslationError, parseTranslation } from './prompt';
import type { TranslationAdapter, TranslationInput, TranslationResult } from './types';
import { createGeminiAdapter, GEMINI_DEFAULT_MODEL } from './gemini';
import { createAnthropicAdapter, ANTHROPIC_DEFAULT_MODEL } from './anthropic';
import { createOpenAIAdapter, OPENAI_DEFAULT_MODEL } from './openai';

export const ENGINE_DEFAULT_MODEL: Record<TranslationEngineId, string> = {
  gemini: GEMINI_DEFAULT_MODEL,
  anthropic: ANTHROPIC_DEFAULT_MODEL,
  openai: OPENAI_DEFAULT_MODEL
};

export function getTranslationAdapter(
  creds: EngineCredentials,
  prefs: { translationEngine: TranslationEngineId; translationModels: TranslationModelOverrides },
  fetchImpl?: typeof fetch
): TranslationAdapter | null {
  // Only the selected engine's own override: see `MiscSettings.translationModels`.
  const model = prefs.translationModels[prefs.translationEngine]?.trim() || undefined;
  switch (prefs.translationEngine) {
    case 'anthropic':
      return creds.anthropicKey
        ? createAnthropicAdapter({ key: creds.anthropicKey, model, fetch: fetchImpl })
        : null;
    case 'openai':
      return creds.openaiKey
        ? createOpenAIAdapter({
            key: creds.openaiKey,
            baseUrl: creds.openaiBaseUrl || undefined,
            model: model ?? (creds.openaiModel || undefined),
            fetch: fetchImpl
          })
        : null;
    default:
      return creds.googleKey
        ? createGeminiAdapter({ key: creds.googleKey, model, fetch: fetchImpl })
        : null;
  }
}

/** One page through an adapter; a malformed reply is retried exactly once. */
export async function translateBlocks(
  adapter: TranslationAdapter,
  input: TranslationInput,
  signal?: AbortSignal
): Promise<TranslationResult[]> {
  const expected = input.blocks.map((b) => b.index);
  for (let attempt = 0; ; attempt++) {
    const raw = await adapter.raw(input, signal);
    try {
      return parseTranslation(raw, expected);
    } catch (error) {
      if (!(error instanceof MalformedTranslationError) || attempt >= 1) throw error;
    }
  }
}
