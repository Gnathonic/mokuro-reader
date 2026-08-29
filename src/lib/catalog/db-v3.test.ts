import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

const generateThumbnail = vi.fn(async () => ({
  file: new File(['thumb'], 'thumb.webp', { type: 'image/webp' }),
  width: 210,
  height: 297
}));
vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: () => generateThumbnail() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

import { CatalogDexieV3 } from './db-v3';

const DB_NAME = 'mokuro_v3_thumbnails_test';
let db: CatalogDexieV3 | null = null;

afterEach(async () => {
  db?.close();
  db = null;
  await Dexie.delete(DB_NAME);
  vi.clearAllMocks();
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    volume_uuid: 'uuid-1',
    series_uuid: 'series-1',
    series_title: 'One Piece',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 1,
    character_count: 10,
    page_char_counts: [],
    ...overrides
  };
}

describe('processThumbnails', () => {
  it('generates a thumbnail for an installed volume that lacks one', async () => {
    db = new CatalogDexieV3(DB_NAME);
    await db.open();
    await db.volumes.add(row() as never);
    await db.volume_files.add({
      volume_uuid: 'uuid-1',
      files: { 'page001.jpg': new File(['img'], 'page001.jpg') }
    });

    await db.processThumbnails();

    expect(generateThumbnail).toHaveBeenCalledTimes(1);
    expect((await db.volumes.get('uuid-1'))?.thumbnail_width).toBe(210);
  });

  it('never retries a metadata-only row — its images are not on this device', async () => {
    // Without the guard this row qualifies forever: no thumbnail, and no files
    // to build one from, so every pass would pick it up again.
    db = new CatalogDexieV3(DB_NAME);
    await db.open();
    await db.volumes.add(row({ metadata_only: true }) as never);

    await db.processThumbnails();

    expect(generateThumbnail).not.toHaveBeenCalled();
  });
});
