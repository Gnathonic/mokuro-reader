<script lang="ts">
  import { currentView } from '$lib/util/hash-router';
  import {
    cropperStore,
    closeAnkiModal,
    getCroppedImg,
    type Pixels,
    createCard,
    updateLastCard,
    ankiConnect,
    FIELD_TEMPLATES,
    DYNAMIC_TAGS,
    resolveTemplate,
    resolveDynamicTags,
    getModelConfig,
    type CreateCardOptions,
    type UpdateCardOptions
  } from '$lib/anki-connect';
  import { settings, updateAnkiSetting, type ModelConfig, type FieldMapping } from '$lib/settings';
  import { Badge, Button, Helper, Input, Modal, Select, Spinner, Toggle } from 'flowbite-svelte';
  import { ChevronRightOutline } from 'flowbite-svelte-icons';
  import { slide } from 'svelte/transition';
  import AnkiTemplateField from './AnkiTemplateField.svelte';
  import { onMount, onDestroy } from 'svelte';
  import CropperJS from 'cropperjs';
  import 'cropperjs/dist/cropper.css';

  let open = $state(false);
  let pixels: Pixels | undefined = undefined;
  let loading = $state(false);
  let cropper: CropperJS | null = null;

  // Note type fields from AnkiConnect
  let noteFields = $state<string[]>([]);
  let loadingFields = $state(false);

  // Field values - key is field name, value is the resolved/editable content
  let fieldValues = $state<Record<string, string>>({});

  // Field templates - key is field name, value is the saved template from config
  let fieldTemplates = $state<Record<string, string>>({});

  // Editable templates - what the user is editing (starts as fieldTemplates, user can modify)
  let editableTemplates = $state<Record<string, string>>({});

  // Tags template - the saved template from config
  let tagsTemplate = $state('');

  // Editable tags - starts from store value, user can modify
  let editableTags = $state('');

  // Track whether crop image is enabled
  let cropEnabled = $state($settings.ankiConnectSettings.cropImage);

  // Accordion state - which collapsible is expanded (null = none, 'image' = cropper, field name = that field)
  let expandedId = $state<string | null>('image');

  function handleExpand(id: string | null) {
    expandedId = id;
  }

  // Base template variables (not including {existing} which is field-specific)
  let baseVariables = $derived.by(() => {
    const store = $cropperStore;
    if (!store) return [];

    const metadata = store.metadata || {};
    const vars: Array<{ template: string; value: string; isImage?: boolean }> = [];

    // Text variables
    if (store.selectedText) {
      vars.push({ template: '{selection}', value: store.selectedText });
    }
    if (store.sentence) {
      vars.push({ template: '{sentence}', value: store.sentence });
    }
    if (metadata.seriesTitle) {
      vars.push({ template: '{series}', value: metadata.seriesTitle });
    }
    if (metadata.volumeTitle) {
      vars.push({ template: '{volume}', value: metadata.volumeTitle });
    }
    if (store.pageNumber !== undefined) {
      vars.push({ template: '{page_num}', value: String(store.pageNumber + 1) });
    }
    if (store.pageFilename) {
      vars.push({ template: '{page_filename}', value: store.pageFilename });
    }

    // Image variable
    vars.push({ template: '{image}', value: '[current capture]', isImage: true });

    return vars;
  });

  // Get available variables for a specific field (includes field-specific {existing} value)
  function getFieldVariables(
    fieldName: string
  ): Array<{ template: string; value: string; isImage?: boolean }> {
    const vars = [...baseVariables];

    // In update mode, add {existing} with the field's actual previous value
    if (mode === 'update' && $cropperStore?.previousValues) {
      const existingValue = $cropperStore.previousValues[fieldName] || '';
      vars.unshift({ template: '{existing}', value: existingValue || '(empty)' });
    }

    return vars;
  }

  // Variables available for tags
  let tagsVariables = $derived.by(() => {
    const store = $cropperStore;
    if (!store) return [];

    const metadata = store.metadata || {};
    const vars: Array<{ template: string; value: string }> = [];

    // Add {existing} for update mode
    if (mode === 'update' && store.previousTags) {
      vars.push({ template: '{existing}', value: store.previousTags.join(' ') });
    }

    if (metadata.seriesTitle) {
      vars.push({ template: '{series}', value: metadata.seriesTitle.replace(/\s+/g, '_') });
    }
    if (metadata.volumeTitle) {
      vars.push({ template: '{volume}', value: metadata.volumeTitle.replace(/\s+/g, '_') });
    }

    return vars;
  });

  // Resolve tags template including {existing}
  function resolveTagsPreview(template: string): string {
    const store = $cropperStore;
    if (!store || !template) return '';

    let resolved = template;

    // Replace {existing} with previous tags
    if (store.previousTags) {
      resolved = resolved.replace(/\{existing\}/g, store.previousTags.join(' '));
    } else {
      resolved = resolved.replace(/\{existing\}/g, '');
    }

    // Use resolveDynamicTags for {series} and {volume}
    resolved = resolveDynamicTags(resolved, store.metadata || {});

    return resolved;
  }

  // Derive mode and settings from store
  let mode = $derived($cropperStore?.mode || 'create');
  // In update mode or configure mode with a specific model, use the store's modelName
  // Otherwise use the settings' selectedModel
  let selectedModel = $derived(
    $cropperStore?.modelName ? $cropperStore.modelName : $settings.ankiConnectSettings.selectedModel
  );

  // Quick capture toggle (per-model setting)
  let quickCapture = $state(false);

  // Deck selection (create mode only)
  let deckName = $state('Default');
  let useCustomDeck = $state(false);
  let customDeckName = $state('');
  let savedDeckName = $state('Default'); // Track original deck for modification detection
  let availableDecks = $derived($settings.ankiConnectSettings.connectionData?.decks ?? []);

  // Get the effective deck name (handles custom vs dropdown)
  function getEffectiveDeckName(): string {
    return useCustomDeck ? customDeckName : deckName;
  }

  // Get resolved deck name for display (resolves {series}, {volume} templates)
  let resolvedDeckDisplay = $derived.by(() => {
    const effective = getEffectiveDeckName();
    if (!effective) return '(custom)';
    const store = $cropperStore;
    if (!store?.metadata) return effective;
    return resolveDynamicTags(effective, store.metadata);
  });

  // Check if deck has been modified from the saved value
  function isDeckModified(): boolean {
    return getEffectiveDeckName() !== savedDeckName;
  }

  // Mode labels
  let modeLabel = $derived(
    mode === 'configure' ? 'Configure Fields' : mode === 'create' ? 'Create Card' : 'Update Card'
  );

  // Show cropper only in create/update modes
  let showCropperSection = $derived(mode === 'create' || mode === 'update');

  // Check if all fields AND tags are set to {existing} (no changes will be made in update mode)
  let allFieldsExisting = $derived.by(() => {
    if (mode !== 'update') return false;
    // Check all field templates
    for (const field of noteFields) {
      const template = editableTemplates[field] || '';
      // If the template is not exactly {existing}, there are changes
      if (template.trim() !== '{existing}') {
        return false;
      }
    }
    // Also check tags - if tags will update, the card is being edited
    if (editableTags.trim() !== '{existing}') {
      return false;
    }
    return noteFields.length > 0;
  });

  // Template buttons to show:
  // - configure mode: show ALL templates (user is setting up templates for any mode)
  // - update mode: show ALL templates (including {existing})
  // - create mode: hide {existing} (no previous card to reference)
  let templateButtons = $derived(
    mode === 'create' ? FIELD_TEMPLATES.filter((t) => t.template !== '{existing}') : FIELD_TEMPLATES
  );

  // Resolve a template to get a preview value
  function resolveTemplatePreview(template: string, fieldName: string): string {
    const store = $cropperStore;
    if (!store || !template) return '';

    if (template === '{image}') {
      return '[Image]';
    }

    const resolved = resolveTemplate(
      template,
      store.metadata || {},
      store.selectedText,
      store.sentence,
      {
        pageNumber: store.pageNumber,
        pageFilename: store.pageFilename,
        previousValues: store.previousValues,
        fieldName
      }
    );
    return resolved || '';
  }

  // Check if a template has been modified from the original
  function isTemplateModified(field: string): boolean {
    return editableTemplates[field] !== fieldTemplates[field];
  }

  // Check if tags have been modified from the original
  function isTagsModified(): boolean {
    return editableTags !== tagsTemplate;
  }

  // Check if a field will update the card (not just {existing})
  function fieldWillUpdate(field: string): boolean {
    if (mode !== 'update') return false;
    const template = editableTemplates[field] || '';
    return template.trim() !== '{existing}';
  }

  // Check if tags will update the card
  function tagsWillUpdate(): boolean {
    if (mode !== 'update') return false;
    return editableTags.trim() !== '{existing}';
  }

  // Close modal on navigation (hash route change)
  let previousViewType = $state($currentView.type);
  $effect(() => {
    const viewType = $currentView.type;
    if (viewType !== previousViewType) {
      previousViewType = viewType;
      if (open) {
        close();
      }
    }
  });

  // Fetch note type fields when modal opens or model changes
  async function fetchNoteFields() {
    if (!selectedModel) return;

    // Try to get fields from connection data first
    const connectionData = $settings.ankiConnectSettings.connectionData;
    if (connectionData?.modelFields?.[selectedModel]) {
      noteFields = connectionData.modelFields[selectedModel];
      return;
    }

    // Fall back to fetching from AnkiConnect
    loadingFields = true;
    try {
      const result = await ankiConnect('modelFieldNames', { modelName: selectedModel });
      if (result && Array.isArray(result)) {
        noteFields = result;
      }
    } catch (e) {
      console.error('Failed to fetch note fields:', e);
    } finally {
      loadingFields = false;
    }
  }

  // Initialize field values based on mode and store data
  function initializeFieldValues() {
    const store = $cropperStore;
    if (!store) return;

    // Determine which config mode to use
    // - configure mode: use the cardMode setting to decide which config to load/save
    // - create/update mode: use the modal's mode
    const configMode: 'create' | 'update' =
      mode === 'configure'
        ? $settings.ankiConnectSettings.cardMode
        : mode === 'update'
          ? 'update'
          : 'create';

    const config = getModelConfig(selectedModel, configMode);

    // Load quickCapture setting from model config
    quickCapture = config?.quickCapture ?? false;

    // Load deck setting from model config (create mode only)
    const configDeck = config?.deckName || 'Default';
    savedDeckName = configDeck; // Track original for modification detection
    deckName = configDeck;
    const isExistingDeck = availableDecks.includes(configDeck);
    useCustomDeck = !isExistingDeck && configDeck !== 'Default';
    if (useCustomDeck) {
      customDeckName = configDeck;
    } else {
      customDeckName = '';
    }

    // Load tags from config or store
    // Use || instead of ?? so empty string also falls back to default
    const defaultTags = configMode === 'update' ? '{existing}' : '';
    if (mode === 'configure') {
      // Configure mode: load saved tags template, default to {existing} for update mode
      tagsTemplate = config?.tags || defaultTags;
      editableTags = tagsTemplate;
    } else {
      // Create/Update mode: use store tags or config tags
      tagsTemplate = config?.tags || defaultTags;
      editableTags = store.tags || tagsTemplate;
    }

    // Reset state
    fieldTemplates = {};
    editableTemplates = {};
    fieldValues = {};

    for (const field of noteFields) {
      const mapping = config?.fieldMappings.find((m) => m.fieldName === field);
      let template = mapping?.template || '';

      // In update mode, default all fields to {existing} if no template is set
      if (configMode === 'update' && !template) {
        template = '{existing}';
      }

      fieldTemplates[field] = template;
      editableTemplates[field] = template;

      if (mode === 'configure') {
        // Configure mode: show templates directly (no resolution)
        fieldValues[field] = template;
      } else {
        // Create/Update mode: resolve template to show preview
        fieldValues[field] = resolveTemplatePreview(template, field);
      }
    }
  }

  onMount(() => {
    cropperStore.subscribe((value) => {
      if (value) {
        open = value.open;
        if (value.open) {
          // Sync cropEnabled with settings
          cropEnabled = $settings.ankiConnectSettings.cropImage;

          // Fetch fields and initialize values (including tags)
          fetchNoteFields().then(() => {
            initializeFieldValues();
          });

          // On mobile, blur the auto-focused input to prevent keyboard issues
          if ($settings.mobile) {
            requestAnimationFrame(() => {
              if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
              }
            });
          }
        }
      }
    });
  });

  onDestroy(() => {
    if (cropper) {
      cropper.destroy();
      cropper = null;
    }
  });

  function initCropperElement(img: HTMLImageElement) {
    let resizeObserver: ResizeObserver | null = null;
    let savedCropData: CropperJS.Data | null = null;
    let isResizing = false;

    // Clamp crop data to image bounds
    const clampToImage = (data: CropperJS.Data): CropperJS.Data => {
      const imgWidth = img.naturalWidth;
      const imgHeight = img.naturalHeight;

      let { x, y, width, height } = data;

      // Clamp position to keep crop within image
      x = Math.max(0, Math.min(x, imgWidth - width));
      y = Math.max(0, Math.min(y, imgHeight - height));

      // If crop is larger than image, constrain it
      if (width > imgWidth) {
        width = imgWidth;
        x = 0;
      }
      if (height > imgHeight) {
        height = imgHeight;
        y = 0;
      }

      return { ...data, x, y, width, height };
    };

    const setup = () => {
      if (cropper) {
        cropper.destroy();
      }

      const textBox = $cropperStore?.textBox;

      cropper = new CropperJS(img, {
        viewMode: 0, // No restrictions - we clamp bounds ourselves
        dragMode: 'move',
        autoCropArea: 1,
        restore: false,
        guides: true,
        center: true,
        highlight: false,
        zoomOnWheel: false,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: false,
        aspectRatio: NaN,
        ready() {
          if (cropEnabled && textBox && cropper) {
            const [xmin, ymin, xmax, ymax] = textBox;
            cropper.setData({
              x: xmin,
              y: ymin,
              width: xmax - xmin,
              height: ymax - ymin
            });
          }
          updatePixels();

          // Set up resize observer after cropper is ready
          const container = img.closest('.cropper-container');
          if (container) {
            resizeObserver = new ResizeObserver(() => {
              if (!cropper || isResizing) return;
              isResizing = true;

              // Save current crop data in image coordinates
              savedCropData = cropper.getData(true);

              // Let cropper resize
              requestAnimationFrame(() => {
                if (cropper && savedCropData) {
                  // Restore crop data after resize, clamped to bounds
                  cropper.setData(clampToImage(savedCropData));
                }
                isResizing = false;
              });
            });
            resizeObserver.observe(container);
          }
        },
        crop() {
          if (!isResizing) {
            updatePixels();
            // Clamp to bounds after user interaction
            if (cropper) {
              const data = cropper.getData(true);
              const clamped = clampToImage(data);
              if (
                data.x !== clamped.x ||
                data.y !== clamped.y ||
                data.width !== clamped.width ||
                data.height !== clamped.height
              ) {
                cropper.setData(clamped);
              }
            }
          }
        }
      });
    };

    if (img.complete && img.naturalWidth > 0) {
      setup();
    } else {
      img.onload = setup;
    }

    // Return cleanup function for Svelte action
    return {
      destroy() {
        resizeObserver?.disconnect();
      }
    };
  }

  function updatePixels() {
    if (!cropper) return;
    const data = cropper.getData(true);
    pixels = {
      x: data.x,
      y: data.y,
      width: data.width,
      height: data.height
    };
  }

  function handleBackdropMousedown(ev: MouseEvent & { currentTarget: HTMLDialogElement }) {
    const dlg = ev.currentTarget;
    if (ev.target === dlg) {
      const rect = dlg.getBoundingClientRect();
      const clickedInContent =
        ev.clientX >= rect.left &&
        ev.clientX <= rect.right &&
        ev.clientY >= rect.top &&
        ev.clientY <= rect.bottom;

      if (!clickedInContent) {
        close();
      }
    }
  }

  function close() {
    if (cropper) {
      cropper.destroy();
      cropper = null;
    }
    loading = false;
    fieldValues = {};
    fieldTemplates = {};
    editableTemplates = {};
    tagsTemplate = '';
    editableTags = '';
    savedDeckName = 'Default';
    expandedId = 'image'; // Reset to image expanded
    closeAnkiModal();
  }

  function handleCropToggle() {
    updateAnkiSetting('cropImage', cropEnabled);

    // If enabling crop and we have a textbox, set the crop area
    if (cropEnabled && cropper && $cropperStore?.textBox) {
      const [xmin, ymin, xmax, ymax] = $cropperStore.textBox;
      cropper.setData({
        x: xmin,
        y: ymin,
        width: xmax - xmin,
        height: ymax - ymin
      });
    } else if (!cropEnabled && cropper) {
      // Reset to full image
      cropper.reset();
    }
  }

  // Handle quick capture toggle - save to model config
  function handleQuickCaptureToggle() {
    const configKey = getConfigKey();
    const configMode = configKey === 'updateModelConfigs' ? 'update' : 'create';
    const config = getModelConfig(selectedModel, configMode);

    const newConfig: ModelConfig = {
      modelName: selectedModel,
      deckName: config?.deckName || 'Default',
      fieldMappings: config?.fieldMappings || [],
      tags: config?.tags,
      quickCapture
    };

    const modelConfigs = { ...$settings.ankiConnectSettings[configKey] };
    modelConfigs[selectedModel] = newConfig;
    updateAnkiSetting(configKey, modelConfigs);
  }

  // Get which config key to use based on mode
  function getConfigKey(): 'createModelConfigs' | 'updateModelConfigs' {
    if (mode === 'configure') {
      // In configure mode, use the cardMode setting
      return $settings.ankiConnectSettings.cardMode === 'update'
        ? 'updateModelConfigs'
        : 'createModelConfigs';
    }
    return mode === 'update' ? 'updateModelConfigs' : 'createModelConfigs';
  }

  // Check if any configuration has been modified
  function hasUnsavedChanges(): boolean {
    return noteFields.some((f) => isTemplateModified(f)) || isTagsModified() || isDeckModified();
  }

  // Save modified templates to settings
  function saveModifiedTemplates() {
    if (!hasUnsavedChanges()) return;

    const configKey = getConfigKey();
    const configMode = configKey === 'updateModelConfigs' ? 'update' : 'create';
    const config = getModelConfig(selectedModel, configMode);
    const fieldMappings: FieldMapping[] = noteFields.map((field) => ({
      fieldName: field,
      template: editableTemplates[field] || ''
    }));

    const effectiveDeck = getEffectiveDeckName();
    const newConfig: ModelConfig = {
      modelName: selectedModel,
      deckName: effectiveDeck || 'Default',
      fieldMappings,
      tags: editableTags || undefined,
      quickCapture: config?.quickCapture
    };

    const modelConfigs = { ...$settings.ankiConnectSettings[configKey] };
    modelConfigs[selectedModel] = newConfig;
    updateAnkiSetting(configKey, modelConfigs);

    // Sync local state so modified indicators disappear
    for (const field of noteFields) {
      fieldTemplates[field] = editableTemplates[field] || '';
    }
    tagsTemplate = editableTags;
    savedDeckName = effectiveDeck;
  }

  async function onSave() {
    if (mode === 'configure') {
      // Save field configuration to settings
      const fieldMappings: FieldMapping[] = noteFields.map((field) => ({
        fieldName: field,
        template: fieldValues[field] || ''
      }));

      const configKey = getConfigKey();
      const configMode = configKey === 'updateModelConfigs' ? 'update' : 'create';
      const currentConfig = getModelConfig(selectedModel, configMode);
      const finalDeckName = useCustomDeck ? customDeckName : deckName;
      const newConfig: ModelConfig = {
        modelName: selectedModel,
        deckName: finalDeckName || 'Default',
        fieldMappings,
        quickCapture,
        tags: editableTags || undefined
      };

      // Update the config for this model
      const modelConfigs = { ...$settings.ankiConnectSettings[configKey] };
      modelConfigs[selectedModel] = newConfig;
      updateAnkiSetting(configKey, modelConfigs);

      close();
      return;
    }

    // Create/Update mode - send to Anki
    if ($cropperStore?.image && pixels) {
      loading = true;
      try {
        const imageData = await getCroppedImg($cropperStore.image, pixels, $settings);

        // Convert editableTemplates to FieldMapping array
        const fieldMappings: FieldMapping[] = noteFields.map((field) => ({
          fieldName: field,
          template: editableTemplates[field] || ''
        }));

        // Get raw text values from store (not simplified/processed)
        const selectedText = $cropperStore.selectedText;
        const sentence = $cropperStore.sentence;

        // Use the modal's mode, not the global cardMode setting
        if (mode === 'update') {
          const updateOptions: UpdateCardOptions = {
            fieldMappings,
            previousValues: $cropperStore.previousValues,
            previousTags: $cropperStore.previousTags,
            pageNumber: $cropperStore.pageNumber,
            pageFilename: $cropperStore.pageFilename,
            selectedText
          };
          // Pass raw tags - updateLastCard will resolve {existing} and dynamic tags
          await updateLastCard(
            imageData,
            sentence,
            editableTags,
            $cropperStore.metadata,
            $cropperStore.previousCardId,
            $cropperStore.modelName,
            updateOptions
          );
        } else {
          const finalDeckName = useCustomDeck ? customDeckName : deckName;
          const createOptions: CreateCardOptions = {
            fieldMappings,
            previousValues: $cropperStore.previousValues,
            pageNumber: $cropperStore.pageNumber,
            pageFilename: $cropperStore.pageFilename,
            deckName: finalDeckName
          };
          // Resolve dynamic tags for create mode
          const resolvedTags = resolveDynamicTags(editableTags, $cropperStore.metadata || {});
          await createCard(
            imageData,
            selectedText,
            sentence,
            resolvedTags,
            $cropperStore.metadata,
            createOptions
          );
        }
        close();
      } catch (error) {
        console.error('[AnkiFieldModal] Error:', error);
        loading = false;
      }
    }
  }
</script>

<Modal
  bind:open
  onclose={close}
  outsideclose={false}
  onmousedown={handleBackdropMousedown}
  size="xl"
  class="!overflow-hidden"
  bodyClass="max-h-[80vh] overflow-y-auto"
>
  <!-- Header -->
  <div class="mb-4 flex items-center gap-3">
    <h3 class="text-xl font-semibold text-gray-900 dark:text-white">{modeLabel}</h3>
    <Badge color={mode === 'configure' ? 'gray' : mode === 'create' ? 'green' : 'blue'}>
      {selectedModel}
    </Badge>
  </div>

  {#if loading}
    <div class="text-center"><Spinner /></div>
  {:else if loadingFields}
    <div class="text-center">
      <Spinner />
      <p class="mt-2 text-sm text-gray-500">Loading note fields...</p>
    </div>
  {:else}
    <div class="flex flex-col gap-4">
      <!-- All collapsibles -->
      <div class="fields-section space-y-1">
        <!-- Image Cropper (create/update modes only) -->
        {#if showCropperSection && $cropperStore?.image}
          <div class="rounded border border-gray-200 dark:border-gray-700">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
              onclick={() => handleExpand(expandedId === 'image' ? null : 'image')}
            >
              <span
                class="text-gray-400 transition-transform duration-200"
                class:rotate-90={expandedId === 'image'}
              >
                <ChevronRightOutline class="h-3 w-3" />
              </span>
              <span class="min-w-16 shrink-0 text-sm text-gray-500 dark:text-gray-400">Image</span>
              <span class="flex-1 text-sm text-gray-900 dark:text-white">
                {cropEnabled ? 'Cropped to text box' : 'Full page'}
              </span>
            </button>
            {#if expandedId === 'image'}
              <div
                class="border-t border-gray-200 px-2 py-2 dark:border-gray-700"
                transition:slide={{ duration: 150 }}
              >
                <div class="cropper-container">
                  <img
                    src={$cropperStore.image}
                    alt="Crop preview"
                    class="cropper-image block max-w-full"
                    use:initCropperElement
                  />
                </div>
                <div class="mt-2">
                  <Toggle size="small" bind:checked={cropEnabled} onchange={handleCropToggle}>
                    Preset crop to text box
                  </Toggle>
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Deck Selection (create/configure mode only) -->
        {#if mode === 'create' || mode === 'configure'}
          <div class="rounded border border-gray-200 dark:border-gray-700">
            <button
              type="button"
              class="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
              onclick={() => handleExpand(expandedId === 'deck' ? null : 'deck')}
            >
              <span
                class="text-gray-400 transition-transform duration-200"
                class:rotate-90={expandedId === 'deck'}
              >
                <ChevronRightOutline class="h-3 w-3" />
              </span>
              <span class="min-w-16 shrink-0 text-sm text-gray-500 dark:text-gray-400">Deck</span>
              <span class="flex-1 text-sm text-gray-900 dark:text-white">
                {resolvedDeckDisplay}
              </span>
            </button>
            {#if expandedId === 'deck'}
              <div
                class="space-y-2 border-t border-gray-200 px-2 py-2 dark:border-gray-700"
                transition:slide={{ duration: 150 }}
              >
                {#if useCustomDeck}
                  <div class="flex gap-2">
                    <Input
                      size="sm"
                      type="text"
                      placeholder="Custom deck name"
                      bind:value={customDeckName}
                      class="flex-1"
                    />
                    <Button
                      size="xs"
                      color="alternative"
                      onclick={() => {
                        useCustomDeck = false;
                        deckName = availableDecks[0] || 'Default';
                      }}
                    >
                      Use existing
                    </Button>
                  </div>
                  <div class="flex flex-wrap gap-1">
                    {#each DYNAMIC_TAGS as { tag, description }}
                      <button
                        type="button"
                        onclick={() => {
                          customDeckName = customDeckName ? `${customDeckName}${tag}` : tag;
                        }}
                        class="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                        title={description}
                      >
                        {tag}
                      </button>
                    {/each}
                  </div>
                  <Helper class="text-xs text-amber-600 dark:text-amber-400">
                    Custom decks don't work with AnkiConnect on Android
                  </Helper>
                {:else}
                  <div class="flex gap-2">
                    <Select
                      size="sm"
                      items={[
                        { value: '__custom__', name: '(Custom deck name)' },
                        ...availableDecks.map((d) => ({ value: d, name: d }))
                      ]}
                      bind:value={deckName}
                      onchange={(e) => {
                        if (e.currentTarget.value === '__custom__') {
                          useCustomDeck = true;
                          customDeckName = '';
                        }
                      }}
                      class="flex-1"
                    />
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        <!-- Field inputs -->
        {#each noteFields as field}
          {#if mode === 'configure'}
            <AnkiTemplateField
              fieldName={field}
              fieldId={field}
              {expandedId}
              onExpand={handleExpand}
              bind:template={fieldValues[field]}
              resolvedValue=""
              {templateButtons}
              configureMode={true}
            />
          {:else}
            <AnkiTemplateField
              fieldName={field}
              fieldId={field}
              {expandedId}
              onExpand={handleExpand}
              bind:template={editableTemplates[field]}
              resolvedValue={fieldValues[field]}
              {templateButtons}
              availableVariables={getFieldVariables(field)}
              isModified={isTemplateModified(field)}
              willUpdate={fieldWillUpdate(field)}
              onTemplateChange={(t) => {
                editableTemplates[field] = t;
                fieldValues[field] = resolveTemplatePreview(t, field);
              }}
            />
          {/if}
        {/each}

        <!-- Tags field -->
        <AnkiTemplateField
          fieldName="Tags"
          fieldId="tags"
          {expandedId}
          onExpand={handleExpand}
          bind:template={editableTags}
          resolvedValue={mode === 'configure' ? '' : resolveTagsPreview(editableTags)}
          templateButtons={[
            ...(mode === 'update' ||
            (mode === 'configure' && $settings.ankiConnectSettings.cardMode === 'update')
              ? [{ template: '{existing}', description: "Card's existing tags" }]
              : []),
            ...DYNAMIC_TAGS.map((t) => ({ template: t.tag, description: t.description }))
          ]}
          availableVariables={mode === 'configure' ? [] : tagsVariables}
          configureMode={mode === 'configure'}
          isModified={isTagsModified()}
          willUpdate={tagsWillUpdate()}
          hint="Spaces separate tags"
          spaceBeforeInsert={true}
        />
      </div>

      <!-- Quick Capture toggle OR Save template changes (mutually exclusive) -->
      {#if mode !== 'configure' && hasUnsavedChanges()}
        <!-- Unsaved template changes - replaces quick capture section -->
        <div
          class="flex items-center justify-between rounded border border-yellow-300 bg-yellow-50 px-3 py-2 dark:border-yellow-700 dark:bg-yellow-900/30"
        >
          <span class="text-sm text-yellow-700 dark:text-yellow-300">Template changes unsaved</span>
          <Button size="xs" color="yellow" onclick={saveModifiedTemplates}>Save Templates</Button>
        </div>
      {:else}
        <!-- Quick Capture toggle -->
        <div
          class="flex items-center gap-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800"
        >
          <Toggle
            size="small"
            bind:checked={quickCapture}
            onchange={mode !== 'configure' ? handleQuickCaptureToggle : undefined}
          >
            Quick Capture
          </Toggle>
          <span class="text-xs text-gray-500 dark:text-gray-400">
            Skip this modal when capturing
          </span>
        </div>
      {/if}

      <!-- Action buttons -->
      <div class="relative z-10 flex gap-2">
        <Button onclick={onSave} class="flex-1" color={allFieldsExisting ? 'light' : 'primary'}>
          {#if mode === 'configure'}
            Save Configuration
          {:else if mode === 'create'}
            Create Card
          {:else if allFieldsExisting}
            No Changes to Update
          {:else}
            Update Card
          {/if}
        </Button>
        <Button onclick={close} outline color="light">Cancel</Button>
      </div>
    </div>
  {/if}
</Modal>

<style>
  .cropper-container {
    position: relative;
    height: 40dvh;
    overflow: hidden;
    border-radius: 0.5rem;
    background: #111827;
  }

  .cropper-container :global(.cropper-container) {
    height: 100% !important;
  }

  /* Make resize handles larger and easier to grab */
  .cropper-container :global(.cropper-point) {
    width: 20px !important;
    height: 20px !important;
    opacity: 1 !important;
  }

  .cropper-container :global(.cropper-point.point-nw) {
    top: -10px !important;
    left: -10px !important;
  }

  .cropper-container :global(.cropper-point.point-ne) {
    top: -10px !important;
    right: -10px !important;
  }

  .cropper-container :global(.cropper-point.point-sw) {
    bottom: -10px !important;
    left: -10px !important;
  }

  .cropper-container :global(.cropper-point.point-se) {
    bottom: -10px !important;
    right: -10px !important;
  }

  .cropper-container :global(.cropper-point.point-n) {
    width: 40px !important;
    height: 20px !important;
    top: -10px !important;
    left: 50% !important;
    margin-left: -20px !important;
  }

  .cropper-container :global(.cropper-point.point-s) {
    width: 40px !important;
    height: 20px !important;
    bottom: -10px !important;
    top: auto !important;
    left: 50% !important;
    margin-left: -20px !important;
  }

  .cropper-container :global(.cropper-point.point-e) {
    height: 40px !important;
    width: 20px !important;
    right: -10px !important;
    left: auto !important;
    top: 50% !important;
    margin-top: -20px !important;
  }

  .cropper-container :global(.cropper-point.point-w) {
    height: 40px !important;
    width: 20px !important;
    left: -10px !important;
    top: 50% !important;
    margin-top: -20px !important;
  }

  .cropper-container :global(.cropper-line) {
    background-color: rgba(59, 130, 246, 0.5) !important;
  }
</style>
