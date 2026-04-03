<script lang="ts">
  import { page } from '$app/stores';
  import { settings, updateAnkiSetting } from '$lib/settings';
  import {
    AccordionItem,
    Button,
    Helper,
    Input,
    Label,
    Radio,
    Select,
    Toggle
  } from 'flowbite-svelte';
  import {
    DYNAMIC_TAGS,
    fetchConnectionData,
    getDeckNames,
    getModelFieldNames,
    getModelNames,
    openConfigureModal
  } from '$lib/anki-connect';
  import { getPopupFieldMarkers } from '$lib/yomitan/anki-note';
  import { onMount } from 'svelte';

  let connectionData = $derived($settings.ankiConnectSettings.connectionData);
  let isConnected = $derived(connectionData?.connected ?? false);
  let isConnecting = $state(false);

  let url = $state($settings.ankiConnectSettings.url);
  let cardMode = $state($settings.ankiConnectSettings.cardMode);
  let selectedModel = $state($settings.ankiConnectSettings.selectedModel);
  let heightField = $state($settings.ankiConnectSettings.heightField);
  let widthField = $state($settings.ankiConnectSettings.widthField);
  let qualityField = $state($settings.ankiConnectSettings.qualityField);
  let cropImage = $state($settings.ankiConnectSettings.cropImage);
  let ankiTags = $state($settings.ankiConnectSettings.tags);
  let popupDeckName = $state($settings.ankiConnectSettings.popupDeckName);
  let popupModelName = $state($settings.ankiConnectSettings.popupModelName);
  let popupFieldMappings = $state({ ...$settings.ankiConnectSettings.popupFieldMappings });
  let popupDecks = $state<string[]>([]);
  let popupModels = $state<string[]>([]);
  let popupModelFields = $state<string[]>([]);
  let popupFieldMarkers = $state<string[]>([]);
  let loadingPopupConfig = $state(false);

  let doubleTapEnabled = $state(
    $settings.ankiConnectSettings.triggerMethod === 'doubleTap' ||
      $settings.ankiConnectSettings.triggerMethod === 'both'
  );

  let configuredModels = $derived.by(() => {
    const ankiSettings = $settings.ankiConnectSettings;
    return Object.keys(ankiSettings.updateModelConfigs || {});
  });

  let hasCurrentModelConfig = $derived.by(() => {
    const ankiSettings = $settings.ankiConnectSettings;
    return !!(ankiSettings.createModelConfigs && ankiSettings.createModelConfigs[selectedModel]);
  });

  let availableModels = $derived(connectionData?.models ?? []);
  let modelOptions = $derived(availableModels.map((model) => ({ value: model, name: model })));
  let popupDeckOptions = $derived(popupDecks.map((deck) => ({ value: deck, name: deck })));
  let popupModelOptions = $derived(popupModels.map((model) => ({ value: model, name: model })));
  let popupMappingButtonLabel = $derived(
    popupModelName.trim().toLowerCase() === 'lapis'
      ? 'Use recommended Lapis mapping'
      : 'Use default mapping'
  );
  let disabled = $derived(!isConnected);

  async function handleConnect() {
    isConnecting = true;
    try {
      const data = await fetchConnectionData(url || undefined);
      if (!data) return;

      updateAnkiSetting('connectionData', data);
      updateAnkiSetting('enabled', true);

      if (!selectedModel && data.models.length > 0) {
        selectedModel = data.models[0];
        updateAnkiSetting('selectedModel', selectedModel);
      }

      await loadPopupConfig();
    } finally {
      isConnecting = false;
    }
  }

  function handleDisconnect() {
    updateAnkiSetting('connectionData', null);
    updateAnkiSetting('enabled', false);
    popupDecks = [];
    popupModels = [];
    popupModelFields = [];
  }

  function updateDoubleTap(enabled: boolean) {
    updateAnkiSetting('triggerMethod', enabled ? 'doubleTap' : 'neither');
  }

  function handleModelChange() {
    updateAnkiSetting('selectedModel', selectedModel);
  }

  async function loadPopupConfig() {
    loadingPopupConfig = true;
    try {
      const [decks, models, markers] = await Promise.all([
        getDeckNames(),
        getModelNames(),
        getPopupFieldMarkers().catch(() => [])
      ]);

      popupDecks = decks;
      popupModels = models;
      popupFieldMarkers = markers;

      if (!popupDeckName && decks.length > 0) {
        popupDeckName = decks[0];
        updateAnkiSetting('popupDeckName', popupDeckName);
      }

      if (!popupModelName && models.length > 0) {
        popupModelName = models[0];
        updateAnkiSetting('popupModelName', popupModelName);
      }

      if (popupModelName) {
        await loadPopupModelFields(popupModelName);
      }
    } finally {
      loadingPopupConfig = false;
    }
  }

  async function loadPopupModelFields(modelName: string) {
    popupModelFields = await getModelFieldNames(modelName);
    const merged = { ...popupFieldMappings };
    for (const field of popupModelFields) {
      if (typeof merged[field] !== 'string') {
        merged[field] = '';
      }
    }
    popupFieldMappings = merged;
    updateAnkiSetting('popupFieldMappings', popupFieldMappings);
  }

  async function onPopupModelChange() {
    updateAnkiSetting('popupModelName', popupModelName);
    if (!popupModelName) return;
    await loadPopupModelFields(popupModelName);
  }

  function updatePopupFieldMapping(field: string, value: string) {
    popupFieldMappings = {
      ...popupFieldMappings,
      [field]: value
    };
    updateAnkiSetting('popupFieldMappings', popupFieldMappings);
  }

  function applyRecommendedPopupMappings() {
    const next = { ...popupFieldMappings };
    const findField = (name: string) =>
      popupModelFields.find((field) => field.toLowerCase() === name.toLowerCase()) ||
      popupModelFields.find((field) => field.toLowerCase().includes(name.toLowerCase()));

    const pickPreferredMainDefinitionMarker = () => {
      const scoreMarker = (marker: string) => {
        const lower = marker.toLowerCase();
        let score = 0;
        if (lower.startsWith('single-glossary-')) score += 1000;
        else if (lower.includes('single-glossary')) score += 500;
        if (lower.includes('jitendex')) score += 100;
        if (lower.includes('jmdict')) score += 80;
        if (lower.includes('glossary')) score += 10;
        return score;
      };

      const best = [...popupFieldMarkers]
        .map((marker) => ({ marker, score: scoreMarker(marker) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)[0];

      return best ? `{${best.marker}}` : '{glossary}';
    };

    if (popupModelName.trim().toLowerCase() === 'lapis') {
      const lapisMappings: Array<[string, string]> = [
        ['Expression', '{expression}'],
        ['ExpressionFurigana', '{furigana-plain}'],
        ['ExpressionReading', '{reading}'],
        ['ExpressionAudio', '{audio}'],
        ['SelectionText', '{popup-selection-text}'],
        ['MainDefinition', pickPreferredMainDefinitionMarker()],
        ['Sentence', '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}'],
        ['Glossary', '{glossary}'],
        ['PitchPosition', '{pitch-accent-positions}'],
        ['PitchCategories', '{pitch-accent-categories}'],
        ['Frequency', '{frequencies}'],
        ['FreqSort', '{frequency-harmonic-rank}'],
        ['MiscInfo', '{document-title}']
      ];

      for (const [fieldName, value] of lapisMappings) {
        const field = findField(fieldName);
        if (field) next[field] = value;
      }
    } else {
      const expressionField = findField('expression') || popupModelFields[0];
      const readingField = findField('reading');
      const glossaryField = findField('definition') || findField('glossary');
      const sentenceField = findField('sentence');

      if (expressionField) next[expressionField] = '{expression}';
      if (readingField) next[readingField] = '{reading}';
      if (glossaryField) next[glossaryField] = '{glossary}';
      if (sentenceField) next[sentenceField] = '{sentence}';
    }

    popupFieldMappings = next;
    updateAnkiSetting('popupFieldMappings', popupFieldMappings);
  }

  function insertTag(tag: string) {
    ankiTags = ankiTags ? `${ankiTags} ${tag}`.trim() : tag;
    updateAnkiSetting('tags', ankiTags);
  }

  onMount(() => {
    if (url && !connectionData && $settings.ankiConnectSettings.enabled) {
      void handleConnect();
    } else if ($settings.ankiConnectSettings.enabled) {
      void loadPopupConfig();
    }
  });
</script>

<AccordionItem>
  {#snippet header()}Anki Connect{/snippet}
  <div class="flex flex-col gap-5">
    <Helper>
      To use AnkiConnect integration, add this reader (<code class="text-primary-500"
        >{$page.url.origin}</code
      >) to your AnkiConnect <b class="text-primary-500">webCorsOriginList</b> setting.
    </Helper>

    <div>
      <Label class="text-gray-900 dark:text-white">AnkiConnect URL:</Label>
      <div class="flex gap-2">
        <Input
          type="text"
          placeholder="http://127.0.0.1:8765"
          bind:value={url}
          onchange={() => {
            updateAnkiSetting('url', url);
            if (isConnected) {
              updateAnkiSetting('connectionData', null);
            }
            popupDecks = [];
            popupModels = [];
            popupModelFields = [];
          }}
          class="flex-1"
        />
        {#if isConnected}
          <Button
            size="sm"
            color="red"
            outline
            onclick={handleDisconnect}
            class="whitespace-nowrap"
          >
            Disconnect
          </Button>
        {:else}
          <Button
            size="sm"
            color="primary"
            onclick={handleConnect}
            class="whitespace-nowrap"
            disabled={isConnecting}
          >
            {#if isConnecting}
              Connecting...
            {:else}
              Connect
            {/if}
          </Button>
        {/if}
      </div>

      {#if isConnected}
        <div
          class="mt-2 rounded bg-green-100 p-2 text-sm text-green-800 dark:bg-green-900 dark:text-green-200"
        >
          Connected to AnkiConnect v{connectionData?.version}
          ({availableModels.length} models)
        </div>
      {:else if !isConnecting}
        <Helper class="mt-1">Connect to AnkiConnect to configure card settings</Helper>
      {/if}
    </div>

    {#if isConnected}
      <div class="rounded border border-gray-200 p-3 dark:border-gray-700">
        <div class="mb-2 flex items-center justify-between">
          <h4 class="text-sm font-semibold text-gray-900 dark:text-white">
            Yomitan Popup Note Mapping
          </h4>
          <Button
            size="xs"
            color="alternative"
            onclick={loadPopupConfig}
            disabled={disabled || loadingPopupConfig}
          >
            {loadingPopupConfig ? 'Loading...' : 'Refresh'}
          </Button>
        </div>
        <Helper class="mb-3">
          Configure deck, note type, and field mappings used by the Yomitan popup Add to Anki
          action.
        </Helper>

        <div class="mb-3">
          <Label class="text-gray-900 dark:text-white">
            Popup deck:
            <Select
              {disabled}
              items={popupDeckOptions}
              bind:value={popupDeckName}
              onchange={() => updateAnkiSetting('popupDeckName', popupDeckName)}
            />
          </Label>
        </div>

        <div class="mb-3">
          <Label class="text-gray-900 dark:text-white">
            Popup note type:
            <Select
              {disabled}
              items={popupModelOptions}
              bind:value={popupModelName}
              onchange={onPopupModelChange}
            />
          </Label>
        </div>

        <div class="mb-3">
          <Button {disabled} size="xs" color="alternative" onclick={applyRecommendedPopupMappings}>
            {popupMappingButtonLabel}
          </Button>
        </div>

        {#if popupModelFields.length === 0}
          <p class="text-xs text-gray-400">
            No popup fields loaded yet. Connect to AnkiConnect and refresh.
          </p>
        {:else}
          <div class="flex flex-col gap-3">
            {#each popupModelFields as field}
              <div class="rounded border border-gray-200 p-2 dark:border-gray-700">
                <Label class="mb-1 text-gray-900 dark:text-white">{field}</Label>
                <Input
                  {disabled}
                  type="text"
                  value={popupFieldMappings[field] || ''}
                  onchange={(event) =>
                    updatePopupFieldMapping(field, (event.currentTarget as HTMLInputElement).value)}
                  list="popup-marker-options"
                  placeholder={'{expression}'}
                />
              </div>
            {/each}
            <datalist id="popup-marker-options">
              {#each popupFieldMarkers as marker}
                <option value={`{${marker}}`}></option>
              {/each}
            </datalist>
          </div>
        {/if}
      </div>

      <div>
        <Label class="mb-2 text-gray-900 dark:text-white">Card Mode:</Label>
        <div class="flex flex-wrap gap-4">
          <Radio
            {disabled}
            name="cardMode"
            value="create"
            bind:group={cardMode}
            onchange={() => updateAnkiSetting('cardMode', cardMode)}
          >
            Create new card
          </Radio>
          <Radio
            {disabled}
            name="cardMode"
            value="update"
            bind:group={cardMode}
            onchange={() => updateAnkiSetting('cardMode', cardMode)}
          >
            Update last card (within 5 min)
          </Radio>
        </div>
        <Helper class="mt-1">
          {#if cardMode === 'create'}
            Creates a new card with your selected text and image
          {:else}
            Updates the most recently created card's image and sentence fields
          {/if}
        </Helper>
      </div>

      {#if cardMode === 'create'}
        <div>
          <Label class="text-gray-900 dark:text-white">Note Type:</Label>
          <div class="flex gap-2">
            <Select
              {disabled}
              items={modelOptions}
              bind:value={selectedModel}
              onchange={handleModelChange}
              class="flex-1"
            />
            <Button
              {disabled}
              size="sm"
              color="alternative"
              onclick={() => openConfigureModal(selectedModel)}
            >
              Configure
            </Button>
          </div>
          {#if hasCurrentModelConfig}
            <Helper class="mt-1 text-green-600 dark:text-green-400">Configured</Helper>
          {:else}
            <Helper class="mt-1">Using default field mappings</Helper>
          {/if}
        </div>
      {/if}

      {#if cardMode === 'update'}
        <hr />
        <div>
          <h4 class="mb-2 text-gray-900 dark:text-white">Update Mode Configurations</h4>
          <Helper class="mb-2">
            Configure how each note type is updated. The note type is detected from the card being
            updated.
          </Helper>

          {#if configuredModels.length > 0}
            <div class="space-y-1">
              {#each configuredModels as modelName}
                <div
                  class="flex items-center justify-between rounded border border-gray-200 px-2 py-1.5 dark:border-gray-700"
                >
                  <span class="text-sm text-gray-700 dark:text-gray-300">{modelName}</span>
                  <Button
                    {disabled}
                    size="xs"
                    color="light"
                    onclick={() => openConfigureModal(modelName)}
                  >
                    Edit
                  </Button>
                </div>
              {/each}
            </div>
          {:else}
            <div
              class="rounded border border-dashed border-gray-300 p-3 text-center text-sm text-gray-500 dark:border-gray-600 dark:text-gray-400"
            >
              No note types configured yet. Configurations will be created when you update cards.
            </div>
          {/if}
        </div>
      {/if}

      <hr />
      <h4 class="text-gray-900 dark:text-white">Trigger Settings</h4>
      <div>
        <Toggle
          {disabled}
          bind:checked={doubleTapEnabled}
          onchange={() => updateDoubleTap(doubleTapEnabled)}
        >
          Double-tap to capture
        </Toggle>
        <Helper class="mt-1">
          Right-click (long press on mobile) any text box for more options
        </Helper>
      </div>

      <div>
        <Toggle
          {disabled}
          bind:checked={cropImage}
          onchange={() => updateAnkiSetting('cropImage', cropImage)}
        >
          Preset crop to text box
        </Toggle>
        <Helper class="mt-1">Applies to quick captures and the Anki capture modal.</Helper>
      </div>

      <div>
        <Label class="text-gray-900 dark:text-white">Tags:</Label>
        <Input
          {disabled}
          type="text"
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
        <Helper class="mt-1"
          >Global tag template used by capture flows that do not override tags.</Helper
        >
      </div>

      <hr />
      <h4 class="text-gray-900 dark:text-white">Image Quality</h4>
      <Helper>Customize the image size and quality stored in Anki</Helper>
      <div>
        <Label class="text-gray-900 dark:text-white">Max Height (0 = no limit):</Label>
        <Input
          {disabled}
          type="number"
          bind:value={heightField}
          onchange={() => {
            if (heightField < 0) heightField = 0;
            updateAnkiSetting('heightField', heightField);
          }}
          min={0}
        />
      </div>
      <div>
        <Label class="text-gray-900 dark:text-white">Max Width (0 = no limit):</Label>
        <Input
          {disabled}
          type="number"
          bind:value={widthField}
          onchange={() => {
            if (widthField < 0) widthField = 0;
            updateAnkiSetting('widthField', widthField);
          }}
          min={0}
        />
      </div>
      <div>
        <Label class="text-gray-900 dark:text-white">Quality (0-1, lower = smaller file):</Label>
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
    {:else}
      <div
        class="rounded border border-gray-200 bg-gray-50 p-4 text-center text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
      >
        Connect to AnkiConnect to configure card settings
      </div>
    {/if}
  </div>
</AccordionItem>
