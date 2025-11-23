/**
 * Database mocking utilities for Dexie/IndexedDB operations
 */

import { vi } from 'vitest';
import type { VolumeMetadata } from '$lib/types';

// ============================================================================
// Mock Data Storage
// ============================================================================

/**
 * In-memory storage for mock database
 */
export class MockDatabase {
  private volumesStore = new Map<string, VolumeMetadata>();
  private volumesDataStore = new Map<string, any>();

  // Volumes table mock
  volumes = {
    get: vi.fn((uuid: string) => {
      return Promise.resolve(this.volumesStore.get(uuid));
    }),
    add: vi.fn((volume: VolumeMetadata) => {
      this.volumesStore.set(volume.volume_uuid, volume);
      return Promise.resolve(volume.volume_uuid);
    }),
    put: vi.fn((volume: VolumeMetadata) => {
      this.volumesStore.set(volume.volume_uuid, volume);
      return Promise.resolve(volume.volume_uuid);
    }),
    update: vi.fn((uuid: string, changes: Partial<VolumeMetadata>) => {
      const existing = this.volumesStore.get(uuid);
      if (existing) {
        this.volumesStore.set(uuid, { ...existing, ...changes });
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    }),
    delete: vi.fn((uuid: string) => {
      this.volumesStore.delete(uuid);
      return Promise.resolve();
    }),
    toArray: vi.fn(() => {
      return Promise.resolve(Array.from(this.volumesStore.values()));
    }),
    where: vi.fn((field: string) => ({
      equals: vi.fn((value: any) => ({
        first: vi.fn(() => {
          for (const vol of this.volumesStore.values()) {
            if ((vol as any)[field] === value) {
              return Promise.resolve(vol);
            }
          }
          return Promise.resolve(undefined);
        }),
        toArray: vi.fn(() => {
          const results: VolumeMetadata[] = [];
          for (const vol of this.volumesStore.values()) {
            if ((vol as any)[field] === value) {
              results.push(vol);
            }
          }
          return Promise.resolve(results);
        }),
        delete: vi.fn(() => {
          let count = 0;
          for (const [uuid, vol] of this.volumesStore.entries()) {
            if ((vol as any)[field] === value) {
              this.volumesStore.delete(uuid);
              count++;
            }
          }
          return Promise.resolve(count);
        })
      }))
    })),
    count: vi.fn(() => Promise.resolve(this.volumesStore.size)),
    clear: vi.fn(() => {
      this.volumesStore.clear();
      return Promise.resolve();
    })
  };

  // Volumes data table mock
  volumes_data = {
    get: vi.fn((uuid: string) => {
      return Promise.resolve(this.volumesDataStore.get(uuid));
    }),
    add: vi.fn((data: any) => {
      this.volumesDataStore.set(data.volume_uuid, data);
      return Promise.resolve(data.volume_uuid);
    }),
    put: vi.fn((data: any) => {
      this.volumesDataStore.set(data.volume_uuid, data);
      return Promise.resolve(data.volume_uuid);
    }),
    delete: vi.fn((uuid: string) => {
      this.volumesDataStore.delete(uuid);
      return Promise.resolve();
    }),
    toArray: vi.fn(() => {
      return Promise.resolve(Array.from(this.volumesDataStore.values()));
    }),
    count: vi.fn(() => Promise.resolve(this.volumesDataStore.size)),
    clear: vi.fn(() => {
      this.volumesDataStore.clear();
      return Promise.resolve();
    })
  };

  // Testing utilities
  reset() {
    this.volumesStore.clear();
    this.volumesDataStore.clear();
    vi.clearAllMocks();
  }

  seedVolume(volume: VolumeMetadata, data?: any) {
    this.volumesStore.set(volume.volume_uuid, volume);
    if (data) {
      this.volumesDataStore.set(volume.volume_uuid, {
        volume_uuid: volume.volume_uuid,
        ...data
      });
    }
  }

  seedVolumes(volumes: VolumeMetadata[]) {
    volumes.forEach((vol) => this.seedVolume(vol));
  }

  getVolumeCount() {
    return this.volumesStore.size;
  }

  getVolume(uuid: string) {
    return this.volumesStore.get(uuid);
  }

  getAllVolumes() {
    return Array.from(this.volumesStore.values());
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a fresh mock database instance
 */
export function createMockDb() {
  return new MockDatabase();
}

/**
 * Create a pre-seeded mock database
 */
export function createSeededMockDb(volumes: VolumeMetadata[]) {
  const db = new MockDatabase();
  db.seedVolumes(volumes);
  return db;
}

// ============================================================================
// Vitest Mock Helpers
// ============================================================================

/**
 * Create a vi.mock factory for the database module
 *
 * Usage:
 * ```typescript
 * const mockDb = createMockDb();
 *
 * vi.mock('$lib/catalog/db', () => ({
 *   db: mockDb
 * }));
 *
 * // In tests:
 * beforeEach(() => {
 *   mockDb.reset();
 * });
 * ```
 */
export function createDbMockFactory(mockDb: MockDatabase) {
  return {
    db: mockDb
  };
}

// ============================================================================
// Volume Data Helpers
// ============================================================================

/**
 * Create mock volume data (pages and files)
 */
export function createMockVolumeData(pageCount: number = 10) {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    img_width: 1000,
    img_height: 1500,
    blocks: [
      {
        box: [0, 0, 100, 50],
        vertical: false,
        font_size: 16,
        lines: [`Page ${i + 1} text`]
      }
    ]
  }));

  const files: Record<string, Blob> = {};
  for (let i = 0; i < pageCount; i++) {
    files[`page${i + 1}.jpg`] = new Blob(['test'], { type: 'image/jpeg' });
  }

  return {
    pages,
    files
  };
}

/**
 * Create mock Mokuro metadata
 */
export function createMockMokuroData(
  title: string = 'Test Manga',
  volume: string = 'Volume 1',
  pageCount: number = 10
) {
  return {
    version: '0.1.5',
    title,
    title_uuid: `series-${Math.random().toString(36).slice(2, 10)}`,
    volume,
    volume_uuid: `vol-${Math.random().toString(36).slice(2, 10)}`,
    pages: Array.from({ length: pageCount }, (_, i) => ({
      img_width: 1000,
      img_height: 1500,
      blocks: [
        {
          box: [0, 0, 100, 50],
          vertical: false,
          font_size: 16,
          lines: [`Page ${i + 1} text`]
        }
      ]
    })),
    chars: pageCount * 100
  };
}

// ============================================================================
// Transaction Mock
// ============================================================================

/**
 * Mock Dexie transaction
 */
export function createMockTransaction() {
  return {
    on: vi.fn(),
    abort: vi.fn(),
    tables: {}
  };
}

// ============================================================================
// Bulk Operations Mock
// ============================================================================

/**
 * Create a mock for bulk operations
 */
export function createBulkOperationsMock() {
  return {
    bulkAdd: vi.fn((items: any[]) => Promise.resolve(items.map((_, i) => i))),
    bulkPut: vi.fn((items: any[]) => Promise.resolve(items.map((_, i) => i))),
    bulkDelete: vi.fn((keys: any[]) => Promise.resolve())
  };
}
