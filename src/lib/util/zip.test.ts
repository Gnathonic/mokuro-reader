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

// Mock the DOM APIs
global.URL.createObjectURL = vi.fn(() => 'blob:test');
global.URL.revokeObjectURL = vi.fn();

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
    character_count: 100
  };

  const mockVolumeData = {
    pages: [{ width: 100, height: 100 }],
    files: {
      'page1.jpg': new Blob(['test'], { type: 'image/jpeg' })
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-ignore
    db.volumes_data.get.mockResolvedValue(mockVolumeData);
  });

  it('should create a single archive when individualVolumes is false', async () => {
    const result = await zipManga([mockVolume], false, false, true);
    expect(result).toBe(false);
    expect(document.createElement).toHaveBeenCalledWith('a');
    const link = document.createElement('a');
    expect(link.download).toBe('Test Manga.zip');
  });

  it('should create individual archives when individualVolumes is true', async () => {
    const result = await zipManga([mockVolume], false, true, true);
    expect(result).toBe(false);
    expect(document.createElement).toHaveBeenCalledWith('a');
    const link = document.createElement('a');
    expect(link.download).toBe('Test Manga - Volume 1.zip');
  });

  it('should use cbz extension when asCbz is true', async () => {
    const result = await zipManga([mockVolume], true, false, true);
    expect(result).toBe(false);
    expect(document.createElement).toHaveBeenCalledWith('a');
    const link = document.createElement('a');
    expect(link.download).toBe('Test Manga.cbz');
  });

  it('should include series title in filename when includeSeriesTitle is true', async () => {
    const result = await zipManga([mockVolume], false, true, true);
    expect(result).toBe(false);
    expect(document.createElement).toHaveBeenCalledWith('a');
    const link = document.createElement('a');
    expect(link.download).toBe('Test Manga - Volume 1.zip');
  });

  it('should exclude series title from filename when includeSeriesTitle is false', async () => {
    const result = await zipManga([mockVolume], false, true, false);
    expect(result).toBe(false);
    expect(document.createElement).toHaveBeenCalledWith('a');
    const link = document.createElement('a');
    expect(link.download).toBe('Volume 1.zip');
  });

  it('should handle multiple volumes correctly when individualVolumes is true', async () => {
    // Create a second mock volume
    const mockVolume2 = {
      ...mockVolume,
      volume_uuid: 'test-uuid-2',
      volume_title: 'Volume 2'
    };

    // Mock the document.createElement to track calls
    const originalCreateElement = document.createElement;
    const mockCreateElement = vi.fn().mockImplementation((tag) => {
      if (tag === 'a') {
        return {
          href: '',
          download: '',
          click: vi.fn()
        };
      }
      return {};
    });
    document.createElement = mockCreateElement;

    // Mock the database get for the second volume
    // @ts-ignore
    db.volumes_data.get.mockImplementation((uuid) => {
      if (uuid === 'test-uuid') {
        return Promise.resolve(mockVolumeData);
      } else if (uuid === 'test-uuid-2') {
        return Promise.resolve(mockVolumeData);
      }
      return Promise.resolve(null);
    });

    const result = await zipManga([mockVolume, mockVolume2], false, true, true);
    expect(result).toBe(false);

    // Should have created 2 download links
    expect(mockCreateElement).toHaveBeenCalledTimes(2);

    // Restore the original function
    document.createElement = originalCreateElement;
  });

  it('should use the same internal structure for both single and multiple archives', async () => {
    // This test verifies that we're using the same function to add files to the archive
    // regardless of whether we're creating a single archive or multiple archives
    const singleArchiveResult = await zipManga([mockVolume], false, false, true);
    const multipleArchiveResult = await zipManga([mockVolume], false, true, true);

    expect(singleArchiveResult).toBe(false);
    expect(multipleArchiveResult).toBe(false);

    // Both should call the database get method the same number of times
    expect(db.volumes_data.get).toHaveBeenCalledTimes(2);
    expect(db.volumes_data.get).toHaveBeenCalledWith(mockVolume.volume_uuid);
  });
});
