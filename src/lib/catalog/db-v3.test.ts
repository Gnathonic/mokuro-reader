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
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>';
let db: CatalogDexieV3 | null = null;

afterEach(async () => {
  db?.close();
  db = null;
  await Dexie.delete(DB_NAME);
  vi.clearAllMocks();
  vi.restoreAllMocks();
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

  it('keeps a raster thumbnail, re-typing one stored under another type from its bytes', async () => {
    db = new CatalogDexieV3(DB_NAME);
    await db.open();
    const types = ['image/png', 'image/webp', 'application/octet-stream', ''];
    for (const [i, type] of types.entries()) {
      await db.volumes.add(
        row({
          volume_uuid: `uuid-${i}`,
          thumbnail: new File([PNG], 'cover', { type }),
          thumbnail_width: 210,
          thumbnail_height: 297
        }) as never
      );
    }

    await db.processThumbnails();

    expect(generateThumbnail).not.toHaveBeenCalled();
    for (const [i, type] of types.entries()) {
      const stored = (await db.volumes.get(`uuid-${i}`))!.thumbnail!;
      // A raster type is left as it is; any other is replaced by the bytes' own.
      expect(stored.type, type).toBe(type === 'image/webp' ? 'image/webp' : 'image/png');
      expect(stored.size).toBe(PNG.length);
    }
  });

  // SVG is unsupported: a stored `image/svg+xml` cover (a deep link once kept
  // the server's Content-Type) runs as the app when opened in a new tab.
  it('rebuilds an SVG thumbnail of an installed volume from its first page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db = new CatalogDexieV3(DB_NAME);
    await db.open();
    await db.volumes.add(
      row({
        thumbnail: new File([SVG], 'Volume 1.svg', { type: 'image/svg+xml' }),
        thumbnail_width: 250,
        thumbnail_height: 350
      }) as never
    );
    await db.volume_files.add({
      volume_uuid: 'uuid-1',
      files: { 'page001.jpg': new File(['img'], 'page001.jpg') }
    });

    await db.processThumbnails();

    expect(generateThumbnail).toHaveBeenCalledTimes(1);
    const stored = await db.volumes.get('uuid-1');
    expect(stored?.thumbnail?.type).toBe('image/webp');
    expect(stored?.thumbnail_width).toBe(210);
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('not a raster image');
  });

  it('drops an SVG thumbnail of a metadata-only volume, leaving the cover to be fetched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    db = new CatalogDexieV3(DB_NAME);
    await db.open();
    await db.volumes.add(
      row({
        metadata_only: true,
        thumbnail: new File([SVG], 'Volume 1.png', { type: 'image/svg+xml' }),
        thumbnail_width: 250,
        thumbnail_height: 350
      }) as never
    );

    await db.processThumbnails();

    expect(generateThumbnail).not.toHaveBeenCalled();
    const stored = await db.volumes.get('uuid-1');
    expect(stored?.thumbnail).toBeUndefined();
    expect(stored?.thumbnail_width).toBeUndefined();
    expect(stored?.metadata_only).toBe(true);

    // Nothing left to do: a second pass touches nothing.
    await db.processThumbnails();
    expect(generateThumbnail).not.toHaveBeenCalled();
  });

  it('re-types a metadata-only raster thumbnail stored untyped, keeping it', async () => {
    db = new CatalogDexieV3(DB_NAME);
    await db.open();
    await db.volumes.add(
      row({
        metadata_only: true,
        thumbnail: new File([PNG], 'cover'),
        thumbnail_width: 250,
        thumbnail_height: 350
      }) as never
    );

    await db.processThumbnails();

    const stored = await db.volumes.get('uuid-1');
    expect(stored?.thumbnail?.type).toBe('image/png');
    expect(stored?.thumbnail_width).toBe(250);
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
