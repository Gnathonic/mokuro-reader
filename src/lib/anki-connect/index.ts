import type { Settings } from '$lib/settings/settings';
import { settings } from '$lib/settings';
import { showSnackbar } from '$lib/util';
import { get } from 'svelte/store';

export * from './cropper';

export async function ankiConnect(action: string, params: Record<string, any>) {
  try {
    const res = await fetch('http://127.0.0.1:8765', {
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

export async function updateLastCard(imageData: string | null | undefined, sentence?: string) {
  const { overwriteImage, enabled, grabSentence, pictureField, sentenceField } =
    get(settings).ankiConnectSettings;

  if (!enabled) {
    return;
  }

  showSnackbar('Updating last card...', 10000);

  const id = await getLastCardId();

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

  if (imageData) {
    ankiConnect('updateNoteFields', {
      note: {
        id,
        fields,
        picture: {
          filename: `mokuro_${id}.webp`,
          data: imageData.split(';base64,')[1],
          fields: [pictureField]
        }
      }
    })
      .then(() => {
        showSnackbar('Card updated!');
      })
      .catch((e) => {
        showSnackbar(e);
      });
  } else {
    showSnackbar('Something went wrong');
  }
}
