import type {
  Settings,
  AnkiConnectionData,
  ModelConfig,
  FieldMapping
} from '$lib/settings/settings';
import { settings, DEFAULT_MODEL_CONFIGS } from '$lib/settings';
import { showSnackbar } from '$lib/util';
import { get } from 'svelte/store';

export * from './cropper';

// Template variables that can be used in field mappings
export const FIELD_TEMPLATES = [
  { template: '{selection}', description: 'Selected/highlighted text' },
  { template: '{sentence}', description: 'Full sentence/textbox content' },
  { template: '{image}', description: 'Screenshot image' },
  { template: '{series}', description: 'Series title' },
  { template: '{volume}', description: 'Volume title' }
] as const;

// Keep old DYNAMIC_TAGS for backwards compatibility with tags field
export const DYNAMIC_TAGS = [
  { tag: '{series}', description: 'Series title' },
  { tag: '{volume}', description: 'Volume title' }
] as const;

export type VolumeMetadata = {
  seriesTitle?: string;
  volumeTitle?: string;
};

/**
 * Resolves dynamic tag templates in a tags string
 * e.g., "{series} mining" -> "One_Piece mining"
 */
export function resolveDynamicTags(tags: string, metadata: VolumeMetadata): string {
  if (!tags) return '';

  let resolved = tags;

  // Replace {series} with sanitized series title
  if (metadata.seriesTitle) {
    // Anki tags can't have spaces, replace with underscores
    const sanitized = metadata.seriesTitle.replace(/\s+/g, '_');
    resolved = resolved.replace(/\{series\}/g, sanitized);
  } else {
    // Remove the tag if no series title available
    resolved = resolved.replace(/\{series\}/g, '');
  }

  // Replace {volume} with sanitized volume title
  if (metadata.volumeTitle) {
    const sanitized = metadata.volumeTitle.replace(/\s+/g, '_');
    resolved = resolved.replace(/\{volume\}/g, sanitized);
  } else {
    resolved = resolved.replace(/\{volume\}/g, '');
  }

  // Clean up any double spaces and trim
  return resolved.replace(/\s+/g, ' ').trim();
}

/**
 * Resolves all template variables in a field template string.
 * Returns the resolved string, or null if the template is empty or only contains {image}.
 */
export function resolveTemplate(
  template: string,
  metadata: VolumeMetadata,
  selectedText?: string,
  sentence?: string
): string | null {
  if (!template || template === '{image}') {
    return null; // {image} is handled specially, not as text
  }

  let resolved = template;

  // Replace {selection} with selected text
  if (selectedText) {
    resolved = resolved.replace(/\{selection\}/g, selectedText);
  } else {
    resolved = resolved.replace(/\{selection\}/g, '');
  }

  // Replace {sentence} with full sentence
  if (sentence) {
    resolved = resolved.replace(/\{sentence\}/g, sentence);
  } else {
    resolved = resolved.replace(/\{sentence\}/g, '');
  }

  // Replace {series} with series title
  if (metadata.seriesTitle) {
    resolved = resolved.replace(/\{series\}/g, metadata.seriesTitle);
  } else {
    resolved = resolved.replace(/\{series\}/g, '');
  }

  // Replace {volume} with volume title
  if (metadata.volumeTitle) {
    resolved = resolved.replace(/\{volume\}/g, metadata.volumeTitle);
  } else {
    resolved = resolved.replace(/\{volume\}/g, '');
  }

  // Clean up whitespace
  resolved = resolved.replace(/\s+/g, ' ').trim();

  return resolved || null;
}

/**
 * Fetches connection data from AnkiConnect including decks, models, and fields.
 * Also detects if running on AnkiConnect Android by testing createDeck support.
 */
export async function fetchConnectionData(testUrl?: string): Promise<AnkiConnectionData | null> {
  const url = testUrl || get(settings).ankiConnectSettings.url || 'http://127.0.0.1:8765';

  try {
    // Test connection first
    const versionResult = await testConnection(url);
    if (!versionResult.success) {
      showSnackbar(versionResult.message);
      return null;
    }

    // Fetch deck names
    const decks = await ankiConnectRaw(url, 'deckNames', {});
    if (!decks) {
      showSnackbar('Failed to fetch deck names');
      return null;
    }

    // Fetch model names
    const models = await ankiConnectRaw(url, 'modelNames', {});
    if (!models) {
      showSnackbar('Failed to fetch model names');
      return null;
    }

    // Fetch field names for each model
    const modelFields: Record<string, string[]> = {};
    for (const model of models) {
      const fields = await ankiConnectRaw(url, 'modelFieldNames', { modelName: model });
      if (fields) {
        modelFields[model] = fields;
      }
    }

    // Detect Android by trying to create a temporary deck
    let isAndroid = false;
    const tempDeckName = `__mokuro_test_${Date.now()}`;
    const createResult = await ankiConnectRaw(url, 'createDeck', { deck: tempDeckName });

    if (createResult === null) {
      // createDeck failed - likely Android
      isAndroid = true;
    } else {
      // createDeck succeeded - delete the temp deck (desktop only)
      await ankiConnectRaw(url, 'deleteDecks', { decks: [tempDeckName], cardsToo: true });
    }

    return {
      connected: true,
      version: versionResult.version,
      decks,
      models,
      modelFields,
      lastConnected: new Date().toISOString(),
      isAndroid
    };
  } catch (e: any) {
    showSnackbar(`Connection failed: ${e?.message ?? String(e)}`);
    return null;
  }
}

/**
 * Raw AnkiConnect call without showing errors (for internal use).
 */
async function ankiConnectRaw(url: string, action: string, params: Record<string, any>): Promise<any> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ action, params, version: 6 })
    });
    const json = await res.json();
    if (json.error) {
      return null;
    }
    return json.result;
  } catch {
    return null;
  }
}

/**
 * Check if we're in Android compatibility mode.
 */
export function isAndroidMode(): boolean {
  const ankiSettings = get(settings).ankiConnectSettings;
  if (ankiSettings.androidModeOverride === 'android') return true;
  if (ankiSettings.androidModeOverride === 'desktop') return false;
  return ankiSettings.connectionData?.isAndroid ?? false;
}

/**
 * Get the current model configuration, or generate a default one.
 * Always uses actual fields from connectionData to ensure all fields are included.
 */
export function getModelConfig(modelName: string): ModelConfig | null {
  const ankiSettings = get(settings).ankiConnectSettings;

  // Always use actual fields from connectionData to ensure we include all fields
  const actualFields = ankiSettings.connectionData?.modelFields[modelName];
  if (!actualFields || actualFields.length === 0) {
    // Fall back to saved config if no connection data
    if (ankiSettings.modelConfigs[modelName]) {
      return ankiSettings.modelConfigs[modelName];
    }
    return null;
  }

  // Get saved config and default config for template suggestions
  const savedConfig = ankiSettings.modelConfigs[modelName];
  const defaultConfig = DEFAULT_MODEL_CONFIGS[modelName];

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
    modelName,
    deckName: savedConfig?.deckName || defaultConfig?.deckName || 'Default',
    fieldMappings
  };
}

export type ConnectionTestResult = {
  success: boolean;
  error?: 'network' | 'cors' | 'invalid_response' | 'anki_error';
  message: string;
  version?: number;
};

/**
 * Tests the AnkiConnect connection and returns detailed error information.
 * Uses the "version" action which is a simple ping that returns the API version.
 */
export async function testConnection(testUrl?: string): Promise<ConnectionTestResult> {
  const url = testUrl || get(settings).ankiConnectSettings.url || 'http://127.0.0.1:8765';

  try {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ action: 'version', version: 6 })
    });

    const json = await res.json();

    if (json.error) {
      return {
        success: false,
        error: 'anki_error',
        message: `Anki error: ${json.error}`
      };
    }

    return {
      success: true,
      message: `Connected to AnkiConnect v${json.result}`,
      version: json.result
    };
  } catch (e: any) {
    // Distinguish between different error types
    const errorMessage = e?.message ?? String(e);

    // CORS errors typically show as "Failed to fetch" or similar network errors
    // but we can check if it's a TypeError which often indicates CORS
    if (e instanceof TypeError && errorMessage.includes('Failed to fetch')) {
      // Could be CORS or network - provide guidance for both
      return {
        success: false,
        error: 'cors',
        message:
          'Cannot connect. Either Anki is not running, the URL is wrong, or CORS is not configured. Add this site to webCorsOriginList in AnkiConnect settings.'
      };
    }

    if (errorMessage.includes('NetworkError') || errorMessage.includes('net::')) {
      return {
        success: false,
        error: 'network',
        message: 'Network error: Check that Anki is running and the URL is correct'
      };
    }

    return {
      success: false,
      error: 'invalid_response',
      message: `Connection failed: ${errorMessage}`
    };
  }
}

export async function ankiConnect(
  action: string,
  params: Record<string, any>,
  options?: { silent?: boolean }
) {
  const url = get(settings).ankiConnectSettings.url || 'http://127.0.0.1:8765';

  try {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ action, params, version: 6 })
    });
    const json = await res.json();

    if (json.error) {
      throw new Error(json.error);
    }

    return json.result;
  } catch (e: any) {
    // Skip showing errors if silent mode
    if (options?.silent) {
      return undefined;
    }

    // Provide more helpful error messages
    const errorMessage = e?.message ?? String(e);

    if (e instanceof TypeError && errorMessage.includes('Failed to fetch')) {
      showSnackbar(
        'Error: Cannot connect to AnkiConnect. Check that Anki is running and CORS is configured.'
      );
    } else {
      showSnackbar(`Error: ${errorMessage}`);
    }
  }
}

export async function getCardInfo(id: string) {
  const [noteInfo] = await ankiConnect('notesInfo', { notes: [id] });
  return noteInfo;
}

export async function getLastCardId() {
  const notesToday = await ankiConnect('findNotes', { query: 'added:1' });
  if (!notesToday || !Array.isArray(notesToday)) {
    return undefined;
  }
  const id = notesToday.sort().at(-1);
  return id;
}

export async function getLastCardInfo() {
  const id = await getLastCardId();
  return await getCardInfo(id);
}

export function getCardAgeInMin(id: number) {
  return Math.floor((Date.now() - id) / 60000);
}

export async function blobToBase64(blob: Blob) {
  return new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

export async function imageToWebp(source: File, settings: Settings) {
  const image = await createImageBitmap(source);
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');

  if (context) {
    context.drawImage(image, 0, 0);
    await imageResize(
      canvas,
      context,
      settings.ankiConnectSettings.widthField,
      settings.ankiConnectSettings.heightField
    );
    const blob = await canvas.convertToBlob({
      type: 'image/webp',
      quality: settings.ankiConnectSettings.qualityField
    });
    image.close();

    return await blobToBase64(blob);
  }
}

export async function imageResize(
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  maxWidth: number,
  maxHeight: number
): Promise<OffscreenCanvas> {
  return new Promise((resolve, reject) => {
    const widthRatio = maxWidth <= 0 ? 1 : maxWidth / canvas.width;
    const heightRatio = maxHeight <= 0 ? 1 : maxHeight / canvas.height;
    const ratio = Math.min(1, Math.min(widthRatio, heightRatio));

    if (ratio < 1) {
      const newWidth = canvas.width * ratio;
      const newHeight = canvas.height * ratio;
      createImageBitmap(canvas, {
        resizeWidth: newWidth,
        resizeHeight: newHeight,
        resizeQuality: 'high'
      })
        .then((sprite) => {
          canvas.width = newWidth;
          canvas.height = newHeight;
          ctx.drawImage(sprite, 0, 0);
          resolve(canvas);
        })
        .catch((e) => reject(e));
    } else {
      resolve(canvas);
    }
  });
}

export async function createCard(
  imageData: string | null | undefined,
  selectedText?: string,
  sentence?: string,
  tags?: string,
  metadata?: VolumeMetadata
) {
  const ankiSettings = get(settings).ankiConnectSettings;
  const { enabled, selectedModel } = ankiSettings;

  if (!enabled) {
    return;
  }

  // Get model configuration
  const config = getModelConfig(selectedModel);
  if (!config) {
    showSnackbar(`Error: No configuration found for model "${selectedModel}"`);
    return;
  }

  showSnackbar('Creating new card...', 10000);

  // Resolve dynamic templates in deck name (e.g., "Mining::{series}" -> "Mining::One_Piece")
  const resolvedDeckName = metadata
    ? resolveDynamicTags(config.deckName, metadata)
    : config.deckName;

  // Resolve dynamic tags with volume metadata
  const resolvedTags = tags && metadata ? resolveDynamicTags(tags, metadata) : tags;
  const tagList = resolvedTags ? resolvedTags.split(' ').filter((t) => t.length > 0) : [];

  if (!imageData) {
    showSnackbar('Error: No image data');
    return;
  }

  // Build fields object from field mappings
  const fields: Record<string, string> = {};
  const imageFields: string[] = [];

  for (const mapping of config.fieldMappings) {
    if (!mapping.template) continue;

    const hasImage = mapping.template.includes('{image}');

    // Always resolve text templates (strip {image} placeholder first)
    // This allows mixed templates like "{sentence} {image}" to work
    const textTemplate = mapping.template.replace(/\{image\}/g, '').trim();
    if (textTemplate) {
      const resolved = resolveTemplate(textTemplate, metadata || {}, selectedText, sentence);
      if (resolved) {
        fields[mapping.fieldName] = resolved;
      }
    }

    // Additionally mark field for image attachment if template contained {image}
    // AnkiConnect will append the image to whatever text is already in the field
    if (hasImage) {
      imageFields.push(mapping.fieldName);
    }
  }

  // Ensure we have at least one non-empty field
  if (Object.keys(fields).length === 0 && imageFields.length === 0) {
    showSnackbar('Error: No fields would be populated. Check your field mappings.');
    return;
  }

  const timestamp = Date.now();
  const notePayload: Record<string, any> = {
    deckName: resolvedDeckName,
    modelName: selectedModel,
    fields,
    options: {
      allowDuplicate: true
    }
  };

  // Add picture if we have image fields configured
  if (imageFields.length > 0) {
    notePayload.picture = [
      {
        filename: `mokuro_${timestamp}.webp`,
        data: imageData.split(';base64,')[1],
        fields: imageFields
      }
    ];
  }

  // Only add tags if non-empty (not supported by AnkiConnect Android)
  if (tagList.length > 0) {
    notePayload.tags = tagList;
  }

  // Validate deck exists
  const existingDecks = await ankiConnect('deckNames', {});
  if (!existingDecks) {
    // Connection failed - ankiConnect already showed error
    return;
  }
  const deckExists = existingDecks.includes(resolvedDeckName);

  if (!deckExists) {
    // Try to create deck (not supported by AnkiConnect Android)
    const createResult = await ankiConnect(
      'createDeck',
      { deck: resolvedDeckName },
      { silent: true }
    );

    if (createResult === undefined) {
      showSnackbar(
        `Error: Deck "${resolvedDeckName}" doesn't exist. Please create it in Anki first.`
      );
      return;
    }
  }

  // Validate model exists
  const existingModels = await ankiConnect('modelNames', {});
  if (!existingModels) {
    return;
  }
  const modelExists = existingModels.includes(selectedModel);

  if (!modelExists) {
    showSnackbar(
      `Error: Note type "${selectedModel}" doesn't exist. Available: ${existingModels.join(', ')}`
    );
    return;
  }

  // Validate fields exist on model
  const modelFields = await ankiConnect('modelFieldNames', { modelName: selectedModel });
  if (!modelFields) {
    return;
  }

  // Check all configured fields exist
  const usedFields = [...Object.keys(fields), ...imageFields];
  const missingFields = usedFields.filter((f) => !modelFields.includes(f));

  if (missingFields.length > 0) {
    showSnackbar(
      `Error: Fields ${missingFields.map((f) => `"${f}"`).join(', ')} not found. Available: ${modelFields.join(', ')}`
    );
    return;
  }

  const result = await ankiConnect('addNote', { note: notePayload });

  if (result) {
    showSnackbar('Card created!');
  } else {
    // If we get here, validation passed but addNote still failed
    showSnackbar('Error: Failed to create card. The note may be a duplicate.');
  }
}

export async function updateLastCard(
  imageData: string | null | undefined,
  sentence?: string,
  tags?: string,
  metadata?: VolumeMetadata
) {
  const ankiSettings = get(settings).ankiConnectSettings;
  const { enabled, selectedModel } = ankiSettings;

  if (!enabled) {
    return;
  }

  // Get model configuration
  const config = getModelConfig(selectedModel);
  if (!config) {
    showSnackbar(`Error: No configuration found for model "${selectedModel}"`);
    return;
  }

  showSnackbar('Updating last card...', 10000);

  const id = await getLastCardId();

  if (!id) {
    showSnackbar('Error: Could not find recent card (connection failed or no cards today)');
    return;
  }

  if (getCardAgeInMin(id) >= 5) {
    showSnackbar('Error: Card created over 5 minutes ago');
    return;
  }

  // In update mode, we only update image and sentence fields, NOT selection
  // This preserves the user's word/expression that was captured from another source
  const fields: Record<string, any> = {};
  const imageFields: string[] = [];

  for (const mapping of config.fieldMappings) {
    if (!mapping.template) continue;

    const hasImage = mapping.template.includes('{image}');
    const hasSentence = mapping.template.includes('{sentence}');

    // Strip {image} and check for text content to resolve
    // (Also strip {selection} since we don't update that in update mode)
    const textTemplate = mapping.template
      .replace(/\{image\}/g, '')
      .replace(/\{selection\}/g, '')
      .trim();

    // Resolve text content if there's any (sentence, series, volume, etc.)
    if (textTemplate && hasSentence && sentence) {
      const resolved = resolveTemplate(textTemplate, metadata || {}, undefined, sentence);
      if (resolved) {
        fields[mapping.fieldName] = resolved;
      }
    } else if (hasImage && !hasSentence) {
      // If only image (no sentence text), clear field for image replacement
      fields[mapping.fieldName] = '';
    }

    // Mark field for image attachment if template contained {image}
    // AnkiConnect will append the image to whatever text is already in the field
    if (hasImage) {
      imageFields.push(mapping.fieldName);
    }
  }

  // Resolve dynamic tags with volume metadata
  const resolvedTags = tags && metadata ? resolveDynamicTags(tags, metadata) : tags;

  if (!imageData) {
    showSnackbar('Error: No image data');
    return;
  }

  try {
    const noteUpdate: Record<string, any> = {
      id,
      fields
    };

    // Add picture if we have image fields configured
    if (imageFields.length > 0) {
      noteUpdate.picture = {
        filename: `mokuro_${id}.webp`,
        data: imageData.split(';base64,')[1],
        fields: imageFields
      };
    }

    const updateResult = await ankiConnect('updateNoteFields', { note: noteUpdate });

    // ankiConnect returns undefined on error (after showing snackbar)
    if (updateResult === undefined) {
      return;
    }

    // Add tags if provided (not supported by AnkiConnect Android)
    let tagsAdded = true;
    if (resolvedTags && resolvedTags.length > 0) {
      const tagResult = await ankiConnect(
        'addTags',
        { notes: [id], tags: resolvedTags },
        { silent: true }
      );
      tagsAdded = tagResult !== undefined;
    }

    if (tagsAdded) {
      showSnackbar('Card updated!');
    } else {
      showSnackbar('Card updated! (tags not supported on Android)');
    }
  } catch (e) {
    showSnackbar(String(e));
  }
}

/**
 * Main entry point for sending data to Anki.
 * Dispatches to either createCard or updateLastCard based on settings.
 *
 * @param imageData - Base64 image data
 * @param selectedText - The selected/highlighted text (for Front field)
 * @param sentence - The full sentence/context (for Sentence field)
 * @param tags - Tags to add to the card
 * @param metadata - Volume metadata for dynamic tag resolution
 */
export async function sendToAnki(
  imageData: string | null | undefined,
  selectedText?: string,
  sentence?: string,
  tags?: string,
  metadata?: VolumeMetadata
) {
  const { cardMode } = get(settings).ankiConnectSettings;

  if (cardMode === 'create') {
    return createCard(imageData, selectedText, sentence, tags, metadata);
  } else {
    return updateLastCard(imageData, sentence, tags, metadata);
  }
}
