import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_archive_size_test') };
});

import { db } from '$lib/catalog/db';
import { recordArchiveSize } from './archive-size';

async function addRow(extra: Record<string, unknown> = {}) {
  await db.volumes.add({
    volume_uuid: 'uuid-1',
    series_uuid: 's',
    series_title: 'Dr Stone',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 200,
    character_count: 5000,
    page_char_counts: [],
    ...extra
  } as never);
}

afterEach(async () => {
  await db.volumes.clear();
});

describe('recordArchiveSize', () => {
  it('writes the measured size onto the row', async () => {
    await addRow();
    await recordArchiveSize('uuid-1', 193_000_000);
    expect((await db.volumes.get('uuid-1'))?.archive_size).toBe(193_000_000);
  });

  it('replaces a stale size — this upload or download IS the archive', async () => {
    await addRow({ archive_size: 7 });
    await recordArchiveSize('uuid-1', 193_000_000);
    expect((await db.volumes.get('uuid-1'))?.archive_size).toBe(193_000_000);
  });

  it('ignores a size that is not a positive whole number of bytes', async () => {
    await addRow({ archive_size: 7 });
    for (const size of [0, -1, 1.5, NaN, undefined, null]) {
      await recordArchiveSize('uuid-1', size as number);
    }
    expect((await db.volumes.get('uuid-1'))?.archive_size).toBe(7);
  });

  it('is a no-op for a volume that has no row', async () => {
    await expect(recordArchiveSize('missing', 100)).resolves.toBeUndefined();
  });
});
