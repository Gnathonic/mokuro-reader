import { describe, expect, it, vi } from 'vitest';
import { createGeminiAdapter, testGemini } from './gemini';
import { createAnthropicAdapter, testAnthropic } from './anthropic';
import { createOpenAIAdapter, testOpenAI } from './openai';
import { ENGINE_DEFAULT_MODEL, getTranslationAdapter, translateBlocks } from './index';
import { MalformedTranslationError } from './prompt';
import { RetryableError } from '../run-queue';
import type { TranslationAdapter } from './types';

const input = {
  seriesTitle: 'S',
  volumeTitle: 'V',
  target: 'en',
  blocks: [{ index: 0, text: 'こんにちは' }]
};
const reply = JSON.stringify([{ index: 0, text: 'Hello' }]);
const okFetch = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));
const asFetch = (f: unknown) => f as typeof fetch;
const call = (f: ReturnType<typeof okFetch>) => f.mock.calls[0] as unknown as [string, RequestInit];

describe('gemini adapter', () => {
  it('posts to generateContent with the key, JSON mode, and returns the parsed reply', async () => {
    const f = okFetch({ candidates: [{ content: { parts: [{ text: reply }] } }] });
    const a = createGeminiAdapter({ key: 'g', fetch: asFetch(f) });
    expect(a.model).toBe('gemini-2.5-flash');
    expect(await a.translatePage(input)).toEqual([{ index: 0, text: 'Hello' }]);
    const [url, init] = call(f);
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=g'
    );
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.systemInstruction.parts[0].text).toContain('en');
    expect(body.contents[0].parts[0].text).toContain('こんにちは');
  });
  it('429 → RetryableError; 400 → Error with the message', async () => {
    await expect(
      createGeminiAdapter({ key: 'g', fetch: asFetch(okFetch({}, 429)) }).translatePage(input)
    ).rejects.toBeInstanceOf(RetryableError);
    await expect(
      createGeminiAdapter({
        key: 'g',
        fetch: asFetch(okFetch({ error: { message: 'API key not valid' } }, 400))
      }).translatePage(input)
    ).rejects.toThrow('API key not valid');
  });
  it('testGemini reports ok / error', async () => {
    expect(
      await testGemini(
        'g',
        undefined,
        asFetch(okFetch({ candidates: [{ content: { parts: [{ text: reply }] } }] }))
      )
    ).toEqual({ ok: true });
    expect(
      await testGemini('g', undefined, asFetch(okFetch({ error: { message: 'nope' } }, 403)))
    ).toEqual({ ok: false, error: 'nope' });
  });
});

describe('anthropic adapter', () => {
  it('posts to /v1/messages with the browser header and extracts content[0].text', async () => {
    const f = okFetch({ content: [{ type: 'text', text: reply }] });
    const a = createAnthropicAdapter({ key: 'a', fetch: asFetch(f) });
    expect(a.model).toBe('claude-haiku-4-5');
    expect(await a.translatePage(input)).toEqual([{ index: 0, text: 'Hello' }]);
    const [url, init] = call(f);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const h = init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('a');
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(h['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.messages[0].role).toBe('user');
    expect(body.system).toContain('en');
  });
  it('testAnthropic reports the error message', async () => {
    expect(
      await testAnthropic(
        'a',
        undefined,
        asFetch(
          okFetch({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)
        )
      )
    ).toEqual({ ok: false, error: 'invalid x-api-key' });
  });
});

describe('openai adapter', () => {
  it('posts chat completions to the configured base URL with a bearer token', async () => {
    const f = okFetch({ choices: [{ message: { content: reply } }] });
    const a = createOpenAIAdapter({
      key: 'o',
      baseUrl: 'https://api.deepseek.com/v1/',
      model: 'deepseek-chat',
      fetch: asFetch(f)
    });
    expect(await a.translatePage(input)).toEqual([{ index: 0, text: 'Hello' }]);
    const [url, init] = call(f);
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer o');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('deepseek-chat');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
  });
  it('defaults to api.openai.com and gpt-4.1-mini; testOpenAI lists models', async () => {
    const a = createOpenAIAdapter({ key: 'o', fetch: asFetch(okFetch({})) });
    expect(a.model).toBe('gpt-4.1-mini');
    const f = okFetch({ data: [] });
    expect(await testOpenAI('o', undefined, asFetch(f))).toEqual({ ok: true });
    const [url, init] = call(f);
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(init.method ?? 'GET').toBe('GET');
  });
});

describe('getTranslationAdapter', () => {
  const creds = {
    googleKey: '',
    anthropicKey: '',
    openaiBaseUrl: '',
    openaiKey: '',
    openaiModel: ''
  };
  it('returns null without the chosen engine key, the adapter with it, honouring the model override', () => {
    expect(
      getTranslationAdapter(creds, { translationEngine: 'gemini', translationModels: {} })
    ).toBeNull();
    const g = getTranslationAdapter(
      { ...creds, googleKey: 'g' },
      { translationEngine: 'gemini', translationModels: { gemini: 'gemini-2.5-pro' } }
    );
    expect(g?.id).toBe('gemini');
    expect(g?.model).toBe('gemini-2.5-pro');
    const o = getTranslationAdapter(
      { ...creds, openaiKey: 'o', openaiModel: 'deepseek-chat' },
      { translationEngine: 'openai', translationModels: {} }
    );
    expect(o?.model).toBe('deepseek-chat');
    expect(
      getTranslationAdapter(
        { ...creds, anthropicKey: 'a' },
        { translationEngine: 'anthropic', translationModels: {} }
      )?.id
    ).toBe('anthropic');
  });

  // One flat override string used to ride along to whichever engine was
  // selected, so a Claude model id typed for Anthropic went to Gemini's endpoint
  // the moment the dropdown changed — a model-not-found with no hint why.
  it('never sends one engine an override that was typed for another', () => {
    const all = { ...creds, googleKey: 'g', anthropicKey: 'a', openaiKey: 'o' };
    const translationModels = { anthropic: 'claude-sonnet-5', openai: 'deepseek-reasoner' };
    expect(
      getTranslationAdapter(all, { translationEngine: 'gemini', translationModels })?.model
    ).toBe(ENGINE_DEFAULT_MODEL.gemini);
    expect(
      getTranslationAdapter(all, { translationEngine: 'anthropic', translationModels })?.model
    ).toBe('claude-sonnet-5');
    expect(
      getTranslationAdapter(all, { translationEngine: 'openai', translationModels })?.model
    ).toBe('deepseek-reasoner');
  });
});

describe('translateBlocks', () => {
  it('retries once on a malformed reply, then throws', async () => {
    const replies = ['garbage', reply];
    const adapter: TranslationAdapter = {
      id: 'gemini',
      model: 'm',
      raw: vi.fn(async () => replies.shift()!),
      translatePage: vi.fn(async () => {
        throw new Error('unused');
      })
    };
    expect(await translateBlocks(adapter, input)).toEqual([{ index: 0, text: 'Hello' }]);
    expect(adapter.raw).toHaveBeenCalledTimes(2);
    const bad: TranslationAdapter = { ...adapter, raw: vi.fn(async () => 'nope') };
    await expect(translateBlocks(bad, input)).rejects.toBeInstanceOf(MalformedTranslationError);
    expect(bad.raw).toHaveBeenCalledTimes(2);
  });
});
