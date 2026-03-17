/**
 * Main-thread wrapper for the tile decode worker.
 * Manages worker lifecycle and provides a promise-based API.
 */

import type { TileConfig } from './tile-config';
import type {
	TileDecodeRequest,
	TileDecodeResult,
	TileDecodeError
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

export class TileDecoder {
	private worker: Worker | null = null;
	private nextId = 0;
	private pending = new Map<
		number,
		{
			resolve: (result: DecodeResult) => void;
			reject: (err: Error) => void;
		}
	>();

	constructor() {
		this.worker = new Worker(
			new URL('../../workers/tile-decode-worker.ts', import.meta.url),
			{ type: 'module' }
		);

		this.worker.onmessage = (e: MessageEvent<TileDecodeResult | TileDecodeError>) => {
			const data = e.data;
			const pending = this.pending.get(data.id);
			if (!pending) return;

			this.pending.delete(data.id);

			if ('error' in data) {
				pending.reject(new Error(data.error));
			} else {
				pending.resolve({
					tiles: data.tiles,
					imageWidth: data.imageWidth,
					imageHeight: data.imageHeight,
					cols: data.cols,
					rows: data.rows
				});
			}
		};

		this.worker.onerror = (e) => {
			// Reject all pending requests
			for (const [id, pending] of this.pending) {
				pending.reject(new Error(`Worker error: ${e.message}`));
			}
			this.pending.clear();
		};
	}

	/**
	 * Decode a page image into tiles.
	 * The File is sent to the worker via structured clone.
	 * Returns tile ImageBitmaps via transferable (zero-copy from worker).
	 */
	decodePage(file: File, config: TileConfig): Promise<DecodeResult> {
		if (!this.worker) {
			return Promise.reject(new Error('TileDecoder has been destroyed'));
		}

		const id = this.nextId++;
		const request: TileDecodeRequest = {
			id,
			file,
			tileSize: config.tileSize,
			borderPx: config.borderPx,
			contentSize: config.contentSize
		};

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.worker!.postMessage(request);
		});
	}

	/**
	 * Terminate the worker and reject all pending requests.
	 */
	destroy(): void {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}

		for (const [_, pending] of this.pending) {
			pending.reject(new Error('TileDecoder destroyed'));
		}
		this.pending.clear();
	}
}
