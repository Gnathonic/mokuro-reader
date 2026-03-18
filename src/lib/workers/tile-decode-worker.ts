/**
 * Web Worker for off-main-thread image decoding and tile slicing.
 *
 * Sends tiles individually via postMessage with transferable ImageBitmaps
 * (zero-copy). No batching — each tile is its own message, sent as soon
 * as it's sliced. The main thread queues them and uploads one per frame.
 */

export interface TileDecodeRequest {
	type: 'decode';
	id: number;
	buffer: ArrayBuffer; // Pre-read file bytes — avoids blob storage IPC in worker
	tileSize: number;
}

export interface TileMessage {
	type: 'tile';
	id: number;
	col: number;
	row: number;
	bitmap: ImageBitmap;
}

export interface DecodeStartMessage {
	type: 'decode-start';
	id: number;
	imageWidth: number;
	imageHeight: number;
	cols: number;
	rows: number;
}

export interface DecodeEndMessage {
	type: 'decode-end';
	id: number;
}

export interface DecodeErrorMessage {
	type: 'decode-error';
	id: number;
	error: string;
}

export type WorkerMessage = TileMessage | DecodeStartMessage | DecodeEndMessage | DecodeErrorMessage;

self.onmessage = async (e: MessageEvent<TileDecodeRequest>) => {
	const { id, buffer, tileSize } = e.data;

	try {
		const blob = new Blob([buffer]);
		const fullBitmap = await createImageBitmap(blob, {
			colorSpaceConversion: 'none', // Skip color profile conversion
			premultiplyAlpha: 'none' // Skip alpha premultiplication
		});
		const { width: imgW, height: imgH } = fullBitmap;
		const cols = Math.ceil(imgW / tileSize);
		const rows = Math.ceil(imgH / tileSize);

		// Signal start with dimensions
		self.postMessage({
			type: 'decode-start', id,
			imageWidth: imgW, imageHeight: imgH, cols, rows
		} satisfies DecodeStartMessage);

		const edgeCanvas = new OffscreenCanvas(tileSize, tileSize);
		const edgeCtx = edgeCanvas.getContext('2d')!;

		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const sx = col * tileSize;
				const sy = row * tileSize;
				const tw = Math.min(tileSize, imgW - sx);
				const th = Math.min(tileSize, imgH - sy);
				const isFullTile = tw === tileSize && th === tileSize;

				let bitmap: ImageBitmap;

				if (isFullTile) {
					bitmap = await createImageBitmap(fullBitmap, sx, sy, tileSize, tileSize);
				} else {
					edgeCtx.clearRect(0, 0, tileSize, tileSize);
					edgeCtx.drawImage(fullBitmap, sx, sy, tw, th, 0, 0, tw, th);
					bitmap = await createImageBitmap(edgeCanvas, 0, 0, tw, th);
				}

				// Send tile immediately as transferable — zero-copy
				const msg: TileMessage = { type: 'tile', id, col, row, bitmap };
				self.postMessage(msg, [bitmap] as any);
			}
		}

		fullBitmap.close();
		self.postMessage({ type: 'decode-end', id } satisfies DecodeEndMessage);
	} catch (err) {
		self.postMessage({
			type: 'decode-error', id,
			error: err instanceof Error ? err.message : String(err)
		} satisfies DecodeErrorMessage);
	}
};
