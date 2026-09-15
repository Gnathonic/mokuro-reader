import { requestJson, asTestResult } from './http';
import { buildSystemPrompt, buildUserPrompt, parseTranslation } from './prompt';
import type { EngineTestResult, TranslationAdapter, TranslationInput } from './types';

export const OPENAI_DEFAULT_MODEL = 'gpt-4.1-mini';
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

interface OpenAIReply {
  choices?: { message?: { content?: string | null } }[];
}

function base(url?: string): string {
  return (url || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function createOpenAIAdapter(opts: {
  key: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
}): TranslationAdapter {
  const model = opts.model || OPENAI_DEFAULT_MODEL;
  const f = opts.fetch ?? fetch;
  const raw = async (input: TranslationInput, signal?: AbortSignal) => {
    const json = (await requestJson(f, `${base(opts.baseUrl)}/chat/completions`, {
      headers: { Authorization: `Bearer ${opts.key}` },
      body: {
        model,
        messages: [
          // json_object mode needs an object reply; the parser unwraps {translations}.
          { role: 'system', content: buildSystemPrompt(input.target, true) },
          { role: 'user', content: buildUserPrompt(input) }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2
      },
      signal
    })) as OpenAIReply;
    return json.choices?.[0]?.message?.content ?? '';
  };
  return {
    id: 'openai',
    model,
    raw,
    translatePage: async (input, signal) =>
      parseTranslation(
        await raw(input, signal),
        input.blocks.map((b) => b.index)
      )
  };
}

/** `GET {base}/models` — free on every OpenAI-compatible server. */
export function testOpenAI(
  key: string,
  baseUrl?: string,
  fetchImpl?: typeof fetch
): Promise<EngineTestResult> {
  const f = fetchImpl ?? fetch;
  return asTestResult(() =>
    requestJson(f, `${base(baseUrl)}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` }
    })
  );
}
