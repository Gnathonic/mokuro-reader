<script lang="ts">
  import { page } from '$app/stores';
  import { settings, updateAnkiSetting } from '$lib/settings';
  import { AccordionItem, Button, Helper, Input, Label, Select, Toggle } from 'flowbite-svelte';
  import {
    DYNAMIC_TAGS,
    DEFAULT_ANKI_TAGS,
    testConnection,
    type ConnectionTestResult
  } from '$lib/anki-connect';

  let disabled = $derived(!$settings.ankiConnectSettings.enabled);

  let enabled = $state($settings.ankiConnectSettings.enabled);
  let url = $state($settings.ankiConnectSettings.url);
  let cropImage = $state($settings.ankiConnectSettings.cropImage);
  let grabSentence = $state($settings.ankiConnectSettings.grabSentence);
  let overwriteImage = $state($settings.ankiConnectSettings.overwriteImage);

  let pictureField = $state($settings.ankiConnectSettings.pictureField);
  let sentenceField = $state($settings.ankiConnectSettings.sentenceField);

  let heightField = $state($settings.ankiConnectSettings.heightField);
  let widthField = $state($settings.ankiConnectSettings.widthField);
  let qualityField = $state($settings.ankiConnectSettings.qualityField);

  let ankiTags = $state($settings.ankiConnectSettings.tags);
  let cardMode = $state($settings.ankiConnectSettings.cardMode);
  let deckName = $state($settings.ankiConnectSettings.deckName);
  let modelName = $state($settings.ankiConnectSettings.modelName);

  let isCreateMode = $derived(cardMode === 'create');

  const cardModeOptions = [
    { value: 'update', name: 'Update last card (within 5 min)' },
    { value: 'create', name: 'Create new card' }
  ];

  let doubleTapEnabled = $state(
    $settings.ankiConnectSettings.triggerMethod === 'doubleTap' ||
      $settings.ankiConnectSettings.triggerMethod === 'both'
  );

  // Connection test state
  let connectionStatus = $state<ConnectionTestResult | null>(null);
  let isTesting = $state(false);

  async function handleTestConnection() {
    isTesting = true;
    connectionStatus = null;
    try {
      connectionStatus = await testConnection(url || undefined);
    } finally {
      isTesting = false;
    }
  }

  function updateDoubleTap(enabled: boolean) {
    // Map toggle to triggerMethod for backwards compatibility
    updateAnkiSetting('triggerMethod', enabled ? 'doubleTap' : 'neither');
  }

  function insertTag(tag: string) {
    ankiTags = ankiTags ? `${ankiTags} ${tag}`.trim() : tag;
    updateAnkiSetting('tags', ankiTags);
  }

  function insertDeckTag(tag: string) {
    // For deck names, append without spaces (use :: for hierarchy)
    deckName = deckName ? `${deckName}${tag}` : tag;
    updateAnkiSetting('deckName', deckName);
  }
</script>

<AccordionItem>
  {#snippet header()}Anki Connect{/snippet}
  <div class="flex flex-col gap-5">
    <Helper
      >For anki connect integration to work, you must add the reader (<code class="text-primary-500"
        >{$page.url.origin}</code
      >) to your anki connect <b class="text-primary-500">webCorsOriginList</b> list</Helper
    >
    <Helper>
      To trigger the anki connect integration, double click or right click (long press on mobile)
      any text box.
    </Helper>
    <div>
      <Toggle bind:checked={enabled} onchange={() => updateAnkiSetting('enabled', enabled)}
        >AnkiConnect Integration Enabled</Toggle
      >
    </div>
    <div>
      <Label class="text-gray-900 dark:text-white">AnkiConnect URL:</Label>
      <div class="flex gap-2">
        <Input
          {disabled}
          type="text"
          placeholder="http://127.0.0.1:8765"
          bind:value={url}
          onchange={() => {
            updateAnkiSetting('url', url);
            connectionStatus = null;
          }}
          class="flex-1"
        />
        <Button
          {disabled}
          size="sm"
          color="alternative"
          onclick={handleTestConnection}
          class="whitespace-nowrap"
        >
          {#if isTesting}
            Testing...
          {:else}
            Test
          {/if}
        </Button>
      </div>
      {#if connectionStatus}
        <div
          class="mt-2 rounded p-2 text-sm {connectionStatus.success
            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
            : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'}"
        >
          {connectionStatus.message}
          {#if !connectionStatus.success}
            <span class="mt-1 block text-xs opacity-75"
              >Check browser console (F12) for more details.</span
            >
          {/if}
        </div>
      {:else}
        <Helper class="mt-1">Use a custom URL to connect to AnkiConnect on another device</Helper>
      {/if}
    </div>
    <div>
      <Label class="text-gray-900 dark:text-white">Picture field:</Label>
      <Input
        {disabled}
        type="text"
        bind:value={pictureField}
        onchange={() => updateAnkiSetting('pictureField', pictureField)}
      />
    </div>
    <div>
      <Label class="text-gray-900 dark:text-white">Sentence field:</Label>
      <Input
        {disabled}
        type="text"
        bind:value={sentenceField}
        onchange={() => updateAnkiSetting('sentenceField', sentenceField)}
      />
      <Helper class="mt-1">Field for the full sentence context</Helper>
    </div>
    <div>
      <Toggle
        {disabled}
        bind:checked={cropImage}
        onchange={() => updateAnkiSetting('cropImage', cropImage)}>Crop image</Toggle
      >
    </div>
    <div>
      <Toggle
        {disabled}
        bind:checked={overwriteImage}
        onchange={() => updateAnkiSetting('overwriteImage', overwriteImage)}>Overwrite image</Toggle
      >
    </div>
    <div>
      <Toggle
        {disabled}
        bind:checked={grabSentence}
        onchange={() => updateAnkiSetting('grabSentence', grabSentence)}>Grab sentence</Toggle
      >
    </div>
    <div>
      <Toggle
        {disabled}
        bind:checked={doubleTapEnabled}
        onchange={() => updateDoubleTap(doubleTapEnabled)}>Double-tap to capture</Toggle
      >
      <Helper class="mt-1">Right-click any text box for more options</Helper>
    </div>
    <div>
      <Label class="text-gray-900 dark:text-white">
        Card mode:
        <Select
          {disabled}
          onchange={() => updateAnkiSetting('cardMode', cardMode)}
          items={cardModeOptions}
          bind:value={cardMode}
        />
      </Label>
      <Helper class="mt-1">
        {#if isCreateMode}
          Creates a new card in the specified deck
        {:else}
          Updates the most recently created card (must be within 5 minutes)
        {/if}
      </Helper>
    </div>
    {#if isCreateMode}
      <div>
        <Label class="text-gray-900 dark:text-white">Deck name:</Label>
        <Input
          {disabled}
          type="text"
          placeholder="Default"
          bind:value={deckName}
          onchange={() => updateAnkiSetting('deckName', deckName)}
        />
        <div class="mt-2 flex flex-wrap gap-2">
          {#each DYNAMIC_TAGS as { tag, description }}
            <button
              type="button"
              {disabled}
              onclick={() => insertDeckTag(tag)}
              class="inline-flex items-center rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              title={description}
            >
              {tag}
            </button>
          {/each}
        </div>
        <Helper class="mt-1">Supports dynamic tags. Use :: for subdecks.</Helper>
      </div>
      <div>
        <Label class="text-gray-900 dark:text-white">Note type (model):</Label>
        <Input
          {disabled}
          type="text"
          placeholder="Basic"
          bind:value={modelName}
          onchange={() => updateAnkiSetting('modelName', modelName)}
        />
        <Helper class="mt-1">The note type to use for new cards (e.g., Basic, Cloze)</Helper>
      </div>
    {/if}
    <div>
      <Label class="text-gray-900 dark:text-white">Tags:</Label>
      <Input
        {disabled}
        type="text"
        placeholder={DEFAULT_ANKI_TAGS}
        bind:value={ankiTags}
        onchange={() => updateAnkiSetting('tags', ankiTags)}
      />
      <div class="mt-2 flex flex-wrap gap-2">
        {#each DYNAMIC_TAGS as { tag, description }}
          <button
            type="button"
            {disabled}
            onclick={() => insertTag(tag)}
            class="inline-flex items-center rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            title={description}
          >
            {tag}
          </button>
        {/each}
      </div>
      <Helper class="mt-1">Click to insert. Spaces in names become underscores.</Helper>
    </div>
    <hr />
    <h4 class="text-gray-900 dark:text-white">Quality Settings</h4>
    <Helper>Allows you to customize the file size stored on your devices</Helper>
    <div>
      <Label class="text-gray-900 dark:text-white">Max Height (0 = Ignore; 200 Recommended):</Label>
      <Input
        {disabled}
        type="number"
        bind:value={heightField}
        onchange={() => {
          updateAnkiSetting('heightField', heightField);
          if (heightField < 0) heightField = 0;
        }}
        min={0}
      />
    </div>
    <div>
      <Label class="text-gray-900 dark:text-white">Max Width (0 = Ignore; 200 Recommended):</Label>
      <Input
        {disabled}
        type="number"
        bind:value={widthField}
        onchange={() => {
          updateAnkiSetting('widthField', widthField);
          if (widthField < 0) widthField = 0;
        }}
        min={0}
      />
    </div>
    <div>
      <Label class="text-gray-900 dark:text-white"
        >Quality (Between 0 and 1; 0.5 Recommended):</Label
      >
      <Input
        {disabled}
        type="number"
        bind:value={qualityField}
        onchange={() => updateAnkiSetting('qualityField', qualityField)}
        min={0}
        max={1}
        step="0.1"
      />
    </div>
  </div>
</AccordionItem>
