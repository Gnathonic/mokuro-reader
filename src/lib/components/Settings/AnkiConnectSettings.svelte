<script lang="ts">
  import { page } from '$app/stores';
  import { settings, updateAnkiSetting, DEFAULT_MODEL_CONFIGS } from '$lib/settings';
  import type { FieldMapping, ModelConfig, AnkiConnectionData } from '$lib/settings/settings';
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
    FIELD_TEMPLATES,
    fetchConnectionData,
    isAndroidMode
  } from '$lib/anki-connect';
  import { onMount } from 'svelte';

  // Connection state
  let connectionData = $derived($settings.ankiConnectSettings.connectionData);
  let isConnected = $derived(connectionData?.connected ?? false);
  let isConnecting = $state(false);

  // Basic settings
  let enabled = $state($settings.ankiConnectSettings.enabled);
  let url = $state($settings.ankiConnectSettings.url);
  let androidModeOverride = $state($settings.ankiConnectSettings.androidModeOverride);

  // Derive if we're in Android mode
  let inAndroidMode = $derived(isAndroidMode());

  // Card settings
  let cardMode = $state($settings.ankiConnectSettings.cardMode);
  let selectedModel = $state($settings.ankiConnectSettings.selectedModel);
  let cropImage = $state($settings.ankiConnectSettings.cropImage);
  let ankiTags = $state($settings.ankiConnectSettings.tags);

  // Image quality settings
  let heightField = $state($settings.ankiConnectSettings.heightField);
  let widthField = $state($settings.ankiConnectSettings.widthField);
  let qualityField = $state($settings.ankiConnectSettings.qualityField);

  // Trigger settings
  let doubleTapEnabled = $state(
    $settings.ankiConnectSettings.triggerMethod === 'doubleTap' ||
      $settings.ankiConnectSettings.triggerMethod === 'both'
  );

  // Model configuration - derive reactively from settings store
  // (getModelConfig uses get() which isn't reactive, so we need to depend on $settings directly)
  let currentModelConfig = $derived.by(() => {
    // Access $settings to make this reactive to settings changes
    const ankiSettings = $settings.ankiConnectSettings;

    // Always use actual fields from connectionData to ensure we show all fields
    const actualFields = connectionData?.modelFields[selectedModel];
    if (!actualFields || actualFields.length === 0) {
      // Fall back to saved config if no connection data
      if (ankiSettings.modelConfigs[selectedModel]) {
        return ankiSettings.modelConfigs[selectedModel];
      }
      return null;
    }

    // Get saved config and default config for template suggestions
    const savedConfig = ankiSettings.modelConfigs[selectedModel];
    const defaultConfig = DEFAULT_MODEL_CONFIGS[selectedModel];

    // Build field mappings from actual Anki fields
    const fieldMappings: FieldMapping[] = [];
    for (const field of actualFields) {
      // Check if we have a saved template for this field
      const savedMapping = savedConfig?.fieldMappings.find((m) => m.fieldName === field);
      if (savedMapping) {
        fieldMappings.push(savedMapping);
        continue;
      }

      // Check if default config has a template for this field
      const defaultMapping = defaultConfig?.fieldMappings.find((m) => m.fieldName === field);
      if (defaultMapping) {
        fieldMappings.push(defaultMapping);
        continue;
      }

      // Generate smart default based on field name
      const lowerField = field.toLowerCase();
      if (lowerField.includes('front') || lowerField.includes('expression') || lowerField.includes('word')) {
        fieldMappings.push({ fieldName: field, template: '{selection}' });
      } else if (lowerField.includes('picture') || lowerField.includes('image') || lowerField.includes('screenshot')) {
        fieldMappings.push({ fieldName: field, template: '{image}' });
      } else if (lowerField.includes('sentence') || lowerField.includes('context')) {
        fieldMappings.push({ fieldName: field, template: '{sentence}' });
      } else {
        fieldMappings.push({ fieldName: field, template: '' });
      }
    }

    return {
      modelName: selectedModel,
      deckName: savedConfig?.deckName || defaultConfig?.deckName || 'Default',
      fieldMappings
    } as ModelConfig;
  });

  // Deck name from current model config
  let deckName = $derived(currentModelConfig?.deckName ?? 'Default');

  // Available models and decks from connection data
  let availableModels = $derived(connectionData?.models ?? []);
  let availableDecks = $derived(connectionData?.decks ?? []);
  let modelFields = $derived(connectionData?.modelFields ?? {});

  // Model options for Select component
  let modelOptions = $derived(availableModels.map((m) => ({ value: m, name: m })));
  let deckOptions = $derived([
    { value: '__custom__', name: '(Custom deck name)' },
    ...availableDecks.map((d) => ({ value: d, name: d }))
  ]);

  // Track if using custom deck
  let useCustomDeck = $state(false);
  let customDeckName = $state('');

  // Initialize custom deck state when component loads
  $effect(() => {
    const config = currentModelConfig;
    if (config) {
      const isExistingDeck = availableDecks.includes(config.deckName);
      useCustomDeck = !isExistingDeck && config.deckName !== 'Default';
      if (useCustomDeck) {
        customDeckName = config.deckName;
      }
    }
  });

  // Controls disabled state
  let disabled = $derived(!enabled || !isConnected);

  // Connect to AnkiConnect
  async function handleConnect() {
    isConnecting = true;
    try {
      const data = await fetchConnectionData(url || undefined);
      if (data) {
        updateAnkiSetting('connectionData', data);
        // Auto-select first model if none selected
        if (!selectedModel && data.models.length > 0) {
          selectedModel = data.models[0];
          updateAnkiSetting('selectedModel', selectedModel);
        }
      }
    } finally {
      isConnecting = false;
    }
  }

  // Disconnect from AnkiConnect
  function handleDisconnect() {
    updateAnkiSetting('connectionData', null);
  }

  // Update model config with new deck name
  function updateDeckName(newDeckName: string) {
    if (!currentModelConfig) return;

    const updatedConfig: ModelConfig = {
      ...currentModelConfig,
      deckName: newDeckName
    };

    // Save to modelConfigs
    const modelConfigs = { ...$settings.ankiConnectSettings.modelConfigs };
    modelConfigs[selectedModel] = updatedConfig;
    updateAnkiSetting('modelConfigs', modelConfigs);
  }

  // Update field mapping for a specific field
  function updateFieldMapping(fieldName: string, template: string) {
    if (!currentModelConfig) return;

    const updatedMappings = currentModelConfig.fieldMappings.map((m) =>
      m.fieldName === fieldName ? { ...m, template } : m
    );

    const updatedConfig: ModelConfig = {
      ...currentModelConfig,
      fieldMappings: updatedMappings
    };

    // Save to modelConfigs
    const modelConfigs = { ...$settings.ankiConnectSettings.modelConfigs };
    modelConfigs[selectedModel] = updatedConfig;
    updateAnkiSetting('modelConfigs', modelConfigs);
  }

  // Insert template variable into a field
  function insertTemplate(fieldName: string, template: string) {
    const mapping = currentModelConfig?.fieldMappings.find((m) => m.fieldName === fieldName);
    const currentValue = mapping?.template ?? '';
    // Append template with a space if there's existing content
    const newValue = currentValue ? `${currentValue} ${template}`.trim() : template;
    updateFieldMapping(fieldName, newValue);
  }

  // Update double-tap trigger method
  function updateDoubleTap(enabled: boolean) {
    updateAnkiSetting('triggerMethod', enabled ? 'doubleTap' : 'neither');
  }

  // Insert tag into tags field
  function insertTag(tag: string) {
    ankiTags = ankiTags ? `${ankiTags} ${tag}`.trim() : tag;
    updateAnkiSetting('tags', ankiTags);
  }

  // Handle model change
  function handleModelChange() {
    updateAnkiSetting('selectedModel', selectedModel);
    // The $effect will automatically update useCustomDeck and customDeckName
    // when currentModelConfig changes due to selectedModel change
  }

  // Handle deck dropdown change
  function handleDeckDropdownChange(value: string) {
    if (value === '__custom__') {
      useCustomDeck = true;
      customDeckName = deckName;
    } else {
      useCustomDeck = false;
      updateDeckName(value);
    }
  }

  // Try auto-connect on mount if we have a URL but no connection data
  onMount(() => {
    if (url && !connectionData && enabled) {
      handleConnect();
    }
  });
</script>

<AccordionItem>
  {#snippet header()}Anki Connect{/snippet}
  <div class="flex flex-col gap-5">
    <!-- Setup Instructions -->
    <Helper>
      To use AnkiConnect integration, add this reader (<code class="text-primary-500"
        >{$page.url.origin}</code
      >) to your AnkiConnect <b class="text-primary-500">webCorsOriginList</b> setting.
    </Helper>

    <!-- Connection Section -->
    <div>
      <Label class="text-gray-900 dark:text-white">AnkiConnect URL:</Label>
      <div class="flex gap-2">
        <Input
          type="text"
          placeholder="http://127.0.0.1:8765"
          bind:value={url}
          onchange={() => {
            updateAnkiSetting('url', url);
            // Clear connection data when URL changes
            if (isConnected) {
              updateAnkiSetting('connectionData', null);
            }
          }}
          class="flex-1"
        />
        {#if isConnected}
          <Button size="sm" color="red" outline onclick={handleDisconnect} class="whitespace-nowrap">
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

      <!-- Connection Status -->
      {#if isConnected}
        <div class="mt-2 rounded bg-green-100 p-2 text-sm text-green-800 dark:bg-green-900 dark:text-green-200">
          Connected to AnkiConnect v{connectionData?.version}
          ({availableModels.length} models, {availableDecks.length} decks)
          {#if inAndroidMode}
            <span class="ml-1 font-medium">(Android mode)</span>
          {/if}
        </div>
      {:else if !isConnecting}
        <Helper class="mt-1">Connect to AnkiConnect to configure card settings</Helper>
      {/if}
    </div>

    <!-- Enable Toggle (only when connected) -->
    {#if isConnected}
      <div>
        <Toggle bind:checked={enabled} onchange={() => updateAnkiSetting('enabled', enabled)}>
          AnkiConnect Integration Enabled
        </Toggle>
      </div>

      <!-- Android Mode Override -->
      <div>
        <Label class="mb-2 text-gray-900 dark:text-white">Platform Mode:</Label>
        <div class="flex flex-wrap gap-4">
          <Radio
            name="androidMode"
            value="auto"
            bind:group={androidModeOverride}
            onchange={() => updateAnkiSetting('androidModeOverride', androidModeOverride)}
          >
            Auto-detect {connectionData?.isAndroid ? '(Android)' : '(Desktop)'}
          </Radio>
          <Radio
            name="androidMode"
            value="desktop"
            bind:group={androidModeOverride}
            onchange={() => updateAnkiSetting('androidModeOverride', androidModeOverride)}
          >
            Desktop
          </Radio>
          <Radio
            name="androidMode"
            value="android"
            bind:group={androidModeOverride}
            onchange={() => updateAnkiSetting('androidModeOverride', androidModeOverride)}
          >
            Android
          </Radio>
        </div>
        {#if inAndroidMode}
          <Helper class="mt-1 text-amber-600 dark:text-amber-400">
            Android mode: Tags and dynamic deck creation are disabled
          </Helper>
        {/if}
      </div>

      <!-- Card Mode -->
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

      <!-- Model Selection -->
      <div>
        <Label class="text-gray-900 dark:text-white">Note Type:</Label>
        <Select
          {disabled}
          items={modelOptions}
          bind:value={selectedModel}
          onchange={handleModelChange}
        />
      </div>

      <!-- Deck Selection -->
      {#if cardMode === 'create'}
        <div>
          <Label class="text-gray-900 dark:text-white">Deck:</Label>
          {#if useCustomDeck}
            <div class="flex gap-2">
              <Input
                {disabled}
                type="text"
                placeholder="Custom deck name"
                bind:value={customDeckName}
                onchange={() => updateDeckName(customDeckName)}
                class="flex-1"
              />
              <Button
                {disabled}
                size="sm"
                color="alternative"
                onclick={() => {
                  useCustomDeck = false;
                  updateDeckName(availableDecks[0] || 'Default');
                }}
              >
                Use existing
              </Button>
            </div>
            {#if !inAndroidMode}
              <div class="mt-2 flex flex-wrap gap-2">
                {#each DYNAMIC_TAGS as { tag, description }}
                  <button
                    type="button"
                    {disabled}
                    onclick={() => {
                      customDeckName = customDeckName ? `${customDeckName}${tag}` : tag;
                      updateDeckName(customDeckName);
                    }}
                    class="inline-flex items-center rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                    title={description}
                  >
                    {tag}
                  </button>
                {/each}
              </div>
              <Helper class="mt-1">Use :: for subdecks. Dynamic tags supported.</Helper>
            {:else}
              <Helper class="mt-1 text-amber-600 dark:text-amber-400">
                Deck must exist in Anki (Android can't create decks)
              </Helper>
            {/if}
          {:else}
            <div class="flex gap-2">
              <Select
                {disabled}
                items={deckOptions}
                value={deckName}
                onchange={(e) => handleDeckDropdownChange(e.currentTarget.value)}
                class="flex-1"
              />
              {#if !inAndroidMode}
                <Button
                  {disabled}
                  size="sm"
                  color="alternative"
                  onclick={() => {
                    useCustomDeck = true;
                    customDeckName = '';
                  }}
                >
                  Custom
                </Button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Field Mappings -->
      {#if selectedModel && currentModelConfig}
        <hr />
        <h4 class="text-gray-900 dark:text-white">Field Mappings ({selectedModel})</h4>
        <Helper>Configure how each Anki field is populated</Helper>

        {#each currentModelConfig.fieldMappings as mapping}
          <div>
            <Label class="text-gray-900 dark:text-white">{mapping.fieldName}:</Label>
            <Input
              {disabled}
              type="text"
              value={mapping.template}
              placeholder="Template or leave empty"
              onchange={(e) => updateFieldMapping(mapping.fieldName, e.currentTarget.value)}
            />
            <div class="mt-2 flex flex-wrap gap-2">
              {#each FIELD_TEMPLATES as { template, description }}
                <button
                  type="button"
                  {disabled}
                  onclick={() => insertTemplate(mapping.fieldName, template)}
                  class="inline-flex items-center rounded bg-gray-100 px-2 py-1 text-xs text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                  title={description}
                >
                  {template}
                </button>
              {/each}
            </div>
          </div>
        {/each}
      {/if}

      <!-- Tags (only for desktop mode) -->
      {#if !inAndroidMode}
        <div>
          <Label class="text-gray-900 dark:text-white">Tags (optional):</Label>
          <Input
            {disabled}
            type="text"
            placeholder="mining vocab"
            bind:value={ankiTags}
            oninput={() => updateAnkiSetting('tags', ankiTags)}
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
      {/if}

      <!-- Trigger Settings -->
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
        <Helper class="mt-1">Right-click (long press on mobile) any text box for more options</Helper>
      </div>

      <!-- Cropper Settings -->
      <hr />
      <h4 class="text-gray-900 dark:text-white">Cropper Settings</h4>
      <div>
        <Toggle {disabled} bind:checked={cropImage} onchange={() => updateAnkiSetting('cropImage', cropImage)}>
          Preset crop to text box
        </Toggle>
        <Helper class="mt-1">Ideal for quick single-panel captures</Helper>
      </div>

      <!-- Image Quality Settings -->
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
      <!-- Not Connected State -->
      <div class="rounded border border-gray-200 bg-gray-50 p-4 text-center text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
        Connect to AnkiConnect to configure card settings
      </div>
    {/if}
  </div>
</AccordionItem>
