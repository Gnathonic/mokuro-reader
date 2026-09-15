import type { TranslationEngineId } from '$lib/settings/misc';

export interface TranslationBlockInput {
  index: number;
  text: string;
}

export interface TranslationInput {
  seriesTitle: string;
  volumeTitle: string;
  /** Target language, e.g. 'en'. */
  target: string;
  /** Blocks in reading order. */
  blocks: TranslationBlockInput[];
}

export interface TranslationResult {
  index: number;
  text: string;
}

export interface TranslationAdapter {
  id: TranslationEngineId;
  model: string;
  /** The provider's raw reply text — parsed (and retried once) by `translateBlocks`. */
  raw(input: TranslationInput, signal?: AbortSignal): Promise<string>;
  translatePage(input: TranslationInput, signal?: AbortSignal): Promise<TranslationResult[]>;
}

export type EngineTestResult = { ok: true } | { ok: false; error: string };
