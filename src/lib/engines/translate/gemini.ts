import { requestJson, asTestResult } from './http';
import { buildSystemPrompt, buildUserPrompt, parseTranslation } from './prompt';
import type { EngineTestResult, TranslationAdapter, TranslationInput } from './types';

export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiReply {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export function createGeminiAdapter(opts: {
  key: string;
  model?: string;
  fetch?: typeof fetch;
}): TranslationAdapter {
  const model = opts.model || GEMINI_DEFAULT_MODEL;
  const f = opts.fetch ?? fetch;
  const raw = async (input: TranslationInput, signal?: AbortSignal) => {
    const json = (await requestJson(
      f,
      `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(opts.key)}`,
      {
        body: {
          systemInstruction: { parts: [{ text: buildSystemPrompt(input.target) }] },
          contents: [{ role: 'user', parts: [{ text: buildUserPrompt(input) }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
        },
        signal
      }
    )) as GeminiReply;
    return (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  };
  return {
    id: 'gemini',
    model,
    raw,
    translatePage: async (input, signal) =>
      parseTranslation(
        await raw(input, signal),
        input.blocks.map((b) => b.index)
      )
  };
}

export function testGemini(
  key: string,
  model?: string,
  fetchImpl?: typeof fetch
): Promise<EngineTestResult> {
  const a = createGeminiAdapter({ key, model, fetch: fetchImpl });
  return asTestResult(() =>
    a.raw({
      seriesTitle: 'test',
      volumeTitle: '1',
      target: 'en',
      blocks: [{ index: 0, text: 'こんにちは' }]
    })
  );
}
