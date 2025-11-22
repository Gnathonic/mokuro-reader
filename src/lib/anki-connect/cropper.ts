import { showSnackbar } from '$lib/util';
import { writable } from 'svelte/store';
import { blobToBase64, imageResize } from '.';
import type { Settings } from '$lib/settings/settings';

type CropperModal = {
  open: boolean;
  image?: string;
  sentence?: string;
};

export const cropperStore = writable<CropperModal | undefined>(undefined);

export function showCropper(image: string, sentence?: string) {
  cropperStore.set({
    open: true,
    image,
    sentence
  });
}

async function createImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', (error) => reject(error));
    image.setAttribute('crossOrigin', 'anonymous'); // needed to avoid cross-origin issues on CodeSandbox
    image.src = url;
  });
}

function getRadianAngle(degreeValue: number) {
  return (degreeValue * Math.PI) / 180;
}

export type Pixels = { width: number; height: number; x: number; y: number };

export async function getCroppedImg(
  imageSrc: string,
  pixelCrop: Pixels,
  settings: Settings,
  rotation = 0
) {
  const image = await createImage(imageSrc);
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    showSnackbar('Error: crop failed');
    return;
  }

  const maxSize = Math.max(image.width, image.height);
  const safeArea = 2 * ((maxSize / 2) * Math.sqrt(2));

  // set each dimensions to double largest dimension to allow for a safe area for the
  // image to rotate in without being clipped by canvas context
  canvas.width = safeArea;
  canvas.height = safeArea;

  // translate canvas context to a central location on image to allow rotating around the center.
  ctx.translate(safeArea / 2, safeArea / 2);
  ctx.rotate(getRadianAngle(rotation));
  ctx.translate(-safeArea / 2, -safeArea / 2);

  // draw rotated image and store data.
  ctx.drawImage(image, safeArea / 2 - image.width * 0.5, safeArea / 2 - image.height * 0.5);
  const data = ctx.getImageData(0, 0, safeArea, safeArea);

  // set canvas width to final desired crop size - this will clear existing context
  canvas.width = pixelCrop.width;
  canvas.height = pixelCrop.height;

  // paste generated rotate image with correct offsets for x,y crop values.
  ctx.putImageData(
    data,
    Math.round(0 - safeArea / 2 + image.width * 0.5 - pixelCrop.x),
    Math.round(0 - safeArea / 2 + image.height * 0.5 - pixelCrop.y)
  );

  await imageResize(
    canvas,
    ctx,
    settings.ankiConnectSettings.widthField,
    settings.ankiConnectSettings.heightField
  );
  const blob = await canvas.convertToBlob({
    type: 'image/webp',
    quality: settings.ankiConnectSettings.qualityField
  });

  return await blobToBase64(blob);
}
