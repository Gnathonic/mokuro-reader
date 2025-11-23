import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zipManga } from './zip';
import { db } from '$lib/catalog/db';

// Mock the database
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes_data: {
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

// Mock the compression module to avoid real zip operations
vi.mock('./compress-volume', () => ({
  compressVolume: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
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
    page_count: 1
  };

  const mockVolumeData = {
    pages: [{ width: 100, height: 100 }],
    files: {
      'page1.jpg': new Blob(['test'], { type: 'image/jpeg' })
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - Mock type mismatch
    db.volumes_data.get.mockResolvedValue(mockVolumeData);
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
      page_count: 1
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
