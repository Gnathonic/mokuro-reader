import Pica from 'pica';

export interface ThumbnailResult {
  file: File;
  width: number;
  height: number;
}

// Singleton pica instance
const pica = new Pica();

export async function generateThumbnail(
  file: File,
  maxWidth = 250,
  maxHeight = 350
): Promise<ThumbnailResult> {
  // Create an image element and load the file
  const img = new Image();
  const imgUrl = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = imgUrl;
  });
  URL.revokeObjectURL(imgUrl);

  // Calculate target dimensions maintaining aspect ratio
  const scaleW = maxWidth / img.width;
  const scaleH = maxHeight / img.height;
  const scale = Math.min(scaleW, scaleH, 1); // Don't scale up

  const targetWidth = Math.round(img.width * scale);
  const targetHeight = Math.round(img.height * scale);

  // Create source canvas from image
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = img.width;
  srcCanvas.height = img.height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) throw new Error('Could not get canvas context');
  srcCtx.drawImage(img, 0, 0);

  // Create destination canvas
  const destCanvas = document.createElement('canvas');
  destCanvas.width = targetWidth;
  destCanvas.height = targetHeight;

  // Use pica for high-quality Lanczos3 resampling
  await pica.resize(srcCanvas, destCanvas, {
    filter: 'lanczos3',
    unsharpAmount: 80,
    unsharpRadius: 0.6,
    unsharpThreshold: 2
  });

  // Convert to blob
  const blob = await pica.toBlob(destCanvas, file.type, 0.85);

  return {
    file: new File([blob], `thumbnail_${file.name}`, { type: file.type }),
    width: targetWidth,
    height: targetHeight
  };
}
