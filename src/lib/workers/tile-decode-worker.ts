/**
 * Web Worker for off-main-thread image decoding and tile slicing.
 *
 * Receives a File/Blob, decodes it via createImageBitmap, then slices
 * into a grid of tiles with border padding for filter kernel sampling.
 * Returns ImageBitmap tiles via transferable objects (zero-copy).
 */

export interface TileDecodeRequest {
	id: number;
	file: File;
	tileSize: number;
	borderPx: number;
	contentSize: number;
}

export interface TileDecodeResult {
	id: number;
	tiles: Array<{
		col: number;
		row: number;
		bitmap: ImageBitmap;
	}>;
	imageWidth: number;
	imageHeight: number;
	cols: number;
	rows: number;
}

export interface TileDecodeError {
	id: number;
	error: string;
}

self.onmessage = async (e: MessageEvent<TileDecodeRequest>) => {
	const { id, file, tileSize, borderPx, contentSize } = e.data;

	try {
		// Decode the full image off the main thread
		const fullBitmap = await createImageBitmap(file);
		const { width: imgW, height: imgH } = fullBitmap;

		// Calculate grid dimensions
		const cols = Math.ceil(imgW / contentSize);
		const rows = Math.ceil(imgH / contentSize);

		const tiles: TileDecodeResult['tiles'] = [];
		const transferables: ImageBitmap[] = [];

		// Create an OffscreenCanvas for edge tile handling
		const canvas = new OffscreenCanvas(tileSize, tileSize);
		const ctx = canvas.getContext('2d')!;

		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				// Source coordinates with border offset
				const sx = col * contentSize - borderPx;
				const sy = row * contentSize - borderPx;

				// Check if this tile needs edge clamping
				const needsCanvas =
					sx < 0 || sy < 0 || sx + tileSize > imgW || sy + tileSize > imgH;

				let bitmap: ImageBitmap;

				if (!needsCanvas) {
					// Fast path: tile is fully within image bounds
					bitmap = await createImageBitmap(fullBitmap, sx, sy, tileSize, tileSize);
				} else {
					// Slow path: tile overlaps image edge, need to clamp
					ctx.clearRect(0, 0, tileSize, tileSize);

					// Compute clamped source and destination rects
					const clampedSx = Math.max(0, sx);
					const clampedSy = Math.max(0, sy);
					const clampedEx = Math.min(imgW, sx + tileSize);
					const clampedEy = Math.min(imgH, sy + tileSize);

					const srcW = clampedEx - clampedSx;
					const srcH = clampedEy - clampedSy;

					if (srcW > 0 && srcH > 0) {
						const dstX = clampedSx - sx;
						const dstY = clampedSy - sy;

						ctx.drawImage(fullBitmap, clampedSx, clampedSy, srcW, srcH, dstX, dstY, srcW, srcH);
					}

					bitmap = await createImageBitmap(canvas);
				}

				tiles.push({ col, row, bitmap });
				transferables.push(bitmap);
			}
		}

		// Close the source bitmap to free memory
		fullBitmap.close();

		const result: TileDecodeResult = {
			id,
			tiles,
			imageWidth: imgW,
			imageHeight: imgH,
			cols,
			rows
		};

		self.postMessage(result, transferables as any);
	} catch (err) {
		const error: TileDecodeError = {
			id,
			error: err instanceof Error ? err.message : String(err)
		};
		self.postMessage(error);
	}
};
