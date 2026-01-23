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
  import { fetchConnectionData, openConfigureModal } from '$lib/anki-connect';
  import { onMount } from 'svelte';

  // Connection state
  let connectionData = $derived($settings.ankiConnectSettings.connectionData);
  let isConnected = $derived(connectionData?.connected ?? false);
  let isConnecting = $state(false);

  // Basic settings
  let url = $state($settings.ankiConnectSettings.url);

  // Card settings
  let cardMode = $state($settings.ankiConnectSettings.cardMode);
  let selectedModel = $state($settings.ankiConnectSettings.selectedModel);

  // Image quality settings
  let heightField = $state($settings.ankiConnectSettings.heightField);
  let widthField = $state($settings.ankiConnectSettings.widthField);
  let qualityField = $state($settings.ankiConnectSettings.qualityField);

  // Trigger settings
  let doubleTapEnabled = $state(
    $settings.ankiConnectSettings.triggerMethod === 'doubleTap' ||
      $settings.ankiConnectSettings.triggerMethod === 'both'
  );

  // Get configured models for update mode (only shown in update mode)
  let configuredModels = $derived.by(() => {
    const ankiSettings = $settings.ankiConnectSettings;
    return Object.keys(ankiSettings.updateModelConfigs || {});
  });

  // Check if current model has a config for create mode (only shown in create mode)
  let hasCurrentModelConfig = $derived.by(() => {
    const ankiSettings = $settings.ankiConnectSettings;
    return !!(ankiSettings.createModelConfigs && ankiSettings.createModelConfigs[selectedModel]);
  });

  // Available models from connection data
  let availableModels = $derived(connectionData?.models ?? []);

  // Model options for Select component
  let modelOptions = $derived(availableModels.map((m) => ({ value: m, name: m })));

  // Controls disabled state - disabled when not connected
  let disabled = $derived(!isConnected);

  // Connect to AnkiConnect
  async function handleConnect() {
    isConnecting = true;
    try {
      const data = await fetchConnectionData(url || undefined);
      if (data) {
        updateAnkiSetting('connectionData', data);
        updateAnkiSetting('enabled', true); // Enable when connected
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
    updateAnkiSetting('enabled', false); // Disable when disconnected
  }

  // Update double-tap trigger method
  function updateDoubleTap(enabled: boolean) {
    updateAnkiSetting('triggerMethod', enabled ? 'doubleTap' : 'neither');
  }

  // Handle model change
  function handleModelChange() {
    updateAnkiSetting('selectedModel', selectedModel);
  }

  // Try auto-connect on mount if we have a URL and were previously connected
  onMount(() => {
    if (url && !connectionData && $settings.ankiConnectSettings.enabled) {
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

      <!-- Connection Status -->
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

    <!-- Card Mode (only when connected) -->
    {#if isConnected}
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

      <!-- Create Mode: Note Type Selection + Configure -->
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

      <!-- Update Mode: Configured Models List -->
      {#if cardMode === 'update'}
        <hr />
        <div>
          <h4 class="mb-2 text-gray-900 dark:text-white">Update Mode Configurations</h4>
          <Helper class="mb-2"
            >Configure how each note type is updated. The note type is detected from the card being
            updated.</Helper
          >

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
        <Helper class="mt-1"
          >Right-click (long press on mobile) any text box for more options</Helper
        >
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
      <div
        class="rounded border border-gray-200 bg-gray-50 p-4 text-center text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400"
      >
        Connect to AnkiConnect to configure card settings
      </div>
    {/if}
  </div>
</AccordionItem>
