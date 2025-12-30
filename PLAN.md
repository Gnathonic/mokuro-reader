# Hybridized Import Pathway - TDD Plan

## Overview

Unify upload and download pathways into a single import system that:
1. Pre-pairs .mokuro files with matching sources (dirs/archives)
2. Routes single items directly, multiple items to queue
3. Uses worker pool for compressed items, main thread for decompressed
4. Integrates local files via "pseudo provider" pattern
5. Shares nested archive support across all import sources

---

## Phase 1: Pre-Pairing Logic (TDD)

### Types

```typescript
// Input: What we receive from file picker/drag-drop
interface FileEntry {
  path: string;           // Full path including any ZIP nesting
  file: File;             // The actual file object
  isArchive: boolean;     // .zip, .cbz, .rar, etc.
  isMokuro: boolean;      // .mokuro extension
  isImage: boolean;       // .jpg, .png, .webp, etc.
}

// Output: Paired sources ready for processing
interface PairedSource {
  id: string;                          // Unique ID for queue tracking
  mokuroFile: File | null;             // External .mokuro (null if expected inside archive)
  source: PairedSourceType;            // What contains the images
  basePath: string;                    // For series/volume name extraction
  estimatedSize: number;               // For memory management
  type: 'directory' | 'archive' | 'toc-directory';
}

type PairedSourceType =
  | { type: 'directory'; files: Map<string, File> }      // Loose files
  | { type: 'archive'; file: File }                       // ZIP/CBZ to decompress
  | { type: 'toc-directory'; mokuro: File; chapters: Map<string, Map<string, File>> };
```

### Test Cases for `pairMokuroWithSources()`

```typescript
describe('pairMokuroWithSources', () => {

  // ============================================
  // BASIC PAIRING CASES
  // ============================================

  describe('basic pairing', () => {

    it('pairs mokuro with same-name directory', () => {
      // Input:
      //   manga.mokuro
      //   manga/page001.jpg
      //   manga/page002.jpg
      // Expected: 1 pairing { mokuro: manga.mokuro, source: directory(manga/) }
    });

    it('pairs mokuro with same-name archive', () => {
      // Input:
      //   manga.mokuro
      //   manga.cbz
      // Expected: 1 pairing { mokuro: manga.mokuro, source: archive(manga.cbz) }
    });

    it('pairs mokuro inside same directory as images', () => {
      // Input:
      //   manga/manga.mokuro
      //   manga/page001.jpg
      //   manga/page002.jpg
      // Expected: 1 pairing { mokuro: manga.mokuro, source: directory(manga/) }
    });

    it('handles mokuro with different name than directory', () => {
      // Input:
      //   volume1/metadata.mokuro
      //   volume1/page001.jpg
      // Expected: 1 pairing (mokuro name doesn't need to match dir name)
    });

  });

  // ============================================
  // TOC FORMAT (1.a) - Single mokuro with chapter subdirs
  // ============================================

  describe('TOC format detection', () => {

    it('detects TOC format: mokuro alone with multiple chapter subdirs', () => {
      // Input:
      //   series/series.mokuro
      //   series/chapter01/page001.jpg
      //   series/chapter01/page002.jpg
      //   series/chapter02/page001.jpg
      //   series/chapter02/page002.jpg
      // Expected: 1 pairing {
      //   type: 'toc-directory',
      //   mokuro: series.mokuro,
      //   chapters: { chapter01: [...], chapter02: [...] }
      // }
    });

    it('does NOT treat as TOC if mokuro has sibling images', () => {
      // Input:
      //   series/series.mokuro
      //   series/cover.jpg           <-- sibling image
      //   series/chapter01/page001.jpg
      // Expected: 1 pairing { type: 'directory' } (normal, not TOC)
      // The cover.jpg makes this a regular directory, not TOC
    });

    it('handles TOC with deeply nested chapters', () => {
      // Input:
      //   series/data.mokuro
      //   series/vol1/ch1/page001.jpg
      //   series/vol1/ch2/page001.jpg
      //   series/vol2/ch1/page001.jpg
      // Expected: 1 TOC pairing with nested chapter structure
    });

  });

  // ============================================
  // INTERNAL MOKURO (1.b) - Archives without external mokuro
  // ============================================

  describe('internal mokuro detection', () => {

    it('treats standalone archive as self-contained pairing', () => {
      // Input:
      //   manga.cbz   (no external .mokuro)
      // Expected: 1 pairing { mokuro: null, source: archive(manga.cbz) }
      // Processing will look for mokuro INSIDE the archive
    });

    it('does not double-pair archive that has external mokuro', () => {
      // Input:
      //   manga.mokuro
      //   manga.cbz
      // Expected: 1 pairing (not 2)
      // The archive is paired with external mokuro, not treated as self-contained
    });

    it('handles mixed: some with external mokuro, some without', () => {
      // Input:
      //   vol1.mokuro
      //   vol1.cbz
      //   vol2.cbz        (no external mokuro)
      //   vol3/vol3.mokuro
      //   vol3/page001.jpg
      // Expected: 3 pairings
      //   1. { mokuro: vol1.mokuro, source: archive(vol1.cbz) }
      //   2. { mokuro: null, source: archive(vol2.cbz) }
      //   3. { mokuro: vol3.mokuro, source: directory(vol3/) }
    });

  });

  // ============================================
  // MULTIPLE VOLUMES
  // ============================================

  describe('multiple volume handling', () => {

    it('pairs multiple mokuro files with matching directories', () => {
      // Input:
      //   vol1/vol1.mokuro
      //   vol1/page001.jpg
      //   vol2/vol2.mokuro
      //   vol2/page001.jpg
      // Expected: 2 pairings
    });

    it('pairs multiple archives with their mokuro files', () => {
      // Input:
      //   vol1.mokuro
      //   vol1.cbz
      //   vol2.mokuro
      //   vol2.cbz
      // Expected: 2 pairings
    });

    it('handles bundle archive containing multiple volumes', () => {
      // Input:
      //   bundle.zip (contains vol1.cbz, vol2.cbz internally)
      // Expected: 1 pairing initially { source: archive(bundle.zip) }
      // During PROCESSING, nested archives will be discovered and queued
    });

  });

  // ============================================
  // IMAGE-ONLY FALLBACK
  // ============================================

  describe('image-only detection', () => {

    it('creates image-only pairing when no mokuro anywhere', () => {
      // Input:
      //   manga/page001.jpg
      //   manga/page002.jpg
      // Expected: 1 pairing { mokuro: null, source: directory(manga/), imageOnly: true }
    });

    it('creates image-only pairing for archive without mokuro inside', () => {
      // This can only be determined AFTER decompression
      // Pre-pairing assumes archive might have internal mokuro
      // Processing phase marks as image-only if not found
    });

  });

  // ============================================
  // EDGE CASES
  // ============================================

  describe('edge cases', () => {

    it('handles mokuro at root with images in subdirectory', () => {
      // Input:
      //   manga.mokuro
      //   manga/page001.jpg
      //   manga/page002.jpg
      // Expected: 1 pairing
    });

    it('ignores non-manga files', () => {
      // Input:
      //   manga/manga.mokuro
      //   manga/page001.jpg
      //   manga/readme.txt
      //   manga/.DS_Store
      // Expected: 1 pairing (txt and DS_Store ignored)
    });

    it('handles deeply nested structure', () => {
      // Input:
      //   author/series/vol1/vol1.mokuro
      //   author/series/vol1/page001.jpg
      // Expected: 1 pairing with basePath 'author/series/vol1'
    });

    it('handles multiple mokuro in same directory (error case)', () => {
      // Input:
      //   manga/vol1.mokuro
      //   manga/vol2.mokuro
      //   manga/page001.jpg
      // Expected: Error or warning - ambiguous pairing
    });

    it('handles empty directories gracefully', () => {
      // Input:
      //   manga/manga.mokuro
      //   manga/  (no images)
      // Expected: 1 pairing, but flagged as potentially invalid
    });

    it('matches mokuro to archive by stem, ignoring extension variations', () => {
      // Input:
      //   My Manga [Author].mokuro
      //   My Manga [Author].cbz
      // Expected: 1 pairing (exact stem match)
    });

    it('prefers directory over archive when both exist', () => {
      // Input:
      //   manga.mokuro
      //   manga.cbz
      //   manga/page001.jpg
      // Expected: 1 pairing with directory (directory takes precedence)
      // Rationale: directory is already decompressed, faster to process
    });

  });

  // ============================================
  // NAME MATCHING RULES
  // ============================================

  describe('name matching', () => {

    it('matches mokuro to directory by parent relationship', () => {
      // mokuro inside dir → pairs with that dir
      // mokuro at root with same-name dir → pairs with that dir
    });

    it('matches mokuro to archive by stem name', () => {
      // vol1.mokuro + vol1.cbz → paired
      // vol1.mokuro + vol1.zip → paired
      // vol1.mokuro + vol2.cbz → NOT paired
    });

    it('handles case-insensitive matching', () => {
      // Manga.mokuro + manga.cbz → paired (case-insensitive)
    });

    it('handles unicode names', () => {
      // 漫画.mokuro + 漫画.cbz → paired
    });

  });

});
```

---

## Phase 2: Queue Routing Logic (TDD)

### Types

```typescript
interface ImportDecision {
  directProcess: PairedSource | null;   // Process immediately (single item)
  queuedItems: PairedSource[];          // Send to queue (multiple items)
}
```

### Test Cases for `decideImportRouting()`

```typescript
describe('decideImportRouting', () => {

  it('processes single pairing directly', () => {
    const pairings = [{ id: '1', source: archive, ... }];
    const decision = decideImportRouting(pairings);
    expect(decision.directProcess).toBe(pairings[0]);
    expect(decision.queuedItems).toHaveLength(0);
  });

  it('queues multiple pairings', () => {
    const pairings = [
      { id: '1', source: archive1, ... },
      { id: '2', source: archive2, ... },
    ];
    const decision = decideImportRouting(pairings);
    expect(decision.directProcess).toBeNull();
    expect(decision.queuedItems).toHaveLength(2);
  });

  it('handles empty pairings gracefully', () => {
    const decision = decideImportRouting([]);
    expect(decision.directProcess).toBeNull();
    expect(decision.queuedItems).toHaveLength(0);
  });

});
```

---

## Phase 3: Local Provider (TDD)

### Interface

```typescript
// Pseudo-provider that wraps local file sources
interface LocalImportProvider extends Partial<SyncProvider> {
  readonly type: 'local-import';
  readonly name: 'Local Import';
  readonly supportsWorkerDownload: false;   // Main thread only
  readonly uploadConcurrencyLimit: 4;       // CPU-bound, not network
  readonly downloadConcurrencyLimit: 4;

  // Not implemented (local-only)
  isAuthenticated(): true;                  // Always "authenticated"
  login(): Promise<void>;                   // No-op
  logout(): Promise<void>;                  // No-op
  listCloudVolumes(): never;                // Not supported
  uploadFile(): never;                      // Not supported
  deleteFile(): never;                      // Not supported
  getStorageQuota(): never;                 // Not supported
}

// Queue item for local imports
interface LocalQueueItem {
  id: string;
  source: PairedSource;
  provider: 'local-import';
  status: 'queued' | 'decompressing' | 'processing';
  progress: number;
}
```

### Test Cases for Local Provider Integration

```typescript
describe('LocalImportProvider', () => {

  it('creates queue items from paired sources', () => {
    const source: PairedSource = { type: 'archive', file: mockCbz, ... };
    const queueItem = createLocalQueueItem(source);
    expect(queueItem.provider).toBe('local-import');
    expect(queueItem.status).toBe('queued');
  });

  it('skips worker for directory sources', () => {
    const source: PairedSource = { type: 'directory', files: mockFiles, ... };
    const needsWorker = requiresWorkerDecompression(source);
    expect(needsWorker).toBe(false);
  });

  it('uses worker for archive sources', () => {
    const source: PairedSource = { type: 'archive', file: mockCbz, ... };
    const needsWorker = requiresWorkerDecompression(source);
    expect(needsWorker).toBe(true);
  });

  it('integrates with existing queue store', () => {
    const source: PairedSource = { ... };
    queueLocalImport(source);
    const queue = get(localImportQueue);
    expect(queue).toHaveLength(1);
  });

});
```

---

## Phase 4: Unified Processing Pipeline (TDD)

### Types

```typescript
// Common input format after decompression
interface DecompressedVolume {
  mokuroFile: File | null;           // Parsed mokuro JSON
  imageFiles: Map<string, File>;     // filename → File
  basePath: string;                  // For series/volume extraction
  sourceType: 'local' | 'cloud';
  nestedArchives: File[];            // Archives found inside (for recursive processing)
}

// Processed volume ready for DB
interface ProcessedVolume {
  metadata: VolumeMetadata;
  ocrData: { volume_uuid: string; pages: Page[] };
  fileData: { volume_uuid: string; files: Record<string, File> };
  nestedSources: PairedSource[];     // Discovered during processing
}
```

### Test Cases for `processVolume()`

```typescript
describe('processVolume', () => {

  describe('mokuro parsing', () => {

    it('extracts metadata from mokuro file', async () => {
      const input = createDecompressedVolume({
        mokuro: validMokuroFile,
        images: ['page001.jpg', 'page002.jpg']
      });
      const result = await processVolume(input);
      expect(result.metadata.title).toBe('Test Manga');
      expect(result.metadata.volume_uuid).toBeDefined();
    });

    it('handles missing mokuro gracefully (image-only)', async () => {
      const input = createDecompressedVolume({
        mokuro: null,
        images: ['page001.jpg', 'page002.jpg']
      });
      const result = await processVolume(input);
      expect(result.metadata.mokpimageonlyuro_missing).toBe(true);
      // Should prompt user for confirmation before saving
    });

    it('validates mokuro schema', async () => {
      const input = createDecompressedVolume({
        mokuro: invalidMokuroFile,  // Missing required fields
        images: ['page001.jpg']
      });
      await expect(processVolume(input)).rejects.toThrow(/invalid mokuro/i);
    });

  });

  describe('image matching', () => {

    it('matches images to mokuro page paths', async () => {
      // mokuro.pages[0].img_path = 'images/page001.jpg'
      // actual file: 'images/page001.jpg'
      const input = createDecompressedVolume({
        mokuro: mokuroWithPaths(['images/page001.jpg', 'images/page002.jpg']),
        images: ['images/page001.jpg', 'images/page002.jpg']
      });
      const result = await processVolume(input);
      expect(result.ocrData.pages).toHaveLength(2);
    });

    it('remaps paths when formats differ', async () => {
      // mokuro references .jpg but actual files are .webp
      const input = createDecompressedVolume({
        mokuro: mokuroWithPaths(['page001.jpg']),
        images: ['page001.webp']
      });
      const result = await processVolume(input);
      expect(result.ocrData.pages[0].img_path).toBe('page001.webp');
    });

    it('detects missing images (mismatch)', async () => {
      const input = createDecompressedVolume({
        mokuro: mokuroWithPaths(['page001.jpg', 'page002.jpg', 'page003.jpg']),
        images: ['page001.jpg', 'page002.jpg']  // Missing page003
      });
      const result = await processVolume(input);
      expect(result.metadata.mismatch_warning).toContain('page003.jpg');
    });

    it('detects extra images not in mokuro', async () => {
      const input = createDecompressedVolume({
        mokuro: mokuroWithPaths(['page001.jpg']),
        images: ['page001.jpg', 'bonus.jpg']  // Extra image
      });
      const result = await processVolume(input);
      // Extra images are included but flagged
      expect(Object.keys(result.fileData.files)).toContain('bonus.jpg');
    });

  });

  describe('nested archive discovery', () => {

    it('identifies nested archives for recursive processing', async () => {
      const input = createDecompressedVolume({
        mokuro: null,
        images: [],
        archives: ['vol1.cbz', 'vol2.cbz']  // Found inside
      });
      const result = await processVolume(input);
      expect(result.nestedSources).toHaveLength(2);
      expect(result.nestedSources[0].type).toBe('archive');
    });

    it('handles deeply nested archives', async () => {
      // bundle.zip → series.zip → vol1.cbz
      const input = createDecompressedVolume({
        archives: [createMockArchive('series.zip', {
          archives: ['vol1.cbz']
        })]
      });
      const result = await processVolume(input);
      // Returns nested sources to be queued, not processed inline
      expect(result.nestedSources).toHaveLength(1);
    });

  });

  describe('thumbnail generation', () => {

    it('generates thumbnail from first image', async () => {
      const input = createDecompressedVolume({
        mokuro: validMokuro,
        images: ['page001.jpg', 'page002.jpg']
      });
      const result = await processVolume(input);
      expect(result.metadata.thumbnail).toBeDefined();
      expect(result.metadata.thumbnail_width).toBeGreaterThan(0);
    });

    it('handles missing first image gracefully', async () => {
      const input = createDecompressedVolume({
        mokuro: mokuroWithPaths(['missing.jpg']),
        images: []
      });
      const result = await processVolume(input);
      expect(result.metadata.thumbnail).toBeNull();
    });

  });

  describe('character count calculation', () => {

    it('calculates cumulative character counts', async () => {
      const input = createDecompressedVolume({
        mokuro: mokuroWithChars([100, 150, 200]),  // Per-page counts
        images: ['p1.jpg', 'p2.jpg', 'p3.jpg']
      });
      const result = await processVolume(input);
      expect(result.metadata.chars).toBe(450);  // Total
      expect(result.ocrData.pages[0].cumulativeChars).toBe(100);
      expect(result.ocrData.pages[1].cumulativeChars).toBe(250);
      expect(result.ocrData.pages[2].cumulativeChars).toBe(450);
    });

  });

});
```

---

## Phase 5: Database Operations (TDD)

### Test Cases for `saveVolume()`

```typescript
describe('saveVolume', () => {

  it('writes to all three tables atomically', async () => {
    const volume = createProcessedVolume();
    await saveVolume(volume);

    const metadata = await db.volumes.get(volume.metadata.volume_uuid);
    const ocr = await db.volume_ocr.get(volume.metadata.volume_uuid);
    const files = await db.volume_files.get(volume.metadata.volume_uuid);

    expect(metadata).toBeDefined();
    expect(ocr).toBeDefined();
    expect(files).toBeDefined();
  });

  it('rolls back on partial failure', async () => {
    const volume = createProcessedVolume();
    // Simulate failure during file write
    vi.spyOn(db.volume_files, 'add').mockRejectedValueOnce(new Error('DB full'));

    await expect(saveVolume(volume)).rejects.toThrow('DB full');

    // Verify rollback - metadata should not exist
    const metadata = await db.volumes.get(volume.metadata.volume_uuid);
    expect(metadata).toBeUndefined();
  });

  it('prevents duplicate volume imports', async () => {
    const volume = createProcessedVolume();
    await saveVolume(volume);

    await expect(saveVolume(volume)).rejects.toThrow(/already exists/i);
  });

  it('requests persistent storage', async () => {
    const volume = createProcessedVolume();
    const persistSpy = vi.spyOn(navigator.storage, 'persist');

    await saveVolume(volume);

    expect(persistSpy).toHaveBeenCalled();
  });

});
```

---

## Phase 6: Integration Tests

### End-to-End Import Flow

```typescript
describe('import flow integration', () => {

  it('imports single local directory', async () => {
    const files = createMockFileList([
      'manga/manga.mokuro',
      'manga/page001.jpg',
      'manga/page002.jpg'
    ]);

    await importFiles(files);

    const volumes = await db.volumes.toArray();
    expect(volumes).toHaveLength(1);
    expect(volumes[0].title).toBe('manga');
  });

  it('imports single local archive', async () => {
    const files = createMockFileList([
      createMockCbz('manga.cbz', {
        mokuro: validMokuro,
        images: ['page001.jpg', 'page002.jpg']
      })
    ]);

    await importFiles(files);

    const volumes = await db.volumes.toArray();
    expect(volumes).toHaveLength(1);
  });

  it('queues multiple volumes and processes sequentially', async () => {
    const files = createMockFileList([
      'vol1/vol1.mokuro', 'vol1/page001.jpg',
      'vol2/vol2.mokuro', 'vol2/page001.jpg',
      'vol3/vol3.mokuro', 'vol3/page001.jpg',
    ]);

    const importPromise = importFiles(files);

    // Verify queue was populated
    await waitFor(() => {
      const queue = get(localImportQueue);
      expect(queue.length).toBeGreaterThan(0);
    });

    await importPromise;

    const volumes = await db.volumes.toArray();
    expect(volumes).toHaveLength(3);
  });

  it('handles nested archives', async () => {
    const files = createMockFileList([
      createMockZip('bundle.zip', {
        files: [
          createMockCbz('vol1.cbz', { ... }),
          createMockCbz('vol2.cbz', { ... }),
        ]
      })
    ]);

    await importFiles(files);

    const volumes = await db.volumes.toArray();
    expect(volumes).toHaveLength(2);
  });

  it('integrates local import with existing cloud queue', async () => {
    // Start a cloud download
    await queueCloudVolume(cloudVolume);

    // Start a local import (should use same queue system)
    const files = createMockFileList(['manga.cbz']);
    await importFiles(files);

    // Both should complete
    const volumes = await db.volumes.toArray();
    expect(volumes).toHaveLength(2);
  });

});
```

---

## Implementation Order

### Step 1: Test Infrastructure
- [ ] Create test helpers for mock files, archives, mokuro data
- [ ] Set up fake-indexeddb for database tests
- [ ] Create mock File and FileList factories

### Step 2: Pre-Pairing Module
- [ ] Write tests for `pairMokuroWithSources()`
- [ ] Implement pairing logic
- [ ] Write tests for TOC format detection
- [ ] Implement TOC handling
- [ ] Write tests for edge cases
- [ ] Implement edge case handling

### Step 3: Queue Routing
- [ ] Write tests for `decideImportRouting()`
- [ ] Implement routing logic
- [ ] Connect to existing queue stores

### Step 4: Local Provider
- [ ] Write tests for `LocalImportProvider`
- [ ] Implement provider interface
- [ ] Write tests for queue item creation
- [ ] Implement queue integration

### Step 5: Unified Processing
- [ ] Extract common processing from upload/download
- [ ] Write tests for `processVolume()`
- [ ] Implement unified processing pipeline
- [ ] Write tests for `saveVolume()`
- [ ] Implement database operations

### Step 6: Integration
- [ ] Wire up new import flow to UI
- [ ] Migrate existing upload UI to new system
- [ ] Ensure cloud downloads use same processing
- [ ] Remove duplicated code

---

## File Structure

```
src/lib/import/
├── __tests__/
│   ├── helpers/
│   │   ├── mock-files.ts          # Mock File, FileList, archive factories
│   │   ├── mock-mokuro.ts         # Mock mokuro JSON generators
│   │   └── mock-db.ts             # fake-indexeddb setup
│   ├── pairing.test.ts            # Pre-pairing logic tests
│   ├── routing.test.ts            # Queue routing tests
│   ├── processing.test.ts         # Volume processing tests
│   ├── database.test.ts           # Database operation tests
│   └── integration.test.ts        # End-to-end tests
├── types.ts                       # Shared types
├── pairing.ts                     # Pre-pairing logic
├── routing.ts                     # Queue routing decisions
├── local-provider.ts              # Pseudo-provider for local files
├── processing.ts                  # Unified volume processing
├── database.ts                    # Database operations
└── index.ts                       # Public API

src/lib/util/
├── import-queue.ts                # Unified queue (replaces download-queue partially)
└── ...existing files...
```

---

## Questions to Confirm

1. **TOC Format**: Should the entire TOC directory be imported as ONE volume (chapters merged), or should each chapter become a separate volume?

2. **Duplicate Detection**: When an archive has both external and internal mokuro, prefer external? Error? Merge?

3. **Progress UI**: Keep separate progress for pairing vs. processing? Or unified progress bar?

4. **Worker Usage**: For archives under a certain size (e.g., < 50MB), skip worker and decompress in main thread?

5. **Queue Priority**: Should local imports have priority over cloud downloads, or fair FIFO ordering?
