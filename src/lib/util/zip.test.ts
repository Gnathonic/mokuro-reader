import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zipManga, createArchiveBlob } from './zip';
import { db } from '$lib/catalog/db';
import { compressVolume } from './compress-volume';

// Mock the database with v3 tables
vi.mock('$lib/catalog/db', () => ({
  db: {
    volume_ocr: {
      get: vi.fn()
    },
    volume_files: {
      get: vi.fn()
    }
  }
}));

// Mock the backup queue to avoid Worker issues
vi.mock('./backup-queue', () => ({
  backupQueue: {
    queueVolumeForExport: vi.fn()
  }
}));

// Store the actual compressVolume calls for verification
const compressVolumeCalls: { metadata: unknown; filesData: unknown[] }[] = [];

// Mock the compression module to capture calls
vi.mock('./compress-volume', () => ({
  compressVolume: vi.fn().mockImplementation((title, metadata, filesData) => {
    compressVolumeCalls.push({ metadata, filesData });
    return Promise.resolve(new Uint8Array([1, 2, 3]));
  })
}));

// Mock @zip.js/zip.js to avoid real compression
vi.mock('@zip.js/zip.js', () => ({
  BlobReader: vi.fn(),
  Uint8ArrayWriter: vi.fn(),
  TextReader: vi.fn(),
  ZipWriter: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
  }))
}));

// Mock the DOM APIs
globalThis.URL.createObjectURL = vi.fn(() => 'blob:test');
globalThis.URL.revokeObjectURL = vi.fn();

// Mock document.createElement
document.createElement = vi.fn().mockImplementation((tag) => {
  if (tag === 'a') {
    return {
      href: '',
      download: '',
      click: vi.fn()
    };
  }
  return {};
});

describe('zipManga', () => {
  const mockVolume = {
    volume_uuid: 'test-uuid',
    series_uuid: 'series-uuid',
    series_title: 'Test Manga',
    volume_title: 'Volume 1',
    mokuro_version: '1.0',
    character_count: 100,
    page_count: 1,
    page_char_counts: [] as number[]
  };

  const mockOcrData = {
    volume_uuid: 'test-uuid',
    pages: [{ width: 100, height: 100 }]
  };

  const mockFilesData = {
    volume_uuid: 'test-uuid',
    files: {
      'page1.jpg': new Blob(['test'], { type: 'image/jpeg' })
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - Mock type mismatch
    db.volume_ocr.get.mockResolvedValue(mockOcrData);
    // @ts-expect-error - Mock type mismatch
    db.volume_files.get.mockResolvedValue(mockFilesData);
  });

  it('should create a single archive when individualVolumes is false', async () => {
    const result = await zipManga([mockVolume], false, false, true);
    expect(result).toBe(false);
    expect(document.createElement).toHaveBeenCalledWith('a');
    // Get the actual mock element that was created and used
    const mockCalls = vi.mocked(document.createElement).mock.results;
    const link = mockCalls[mockCalls.length - 1].value;
    expect(link.download).toBe('Test Manga.zip');
  });

  it('should queue individual archives when individualVolumes is true', async () => {
    const { backupQueue } = await import('./backup-queue');
    const result = await zipManga([mockVolume], false, true, true);
    expect(result).toBe(false);
    // Individual volumes use the queue instead of direct download
    expect(backupQueue.queueVolumeForExport).toHaveBeenCalledWith(
      mockVolume,
      'Test Manga - Volume 1.zip',
      'zip'
    );
  });

  it('should use cbz extension when asCbz is true', async () => {
    const result = await zipManga([mockVolume], true, false, true);
    expect(result).toBe(false);
    expect(document.createElement).toHaveBeenCalledWith('a');
    // Get the actual mock element that was created and used
    const mockCalls = vi.mocked(document.createElement).mock.results;
    const link = mockCalls[mockCalls.length - 1].value;
    expect(link.download).toBe('Test Manga.cbz');
  });

  it('should include series title in filename when includeSeriesTitle is true', async () => {
    const { backupQueue } = await import('./backup-queue');
    const result = await zipManga([mockVolume], false, true, true);
    expect(result).toBe(false);
    // Individual volumes use the queue
    expect(backupQueue.queueVolumeForExport).toHaveBeenCalledWith(
      mockVolume,
      'Test Manga - Volume 1.zip',
      'zip'
    );
  });

  it('should exclude series title from filename when includeSeriesTitle is false', async () => {
    const { backupQueue } = await import('./backup-queue');
    const result = await zipManga([mockVolume], false, true, false);
    expect(result).toBe(false);
    // Individual volumes use the queue
    expect(backupQueue.queueVolumeForExport).toHaveBeenCalledWith(
      mockVolume,
      'Volume 1.zip',
      'zip'
    );
  });

  it('should handle multiple volumes correctly when individualVolumes is true', async () => {
    const { backupQueue } = await import('./backup-queue');

    // Create a second mock volume
    const mockVolume2 = {
      ...mockVolume,
      volume_uuid: 'test-uuid-2',
      volume_title: 'Volume 2',
      page_count: 1,
      page_char_counts: [] as number[]
    };

    const result = await zipManga([mockVolume, mockVolume2], false, true, true);
    expect(result).toBe(false);

    // Should have queued 2 volumes
    expect(backupQueue.queueVolumeForExport).toHaveBeenCalledTimes(2);
    expect(backupQueue.queueVolumeForExport).toHaveBeenCalledWith(
      mockVolume,
      'Test Manga - Volume 1.zip',
      'zip'
    );
    expect(backupQueue.queueVolumeForExport).toHaveBeenCalledWith(
      mockVolume2,
      'Test Manga - Volume 2.zip',
      'zip'
    );
  });

  it('should use direct download for single archive vs queue for individual', async () => {
    const { backupQueue } = await import('./backup-queue');

    // Single archive (individualVolumes = false) uses direct download
    const singleArchiveResult = await zipManga([mockVolume], false, false, true);
    expect(singleArchiveResult).toBe(false);
    expect(document.createElement).toHaveBeenCalledWith('a');

    vi.clearAllMocks();

    // Individual volumes uses queue
    const individualResult = await zipManga([mockVolume], false, true, true);
    expect(individualResult).toBe(false);
    expect(backupQueue.queueVolumeForExport).toHaveBeenCalledWith(
      mockVolume,
      'Test Manga - Volume 1.zip',
      'zip'
    );
  });
});

describe('export data integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    compressVolumeCalls.length = 0;
  });

  it('should not include mokuro metadata for image-only volumes', async () => {
    const imageOnlyVolume = {
      volume_uuid: 'image-only-uuid',
      series_uuid: 'series-uuid',
      series_title: 'Image Only Manga',
      volume_title: 'Volume 1',
      mokuro_version: '', // Empty string indicates image-only
      character_count: 0,
      page_count: 2,
      page_char_counts: [] as number[]
    };

    const mockOcrData = {
      volume_uuid: 'image-only-uuid',
      pages: [
        { img_path: 'page1.jpg', img_width: 100, img_height: 100, blocks: [] },
        { img_path: 'page2.jpg', img_width: 100, img_height: 100, blocks: [] }
      ]
    };

    const mockFilesData = {
      volume_uuid: 'image-only-uuid',
      files: {
        'page1.jpg': new Blob(['image1'], { type: 'image/jpeg' }),
        'page2.jpg': new Blob(['image2'], { type: 'image/jpeg' })
      }
    };

    // @ts-expect-error - Mock type mismatch
    db.volume_ocr.get.mockResolvedValue(mockOcrData);
    // @ts-expect-error - Mock type mismatch
    db.volume_files.get.mockResolvedValue(mockFilesData);

    await createArchiveBlob([imageOnlyVolume]);

    // Verify compressVolume was called with null metadata
    expect(compressVolumeCalls.length).toBe(1);
    expect(compressVolumeCalls[0].metadata).toBeNull();
    // Should still have the image files
    expect(compressVolumeCalls[0].filesData).toHaveLength(2);
  });

  it('should exclude placeholder pages from export', async () => {
    const volumeWithMissingPages = {
      volume_uuid: 'missing-pages-uuid',
      series_uuid: 'series-uuid',
      series_title: 'Manga With Missing',
      volume_title: 'Volume 1',
      mokuro_version: '1.0',
      character_count: 100,
      page_count: 3,
      page_char_counts: [50, 100, 150] as number[],
      missing_pages: 1,
      missing_page_paths: ['page2.jpg'] // page2 is a placeholder
    };

    const mockOcrData = {
      volume_uuid: 'missing-pages-uuid',
      pages: [
        { img_path: 'page1.jpg', img_width: 100, img_height: 100, blocks: [] },
        { img_path: 'page2.jpg', img_width: 100, img_height: 100, blocks: [] }, // placeholder
        { img_path: 'page3.jpg', img_width: 100, img_height: 100, blocks: [] }
      ]
    };

    const mockFilesData = {
      volume_uuid: 'missing-pages-uuid',
      files: {
        'page1.jpg': new Blob(['real-image1'], { type: 'image/jpeg' }),
        'page2.jpg': new Blob(['placeholder'], { type: 'image/jpeg' }), // placeholder - should be excluded
        'page3.jpg': new Blob(['real-image3'], { type: 'image/jpeg' })
      }
    };

    // @ts-expect-error - Mock type mismatch
    db.volume_ocr.get.mockResolvedValue(mockOcrData);
    // @ts-expect-error - Mock type mismatch
    db.volume_files.get.mockResolvedValue(mockFilesData);

    await createArchiveBlob([volumeWithMissingPages]);

    // Verify compressVolume was called with mokuro metadata (not image-only)
    expect(compressVolumeCalls.length).toBe(1);
    expect(compressVolumeCalls[0].metadata).not.toBeNull();

    // Should only have 2 files (page1 and page3), not the placeholder page2
    const filesData = compressVolumeCalls[0].filesData as { filename: string }[];
    expect(filesData).toHaveLength(2);

    const filenames = filesData.map((f) => f.filename);
    expect(filenames).toContain('page1.jpg');
    expect(filenames).toContain('page3.jpg');
    expect(filenames).not.toContain('page2.jpg'); // placeholder excluded
  });

  it('should include mokuro metadata for normal volumes', async () => {
    const normalVolume = {
      volume_uuid: 'normal-uuid',
      series_uuid: 'series-uuid',
      series_title: 'Normal Manga',
      volume_title: 'Volume 1',
      mokuro_version: '1.0', // Has mokuro data
      character_count: 100,
      page_count: 2,
      page_char_counts: [50, 100] as number[]
    };

    const mockOcrData = {
      volume_uuid: 'normal-uuid',
      pages: [
        { img_path: 'page1.jpg', img_width: 100, img_height: 100, blocks: [{ lines: ['text'] }] },
        { img_path: 'page2.jpg', img_width: 100, img_height: 100, blocks: [{ lines: ['more'] }] }
      ]
    };

    const mockFilesData = {
      volume_uuid: 'normal-uuid',
      files: {
        'page1.jpg': new Blob(['image1'], { type: 'image/jpeg' }),
        'page2.jpg': new Blob(['image2'], { type: 'image/jpeg' })
      }
    };

    // @ts-expect-error - Mock type mismatch
    db.volume_ocr.get.mockResolvedValue(mockOcrData);
    // @ts-expect-error - Mock type mismatch
    db.volume_files.get.mockResolvedValue(mockFilesData);

    await createArchiveBlob([normalVolume]);

    // Verify compressVolume was called with metadata
    expect(compressVolumeCalls.length).toBe(1);
    expect(compressVolumeCalls[0].metadata).not.toBeNull();

    const metadata = compressVolumeCalls[0].metadata as { version: string; pages: unknown[] };
    expect(metadata.version).toBe('1.0');
    expect(metadata.pages).toHaveLength(2);

    // Should have all files
    expect(compressVolumeCalls[0].filesData).toHaveLength(2);
  });
});
