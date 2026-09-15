import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';

const h = vi.hoisted(() => ({
  testGoogleVision: vi.fn(
    async () => ({ ok: true }) as { ok: true } | { ok: false; error: string }
  ),
  testGemini: vi.fn(async () => ({ ok: true })),
  testAnthropic: vi.fn(async () => ({ ok: false, error: 'invalid x-api-key' })),
  testOpenAI: vi.fn(async () => ({ ok: true }))
}));
vi.mock('$lib/engines/gcv', () => ({ testGoogleVision: h.testGoogleVision }));
vi.mock('$lib/engines/translate/gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/engines/translate/gemini')>()),
  testGemini: h.testGemini
}));
vi.mock('$lib/engines/translate/anthropic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/engines/translate/anthropic')>()),
  testAnthropic: h.testAnthropic
}));
vi.mock('$lib/engines/translate/openai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/engines/translate/openai')>()),
  testOpenAI: h.testOpenAI
}));

import EngineSettings from '../EngineSettings.svelte';
import { engineCredentials, setEngineCredential } from '$lib/engines/credentials';
import { miscSettings, updateMiscSetting } from '$lib/settings/misc';

beforeEach(() => {
  localStorage.clear();
  for (const k of [
    'googleKey',
    'anthropicKey',
    'openaiBaseUrl',
    'openaiKey',
    'openaiModel'
  ] as const)
    setEngineCredential(k, '');
  updateMiscSetting('translationEngine', 'gemini');
  updateMiscSetting('translationModel', '');
  updateMiscSetting('translationLanguage', 'en');
});
afterEach(cleanup);

/** The card is a collapsed AccordionItem: open it before querying its fields. */
async function mount() {
  const utils = render(EngineSettings);
  await fireEvent.click(utils.getByText(/OCR & translation engines \(experimental\)/));
  return utils;
}

describe('EngineSettings', () => {
  it('is labelled experimental and persists a typed key to localStorage only', async () => {
    const { getByLabelText } = await mount();
    const input = getByLabelText('Google API key') as HTMLInputElement;
    expect(input.type).toBe('password');
    await fireEvent.input(input, { target: { value: 'g-key-1' } });
    await fireEvent.change(input);
    expect(get(engineCredentials).googleKey).toBe('g-key-1');
    expect(localStorage.getItem('engine_google_key')).toBe('g-key-1');
    expect(localStorage.getItem('profiles') ?? '').not.toContain('g-key-1');
  });

  it('Show toggles the field type', async () => {
    const { getByLabelText } = await mount();
    const input = getByLabelText('Anthropic API key') as HTMLInputElement;
    expect(input.type).toBe('password');
    await fireEvent.click(getByLabelText('Show Anthropic API key'));
    expect(input.type).toBe('text');
  });

  it('Test buttons call the engine probe and show the result inline', async () => {
    setEngineCredential('googleKey', 'g');
    setEngineCredential('anthropicKey', 'a');
    const { getByLabelText, findByText } = await mount();
    await fireEvent.click(getByLabelText('Test Google API key'));
    expect(h.testGoogleVision).toHaveBeenCalledWith('g');
    expect(await findByText('Cloud Vision OK')).toBeTruthy();
    await fireEvent.click(getByLabelText('Test Anthropic API key'));
    expect(h.testAnthropic).toHaveBeenCalledWith('a', undefined);
    expect(await findByText(/invalid x-api-key/)).toBeTruthy();
  });

  it('translation engine, model and language write to miscSettings', async () => {
    const { getByLabelText } = await mount();
    await fireEvent.change(getByLabelText('Translation engine'), {
      target: { value: 'anthropic' }
    });
    expect(get(miscSettings).translationEngine).toBe('anthropic');
    const model = getByLabelText('Translation model') as HTMLInputElement;
    expect(model.placeholder).toBe('claude-haiku-4-5');
    await fireEvent.input(model, { target: { value: 'claude-sonnet-5' } });
    await fireEvent.change(model);
    expect(get(miscSettings).translationModel).toBe('claude-sonnet-5');
    const lang = getByLabelText('Target language') as HTMLInputElement;
    await fireEvent.input(lang, { target: { value: 'de' } });
    await fireEvent.change(lang);
    await waitFor(() => expect(get(miscSettings).translationLanguage).toBe('de'));
  });
});
