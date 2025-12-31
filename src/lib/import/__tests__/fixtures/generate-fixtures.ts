// @ts-nocheck - This file uses Node.js APIs and is run via tsx, not in browser
/**
 * Fixture generator for import pairing tests
 *
 * Run with: npx tsx src/lib/import/__tests__/fixtures/generate-fixtures.ts
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BlobWriter, ZipWriter, TextReader, Uint8ArrayReader } from '@zip.js/zip.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_ROOT = __dirname;

// Minimal 1x1 white PNG (67 bytes)
const TINY_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
	'base64'
);

// Minimal CBZ (a zip with one tiny image inside)
// This is a valid ZIP containing a single 1x1 PNG named "page001.jpg"
const TINY_CBZ = Buffer.from(
	'UEsDBBQAAAAIAAAAAACKIYmzSwAAAE0AAAAMAAAAcGFnZTAwMS5qcGdpVjFSwzAMvAvE3' +
		'hL/wVaSnQnoXSCXYeyYjTzxO/y9GgpMSXVn7Uq7qPEFJRjwAAAAPAIAAFBLAQIfABQAAA' +
		'AIAAAAAACKIYmzSwAAAE0AAAAMACQAAAAAAAAAAAAAgAAAAABwYWdlMDAxLmpwZwoAIAA' +
		'AAAAAAQAYAKDisVW6idsBqOKxVbqJ2wGo4rFVuonbAVBLBQYAAAAAAQABAF4AAAB1AAAA' +
		'AAA=',
	'base64'
);

/**
 * Create a CBZ with mokuro file inside (async)
 */
async function createCbzWithMokuro(
	title: string,
	volume: string,
	pageCount: number
): Promise<Buffer> {
	const blobWriter = new BlobWriter('application/zip');
	const zipWriter = new ZipWriter(blobWriter);

	// Add mokuro file
	const mokuroContent = createMokuro(title, volume, pageCount);
	await zipWriter.add('data.mokuro', new TextReader(mokuroContent));

	// Add image files
	for (let i = 1; i <= pageCount; i++) {
		const filename = `page${String(i).padStart(3, '0')}.jpg`;
		await zipWriter.add(filename, new Uint8ArrayReader(new Uint8Array(TINY_PNG)));
	}

	await zipWriter.close();
	const blob = await blobWriter.getData();
	const arrayBuffer = await blob.arrayBuffer();
	return Buffer.from(arrayBuffer);
}

/**
 * Create a minimal mokuro file
 */
function createMokuro(
	title: string,
	volume: string,
	pageCount: number,
	imgPathPrefix = ''
): string {
	const pages = [];
	for (let i = 1; i <= pageCount; i++) {
		const imgPath = imgPathPrefix
			? `${imgPathPrefix}/page${String(i).padStart(3, '0')}.jpg`
			: `page${String(i).padStart(3, '0')}.jpg`;
		pages.push({
			version: '0.1.7',
			img_width: 600,
			img_height: 849,
			blocks: [
				{
					box: [100, 100, 200, 200],
					vertical: true,
					font_size: 30,
					lines_coords: [[[100, 100], [200, 100], [200, 200], [100, 200]]],
					lines: [`テストページ${i}`]
				}
			],
			img_path: imgPath
		});
	}

	return JSON.stringify(
		{
			version: '0.2.0',
			title,
			title_uuid: crypto.randomUUID(),
			volume,
			volume_uuid: crypto.randomUUID(),
			pages
		},
		null,
		2
	);
}

/**
 * Create expected.json for a fixture
 */
function createExpected(
	count: number,
	pairings: Array<{
		sourceType: 'directory' | 'archive' | 'toc-directory';
		hasMokuro: boolean;
		basePathContains: string;
		imageOnly: boolean;
		fileCount?: number;
		chapterNames?: string[];
	}>,
	warnings?: string[]
): string {
	return JSON.stringify({ count, pairings, warnings }, null, 2);
}

/**
 * Create a fixture directory with input files
 */
function createFixture(
	category: string,
	name: string,
	files: Record<string, string | Buffer>,
	expected: string
): void {
	const fixtureDir = join(FIXTURES_ROOT, category, name);
	const inputDir = join(fixtureDir, 'input');

	// Create directories
	mkdirSync(inputDir, { recursive: true });

	// Write files
	for (const [path, content] of Object.entries(files)) {
		const fullPath = join(inputDir, path);
		const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
		mkdirSync(dir, { recursive: true });
		writeFileSync(fullPath, content);
	}

	// Write expected.json
	writeFileSync(join(fixtureDir, 'expected.json'), expected);

	console.log(`Created fixture: ${category}/${name}`);
}

// ============================================
// BASIC FIXTURES
// ============================================

// 1. mokuro-with-same-name-dir
createFixture(
	'basic',
	'mokuro-with-same-name-dir',
	{
		'manga.mokuro': createMokuro('Test Manga', 'Volume 1', 2),
		'manga/page001.jpg': TINY_PNG,
		'manga/page002.jpg': TINY_PNG
	},
	createExpected(1, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'manga',
			imageOnly: false,
			fileCount: 2
		}
	])
);

// 2. mokuro-with-same-name-archive
createFixture(
	'basic',
	'mokuro-with-same-name-archive',
	{
		'manga.mokuro': createMokuro('Test Manga', 'Volume 1', 1),
		'manga.cbz': TINY_CBZ
	},
	createExpected(1, [
		{
			sourceType: 'archive',
			hasMokuro: true,
			basePathContains: 'manga',
			imageOnly: false
		}
	])
);

// 3. mokuro-inside-dir
createFixture(
	'basic',
	'mokuro-inside-dir',
	{
		'manga/manga.mokuro': createMokuro('Test Manga', 'Volume 1', 2),
		'manga/page001.jpg': TINY_PNG,
		'manga/page002.jpg': TINY_PNG
	},
	createExpected(1, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'manga',
			imageOnly: false,
			fileCount: 2
		}
	])
);

// 4. mokuro-different-name
createFixture(
	'basic',
	'mokuro-different-name',
	{
		'volume1/metadata.mokuro': createMokuro('Test Manga', 'Volume 1', 2),
		'volume1/page001.jpg': TINY_PNG,
		'volume1/page002.jpg': TINY_PNG
	},
	createExpected(1, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'volume1',
			imageOnly: false,
			fileCount: 2
		}
	])
);

// ============================================
// TOC FORMAT FIXTURES
// ============================================

// 1. mokuro-with-chapter-subdirs
createFixture(
	'toc-format',
	'mokuro-with-chapter-subdirs',
	{
		'series/series.mokuro': createMokuro('Test Series', 'Full', 4),
		'series/chapter01/page001.jpg': TINY_PNG,
		'series/chapter01/page002.jpg': TINY_PNG,
		'series/chapter02/page001.jpg': TINY_PNG,
		'series/chapter02/page002.jpg': TINY_PNG
	},
	createExpected(1, [
		{
			sourceType: 'toc-directory',
			hasMokuro: true,
			basePathContains: 'series',
			imageOnly: false,
			chapterNames: ['chapter01', 'chapter02']
		}
	])
);

// 2. not-toc-with-sibling-images
// Sibling image makes it NOT a TOC, so chapter images become orphaned
createFixture(
	'toc-format',
	'not-toc-with-sibling-images',
	{
		'series/series.mokuro': createMokuro('Test Series', 'Full', 3),
		'series/cover.jpg': TINY_PNG, // Sibling image - makes it NOT a TOC
		'series/chapter01/page001.jpg': TINY_PNG,
		'series/chapter01/page002.jpg': TINY_PNG
	},
	createExpected(2, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'series',
			imageOnly: false,
			fileCount: 1 // Only the cover.jpg in the series dir
		},
		{
			sourceType: 'directory',
			hasMokuro: false,
			basePathContains: 'chapter01',
			imageOnly: true,
			fileCount: 2 // Orphaned images become image-only volume
		}
	])
);

// 3. toc-deeply-nested-chapters
createFixture(
	'toc-format',
	'toc-deeply-nested-chapters',
	{
		'series/data.mokuro': createMokuro('Test Series', 'Full', 4),
		'series/vol1/page001.jpg': TINY_PNG,
		'series/vol1/page002.jpg': TINY_PNG,
		'series/vol2/page001.jpg': TINY_PNG,
		'series/vol2/page002.jpg': TINY_PNG
	},
	createExpected(1, [
		{
			sourceType: 'toc-directory',
			hasMokuro: true,
			basePathContains: 'series',
			imageOnly: false,
			chapterNames: ['vol1', 'vol2']
		}
	])
);

// ============================================
// INTERNAL MOKURO FIXTURES
// ============================================

// 1. standalone-archive (no external mokuro)
createFixture(
	'internal-mokuro',
	'standalone-archive',
	{
		'manga.cbz': TINY_CBZ
	},
	createExpected(1, [
		{
			sourceType: 'archive',
			hasMokuro: false, // null - expected inside archive
			basePathContains: 'manga',
			imageOnly: false
		}
	])
);

// 2. archive-with-external-mokuro
createFixture(
	'internal-mokuro',
	'archive-with-external-mokuro',
	{
		'manga.mokuro': createMokuro('Test Manga', 'Volume 1', 1),
		'manga.cbz': TINY_CBZ
	},
	createExpected(1, [
		{
			sourceType: 'archive',
			hasMokuro: true,
			basePathContains: 'manga',
			imageOnly: false
		}
	])
);

// 3. mixed-external-and-internal
// Multi-pass order: same-dir images (vol3) → same-name archive (vol1) → standalone (vol2)
createFixture(
	'internal-mokuro',
	'mixed-external-and-internal',
	{
		'vol1.mokuro': createMokuro('Test Manga', 'Volume 1', 1),
		'vol1.cbz': TINY_CBZ,
		'vol2.cbz': TINY_CBZ, // No external mokuro
		'vol3/vol3.mokuro': createMokuro('Test Manga', 'Volume 3', 2),
		'vol3/page001.jpg': TINY_PNG,
		'vol3/page002.jpg': TINY_PNG
	},
	createExpected(3, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'vol3',
			imageOnly: false,
			fileCount: 2
		},
		{
			sourceType: 'archive',
			hasMokuro: true,
			basePathContains: 'vol1',
			imageOnly: false
		},
		{
			sourceType: 'archive',
			hasMokuro: false,
			basePathContains: 'vol2',
			imageOnly: false
		}
	])
);

// ============================================
// MULTIPLE VOLUMES FIXTURES
// ============================================

// 1. multiple-dirs-with-mokuro
createFixture(
	'multiple-volumes',
	'multiple-dirs-with-mokuro',
	{
		'vol1/vol1.mokuro': createMokuro('Test Manga', 'Volume 1', 2),
		'vol1/page001.jpg': TINY_PNG,
		'vol1/page002.jpg': TINY_PNG,
		'vol2/vol2.mokuro': createMokuro('Test Manga', 'Volume 2', 2),
		'vol2/page001.jpg': TINY_PNG,
		'vol2/page002.jpg': TINY_PNG
	},
	createExpected(2, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'vol1',
			imageOnly: false,
			fileCount: 2
		},
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'vol2',
			imageOnly: false,
			fileCount: 2
		}
	])
);

// 2. multiple-archives-with-mokuro
createFixture(
	'multiple-volumes',
	'multiple-archives-with-mokuro',
	{
		'vol1.mokuro': createMokuro('Test Manga', 'Volume 1', 1),
		'vol1.cbz': TINY_CBZ,
		'vol2.mokuro': createMokuro('Test Manga', 'Volume 2', 1),
		'vol2.cbz': TINY_CBZ
	},
	createExpected(2, [
		{
			sourceType: 'archive',
			hasMokuro: true,
			basePathContains: 'vol1',
			imageOnly: false
		},
		{
			sourceType: 'archive',
			hasMokuro: true,
			basePathContains: 'vol2',
			imageOnly: false
		}
	])
);

// 3. bundle-archive (single archive, nested archives handled during processing)
createFixture(
	'multiple-volumes',
	'bundle-archive',
	{
		'bundle.zip': TINY_CBZ // Treated as self-contained initially
	},
	createExpected(1, [
		{
			sourceType: 'archive',
			hasMokuro: false,
			basePathContains: 'bundle',
			imageOnly: false
		}
	])
);

// ============================================
// IMAGE-ONLY FIXTURES
// ============================================

// 1. directory-no-mokuro
createFixture(
	'image-only',
	'directory-no-mokuro',
	{
		'manga/page001.jpg': TINY_PNG,
		'manga/page002.jpg': TINY_PNG
	},
	createExpected(1, [
		{
			sourceType: 'directory',
			hasMokuro: false,
			basePathContains: 'manga',
			imageOnly: true,
			fileCount: 2
		}
	])
);

// 2. multiple-dirs-no-mokuro
createFixture(
	'image-only',
	'multiple-dirs-no-mokuro',
	{
		'vol1/page001.jpg': TINY_PNG,
		'vol1/page002.jpg': TINY_PNG,
		'vol2/page001.jpg': TINY_PNG,
		'vol2/page002.jpg': TINY_PNG
	},
	createExpected(2, [
		{
			sourceType: 'directory',
			hasMokuro: false,
			basePathContains: 'vol1',
			imageOnly: true,
			fileCount: 2
		},
		{
			sourceType: 'directory',
			hasMokuro: false,
			basePathContains: 'vol2',
			imageOnly: true,
			fileCount: 2
		}
	])
);

// ============================================
// EDGE CASES FIXTURES
// ============================================

// 1. mokuro-root-images-subdir
createFixture(
	'edge-cases',
	'mokuro-root-images-subdir',
	{
		'manga.mokuro': createMokuro('Test Manga', 'Volume 1', 2),
		'manga/page001.jpg': TINY_PNG,
		'manga/page002.jpg': TINY_PNG
	},
	createExpected(1, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'manga',
			imageOnly: false,
			fileCount: 2
		}
	])
);

// 2. ignores-non-manga-files
createFixture(
	'edge-cases',
	'ignores-non-manga-files',
	{
		'manga/manga.mokuro': createMokuro('Test Manga', 'Volume 1', 2),
		'manga/page001.jpg': TINY_PNG,
		'manga/page002.jpg': TINY_PNG,
		'manga/readme.txt': Buffer.from('This is a readme'),
		'manga/.DS_Store': Buffer.from('fake ds store')
	},
	createExpected(1, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'manga',
			imageOnly: false,
			fileCount: 2 // Only images counted
		}
	])
);

// 3. deeply-nested-structure
createFixture(
	'edge-cases',
	'deeply-nested-structure',
	{
		'author/series/vol1/vol1.mokuro': createMokuro('Test Manga', 'Volume 1', 2),
		'author/series/vol1/page001.jpg': TINY_PNG,
		'author/series/vol1/page002.jpg': TINY_PNG
	},
	createExpected(1, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'author/series/vol1',
			imageOnly: false,
			fileCount: 2
		}
	])
);

// 4. multiple-mokuro-same-dir (ambiguous - first mokuro claims images, second orphaned)
// This is an edge case where user has multiple mokuro files for same images
// With multi-pass matching, the first mokuro in iteration order claims the images,
// and the second mokuro becomes orphaned since the directory is already paired.
createFixture(
	'edge-cases',
	'multiple-mokuro-same-dir',
	{
		'manga/vol1.mokuro': createMokuro('Test Manga', 'Volume 1', 2),
		'manga/vol2.mokuro': createMokuro('Test Manga', 'Volume 2', 2),
		'manga/page001.jpg': TINY_PNG,
		'manga/page002.jpg': TINY_PNG
	},
	createExpected(
		1,
		[
			{
				sourceType: 'directory',
				hasMokuro: true,
				basePathContains: 'manga',
				imageOnly: false,
				fileCount: 2
			}
		],
		['Orphaned mokuro file: manga/vol2.mokuro (no matching images or archive)']
	)
);

// 5. empty-directory (mokuro with no images)
createFixture(
	'edge-cases',
	'empty-directory',
	{
		'manga/manga.mokuro': createMokuro('Test Manga', 'Volume 1', 2)
		// No images
	},
	// Mokuro becomes orphaned - no images to pair with
	createExpected(0, [], [
		'Orphaned mokuro file: manga/manga.mokuro (no matching images or archive)'
	])
);

// 6. stem-matching-with-special-chars
createFixture(
	'edge-cases',
	'stem-matching-with-special-chars',
	{
		'My Manga [Author].mokuro': createMokuro('My Manga', 'Volume 1', 1),
		'My Manga [Author].cbz': TINY_CBZ
	},
	createExpected(1, [
		{
			sourceType: 'archive',
			hasMokuro: true,
			basePathContains: 'My Manga [Author]',
			imageOnly: false
		}
	])
);

// 7. prefers-directory-over-archive
createFixture(
	'edge-cases',
	'prefers-directory-over-archive',
	{
		'manga.mokuro': createMokuro('Test Manga', 'Volume 1', 2),
		'manga.cbz': TINY_CBZ,
		'manga/page001.jpg': TINY_PNG,
		'manga/page002.jpg': TINY_PNG
	},
	// Should pair with directory (already decompressed), archive becomes standalone
	createExpected(2, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'manga',
			imageOnly: false,
			fileCount: 2
		},
		{
			sourceType: 'archive',
			hasMokuro: false,
			basePathContains: 'manga',
			imageOnly: false
		}
	])
);

// 8. case-insensitive-matching
createFixture(
	'edge-cases',
	'case-insensitive-matching',
	{
		'Manga.mokuro': createMokuro('Test Manga', 'Volume 1', 1),
		'manga.cbz': TINY_CBZ
	},
	createExpected(1, [
		{
			sourceType: 'archive',
			hasMokuro: true,
			basePathContains: 'manga',
			imageOnly: false
		}
	])
);

// 9. unicode-names
createFixture(
	'edge-cases',
	'unicode-names',
	{
		'漫画/漫画.mokuro': createMokuro('漫画', 'Volume 1', 2),
		'漫画/page001.jpg': TINY_PNG,
		'漫画/page002.jpg': TINY_PNG
	},
	createExpected(1, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: '漫画',
			imageOnly: false,
			fileCount: 2
		}
	])
);

// 10. mokuro-inside-dir-with-matching-filename
// Pattern: [Series]/[Volume]/[Volume].mokuro + images (like Oshi no Ko)
createFixture(
	'edge-cases',
	'mokuro-inside-dir-matching-filename',
	{
		'Series/Volume01/Volume01.mokuro': createMokuro('Test Series', 'Volume 01', 2),
		'Series/Volume01/001.webp': TINY_PNG,
		'Series/Volume01/002.webp': TINY_PNG
	},
	createExpected(1, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'Series/Volume01',
			imageOnly: false,
			fileCount: 2
		}
	])
);

// ============================================
// MULTI-VOLUME SAME-NAME FIXTURES
// ============================================
// These test the priority of same-name matching over TOC format

// 1. multi-volume-same-name-external-mokuro
// Pattern: Series/[Vol01].mokuro + [Vol01]/ + [Vol02].mokuro + [Vol02]/
// This should NOT be treated as TOC format because each mokuro matches a specific dir
createFixture(
	'multi-volume',
	'same-name-external-mokuro',
	{
		'series/vol01.mokuro': createMokuro('Test Series', 'Volume 1', 2),
		'series/vol01/page001.jpg': TINY_PNG,
		'series/vol01/page002.jpg': TINY_PNG,
		'series/vol02.mokuro': createMokuro('Test Series', 'Volume 2', 2),
		'series/vol02/page001.jpg': TINY_PNG,
		'series/vol02/page002.jpg': TINY_PNG
	},
	createExpected(2, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'vol01',
			imageOnly: false,
			fileCount: 2
		},
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'vol02',
			imageOnly: false,
			fileCount: 2
		}
	])
);

// 2. multi-volume-same-name-with-special-chars
// Pattern with brackets and unicode (like ACCA)
createFixture(
	'multi-volume',
	'same-name-special-chars',
	{
		'series/[Author] Vol 01 【限定版】.mokuro': createMokuro('Test Series', 'Volume 1', 2),
		'series/[Author] Vol 01 【限定版】/page001.jpg': TINY_PNG,
		'series/[Author] Vol 01 【限定版】/page002.jpg': TINY_PNG,
		'series/[Author] Vol 02.mokuro': createMokuro('Test Series', 'Volume 2', 2),
		'series/[Author] Vol 02/page001.jpg': TINY_PNG,
		'series/[Author] Vol 02/page002.jpg': TINY_PNG
	},
	createExpected(2, [
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'Vol 01',
			imageOnly: false,
			fileCount: 2
		},
		{
			sourceType: 'directory',
			hasMokuro: true,
			basePathContains: 'Vol 02',
			imageOnly: false,
			fileCount: 2
		}
	])
);

// 3. toc-vs-same-name-distinction
// One mokuro for TOC (no matching dir), others have matching dirs
createFixture(
	'multi-volume',
	'toc-vs-same-name-distinction',
	{
		// TOC mokuro with no same-name dir, has chapter subdirs
		'series/series.mokuro': createMokuro('Test Series', 'Full', 4),
		'series/chapter01/page001.jpg': TINY_PNG,
		'series/chapter01/page002.jpg': TINY_PNG,
		'series/chapter02/page001.jpg': TINY_PNG,
		'series/chapter02/page002.jpg': TINY_PNG
	},
	createExpected(1, [
		{
			sourceType: 'toc-directory',
			hasMokuro: true,
			basePathContains: 'series',
			imageOnly: false,
			chapterNames: ['chapter01', 'chapter02']
		}
	])
);

// 4. mixed-matching-one-matches-one-doesnt
// ACCA-like scenario: vol2.mokuro matches vol2/, but vol1.mokuro doesn't match any dir
// Multi-pass ensures vol2/ is claimed first, so vol1.mokuro can't steal its files
createFixture(
	'multi-volume',
	'mixed-matching-priority',
	{
		// vol1 mokuro has DIFFERENT name than its intended dir
		'series/volume1-ocr.mokuro': createMokuro('Test Series', 'Volume 1', 2),
		'series/vol1/page001.jpg': TINY_PNG,
		'series/vol1/page002.jpg': TINY_PNG,
		// vol2 mokuro MATCHES its dir exactly
		'series/vol2.mokuro': createMokuro('Test Series', 'Volume 2', 2),
		'series/vol2/page001.jpg': TINY_PNG,
		'series/vol2/page002.jpg': TINY_PNG
	},
	// vol2.mokuro pairs with vol2/ (same-name match)
	// vol1 mokuro is orphaned (no matching dir/archive)
	// vol1/ becomes image-only
	createExpected(
		2,
		[
			{
				sourceType: 'directory',
				hasMokuro: true,
				basePathContains: 'vol2',
				imageOnly: false,
				fileCount: 2
			},
			{
				sourceType: 'directory',
				hasMokuro: false,
				basePathContains: 'vol1',
				imageOnly: true,
				fileCount: 2
			}
		],
		['Orphaned mokuro file: series/volume1-ocr.mokuro (no matching images or archive)']
	)
);

// 5. cross-series-matching-prevention
// Verifies that mokuro files in one series CANNOT match dirs/archives in another series
// This is critical for correct multi-series imports
createFixture(
	'multi-volume',
	'cross-series-matching-prevention',
	{
		// Series 1: mokuro file with no matching dir in its own series
		'series1/manga.mokuro': createMokuro('Series 1', 'Volume 1', 2),
		// Series 2: directory that DOES match the mokuro's stem
		// Without sibling scoping, series1/manga.mokuro would incorrectly claim this
		'series2/manga/page001.jpg': TINY_PNG,
		'series2/manga/page002.jpg': TINY_PNG
	},
	// series1/manga.mokuro is orphaned (no sibling dir named 'manga')
	// series2/manga/ is image-only (no mokuro in its own series)
	createExpected(
		1,
		[
			{
				sourceType: 'directory',
				hasMokuro: false,
				basePathContains: 'series2/manga',
				imageOnly: true,
				fileCount: 2
			}
		],
		['Orphaned mokuro file: series1/manga.mokuro (no matching images or archive)']
	)
);

// 6. cross-series-archive-matching-prevention
// Same as above but with archives instead of directories
createFixture(
	'multi-volume',
	'cross-series-archive-matching-prevention',
	{
		// Series 1: mokuro file with no matching archive in its own series
		'series1/manga.mokuro': createMokuro('Series 1', 'Volume 1', 1),
		// Series 2: archive that DOES match the mokuro's stem
		'series2/manga.cbz': TINY_CBZ
	},
	// series1/manga.mokuro is orphaned (no sibling archive named 'manga')
	// series2/manga.cbz is standalone (no mokuro in its own series)
	createExpected(
		1,
		[
			{
				sourceType: 'archive',
				hasMokuro: false,
				basePathContains: 'manga',
				imageOnly: false
			}
		],
		['Orphaned mokuro file: series1/manga.mokuro (no matching images or archive)']
	)
);

// ============================================
// ASYNC FIXTURES (CBZ with internal mokuro)
// ============================================

/**
 * Create a ZIP containing multiple nested CBZ files (archive of archives)
 */
async function createNestedArchiveZip(
	volumes: Array<{ title: string; volume: string; pageCount: number }>
): Promise<Buffer> {
	const blobWriter = new BlobWriter('application/zip');
	const zipWriter = new ZipWriter(blobWriter);

	// Add each volume as a nested CBZ
	for (const vol of volumes) {
		const cbzBuffer = await createCbzWithMokuro(vol.title, vol.volume, vol.pageCount);
		const filename = `${vol.volume.replace(/\s+/g, '_')}.cbz`;
		await zipWriter.add(filename, new Uint8ArrayReader(new Uint8Array(cbzBuffer)));
	}

	await zipWriter.close();
	const blob = await blobWriter.getData();
	const arrayBuffer = await blob.arrayBuffer();
	return Buffer.from(arrayBuffer);
}

/**
 * Create a deeply nested archive: catalog.zip > series.zip > volume.cbz
 * Simulates a backup archive containing multiple series, each with multiple volumes
 */
async function createDeeplyNestedArchive(
	series: Array<{
		name: string;
		volumes: Array<{ title: string; volume: string; pageCount: number }>;
	}>
): Promise<Buffer> {
	const catalogWriter = new ZipWriter(new BlobWriter('application/zip'));

	// Create each series as a nested ZIP containing CBZs
	for (const s of series) {
		const seriesZip = await createNestedArchiveZip(s.volumes);
		const seriesFilename = `${s.name.replace(/\s+/g, '_')}.zip`;
		await catalogWriter.add(seriesFilename, new Uint8ArrayReader(new Uint8Array(seriesZip)));
	}

	await catalogWriter.close();
	const blob = await (catalogWriter as any).writer.getData();
	const arrayBuffer = await blob.arrayBuffer();
	return Buffer.from(arrayBuffer);
}

/**
 * Create async fixtures that require dynamic CBZ generation
 */
async function createAsyncFixtures(): Promise<void> {
	// 4. self-contained-cbz (mokuro + images inside archive, no directory structure)
	// This is the most common mokuro-processed manga format
	const selfContainedCbz = await createCbzWithMokuro('Test Manga', 'Volume 1', 2);
	createFixture(
		'internal-mokuro',
		'self-contained-cbz',
		{
			'manga.cbz': selfContainedCbz
		},
		createExpected(1, [
			{
				sourceType: 'archive',
				hasMokuro: false, // No EXTERNAL mokuro - it's inside the archive
				basePathContains: 'manga',
				imageOnly: false
			}
		])
	);

	// 5. self-contained-cbz-multiple (multiple self-contained archives)
	const vol1Cbz = await createCbzWithMokuro('Test Series', 'Volume 1', 2);
	const vol2Cbz = await createCbzWithMokuro('Test Series', 'Volume 2', 2);
	createFixture(
		'internal-mokuro',
		'self-contained-cbz-multiple',
		{
			'vol1.cbz': vol1Cbz,
			'vol2.cbz': vol2Cbz
		},
		createExpected(2, [
			{
				sourceType: 'archive',
				hasMokuro: false,
				basePathContains: 'vol1',
				imageOnly: false
			},
			{
				sourceType: 'archive',
				hasMokuro: false,
				basePathContains: 'vol2',
				imageOnly: false
			}
		])
	);

	// 6. nested-archives (ZIP containing multiple CBZ files)
	// Tests archive-of-archives handling - common when bundling multiple volumes
	const nestedArchiveZip = await createNestedArchiveZip([
		{ title: 'Test Series', volume: 'Volume 1', pageCount: 2 },
		{ title: 'Test Series', volume: 'Volume 2', pageCount: 2 },
		{ title: 'Test Series', volume: 'Volume 3', pageCount: 2 }
	]);
	createFixture(
		'edge-cases',
		'nested-archives',
		{
			'bundle.zip': nestedArchiveZip
		},
		// Initial pairing sees bundle.zip as one archive with no direct content
		// The nested CBZs are discovered and queued during processing
		createExpected(1, [
			{
				sourceType: 'archive',
				hasMokuro: false,
				basePathContains: 'bundle',
				imageOnly: false
			}
		])
	);

	// 7. deeply-nested-archives (catalog.zip > series.zip > volume.cbz)
	// Tests multi-level nesting - e.g., backup archive containing series archives
	const deeplyNestedZip = await createDeeplyNestedArchive([
		{
			name: 'Series A',
			volumes: [
				{ title: 'Series A', volume: 'Volume 1', pageCount: 2 },
				{ title: 'Series A', volume: 'Volume 2', pageCount: 2 }
			]
		},
		{
			name: 'Series B',
			volumes: [
				{ title: 'Series B', volume: 'Volume 1', pageCount: 2 }
			]
		}
	]);
	createFixture(
		'edge-cases',
		'deeply-nested-archives',
		{
			'catalog.zip': deeplyNestedZip
		},
		// Initial pairing sees catalog.zip with nested series ZIPs
		// Each series ZIP contains CBZs - requires recursive extraction
		createExpected(1, [
			{
				sourceType: 'archive',
				hasMokuro: false,
				basePathContains: 'catalog',
				imageOnly: false
			}
		])
	);

	console.log('Created async fixtures (CBZ with internal mokuro)');
}

// Run async fixtures
createAsyncFixtures()
	.then(() => {
		console.log('\nAll fixtures created successfully!');
	})
	.catch((err) => {
		console.error('Failed to create async fixtures:', err);
		process.exit(1);
	});
