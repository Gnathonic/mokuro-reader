/**
 * Main-thread tile decoder.
 *
 * Tiles arrive individually via postMessage with transferable ImageBitmaps
 * (zero-copy from worker). The decoder queues them and exposes a rAF-paced
 * drain loop that uploads one tile per frame.
 */

import type {
	TileDecodeRequest,
	WorkerMessage,
	TileMessage
} from '$lib/workers/tile-decode-worker';

export interface TileBitmap {
	col: number;
	row: number;
	bitmap: ImageBitmap;
}

export interface DecodeResult {
	tiles: TileBitmap[];
	imageWidth: number;
	imageHeight: number;
	cols: number;
	rows: number;
}

interface PendingDecode {
	resolve: (result: DecodeResult) => void;
	reject: (err: Error) => void;
	tiles: TileBitmap[];
	imageWidth: number;
	imageHeight: number;
	cols: number;
	rows: number;
	/** Called for each tile as it arrives — for streaming upload */
	onTile?: (tile: TileBitmap) => void;
}

export class TileDecoder {
	private worker: Worker;
	private nextId = 0;
	private pending = new Map<number, PendingDecode>();
	private destroyed = false;

	constructor() {
		this.worker = new Worker(
			new URL('../../workers/tile-decode-worker.ts', import.meta.url),
			{ type: 'module' }
		);

		this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
			this.handleMessage(e.data);
		};

		this.worker.onerror = (e) => {
			for (const [_, p] of this.pending) {
				p.reject(new Error(`Worker error: ${e.message}`));
			}
			this.pending.clear();
		};
	}

	private handleMessage(msg: WorkerMessage): void {
		const p = this.pending.get(msg.id);
		if (!p) return;

		switch (msg.type) {
			case 'decode-start':
				p.imageWidth = msg.imageWidth;
				p.imageHeight = msg.imageHeight;
				p.cols = msg.cols;
				p.rows = msg.rows;
				break;

			case 'tile': {
				const tile: TileBitmap = {
					col: msg.col,
					row: msg.row,
					bitmap: msg.bitmap
				};
				p.tiles.push(tile);
				p.onTile?.(tile);
				break;
			}

			case 'decode-end':
				this.pending.delete(msg.id);
				p.resolve({
					tiles: p.tiles,
					imageWidth: p.imageWidth,
					imageHeight: p.imageHeight,
					cols: p.cols,
					rows: p.rows
				});
				break;

			case 'decode-error':
				this.pending.delete(msg.id);
				p.reject(new Error(msg.error));
				break;
		}
	}

	/**
	 * Decode a page. Calls onTile() for each tile as it arrives
	 * from the worker (zero-copy transferable). The caller can
	 * upload to GPU immediately in the callback.
	 *
	 * Returns the full result when all tiles are received.
	 */
	/**
	 * Decode a page. Pre-reads the file to ArrayBuffer on the main thread
	 * (async, non-blocking), then transfers the buffer to the worker
	 * (zero-copy). This avoids blob storage IPC stalls in the worker.
	 */
	async decodePage(
		file: File,
		tileSize: number,
		onTile?: (tile: TileBitmap) => void
	): Promise<DecodeResult> {
		if (this.destroyed) return Promise.reject(new Error('TileDecoder destroyed'));

		// Pre-read file bytes — async, non-blocking
		const buffer = await file.arrayBuffer();

		const id = this.nextId++;
		const request: TileDecodeRequest = { type: 'decode', id, buffer, tileSize };

		return new Promise((resolve, reject) => {
			this.pending.set(id, {
				resolve,
				reject,
				tiles: [],
				imageWidth: 0,
				imageHeight: 0,
				cols: 0,
				rows: 0,
				onTile
			});
			// Transfer the ArrayBuffer — zero-copy to worker
			this.worker.postMessage(request, [buffer]);
		});
	}

	destroy(): void {
		this.destroyed = true;
		this.worker.terminate();
		for (const [_, p] of this.pending) {
			p.reject(new Error('TileDecoder destroyed'));
		}
		this.pending.clear();
	}
}
