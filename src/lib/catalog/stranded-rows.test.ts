import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('stranded-rows-test');
  db.version(1).stores({
    volumes: 'volume_uuid, series_uuid, series_title',
    volume_ocr: 'volume_uuid',
    volume_files: 'volume_uuid'
  });
  return { db };
});

import { db } from '$lib/catalog/db';
import { dropStrandedMetadataOnlyRow } from './stranded-rows';

function row(overrides: Record<string, unknown> = {}) {
  return {
    volume_uuid: 'uuid-new',
    series_uuid: 'series-1',
    series_title: 'One Piece',
    volume_title: 'Volume 1',
    mokuro_version: '0.4.11',
    page_count: 200,
    character_count: 5000,
    page_char_counts: [],
    ...overrides
  };
}

describe('dropStrandedMetadataOnlyRow', () => {
  beforeEach(async () => {
    await (db as any).table('volumes').clear();
    await (db as any).table('volume_ocr').clear();
    await (db as any).table('volume_files').clear();
  });

  it('drops the old row when the archive brought a different uuid for the same volume', async () => {
    // The downloaded .mokuro carries its own uuid, so `saveVolume` added a new
    // row. The old one now owns nothing — its path belongs to the new row — and
    // would sit in the catalog forever as an undownloadable duplicate.
    await db.volumes.bulkAdd([
      row() as never,
      row({ volume_uuid: 'uuid-old', metadata_only: true }) as never
    ]);

    await dropStrandedMetadataOnlyRow('uuid-new');

    expect(await db.volumes.get('uuid-old')).toBeUndefined();
    expect(await db.volumes.get('uuid-new')).toBeTruthy();
  });

  it('drops a stranded row filed under a whitespace-variant series title', async () => {
    // materializeSeriesVolumes treats 'Dr  Stone' and 'Dr Stone' as one series
    // (normalizeSeriesKey collapses the run), so it can fill a row under either
    // spelling. The indexed equalsIgnoreCase lookup cannot see across them, and
    // a missed row here is precisely the permanent duplicate this exists to
    // prevent.
    await db.volumes.bulkAdd([
      row({ series_title: 'Dr Stone' }) as never,
      row({
        volume_uuid: 'uuid-old',
        series_title: 'Dr  Stone',
        metadata_only: true
      }) as never
    ]);

    await dropStrandedMetadataOnlyRow('uuid-new');

    expect(await db.volumes.get('uuid-old')).toBeUndefined();
    expect(await db.volumes.get('uuid-new')).toBeTruthy();
  });

  it('leaves a genuinely different series alone', async () => {
    await db.volumes.bulkAdd([
      row({ series_title: 'Dr Stone' }) as never,
      row({ volume_uuid: 'uuid-other', series_title: 'Dr. Stone', metadata_only: true }) as never
    ]);

    await dropStrandedMetadataOnlyRow('uuid-new');

    expect(await db.volumes.get('uuid-other')).toBeTruthy();
  });

  it('matches the volume title case-insensitively', async () => {
    await db.volumes.bulkAdd([
      row() as never,
      row({ volume_uuid: 'uuid-old', volume_title: 'VOLUME 1', metadata_only: true }) as never
    ]);

    await dropStrandedMetadataOnlyRow('uuid-new');

    expect(await db.volumes.get('uuid-old')).toBeUndefined();
  });

  it('matches the series title case-insensitively too', async () => {
    // preserveTitles imports can store a casing that differs from the cloud
    // path the stranded row was created from.
    await db.volumes.bulkAdd([
      row() as never,
      row({ volume_uuid: 'uuid-old', series_title: 'ONE PIECE', metadata_only: true }) as never
    ]);

    await dropStrandedMetadataOnlyRow('uuid-new');

    expect(await db.volumes.get('uuid-old')).toBeUndefined();
  });

  it('never touches another volume of the same series', async () => {
    await db.volumes.bulkAdd([
      row() as never,
      row({ volume_uuid: 'uuid-vol2', volume_title: 'Volume 2', metadata_only: true }) as never
    ]);

    await dropStrandedMetadataOnlyRow('uuid-new');

    expect(await db.volumes.get('uuid-vol2')).toBeTruthy();
  });

  it('never touches an installed row that happens to share the title', async () => {
    await db.volumes.bulkAdd([row() as never, row({ volume_uuid: 'uuid-installed' }) as never]);

    await dropStrandedMetadataOnlyRow('uuid-new');

    expect(await db.volumes.get('uuid-installed')).toBeTruthy();
  });
});
