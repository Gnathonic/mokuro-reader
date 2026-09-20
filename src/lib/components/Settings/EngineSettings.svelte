<script lang="ts">
  /**
   * Keys and preferences for the EXPERIMENTAL OCR / translation engines.
   * Keys are written to localStorage only (`$lib/engines/credentials`) — they
   * never reach `profiles` or any synced file. Each engine has a Test button
   * that makes one cheap call and reports inline.
   */
  import { AccordionItem, Button, Helper, Input, Label } from 'flowbite-svelte';
  import {
    engineCredentials,
    setEngineCredential,
    type EngineCredentials
  } from '$lib/engines/credentials';
  import { testGoogleVision } from '$lib/engines/gcv';
  import { testGemini } from '$lib/engines/translate/gemini';
  import { testAnthropic } from '$lib/engines/translate/anthropic';
  import { testOpenAI } from '$lib/engines/translate/openai';
  import { ENGINE_DEFAULT_MODEL } from '$lib/engines/translate';
  import { miscSettings, updateMiscSetting, type TranslationEngineId } from '$lib/settings/misc';

  type Field = keyof EngineCredentials;
  let shown = $state<Record<Field, boolean>>({
    googleKey: false,
    anthropicKey: false,
    openaiBaseUrl: true,
    openaiKey: false,
    openaiModel: true
  });
  let results = $state<Record<string, string>>({});
  let testing = $state<Record<string, boolean>>({});

  function onField(field: Field, e: Event) {
    setEngineCredential(field, (e.currentTarget as HTMLInputElement).value);
  }

  async function runTest(
    id: string,
    run: () => Promise<{ ok: true } | { ok: false; error: string }>,
    okText: string
  ) {
    testing = { ...testing, [id]: true };
    results = { ...results, [id]: '' };
    try {
      const r = await run();
      results = { ...results, [id]: r.ok ? okText : `Error: ${r.error}` };
    } finally {
      testing = { ...testing, [id]: false };
    }
  }

  let engine = $derived($miscSettings.translationEngine);
  // The one model field edits the SELECTED engine's override only, so changing
  // the dropdown swaps what the field shows instead of re-aiming its text at a
  // provider that has never heard of that model.
  let modelOverride = $derived($miscSettings.translationModels[engine] ?? '');

  function setModelOverride(value: string) {
    const { [engine]: _previous, ...others } = $miscSettings.translationModels;
    // An emptied field removes the key: '' and absent both mean "the default",
    // and only one of them should ever be stored.
    updateMiscSetting('translationModels', value ? { ...others, [engine]: value } : others);
  }
  let modelPlaceholder = $derived(
    engine === 'openai'
      ? $engineCredentials.openaiModel || ENGINE_DEFAULT_MODEL.openai
      : ENGINE_DEFAULT_MODEL[engine]
  );

  const inputClass = 'flex-1';
</script>

<AccordionItem>
  {#snippet header()}OCR & translation engines (experimental){/snippet}
  <div class="flex flex-col gap-5">
    <Helper>
      Experimental. Keys are stored only in this browser and never synced. OCR results and
      translations land in OCR layers beside the primary OCR, never over it.
    </Helper>

    <!-- Google: Cloud Vision + Gemini -->
    <div class="flex flex-col gap-1">
      <Label for="engine-google-key" class="text-gray-900 dark:text-white"
        >Google API key (Cloud Vision + Gemini)</Label
      >
      <div class="flex gap-2">
        <Input
          id="engine-google-key"
          aria-label="Google API key"
          type={shown.googleKey ? 'text' : 'password'}
          autocomplete="off"
          value={$engineCredentials.googleKey}
          onchange={(e) => onField('googleKey', e)}
          class={inputClass}
        />
        <Button
          size="xs"
          color="alternative"
          aria-label="Show Google API key"
          onclick={() => (shown = { ...shown, googleKey: !shown.googleKey })}
          >{shown.googleKey ? 'Hide' : 'Show'}</Button
        >
        <Button
          size="xs"
          color="alternative"
          aria-label="Test Google API key"
          disabled={!$engineCredentials.googleKey || testing.google}
          onclick={() =>
            runTest(
              'google',
              async () => {
                const v = await testGoogleVision($engineCredentials.googleKey);
                if (!v.ok) return { ok: false, error: `Cloud Vision: ${v.error}` };
                const g = await testGemini($engineCredentials.googleKey, undefined);
                return g.ok ? { ok: true } : { ok: false, error: `Gemini: ${g.error}` };
              },
              'Cloud Vision OK'
            )}>Test</Button
        >
      </div>
      {#if results.google}<span class="text-xs text-gray-600 dark:text-gray-300"
          >{results.google}</span
        >{/if}
      <Helper>
        Enable the Cloud Vision API and the Generative Language API on the key. Cloud Vision: about
        $1.50 per 1000 pages after the free monthly 1000. Gemini Flash: a few cents per volume.
      </Helper>
    </div>

    <!-- Anthropic -->
    <div class="flex flex-col gap-1">
      <Label for="engine-anthropic-key" class="text-gray-900 dark:text-white"
        >Anthropic API key</Label
      >
      <div class="flex gap-2">
        <Input
          id="engine-anthropic-key"
          aria-label="Anthropic API key"
          type={shown.anthropicKey ? 'text' : 'password'}
          autocomplete="off"
          value={$engineCredentials.anthropicKey}
          onchange={(e) => onField('anthropicKey', e)}
          class={inputClass}
        />
        <Button
          size="xs"
          color="alternative"
          aria-label="Show Anthropic API key"
          onclick={() => (shown = { ...shown, anthropicKey: !shown.anthropicKey })}
          >{shown.anthropicKey ? 'Hide' : 'Show'}</Button
        >
        <Button
          size="xs"
          color="alternative"
          aria-label="Test Anthropic API key"
          disabled={!$engineCredentials.anthropicKey || testing.anthropic}
          onclick={() =>
            runTest(
              'anthropic',
              () =>
                testAnthropic(
                  $engineCredentials.anthropicKey,
                  $miscSettings.translationModels.anthropic || undefined
                ),
              'Anthropic OK'
            )}>Test</Button
        >
      </div>
      {#if results.anthropic}<span class="text-xs text-gray-600 dark:text-gray-300"
          >{results.anthropic}</span
        >{/if}
      <Helper>Claude Haiku 4.5: roughly $0.50 per volume. Better at tone and honorifics.</Helper>
    </div>

    <!-- OpenAI-compatible -->
    <div class="flex flex-col gap-1">
      <Label class="text-gray-900 dark:text-white">OpenAI-compatible endpoint</Label>
      <Input
        aria-label="OpenAI-compatible base URL"
        type="text"
        placeholder="https://api.openai.com/v1"
        autocomplete="off"
        value={$engineCredentials.openaiBaseUrl}
        onchange={(e) => onField('openaiBaseUrl', e)}
      />
      <div class="flex gap-2">
        <Input
          aria-label="OpenAI-compatible API key"
          type={shown.openaiKey ? 'text' : 'password'}
          autocomplete="off"
          placeholder="API key"
          value={$engineCredentials.openaiKey}
          onchange={(e) => onField('openaiKey', e)}
          class={inputClass}
        />
        <Button
          size="xs"
          color="alternative"
          aria-label="Show OpenAI-compatible API key"
          onclick={() => (shown = { ...shown, openaiKey: !shown.openaiKey })}
          >{shown.openaiKey ? 'Hide' : 'Show'}</Button
        >
        <Button
          size="xs"
          color="alternative"
          aria-label="Test OpenAI-compatible API key"
          disabled={!$engineCredentials.openaiKey || testing.openai}
          onclick={() =>
            runTest(
              'openai',
              () =>
                testOpenAI(
                  $engineCredentials.openaiKey,
                  $engineCredentials.openaiBaseUrl || undefined
                ),
              'Endpoint OK'
            )}>Test</Button
        >
      </div>
      <Input
        aria-label="OpenAI-compatible model"
        type="text"
        placeholder={ENGINE_DEFAULT_MODEL.openai}
        autocomplete="off"
        value={$engineCredentials.openaiModel}
        onchange={(e) => onField('openaiModel', e)}
      />
      {#if results.openai}<span class="text-xs text-gray-600 dark:text-gray-300"
          >{results.openai}</span
        >{/if}
      <Helper
        >Covers OpenAI, DeepSeek, OpenRouter and local servers. Cost depends on the model.</Helper
      >
    </div>

    <!-- Translation preferences -->
    <div class="flex flex-col gap-2">
      <Label for="engine-translation-engine" class="text-gray-900 dark:text-white"
        >Translation</Label
      >
      <select
        id="engine-translation-engine"
        aria-label="Translation engine"
        class="block w-full rounded-lg border border-gray-300 bg-gray-50 p-2 text-sm text-gray-900 focus:border-primary-500 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        value={engine}
        onchange={(e) =>
          updateMiscSetting(
            'translationEngine',
            (e.currentTarget as HTMLSelectElement).value as TranslationEngineId
          )}
      >
        <option value="gemini" selected={engine === 'gemini'}>Gemini (Google key)</option>
        <option value="anthropic" selected={engine === 'anthropic'}>Anthropic</option>
        <option value="openai" selected={engine === 'openai'}>OpenAI-compatible</option>
      </select>
      <div class="flex flex-wrap gap-2">
        <Input
          aria-label="Translation model"
          type="text"
          placeholder={modelPlaceholder}
          autocomplete="off"
          value={modelOverride}
          onchange={(e) => setModelOverride((e.currentTarget as HTMLInputElement).value.trim())}
          class="flex-1"
        />
        <Input
          aria-label="Target language"
          type="text"
          placeholder="en"
          autocomplete="off"
          value={$miscSettings.translationLanguage}
          onchange={(e) =>
            updateMiscSetting(
              'translationLanguage',
              (e.currentTarget as HTMLInputElement).value.trim() || 'en'
            )}
          class="w-24"
        />
      </div>
      <Helper>
        Model override (blank = the engine's default) and the target language code. Translations
        land in a "Translation (language)" layer; the primary OCR is never overwritten.
      </Helper>
    </div>
  </div>
</AccordionItem>
