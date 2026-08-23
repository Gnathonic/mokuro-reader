import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { SeriesFileVolume } from '$lib/metadata/series-file';

vi.mock('$lib/catalog/thumbnails', () => ({ generateThumbnail: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_materialize_test') };
});

import { db } from '$lib/catalog/db';
import { materializeSeriesVolumes } from './materialize';

afterEach(async () => {
  await db.volumes.clear();
  await db.volume_ocr.clear();
  await db.volume_files.clear();
});

function entry(overrides: Partial<SeriesFileVolume> = {}): SeriesFileVolume {
  return {
    volume_uuid: 'uuid-1',
    volume_title: 'Volume 1',
    page_count: 200,
    character_count: 5000,
    mokuro_version: '0.4.11',
    spine_width: 12,
    ...overrides
  };
}

const CLOUD = new Set(['Volume 1', 'Volume 2']);

describe('materializeSeriesVolumes', () => {
  it('creates a metadata-only row carrying the real uuid and counts', async () => {
    const created = await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry()],
      cloudVolumeTitles: CLOUD
    });
    expect(created).toBe(1);

    const row = await db.volumes.get('uuid-1');
    expect(row).toMatchObject({
      volume_uuid: 'uuid-1',
      series_title: 'Dr Stone',
      volume_title: 'Volume 1',
      page_count: 200,
      character_count: 5000,
      mokuro_version: '0.4.11',
      spine_width: 12,
      metadata_only: true,
      page_char_counts: []
    });
    expect(row?.isPlaceholder).toBeUndefined();
  });

  it('reuses the series_uuid of a row already in the series', async () => {
    await db.volumes.add({
      volume_uuid: 'installed',
      series_uuid: 'series-real',
      series_title: 'Dr Stone',
      volume_title: 'Volume 2',
      mokuro_version: '0.4.11',
      page_count: 1,
      character_count: 1,
      page_char_counts: []
    } as never);

    await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry()],
      cloudVolumeTitles: CLOUD
    });
    expect((await db.volumes.get('uuid-1'))?.series_uuid).toBe('series-real');
  });

  it('never overwrites an installed row with the same uuid', async () => {
    await db.volumes.add({
      volume_uuid: 'uuid-1',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'Volume 1',
      mokuro_version: '0.4.11',
      page_count: 999,
      character_count: 999,
      page_char_counts: [1, 2, 3]
    } as never);

    expect(
      await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone',
        entries: [entry()],
        cloudVolumeTitles: CLOUD
      })
    ).toBe(0);
    const row = await db.volumes.get('uuid-1');
    expect(row?.page_count).toBe(999);
    expect(row?.metadata_only).toBeUndefined();
  });

  it('never creates a second row for a volume title a local row already owns', async () => {
    await db.volumes.add({
      volume_uuid: 'other-uuid',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'volume 1',
      mokuro_version: '',
      page_count: 10,
      character_count: 10,
      page_char_counts: [],
      metadata_only: true
    } as never);

    expect(
      await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone',
        entries: [entry()],
        cloudVolumeTitles: CLOUD
      })
    ).toBe(0);
    expect(await db.volumes.get('uuid-1')).toBeUndefined();
  });

  it('fills only the gaps of an existing metadata-only row — local wins', async () => {
    await db.volumes.add({
      volume_uuid: 'uuid-1',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'Volume 1',
      mokuro_version: 'unknown',
      page_count: 0,
      character_count: 4242,
      page_char_counts: [],
      metadata_only: true
    } as never);

    await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry()],
      cloudVolumeTitles: CLOUD
    });
    const row = await db.volumes.get('uuid-1');
    expect(row?.page_count).toBe(200); // was 0 = unknown, filled
    expect(row?.character_count).toBe(4242); // local value kept, never downgraded
    expect(row?.mokuro_version).toBe('0.4.11'); // 'unknown' is the placeholder default
    expect(row?.spine_width).toBe(12);
  });

  it('keeps an image-only mokuro_version of "" instead of overwriting it', async () => {
    await db.volumes.add({
      volume_uuid: 'uuid-1',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'Volume 1',
      mokuro_version: '',
      page_count: 200,
      character_count: 5000,
      page_char_counts: [],
      metadata_only: true
    } as never);

    await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry()],
      cloudVolumeTitles: CLOUD
    });
    expect((await db.volumes.get('uuid-1'))?.mokuro_version).toBe('');
  });

  it('skips entries whose archive the cloud listing does not show', async () => {
    expect(
      await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone',
        entries: [entry({ volume_uuid: 'ghost', volume_title: 'Volume 99' })],
        cloudVolumeTitles: CLOUD
      })
    ).toBe(0);
    expect(await db.volumes.get('ghost')).toBeUndefined();
  });

  it('does nothing at all when the listing is empty (unfetched, not empty cloud)', async () => {
    expect(
      await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone',
        entries: [entry()],
        cloudVolumeTitles: new Set()
      })
    ).toBe(0);
  });
});
