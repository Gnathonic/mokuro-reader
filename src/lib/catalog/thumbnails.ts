export async function generateThumbnail(
  file: File,
  maxWidth = 500,
  maxHeight = 700
): Promise<File> {
  // Create a canvas element
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  // Create an image element and load the file
  const img = new Image();
  const imgUrl = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = imgUrl;
  });
  URL.revokeObjectURL(imgUrl);

  // Calculate thumbnail dimensions maintaining aspect ratio
  let width = img.width;
  let height = img.height;
  while (width > maxWidth * 2 || height > maxHeight * 2) {
    width = width / 2;
    height = height / 2;
  }
  width = Math.round(width);
  height = Math.round(height);

  canvas.width = width;
  canvas.height = height;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);

  // Convert canvas to blob using the same type as the input file
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b!), file.type, 0.8)
  );

  // Create and return a new File with the same type
  return new File([blob], `thumbnail_${file.name}`, { type: file.type });
}
