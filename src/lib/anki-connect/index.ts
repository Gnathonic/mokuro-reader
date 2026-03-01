/**
 * AnkiConnect integration for creating and updating Anki cards.
 *
 * The CORS permission request pattern is based on code from Mangatan-WebUI
 * by KolbyML, licensed under Mozilla Public License 2.0.
 * https://github.com/KolbyML/Mangatan-WebUI
 */

import type {
  Settings,
  AnkiConnectSettings,
  AnkiConnectionData,
  ModelConfig,
  FieldMapping
} from '$lib/settings/settings';
import { settings, DEFAULT_MODEL_CONFIGS } from '$lib/settings';
import { showSnackbar } from '$lib/util';
import { isMobilePlatform } from '$lib/util/platform';
import { get } from 'svelte/store';

export * from './cropper';

// Template variables that can be used in field mappings
export const FIELD_TEMPLATES = [
  { template: '{existing}', description: "Card's existing value (update mode)" },
  { template: '{selection}', description: 'Selected/highlighted text' },
  { template: '{sentence}', description: 'Full sentence/textbox content' },
  { template: '{image}', description: 'Screenshot image' },
  { template: '{series}', description: 'Series title' },
  { template: '{volume}', description: 'Volume title' },
  { template: '{page_num}', description: 'Current page number' },
  { template: '{page_filename}', description: 'Page image filename' }
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
 * Sanitizes a string for use in a filename.
 * Replaces spaces with underscores and removes unsafe characters.
 */
function sanitizeForFilename(str: string): string {
  return str
    .replace(/\s+/g, '_') // spaces to underscores
    .replace(/[<>:"/\\|?*]/g, '') // remove unsafe chars
    .replace(/_{2,}/g, '_') // collapse multiple underscores
    .substring(0, 50); // limit length
}

/**
 * Generates a descriptive image filename from metadata.
 * Format: mokuro_{series}_{volume}_{page}.jpg
 */
export function generateImageFilename(metadata?: VolumeMetadata, pageFilename?: string): string {
  const parts = ['mokuro'];

  if (metadata?.seriesTitle) {
    parts.push(sanitizeForFilename(metadata.seriesTitle));
  }
  if (metadata?.volumeTitle) {
    parts.push(sanitizeForFilename(metadata.volumeTitle));
  }
  if (pageFilename) {
    parts.push(sanitizeForFilename(pageFilename));
  }

  // If no metadata, use timestamp as fallback
  if (parts.length === 1) {
    parts.push(String(Date.now()));
  }

  return parts.join('_') + '.jpg';
}

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
 * Options for resolving templates with additional context
 */
export type ResolveTemplateOptions = {
  pageNumber?: number;
  pageFilename?: string;
  previousValues?: Record<string, string>;
  fieldName?: string;
};

/**
 * Resolves all template variables in a field template string.
 * Returns the resolved string, or null if the template is empty or only contains {image}.
 */
export function resolveTemplate(
  template: string,
  metadata: VolumeMetadata,
  selectedText?: string,
  sentence?: string,
  options?: ResolveTemplateOptions
): string | null {
  if (!template || template === '{image}') {
    return null; // {image} is handled specially, not as text
  }

  let resolved = template;
  const existingPlaceholders: string[] = [];

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

  // Replace {page_num} with page number (already 1-indexed from callers)
  if (options?.pageNumber !== undefined) {
    resolved = resolved.replace(/\{page_num\}/g, String(options.pageNumber));
  } else {
    resolved = resolved.replace(/\{page_num\}/g, '');
  }

  // Replace {page_filename} with page filename
  if (options?.pageFilename) {
    resolved = resolved.replace(/\{page_filename\}/g, options.pageFilename);
  } else {
    resolved = resolved.replace(/\{page_filename\}/g, '');
  }

  // Replace {existing} with existing value of the current field (for update mode)
  if (options?.previousValues && options?.fieldName) {
    const existingValue = options.previousValues[options.fieldName] || '';
    resolved = resolved.replace(/\{existing\}/g, () => {
      const token = `__MOKURO_EXISTING_${existingPlaceholders.length}__`;
      existingPlaceholders.push(existingValue);
      return token;
    });
  } else {
    resolved = resolved.replace(/\{existing\}/g, '');
  }

  // Clean up whitespace (but preserve HTML structure)
  // Only collapse multiple spaces, don't trim inside HTML tags
  resolved = resolved
    .replace(/[ \t]+/g, ' ') // Collapse multiple spaces/tabs to single space (not newlines)
    .trim();

  // Convert newlines to <br> for Anki
  resolved = resolved.replace(/\n/g, '<br>');

  // Restore raw existing HTML after normalization.
  // This prevents converting newlines inside <style> blocks to <br>, which breaks CSS.
  if (existingPlaceholders.length > 0) {
    resolved = resolved.replace(/__MOKURO_EXISTING_(\d+)__/g, (_match, idx) => {
      const index = Number(idx);
      return existingPlaceholders[index] ?? '';
    });
  }

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
async function ankiConnectRaw(
  url: string,
  action: string,
  params: Record<string, any>
): Promise<any> {
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
 * Get the model configurations store for the given mode.
 */
function getModelConfigsForMode(
  ankiSettings: AnkiConnectSettings,
  mode: 'create' | 'update'
): Record<string, ModelConfig> {
  if (mode === 'create') {
    // For create mode, also check legacy modelConfigs (migration path)
    if (ankiSettings.modelConfigs && Object.keys(ankiSettings.modelConfigs).length > 0) {
      return { ...ankiSettings.modelConfigs, ...ankiSettings.createModelConfigs };
    }
    return ankiSettings.createModelConfigs || {};
  } else {
    // Update mode uses only updateModelConfigs - no legacy fallback
    return ankiSettings.updateModelConfigs || {};
  }
}

/**
 * Check if a model has been explicitly configured for the given mode.
 */
export function hasModelConfig(modelName: string, mode: 'create' | 'update'): boolean {
  const ankiSettings = get(settings).ankiConnectSettings;
  const configs = getModelConfigsForMode(ankiSettings, mode);
  return !!configs[modelName];
}

/**
 * Get the current model configuration, or generate a default one.
 * Always uses actual fields from connectionData to ensure all fields are included.
 *
 * @param modelName - The Anki note type name
 * @param mode - 'create' or 'update' - determines which config store to use
 */
export function getModelConfig(
  modelName: string,
  mode: 'create' | 'update' = 'create'
): ModelConfig | null {
  const ankiSettings = get(settings).ankiConnectSettings;

  // Always use actual fields from connectionData to ensure we include all fields
  const actualFields = ankiSettings.connectionData?.modelFields[modelName];
  const modeConfigs = getModelConfigsForMode(ankiSettings, mode);

  if (!actualFields || actualFields.length === 0) {
    // Fall back to saved config if no connection data
    if (modeConfigs[modelName]) {
      return modeConfigs[modelName];
    }
    return null;
  }

  // Get saved config and default config for template suggestions
  const savedConfig = modeConfigs[modelName];
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

    // In create mode only, check if default config has a template for this field
    // (DEFAULT_MODEL_CONFIGS are for create mode, not update mode)
    if (mode === 'create') {
      const defaultMapping = defaultConfig?.fieldMappings.find((m) => m.fieldName === field);
      if (defaultMapping) {
        fieldMappings.push(defaultMapping);
        continue;
      }
    }

    // Generate smart default based on field name (mode-specific defaults)
    const lowerField = field.toLowerCase();
    if (mode === 'update') {
      // In update mode, default to {existing} for most fields
      if (
        lowerField.includes('picture') ||
        lowerField.includes('image') ||
        lowerField.includes('screenshot')
      ) {
        fieldMappings.push({ fieldName: field, template: '{existing}{image}' });
      } else if (lowerField.includes('sentence') || lowerField.includes('context')) {
        fieldMappings.push({ fieldName: field, template: '{sentence}' });
      } else {
        fieldMappings.push({ fieldName: field, template: '{existing}' });
      }
    } else {
      // Create mode defaults
      if (
        lowerField.includes('front') ||
        lowerField.includes('expression') ||
        lowerField.includes('word')
      ) {
        fieldMappings.push({ fieldName: field, template: '{selection}' });
      } else if (
        lowerField.includes('picture') ||
        lowerField.includes('image') ||
        lowerField.includes('screenshot')
      ) {
        fieldMappings.push({ fieldName: field, template: '{image}' });
      } else if (lowerField.includes('sentence') || lowerField.includes('context')) {
        fieldMappings.push({ fieldName: field, template: '{sentence}' });
      } else {
        fieldMappings.push({ fieldName: field, template: '' });
      }
    }
  }

  return {
    modelName,
    deckName: savedConfig?.deckName || defaultConfig?.deckName || 'Default',
    fieldMappings,
    tags: savedConfig?.tags,
    quickCapture: savedConfig?.quickCapture
  };
}

export type ConnectionTestResult = {
  success: boolean;
  error?: 'network' | 'cors' | 'invalid_response' | 'anki_error' | 'permission_denied';
  message: string;
  version?: number;
};

/**
 * Requests permission from AnkiConnect.
 * This triggers a popup in Anki asking the user to grant permission to this website.
 * Returns true if permission was granted, false otherwise.
 */
async function requestAnkiPermission(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ action: 'requestPermission', version: 6 })
    });
    const json = await res.json();
    return json.result?.permission === 'granted';
  } catch {
    return false;
  }
}

/**
 * Tests the AnkiConnect connection and returns detailed error information.
 * Uses the "version" action which is a simple ping that returns the API version.
 * If CORS blocks the request, attempts to request permission from Anki.
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
    if (e instanceof TypeError && errorMessage.includes('Failed to fetch')) {
      // Try requesting permission from Anki - this triggers a popup in Anki
      const granted = await requestAnkiPermission(url);

      if (granted) {
        // Permission granted, retry the connection
        return testConnection(testUrl);
      }

      // Permission not granted or request failed
      return {
        success: false,
        error: 'cors',
        message:
          'Connection blocked. If Anki showed a permission popup, click "Yes" and try again. Otherwise, add this site to webCorsOriginList in AnkiConnect settings.'
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
  options?: { silent?: boolean; retried?: boolean }
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
      // Try requesting permission if we haven't already retried
      if (!options?.retried) {
        const granted = await requestAnkiPermission(url);
        if (granted) {
          // Retry the request
          return ankiConnect(action, params, { ...options, retried: true });
        }
      }

      showSnackbar(
        'Error: Cannot connect to AnkiConnect. If Anki showed a permission popup, click "Yes" and try again.'
      );
    } else {
      showSnackbar(`Error: ${errorMessage}`);
    }
  }
}

export async function getCardInfo(id: number) {
  const [noteInfo] = await ankiConnect('notesInfo', { notes: [id] });
  return noteInfo;
}

export async function getLastCardId(): Promise<number | undefined> {
  const notesToday = await ankiConnect('findNotes', { query: 'added:1' });
  if (!notesToday || !Array.isArray(notesToday) || notesToday.length === 0) {
    return undefined;
  }
  // Sort numerically (not lexicographically) and get the highest ID (most recent)
  const id = notesToday.sort((a: number, b: number) => a - b).at(-1);
  return id;
}

export async function getLastCardInfo() {
  const id = await getLastCardId();
  if (id === undefined) return undefined;
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
      type: 'image/jpeg',
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

export type CreateCardOptions = {
  fieldMappings?: FieldMapping[];
  previousValues?: Record<string, string>;
  pageNumber?: number;
  pageFilename?: string;
  deckName?: string;
};

export async function createCard(
  imageData: string | null | undefined,
  selectedText?: string,
  sentence?: string,
  tags?: string,
  metadata?: VolumeMetadata,
  options?: CreateCardOptions
) {
  const ankiSettings = get(settings).ankiConnectSettings;
  const { enabled, selectedModel } = ankiSettings;

  if (!enabled) {
    return;
  }

  // Get model configuration for create mode
  const config = getModelConfig(selectedModel, 'create');
  if (!config) {
    showSnackbar(`Error: No configuration found for model "${selectedModel}"`);
    return;
  }

  showSnackbar('Creating new card...', 10000);

  // Resolve dynamic templates in deck name (e.g., "Mining::{series}" -> "Mining::One_Piece")
  // Use provided deckName from options (modal) or fall back to config
  const baseDeckName = options?.deckName || config.deckName;
  const resolvedDeckName = metadata ? resolveDynamicTags(baseDeckName, metadata) : baseDeckName;

  // Resolve dynamic tags with volume metadata
  const resolvedTags = tags && metadata ? resolveDynamicTags(tags, metadata) : tags;
  const tagList = resolvedTags ? resolvedTags.split(' ').filter((t) => t.length > 0) : [];

  if (!imageData) {
    showSnackbar('Error: No image data');
    return;
  }

  // Use provided field mappings (from modal) or fall back to saved config
  const fieldMappings = options?.fieldMappings || config.fieldMappings;

  // Find fields that use {image} - these will receive the picture via AnkiConnect's picture parameter
  const imageFields: string[] = [];
  for (const mapping of fieldMappings) {
    if (mapping.template?.includes('{image}')) {
      imageFields.push(mapping.fieldName);
    }
  }

  // Generate image filename
  const imageFilename = generateImageFilename(metadata, options?.pageFilename);

  // Extract base64 data from data URL
  const base64Data = imageData.split(';base64,')[1];
  if (!base64Data) {
    showSnackbar('Error: Invalid image data format');
    return;
  }

  // Build fields object from field mappings
  // For fields with {image}, we resolve without the image (AnkiConnect will insert it)
  const fields: Record<string, string> = {};

  for (const mapping of fieldMappings) {
    if (!mapping.template) continue;

    // Remove {image} from template - AnkiConnect's picture parameter handles image insertion
    const templateWithoutImage = mapping.template.replace(/\{image\}/g, '');

    const resolved = resolveTemplate(templateWithoutImage, metadata || {}, selectedText, sentence, {
      pageNumber: options?.pageNumber,
      previousValues: options?.previousValues,
      fieldName: mapping.fieldName
    });
    if (resolved) {
      fields[mapping.fieldName] = resolved;
    }
  }

  // Ensure we have at least one non-empty field (excluding image-only fields)
  const nonImageFields = Object.keys(fields).filter((f) => !imageFields.includes(f) || fields[f]);
  if (nonImageFields.length === 0 && imageFields.length === 0) {
    showSnackbar('Error: No fields would be populated. Check your field mappings.');
    return;
  }

  const notePayload: Record<string, any> = {
    deckName: resolvedDeckName,
    modelName: selectedModel,
    fields,
    options: {
      allowDuplicate: true
    }
  };

  // Add picture using AnkiConnect's built-in picture parameter (works on desktop and Android)
  if (imageFields.length > 0) {
    notePayload.picture = [
      {
        filename: imageFilename,
        data: base64Data,
        fields: imageFields
      }
    ];
  }

  // Only add tags if non-empty
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
  const usedFields = Object.keys(fields);
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

export type UpdateCardOptions = {
  fieldMappings?: FieldMapping[];
  previousValues?: Record<string, string>;
  previousTags?: string[];
  pageNumber?: number;
  pageFilename?: string;
  selectedText?: string;
};

export async function updateLastCard(
  imageData: string | null | undefined,
  sentence?: string,
  tags?: string,
  metadata?: VolumeMetadata,
  cardId?: number,
  modelName?: string,
  options?: UpdateCardOptions
) {
  const ankiSettings = get(settings).ankiConnectSettings;
  const { enabled, selectedModel } = ankiSettings;

  if (!enabled) {
    return;
  }

  // Model name is required for update mode - must know the card's actual note type
  if (!modelName) {
    showSnackbar('Error: Model name required for update mode');
    return;
  }

  // Get model configuration for update mode
  const config = getModelConfig(modelName, 'update');
  if (!config) {
    showSnackbar(`Error: No configuration found for model "${modelName}"`);
    return;
  }

  showSnackbar('Updating card...', 10000);

  // Use provided card ID or fetch the last one
  let id = cardId;
  if (!id) {
    id = await getLastCardId();

    if (!id) {
      showSnackbar('Error: Could not find recent card (connection failed or no cards today)');
      return;
    }

    // Only check timeout when we're fetching the card (not when ID is provided)
    if (getCardAgeInMin(id) >= 5) {
      showSnackbar('Error: Card created over 5 minutes ago');
      return;
    }
  }

  // Use provided field mappings (from modal) or fall back to saved config
  const fieldMappings = options?.fieldMappings || config.fieldMappings;

  // Resolve dynamic tags with volume metadata and {existing}
  let resolvedTags = tags || '';
  // Replace {existing} with previous tags
  if (options?.previousTags) {
    resolvedTags = resolvedTags.replace(/\{existing\}/g, options.previousTags.join(' '));
  } else {
    resolvedTags = resolvedTags.replace(/\{existing\}/g, '');
  }
  // Resolve {series} and {volume}
  resolvedTags = metadata ? resolveDynamicTags(resolvedTags, metadata) : resolvedTags;

  if (!imageData) {
    showSnackbar('Error: No image data');
    return;
  }

  // Find fields that use {image} - these will receive the picture via AnkiConnect's picture parameter
  const imageFields: string[] = [];
  for (const mapping of fieldMappings) {
    if (mapping.template?.includes('{image}')) {
      imageFields.push(mapping.fieldName);
    }
  }

  // Generate image filename (use card ID for uniqueness in updates)
  const imageFilename = generateImageFilename(metadata, options?.pageFilename);

  // Extract base64 data from data URL
  const base64Data = imageData.split(';base64,')[1];
  if (!base64Data) {
    showSnackbar('Error: Invalid image data format');
    return;
  }

  // Build fields object from field mappings
  // For fields with {image}, we resolve without the image (AnkiConnect will insert it)
  const fields: Record<string, any> = {};

  for (const mapping of fieldMappings) {
    if (!mapping.template) continue;

    // Remove {image} from template - AnkiConnect's picture parameter handles image insertion
    const templateWithoutImage = mapping.template.replace(/\{image\}/g, '');

    // Resolve text content
    const resolved = resolveTemplate(
      templateWithoutImage,
      metadata || {},
      options?.selectedText,
      sentence,
      {
        pageNumber: options?.pageNumber,
        previousValues: options?.previousValues,
        fieldName: mapping.fieldName
      }
    );

    // For image fields: if template resolves to empty (e.g., just "{image}"),
    // we must explicitly clear the field first so the new image replaces rather than appends
    if (imageFields.includes(mapping.fieldName)) {
      fields[mapping.fieldName] = resolved || '';
    } else if (resolved) {
      fields[mapping.fieldName] = resolved;
    }
  }

  try {
    const noteUpdate: Record<string, any> = {
      id,
      fields
    };

    // Add picture using AnkiConnect's built-in picture parameter (works on desktop and Android)
    if (imageFields.length > 0) {
      noteUpdate.picture = {
        filename: imageFilename,
        data: base64Data,
        fields: imageFields
      };
    }

    const updateResult = await ankiConnect('updateNoteFields', { note: noteUpdate });

    // ankiConnect returns undefined on error (after showing snackbar)
    if (updateResult === undefined) {
      return;
    }

    // Add tags if provided (AnkiConnect Android doesn't support addTags, so skip on mobile)
    if (resolvedTags && resolvedTags.length > 0 && !isMobilePlatform()) {
      await ankiConnect('addTags', { notes: [id], tags: resolvedTags }, { silent: true });
    }

    showSnackbar('Card updated!');
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

/**
 * Extracts field values from an Anki note info object.
 * Returns a map of field name -> raw field value (preserving HTML).
 * This is important for the {existing} template to work with images and formatting.
 */
export function extractFieldValues(noteInfo: any): Record<string, string> {
  if (!noteInfo?.fields) return {};

  const values: Record<string, string> = {};
  for (const [fieldName, fieldData] of Object.entries(noteInfo.fields)) {
    // fieldData is { value: string, order: number }
    const data = fieldData as { value: string; order: number };
    // Preserve raw HTML so {existing} can include images and formatting
    values[fieldName] = data.value || '';
  }
  return values;
}

/**
 * Crops an image URL to the specified bounds and converts to base64 jpg.
 * If no textBox is provided, uses the full image.
 */
export async function cropImageToBounds(
  imageUrl: string,
  textBox?: [number, number, number, number]
): Promise<string | null> {
  const currentSettings = get(settings);

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      let x = 0,
        y = 0,
        width = img.width,
        height = img.height;

      if (textBox && currentSettings.ankiConnectSettings.cropImage) {
        const [xmin, ymin, xmax, ymax] = textBox;
        x = xmin;
        y = ymin;
        width = xmax - xmin;
        height = ymax - ymin;
      }

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }

      ctx.drawImage(img, x, y, width, height, 0, 0, width, height);

      // Apply size limits
      await imageResize(
        canvas,
        ctx,
        currentSettings.ankiConnectSettings.widthField,
        currentSettings.ankiConnectSettings.heightField
      );

      const blob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: currentSettings.ankiConnectSettings.qualityField
      });

      resolve(await blobToBase64(blob));
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}

/**
 * Quick capture function - sends card directly without showing modal.
 * Auto-crops image to textBox bounds if cropImage setting is enabled.
 */
export async function sendQuickCapture(
  mode: 'create' | 'update',
  imageUrl: string,
  selectedText?: string,
  sentence?: string,
  metadata?: VolumeMetadata,
  textBox?: [number, number, number, number],
  previousValues?: Record<string, string>,
  previousCardId?: number,
  previousTags?: string[],
  modelName?: string,
  pageFilename?: string
): Promise<void> {
  const ankiSettings = get(settings).ankiConnectSettings;
  const { enabled, selectedModel } = ankiSettings;

  if (!enabled) return;

  // Crop image
  const imageData = await cropImageToBounds(imageUrl, textBox);
  if (!imageData) {
    showSnackbar('Error: Failed to process image');
    return;
  }

  if (mode === 'create') {
    // Get the model config for create mode
    const config = getModelConfig(selectedModel, 'create');

    // Use tags template from config, resolve dynamic tags
    const tagsTemplate = config?.tags || '';
    const resolvedTags = resolveDynamicTags(tagsTemplate, metadata || {});

    await createCard(imageData, selectedText, sentence, resolvedTags, metadata, {
      deckName: config?.deckName,
      pageFilename
    });
  } else {
    // Update mode - must have card's model name
    if (!modelName) {
      showSnackbar('Error: Could not detect card note type for update');
      return;
    }
    const config = getModelConfig(modelName, 'update');

    // Use tags template from config (will be resolved with {existing} in updateLastCard)
    const tagsTemplate = config?.tags || '{existing}';

    await updateLastCard(imageData, sentence, tagsTemplate, metadata, previousCardId, modelName, {
      previousValues,
      pageFilename,
      previousTags,
      selectedText
    });
  }
}
