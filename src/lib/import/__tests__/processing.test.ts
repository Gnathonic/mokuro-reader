/**
 * Tests for unified volume processing
 *
 * The processing module takes decompressed volume data and prepares it
 * for database storage: parsing mokuro, matching images, generating thumbnails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	processVolume,
	parseMokuroFile,
	matchImagesToPages,
	extractVolumeInfo
} from '../processing';
import type { DecompressedVolume } from '../types';

// Mock thumbnail generation since we can't use canvas in tests
vi.mock('$lib/catalog/thumbnails', () => ({
	generateThumbnail: vi.fn().mockResolvedValue({
		file: new File([], 'thumbnail.jpg'),
		width: 200,
		height: 300
	})
}));

/**
 * Helper to create a valid mokuro JSON file
 * Uses Blob with text() method that works in jsdom
 */
function createMokuroFile(overrides: Partial<{
	version: string;
	title: string;
	title_uuid: string;
	volume: string;
	volume_uuid: string;
	pages: Array<{ img_path: string; blocks: unknown[] }>;
	chars: number;
}> = {}): File {
	const data = {
		version: '0.2.0',
		title: 'Test Series',
		title_uuid: 'series-uuid-123',
		volume: 'Test Volume 01',
		volume_uuid: 'volume-uuid-456',
		pages: [
			{ img_path: 'page001.jpg', blocks: [] },
			{ img_path: 'page002.jpg', blocks: [] }
		],
		chars: 100,
		...overrides
	};
	const json = JSON.stringify(data);
	const blob = new Blob([json], { type: 'application/json' });
	// Create a File-like object with text() method
	return Object.assign(blob, {
		name: 'test.mokuro',
		lastModified: Date.now()
	}) as unknown as File;
}

/**
 * Helper to create image files
 */
function createImageFiles(names: string[]): Map<string, File> {
	const files = new Map<string, File>();
	for (const name of names) {
		files.set(name, new File([], name, { type: 'image/jpeg' }));
	}
	return files;
}

/**
 * Helper to create a DecompressedVolume
 */
function createDecompressedVolume(overrides: Partial<DecompressedVolume> = {}): DecompressedVolume {
	return {
		mokuroFile: createMokuroFile(),
		imageFiles: createImageFiles(['page001.jpg', 'page002.jpg']),
		basePath: 'test-manga',
		sourceType: 'local',
		nestedArchives: [],
		...overrides
	};
}

describe('parseMokuroFile', () => {
	it('extracts metadata from valid mokuro file', async () => {
		const mokuroFile = createMokuroFile({
			title: 'My Series',
			volume: 'Volume 01',
			chars: 500
		});

		const result = await parseMokuroFile(mokuroFile);

		expect(result.series).toBe('My Series');
		expect(result.volume).toBe('Volume 01');
		expect(result.chars).toBe(500);
		expect(result.pages).toHaveLength(2);
	});

	it('extracts UUIDs from mokuro file', async () => {
		const mokuroFile = createMokuroFile({
			title_uuid: 'series-abc-123',
			volume_uuid: 'volume-def-456'
		});

		const result = await parseMokuroFile(mokuroFile);

		expect(result.seriesUuid).toBe('series-abc-123');
		expect(result.volumeUuid).toBe('volume-def-456');
	});

	it('extracts version from mokuro file', async () => {
		const mokuroFile = createMokuroFile({ version: '0.3.0' });

		const result = await parseMokuroFile(mokuroFile);

		expect(result.version).toBe('0.3.0');
	});

	it('throws on invalid JSON', async () => {
		const blob = new Blob(['not json'], { type: 'application/json' });
		const badFile = Object.assign(blob, { name: 'bad.mokuro', lastModified: Date.now() }) as unknown as File;

		await expect(parseMokuroFile(badFile)).rejects.toThrow();
	});

	it('throws on missing required fields', async () => {
		const incompleteData = { version: '0.2.0' }; // Missing title, pages, etc.
		const blob = new Blob([JSON.stringify(incompleteData)], { type: 'application/json' });
		const badFile = Object.assign(blob, { name: 'incomplete.mokuro', lastModified: Date.now() }) as unknown as File;

		await expect(parseMokuroFile(badFile)).rejects.toThrow(/missing required/i);
	});
});

describe('matchImagesToPages', () => {
	it('matches images to mokuro page paths exactly', () => {
		const pages = [
			{ img_path: 'page001.jpg', blocks: [] },
			{ img_path: 'page002.jpg', blocks: [] }
		];
		const files = createImageFiles(['page001.jpg', 'page002.jpg']);

		const result = matchImagesToPages(pages, files);

		expect(result.matched).toHaveLength(2);
		expect(result.missing).toHaveLength(0);
		expect(result.extra).toHaveLength(0);
	});

	it('detects missing images', () => {
		const pages = [
			{ img_path: 'page001.jpg', blocks: [] },
			{ img_path: 'page002.jpg', blocks: [] },
			{ img_path: 'page003.jpg', blocks: [] }
		];
		const files = createImageFiles(['page001.jpg', 'page002.jpg']);

		const result = matchImagesToPages(pages, files);

		expect(result.matched).toHaveLength(2);
		expect(result.missing).toEqual(['page003.jpg']);
	});

	it('detects extra images not in mokuro', () => {
		const pages = [{ img_path: 'page001.jpg', blocks: [] }];
		const files = createImageFiles(['page001.jpg', 'bonus.jpg']);

		const result = matchImagesToPages(pages, files);

		expect(result.matched).toHaveLength(1);
		expect(result.extra).toEqual(['bonus.jpg']);
	});

	it('handles path remapping when extensions differ', () => {
		const pages = [
			{ img_path: 'page001.png', blocks: [] },
			{ img_path: 'page002.png', blocks: [] }
		];
		const files = createImageFiles(['page001.webp', 'page002.webp']);

		const result = matchImagesToPages(pages, files);

		expect(result.matched).toHaveLength(2);
		expect(result.remapped.get('page001.png')).toBe('page001.webp');
		expect(result.remapped.get('page002.png')).toBe('page002.webp');
	});

	it('handles nested paths in mokuro', () => {
		const pages = [
			{ img_path: 'images/page001.jpg', blocks: [] },
			{ img_path: 'images/page002.jpg', blocks: [] }
		];
		const files = createImageFiles(['images/page001.jpg', 'images/page002.jpg']);

		const result = matchImagesToPages(pages, files);

		expect(result.matched).toHaveLength(2);
	});

	it('handles case-insensitive matching', () => {
		const pages = [{ img_path: 'PAGE001.JPG', blocks: [] }];
		const files = createImageFiles(['page001.jpg']);

		const result = matchImagesToPages(pages, files);

		expect(result.matched).toHaveLength(1);
	});

	it('uses count-based fallback when names completely mismatch but counts match', () => {
		// Simulates files that were renamed after mokuro processing (e.g., with _result suffix)
		const pages = [
			{ img_path: '001.png', blocks: [] },
			{ img_path: '002.png', blocks: [] },
			{ img_path: '003.png', blocks: [] }
		];
		const files = createImageFiles(['001_result.webp', '002_result.webp', '003_result.webp']);

		const result = matchImagesToPages(pages, files);

		// Should match all via count-based fallback
		expect(result.matched).toHaveLength(3);
		expect(result.missing).toHaveLength(0);
		expect(result.extra).toHaveLength(0);
		// Check remapping is correct (sorted order)
		expect(result.remapped.get('001.png')).toBe('001_result.webp');
		expect(result.remapped.get('002.png')).toBe('002_result.webp');
		expect(result.remapped.get('003.png')).toBe('003_result.webp');
	});

	it('does not use count-based fallback when most files match by name', () => {
		// If more than 50% match by name, don't use fallback for the rest
		const pages = [
			{ img_path: 'page001.jpg', blocks: [] },
			{ img_path: 'page002.jpg', blocks: [] },
			{ img_path: 'page003.jpg', blocks: [] }, // This one won't match
			{ img_path: 'page004.jpg', blocks: [] }
		];
		const files = createImageFiles(['page001.jpg', 'page002.jpg', 'renamed.jpg', 'page004.jpg']);

		const result = matchImagesToPages(pages, files);

		// 3 should match by name, 1 missing, 1 extra (no fallback since >50% matched)
		expect(result.matched).toHaveLength(3);
		expect(result.missing).toEqual(['page003.jpg']);
		expect(result.extra).toEqual(['renamed.jpg']);
	});

	it('does not use count-based fallback when counts do not match', () => {
		const pages = [
			{ img_path: '001.png', blocks: [] },
			{ img_path: '002.png', blocks: [] },
			{ img_path: '003.png', blocks: [] }
		];
		// Only 2 files for 3 pages - counts don't match
		const files = createImageFiles(['001_result.webp', '002_result.webp']);

		const result = matchImagesToPages(pages, files);

		// Should NOT use fallback, report missing
		expect(result.matched).toHaveLength(0);
		expect(result.missing).toHaveLength(3);
		expect(result.extra).toHaveLength(2);
	});
});

describe('extractVolumeInfo', () => {
	it('extracts series and volume from base path', () => {
		const result = extractVolumeInfo('Author/Series Name/Volume 01');

		expect(result.series).toBe('Series Name');
		expect(result.volume).toBe('Volume 01');
	});

	it('handles simple paths (single segment)', () => {
		// Single segment paths use the same value for both series and volume
		const result = extractVolumeInfo('My Manga Vol 1');

		expect(result.series).toBe('My Manga Vol 1');
		expect(result.volume).toBe('My Manga Vol 1');
	});

	it('handles empty path', () => {
		const result = extractVolumeInfo('');

		expect(result.series).toBe('Untitled');
		expect(result.volume).toBe('Untitled');
	});

	it('handles single segment path', () => {
		const result = extractVolumeInfo('Manga');

		expect(result.series).toBe('Manga');
		expect(result.volume).toBe('Manga');
	});
});

describe('processVolume', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('processes volume with mokuro file', async () => {
		const input = createDecompressedVolume();

		const result = await processVolume(input);

		expect(result.metadata.series).toBe('Test Series');
		expect(result.metadata.volume).toBe('Test Volume 01');
		expect(result.metadata.pageCount).toBe(2);
		expect(result.metadata.chars).toBe(100);
	});

	it('calculates cumulative character counts', async () => {
		const mokuroFile = createMokuroFile({
			pages: [
				{ img_path: 'page001.jpg', blocks: [{ lines: ['あいう'] }] }, // 3 chars
				{ img_path: 'page002.jpg', blocks: [{ lines: ['かきくけ'] }] } // 4 chars
			],
			chars: 7
		});
		const input = createDecompressedVolume({ mokuroFile });

		const result = await processVolume(input);

		expect(result.ocrData.pages[0].cumulativeChars).toBe(3);
		expect(result.ocrData.pages[1].cumulativeChars).toBe(7);
	});

	it('includes matched files in fileData', async () => {
		const input = createDecompressedVolume();

		const result = await processVolume(input);

		expect(result.fileData.files['page001.jpg']).toBeDefined();
		expect(result.fileData.files['page002.jpg']).toBeDefined();
	});

	it('handles image-only volumes (no mokuro)', async () => {
		const input = createDecompressedVolume({
			mokuroFile: null,
			basePath: 'My Manga/Volume 01',
			imageFiles: createImageFiles(['001.jpg', '002.jpg', '003.jpg'])
		});

		const result = await processVolume(input);

		expect(result.metadata.imageOnly).toBe(true);
		expect(result.metadata.pageCount).toBe(3);
		expect(result.metadata.series).toBe('My Manga');
		expect(result.metadata.volume).toBe('Volume 01');
	});

	it('generates thumbnail from first image', async () => {
		const input = createDecompressedVolume();

		const result = await processVolume(input);

		expect(result.metadata.thumbnail).toBeDefined();
		expect(result.metadata.thumbnailWidth).toBeGreaterThan(0);
		expect(result.metadata.thumbnailHeight).toBeGreaterThan(0);
	});

	it('handles missing images gracefully', async () => {
		const mokuroFile = createMokuroFile({
			pages: [
				{ img_path: 'page001.jpg', blocks: [] },
				{ img_path: 'page002.jpg', blocks: [] },
				{ img_path: 'page003.jpg', blocks: [] } // Missing
			]
		});
		const input = createDecompressedVolume({
			mokuroFile,
			imageFiles: createImageFiles(['page001.jpg', 'page002.jpg'])
		});

		const result = await processVolume(input);

		expect(result.metadata.mismatchWarning).toContain('page003.jpg');
		expect(result.ocrData.pages).toHaveLength(3); // Still includes all pages
	});

	it('discovers nested archives', async () => {
		const nestedArchive = new File([], 'nested.cbz');
		const input = createDecompressedVolume({
			nestedArchives: [nestedArchive]
		});

		const result = await processVolume(input);

		expect(result.nestedSources).toHaveLength(1);
		expect(result.nestedSources[0].source.type).toBe('archive');
	});

	it('preserves source type in metadata', async () => {
		const localInput = createDecompressedVolume({ sourceType: 'local' });
		const cloudInput = createDecompressedVolume({ sourceType: 'cloud' });

		const localResult = await processVolume(localInput);
		const cloudResult = await processVolume(cloudInput);

		expect(localResult.metadata.sourceType).toBe('local');
		expect(cloudResult.metadata.sourceType).toBe('cloud');
	});
});
