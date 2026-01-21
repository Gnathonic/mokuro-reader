/**
 * Tests for Local Import Provider
 *
 * The local provider wraps local file imports (drag-drop, file picker)
 * to integrate with the unified import queue system.
 */

import { describe, it, expect } from 'vitest';
import {
  createLocalQueueItem,
  requiresWorkerDecompression,
  localImportProvider
} from '../local-provider';
import type { PairedSource, DirectorySource, ArchiveSource } from '../types';

/**
 * Helper to create a mock directory pairing
 */
function createDirectoryPairing(overrides: Partial<PairedSource> = {}): PairedSource {
  const source: DirectorySource = {
    type: 'directory',
    files: new Map([
      ['page001.jpg', new File([], 'page001.jpg')],
      ['page002.jpg', new File([], 'page002.jpg')]
    ])
  };

  return {
    id: crypto.randomUUID(),
    mokuroFile: new File(['{}'], 'test.mokuro'),
    source,
    basePath: 'test-manga',
    estimatedSize: 5000,
    imageOnly: false,
    ...overrides
  };
}

/**
 * Helper to create a mock archive pairing
 */
function createArchivePairing(overrides: Partial<PairedSource> = {}): PairedSource {
  const source: ArchiveSource = {
    type: 'archive',
    file: new File([], 'test.cbz')
  };

  return {
    id: crypto.randomUUID(),
    mokuroFile: null, // Archive may have internal mokuro
    source,
    basePath: 'test-manga',
    estimatedSize: 50000,
    imageOnly: false,
    ...overrides
  };
}

describe('localImportProvider', () => {
  describe('provider properties', () => {
    it('has correct type identifier', () => {
      expect(localImportProvider.type).toBe('local-import');
    });

    it('has human-readable name', () => {
      expect(localImportProvider.name).toBe('Local Import');
    });

    it('does not support worker downloads (main thread decompression)', () => {
      expect(localImportProvider.supportsWorkerDownload).toBe(false);
    });

    it('has reasonable concurrency limits', () => {
      expect(localImportProvider.uploadConcurrencyLimit).toBe(4);
      expect(localImportProvider.downloadConcurrencyLimit).toBe(4);
    });
  });

  describe('authentication (always ready)', () => {
    it('is always authenticated', () => {
      expect(localImportProvider.isAuthenticated()).toBe(true);
    });

    it('returns ready status', () => {
      const status = localImportProvider.getStatus();
      expect(status.isAuthenticated).toBe(true);
      expect(status.hasStoredCredentials).toBe(true);
      expect(status.needsAttention).toBe(false);
    });
  });

  describe('unsupported operations', () => {
    it('throws on login attempt', async () => {
      await expect(localImportProvider.login()).rejects.toThrow(/does not support/i);
    });

    it('throws on logout attempt', async () => {
      await expect(localImportProvider.logout()).rejects.toThrow(/does not support/i);
    });

    it('throws on listCloudVolumes', async () => {
      await expect(localImportProvider.listCloudVolumes()).rejects.toThrow(/does not support/i);
    });

    it('throws on uploadFile', async () => {
      await expect(localImportProvider.uploadFile('path', new Blob())).rejects.toThrow(
        /does not support/i
      );
    });

    it('throws on downloadFile', async () => {
      await expect(
        localImportProvider.downloadFile({
          provider: 'google-drive',
          fileId: '123',
          path: '',
          modifiedTime: '',
          size: 0
        })
      ).rejects.toThrow(/does not support/i);
    });

    it('throws on deleteFile', async () => {
      await expect(
        localImportProvider.deleteFile({
          provider: 'google-drive',
          fileId: '123',
          path: '',
          modifiedTime: '',
          size: 0
        })
      ).rejects.toThrow(/does not support/i);
    });

    it('throws on getStorageQuota', async () => {
      await expect(localImportProvider.getStorageQuota()).rejects.toThrow(/does not support/i);
    });
  });
});

describe('requiresWorkerDecompression', () => {
  it('returns false for directory sources (already decompressed)', () => {
    const pairing = createDirectoryPairing();
    expect(requiresWorkerDecompression(pairing)).toBe(false);
  });

  it('returns true for archive sources (needs decompression)', () => {
    const pairing = createArchivePairing();
    expect(requiresWorkerDecompression(pairing)).toBe(true);
  });

  it('returns false for toc-directory sources', () => {
    const pairing = createDirectoryPairing({
      source: {
        type: 'toc-directory',
        chapters: new Map([
          ['chapter01', new Map([['page001.jpg', new File([], 'page001.jpg')]])],
          ['chapter02', new Map([['page001.jpg', new File([], 'page001.jpg')]])]
        ])
      }
    });
    expect(requiresWorkerDecompression(pairing)).toBe(false);
  });
});

describe('createLocalQueueItem', () => {
  it('creates queue item from directory pairing', () => {
    const pairing = createDirectoryPairing({ basePath: 'My Manga Vol 1' });
    const item = createLocalQueueItem(pairing);

    expect(item.id).toBe(pairing.id);
    expect(item.source).toBe(pairing);
    expect(item.provider).toBe('local-import');
    expect(item.status).toBe('queued');
    expect(item.progress).toBe(0);
    expect(item.displayTitle).toBe('My Manga Vol 1');
  });

  it('creates queue item from archive pairing', () => {
    const pairing = createArchivePairing({ basePath: 'Archive Volume' });
    const item = createLocalQueueItem(pairing);

    expect(item.provider).toBe('local-import');
    expect(item.status).toBe('queued');
    expect(item.displayTitle).toBe('Archive Volume');
  });

  it('preserves pairing reference', () => {
    const pairing = createDirectoryPairing();
    const item = createLocalQueueItem(pairing);

    expect(item.source).toBe(pairing);
    expect(item.source.mokuroFile).toBe(pairing.mokuroFile);
  });

  it('uses basePath for display title', () => {
    const pairing = createDirectoryPairing({
      basePath: 'author/series/vol1'
    });
    const item = createLocalQueueItem(pairing);

    // Should use last path segment as display title
    expect(item.displayTitle).toBe('vol1');
  });

  it('handles empty basePath', () => {
    const pairing = createDirectoryPairing({ basePath: '' });
    const item = createLocalQueueItem(pairing);

    expect(item.displayTitle).toBe('Untitled');
  });
});
