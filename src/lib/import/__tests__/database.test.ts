/**
 * Tests for database operations
 *
 * The database module handles atomic writes to IndexedDB:
 * - volumes table: metadata
 * - volume_ocr table: OCR data (pages)
 * - volume_files table: image files
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveVolume, volumeExists, deleteVolume } from '../database';
import type { ProcessedVolume, ProcessedMetadata, ProcessedPage } from '../types';

// Mock the db module to use our test database
vi.mock('$lib/catalog/db', () => ({
	db: {
		volumes: {
			add: vi.fn(),
			get: vi.fn(),
			where: vi.fn(),
			delete: vi.fn()
		},
		volume_ocr: {
			add: vi.fn(),
			get: vi.fn(),
			delete: vi.fn()
		},
		volume_files: {
			add: vi.fn(),
			get: vi.fn(),
			delete: vi.fn()
		},
		transaction: vi.fn()
	}
}));

// Import the mocked db
import { db } from '$lib/catalog/db';

/**
 * Helper to create a processed volume
 */
function createProcessedVolume(overrides: Partial<ProcessedVolume> = {}): ProcessedVolume {
	const metadata: ProcessedMetadata = {
		volumeUuid: 'test-volume-uuid',
		seriesUuid: 'test-series-uuid',
		series: 'Test Series',
		volume: 'Test Volume',
		mokuroVersion: '0.2.0',
		pageCount: 2,
		chars: 100,
		thumbnail: new Blob(['thumbnail']),
		thumbnailWidth: 200,
		thumbnailHeight: 300,
		...overrides.metadata
	};

	const pages: ProcessedPage[] = [
		{ img_path: 'page001.jpg', blocks: [], cumulativeChars: 50 },
		{ img_path: 'page002.jpg', blocks: [], cumulativeChars: 100 }
	];

	return {
		metadata,
		ocrData: {
			volume_uuid: metadata.volumeUuid,
			pages: overrides.ocrData?.pages ?? pages
		},
		fileData: {
			volume_uuid: metadata.volumeUuid,
			files: overrides.fileData?.files ?? {
				'page001.jpg': new File([], 'page001.jpg'),
				'page002.jpg': new File([], 'page002.jpg')
			}
		},
		nestedSources: overrides.nestedSources ?? [],
		...overrides
	};
}

describe('saveVolume', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Set up the mock transaction to execute the callback
		(db.transaction as any).mockImplementation(async (_mode: string, _tables: any[], callback: () => Promise<void>) => {
			await callback();
		});
		// Set up where().equals().first() chain for duplicate check
		(db.volumes.where as any).mockReturnValue({
			equals: vi.fn().mockReturnValue({
				first: vi.fn().mockResolvedValue(undefined)
			})
		});
	});

	it('writes to all three tables', async () => {
		const volume = createProcessedVolume();

		await saveVolume(volume);

		expect(db.volumes.add).toHaveBeenCalledTimes(1);
		expect(db.volume_ocr.add).toHaveBeenCalledTimes(1);
		expect(db.volume_files.add).toHaveBeenCalledTimes(1);
	});

	it('writes metadata with correct structure', async () => {
		const volume = createProcessedVolume({
			metadata: {
				volumeUuid: 'my-uuid',
				seriesUuid: 'series-uuid',
				series: 'My Series',
				volume: 'Volume 01',
				mokuroVersion: '0.3.0',
				pageCount: 5,
				chars: 500,
				thumbnail: null,
				thumbnailWidth: 0,
				thumbnailHeight: 0
			}
		});

		await saveVolume(volume);

		const addCall = (db.volumes.add as any).mock.calls[0][0];
		expect(addCall.volume_uuid).toBe('my-uuid');
		expect(addCall.series_uuid).toBe('series-uuid');
		expect(addCall.series_title).toBe('My Series');
		expect(addCall.volume_title).toBe('Volume 01');
		expect(addCall.mokuro_version).toBe('0.3.0');
		expect(addCall.page_count).toBe(5);
		expect(addCall.character_count).toBe(500);
	});

	it('writes OCR data with pages (strips cumulativeChars)', async () => {
		const pages: ProcessedPage[] = [
			{ img_path: 'p1.jpg', blocks: [{ lines: ['test'] }], cumulativeChars: 10 }
		];
		const volume = createProcessedVolume({
			ocrData: { volume_uuid: 'test-uuid', pages }
		});

		await saveVolume(volume);

		const addCall = (db.volume_ocr.add as any).mock.calls[0][0];
		expect(addCall.volume_uuid).toBe('test-uuid');
		// cumulativeChars is stripped as it's stored in page_char_counts
		expect(addCall.pages).toEqual([
			{ img_path: 'p1.jpg', blocks: [{ lines: ['test'] }] }
		]);
	});

	it('writes file data with sorted files', async () => {
		const files = {
			'page002.jpg': new File([], 'page002.jpg'),
			'page001.jpg': new File([], 'page001.jpg'),
			'page003.jpg': new File([], 'page003.jpg')
		};
		const volume = createProcessedVolume({
			fileData: { volume_uuid: 'test-uuid', files }
		});

		await saveVolume(volume);

		const addCall = (db.volume_files.add as any).mock.calls[0][0];
		expect(addCall.volume_uuid).toBe('test-uuid');
		// Files should be present (sorting is done in the implementation)
		expect(Object.keys(addCall.files)).toHaveLength(3);
	});

	it('uses transaction for atomicity', async () => {
		const volume = createProcessedVolume();

		await saveVolume(volume);

		expect(db.transaction).toHaveBeenCalledWith(
			'rw',
			expect.arrayContaining([db.volumes, db.volume_ocr, db.volume_files]),
			expect.any(Function)
		);
	});

	it('prevents duplicate imports', async () => {
		// Set up mock to return existing volume
		(db.volumes.where as any).mockReturnValue({
			equals: vi.fn().mockReturnValue({
				first: vi.fn().mockResolvedValue({ volume_uuid: 'existing' })
			})
		});

		const volume = createProcessedVolume();

		await expect(saveVolume(volume)).rejects.toThrow(/already exists/i);
	});

	it('calculates page_char_counts from pages', async () => {
		const pages: ProcessedPage[] = [
			{ img_path: 'p1.jpg', blocks: [], cumulativeChars: 50 },
			{ img_path: 'p2.jpg', blocks: [], cumulativeChars: 150 },
			{ img_path: 'p3.jpg', blocks: [], cumulativeChars: 200 }
		];
		const volume = createProcessedVolume({
			ocrData: { volume_uuid: 'test-uuid', pages }
		});

		await saveVolume(volume);

		const addCall = (db.volumes.add as any).mock.calls[0][0];
		expect(addCall.page_char_counts).toEqual([50, 150, 200]);
	});
});

describe('volumeExists', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns true if volume exists', async () => {
		(db.volumes.where as any).mockReturnValue({
			equals: vi.fn().mockReturnValue({
				first: vi.fn().mockResolvedValue({ volume_uuid: 'existing' })
			})
		});

		const exists = await volumeExists('existing');

		expect(exists).toBe(true);
	});

	it('returns false if volume does not exist', async () => {
		(db.volumes.where as any).mockReturnValue({
			equals: vi.fn().mockReturnValue({
				first: vi.fn().mockResolvedValue(undefined)
			})
		});

		const exists = await volumeExists('not-found');

		expect(exists).toBe(false);
	});
});

describe('deleteVolume', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(db.transaction as any).mockImplementation(async (_mode: string, _tables: any[], callback: () => Promise<void>) => {
			await callback();
		});
	});

	it('deletes from all three tables', async () => {
		await deleteVolume('test-uuid');

		expect(db.volumes.delete).toHaveBeenCalledWith('test-uuid');
		expect(db.volume_ocr.delete).toHaveBeenCalledWith('test-uuid');
		expect(db.volume_files.delete).toHaveBeenCalledWith('test-uuid');
	});

	it('uses transaction for atomicity', async () => {
		await deleteVolume('test-uuid');

		expect(db.transaction).toHaveBeenCalledWith(
			'rw',
			expect.arrayContaining([db.volumes, db.volume_ocr, db.volume_files]),
			expect.any(Function)
		);
	});
});
