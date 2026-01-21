/**
 * Tests for import routing logic
 *
 * The routing logic decides whether to process items directly (single item)
 * or send them to the queue (multiple items).
 */

import { describe, it, expect } from 'vitest';
import { decideImportRouting } from '../routing';
import type { PairedSource, DirectorySource, ArchiveSource } from '../types';

/**
 * Helper to create a mock PairedSource
 */
function createMockPairing(overrides: Partial<PairedSource> = {}): PairedSource {
  const defaultSource: DirectorySource = {
    type: 'directory',
    files: new Map([['page001.jpg', new File([], 'page001.jpg')]])
  };

  return {
    id: crypto.randomUUID(),
    mokuroFile: new File(['{}'], 'test.mokuro'),
    source: defaultSource,
    basePath: 'test-manga',
    estimatedSize: 1000,
    imageOnly: false,
    ...overrides
  };
}

/**
 * Helper to create a mock archive pairing
 */
function createMockArchivePairing(overrides: Partial<PairedSource> = {}): PairedSource {
  const archiveSource: ArchiveSource = {
    type: 'archive',
    file: new File([], 'test.cbz')
  };

  return {
    id: crypto.randomUUID(),
    mokuroFile: null,
    source: archiveSource,
    basePath: 'test-manga',
    estimatedSize: 5000,
    imageOnly: false,
    ...overrides
  };
}

describe('decideImportRouting', () => {
  describe('single item routing', () => {
    it('processes single directory pairing directly', () => {
      const pairings = [createMockPairing()];
      const decision = decideImportRouting(pairings);

      expect(decision.directProcess).not.toBeNull();
      expect(decision.directProcess?.id).toBe(pairings[0].id);
      expect(decision.queuedItems).toHaveLength(0);
    });

    it('processes single archive pairing directly', () => {
      const pairings = [createMockArchivePairing()];
      const decision = decideImportRouting(pairings);

      expect(decision.directProcess).not.toBeNull();
      expect(decision.directProcess?.source.type).toBe('archive');
      expect(decision.queuedItems).toHaveLength(0);
    });

    it('processes single image-only pairing directly', () => {
      const pairings = [createMockPairing({ imageOnly: true, mokuroFile: null })];
      const decision = decideImportRouting(pairings);

      expect(decision.directProcess).not.toBeNull();
      expect(decision.directProcess?.imageOnly).toBe(true);
      expect(decision.queuedItems).toHaveLength(0);
    });
  });

  describe('multiple item routing', () => {
    it('queues multiple pairings', () => {
      const pairings = [
        createMockPairing({ basePath: 'vol1' }),
        createMockPairing({ basePath: 'vol2' })
      ];
      const decision = decideImportRouting(pairings);

      expect(decision.directProcess).toBeNull();
      expect(decision.queuedItems).toHaveLength(2);
      expect(decision.queuedItems[0].basePath).toBe('vol1');
      expect(decision.queuedItems[1].basePath).toBe('vol2');
    });

    it('queues three or more pairings', () => {
      const pairings = [
        createMockPairing({ basePath: 'vol1' }),
        createMockArchivePairing({ basePath: 'vol2' }),
        createMockPairing({ basePath: 'vol3', imageOnly: true })
      ];
      const decision = decideImportRouting(pairings);

      expect(decision.directProcess).toBeNull();
      expect(decision.queuedItems).toHaveLength(3);
    });

    it('preserves pairing order in queue', () => {
      const pairings = [
        createMockPairing({ basePath: 'alpha' }),
        createMockPairing({ basePath: 'beta' }),
        createMockPairing({ basePath: 'gamma' })
      ];
      const decision = decideImportRouting(pairings);

      expect(decision.queuedItems.map((p) => p.basePath)).toEqual(['alpha', 'beta', 'gamma']);
    });
  });

  describe('edge cases', () => {
    it('handles empty pairings gracefully', () => {
      const decision = decideImportRouting([]);

      expect(decision.directProcess).toBeNull();
      expect(decision.queuedItems).toHaveLength(0);
    });

    it('preserves all pairing properties', () => {
      const original = createMockPairing({
        basePath: 'custom/path',
        estimatedSize: 12345,
        imageOnly: true
      });
      const decision = decideImportRouting([original]);

      expect(decision.directProcess).toEqual(original);
    });
  });

  describe('mixed source types', () => {
    it('queues mixed directory and archive pairings', () => {
      const pairings = [
        createMockPairing({ basePath: 'dir-volume' }),
        createMockArchivePairing({ basePath: 'archive-volume' })
      ];
      const decision = decideImportRouting(pairings);

      expect(decision.directProcess).toBeNull();
      expect(decision.queuedItems).toHaveLength(2);
      expect(decision.queuedItems[0].source.type).toBe('directory');
      expect(decision.queuedItems[1].source.type).toBe('archive');
    });
  });
});
