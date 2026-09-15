import { requestJson, asTestResult } from './http';
import { buildSystemPrompt, buildUserPrompt, parseTranslation } from './prompt';
import type { EngineTestResult, TranslationAdapter, TranslationInput } from './types';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

interface AnthropicReply {
  content?: { type?: string; text?: string }[];
}

function headers(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    // Browser calls need this opt-in header; the key never leaves this device.
    'anthropic-dangerous-direct-browser-access': 'true'
  };
}

export function createAnthropicAdapter(opts: {
  key: string;
  model?: string;
  fetch?: typeof fetch;
}): TranslationAdapter {
  const model = opts.model || ANTHROPIC_DEFAULT_MODEL;
  const f = opts.fetch ?? fetch;
  const raw = async (input: TranslationInput, signal?: AbortSignal, maxTokens = 4096) => {
    const json = (await requestJson(f, ENDPOINT, {
      headers: headers(opts.key),
      body: {
        model,
        max_tokens: maxTokens,
        system: buildSystemPrompt(input.target),
        messages: [{ role: 'user', content: buildUserPrompt(input) }]
      },
      signal
    })) as AnthropicReply;
    return (json.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
  };
  return {
    id: 'anthropic',
    model,
    raw: (input, signal) => raw(input, signal),
    translatePage: async (input, signal) =>
      parseTranslation(
        await raw(input, signal),
        input.blocks.map((b) => b.index)
      )
  };
}

export function testAnthropic(
  key: string,
  model?: string,
  fetchImpl?: typeof fetch
): Promise<EngineTestResult> {
  const f = fetchImpl ?? fetch;
  return asTestResult(() =>
    requestJson(f, ENDPOINT, {
      headers: headers(key),
      body: {
        model: model || ANTHROPIC_DEFAULT_MODEL,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with OK.' }]
      }
    })
  );
}
