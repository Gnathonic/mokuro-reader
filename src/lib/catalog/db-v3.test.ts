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
import { MOKURO_DB_SCHEMA } from './db-schema';

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

  // A deep link once stored the server's HTML catalog page as a cover (a `#`
  // in the series name cut the cover URL to the site root): no image to show,
  // yet every field set, so nothing ever replaced it.
  it('regenerates a thumbnail that is not an image', async () => {
    db = new CatalogDexieV3(DB_NAME);
    await db.open();
    await db.volumes.add(
      row({
        thumbnail: new File(['<html></html>'], 'Volume 1.moe', { type: 'text/html' }),
        thumbnail_width: 1,
        thumbnail_height: 1
      }) as never
    );
    await db.volume_files.add({
      volume_uuid: 'uuid-1',
      files: { 'page001.jpg': new File(['img'], 'page001.jpg') }
    });

    await db.processThumbnails();

    expect(generateThumbnail).toHaveBeenCalledTimes(1);
    expect((await db.volumes.get('uuid-1'))?.thumbnail_width).toBe(210);
  });

  it('keeps an image thumbnail, whatever its type is spelled as', async () => {
    db = new CatalogDexieV3(DB_NAME);
    await db.open();
    for (const [i, type] of ['image/webp', 'application/octet-stream', ''].entries()) {
      await db.volumes.add(
        row({
          volume_uuid: `uuid-${i}`,
          thumbnail: new File(['img'], 'cover', { type }),
          thumbnail_width: 210,
          thumbnail_height: 297
        }) as never
      );
    }

    await db.processThumbnails();

    expect(generateThumbnail).not.toHaveBeenCalled();
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

// A tab still running the previous build holds an open connection at the old
// version. IndexedDB parks the new tab's upgrade until that connection closes,
// and nothing but the OLD connection's own `versionchange` handler can close
// it. Dexie installs one in its constructor (close, keep auto-open), which is
// the behaviour pinned here: a handler registered on top that returned false,
// or a connection opened with raw `indexedDB.open`, would leave every upgrade
// hanging behind a forgotten tab.
describe('a schema upgrade while an older connection is still open', () => {
  it('is yielded to by the old connection instead of blocking forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const latest = MOKURO_DB_SCHEMA[MOKURO_DB_SCHEMA.length - 1].version;
    const oldTab = new Dexie(DB_NAME);
    for (const { version, stores } of MOKURO_DB_SCHEMA) {
      if (version < latest) oldTab.version(version).stores(stores);
    }
    await oldTab.open();
    expect(oldTab.verno).toBe(latest - 1);

    db = new CatalogDexieV3(DB_NAME);
    await db.open();

    expect(db.verno).toBe(latest);
    expect(oldTab.isOpen()).toBe(false);
    oldTab.close();
    warn.mockRestore();
  });
});
