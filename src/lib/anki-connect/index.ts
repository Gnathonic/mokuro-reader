import type { Settings } from '$lib/settings/settings';
import { settings } from '$lib/settings';
import { showSnackbar } from '$lib/util';
import { get } from 'svelte/store';

export * from './cropper';

// Dynamic tag templates that can be used in ankiTags
export const DYNAMIC_TAGS = [
  { tag: '{series}', description: 'Series title' },
  { tag: '{volume}', description: 'Volume title' }
] as const;

// Default tags template when none specified
export const DEFAULT_ANKI_TAGS = '{series}';

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

export async function ankiConnect(action: string, params: Record<string, any>) {
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
    showSnackbar(`Error: ${e?.message ?? e}`);
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
  const { enabled, pictureField, sentenceField, grabSentence, deckName, modelName } =
    get(settings).ankiConnectSettings;

  // Front field is always "Front" for Basic note type
  const frontField = 'Front';

  if (!enabled) {
    return;
  }

  showSnackbar('Creating new card...', 10000);

  // Resolve dynamic templates in deck name (e.g., "Mining::{series}" -> "Mining::One_Piece")
  const resolvedDeckName = metadata ? resolveDynamicTags(deckName, metadata) : deckName;

  // Resolve dynamic tags with volume metadata
  const resolvedTags = tags && metadata ? resolveDynamicTags(tags, metadata) : tags;
  const tagList = resolvedTags ? resolvedTags.split(' ').filter((t) => t.length > 0) : [];

  // Validate required Front field
  if (!selectedText || selectedText.trim().length === 0) {
    showSnackbar('Error: Front field is required');
    return;
  }

  if (!imageData) {
    showSnackbar('Error: No image data');
    return;
  }

  // Build fields object
  const fields: Record<string, string> = {};

  // Front field gets the selected text (required)
  fields[frontField] = selectedText;

  // Sentence field gets the full sentence context (if enabled and different from front)
  if (grabSentence && sentence && frontField !== sentenceField) {
    fields[sentenceField] = sentence;
  }

  const timestamp = Date.now();
  const notePayload: Record<string, any> = {
    deckName: resolvedDeckName,
    modelName,
    fields,
    tags: tagList,
    options: {
      allowDuplicate: true
    },
    picture: [
      {
        filename: `mokuro_${timestamp}.webp`,
        data: imageData.split(';base64,')[1],
        fields: [pictureField]
      }
    ]
  };

  console.log('[AnkiConnect] Creating card with payload:', {
    deckName: resolvedDeckName,
    modelName,
    fields,
    tags: tagList,
    pictureField
  });

  // Create deck if it doesn't exist
  await ankiConnect('createDeck', { deck: resolvedDeckName });

  const result = await ankiConnect('addNote', { note: notePayload });

  if (result) {
    showSnackbar('Card created!');
  } else {
    // ankiConnect already showed the error via showSnackbar
    // If result is null/undefined without an error, show generic message
    showSnackbar('Error: Failed to create card (check deck/model names)');
  }
}

export async function updateLastCard(
  imageData: string | null | undefined,
  sentence?: string,
  tags?: string,
  metadata?: VolumeMetadata
) {
  const { overwriteImage, enabled, grabSentence, pictureField, sentenceField } =
    get(settings).ankiConnectSettings;

  if (!enabled) {
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

  const fields: Record<string, any> = {};

  if (grabSentence && sentence) {
    fields[sentenceField] = sentence;
  }

  if (overwriteImage) {
    fields[pictureField] = '';
  }

  // Resolve dynamic tags with volume metadata
  const resolvedTags = tags && metadata ? resolveDynamicTags(tags, metadata) : tags;

  if (imageData) {
    try {
      const updateResult = await ankiConnect('updateNoteFields', {
        note: {
          id,
          fields,
          picture: {
            filename: `mokuro_${id}.webp`,
            data: imageData.split(';base64,')[1],
            fields: [pictureField]
          }
        }
      });

      // ankiConnect returns undefined on error (after showing snackbar)
      if (updateResult === undefined) {
        return;
      }

      // Add tags if provided (after resolving dynamic templates)
      if (resolvedTags && resolvedTags.length > 0) {
        const tagResult = await ankiConnect('addTags', {
          notes: [id],
          tags: resolvedTags
        });

        if (tagResult === undefined) {
          // Tag addition failed - ankiConnect already showed error
          showSnackbar('Card updated, but tags failed');
          return;
        }
      }

      showSnackbar('Card updated!');
    } catch (e) {
      showSnackbar(String(e));
    }
  } else {
    showSnackbar('Something went wrong');
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
