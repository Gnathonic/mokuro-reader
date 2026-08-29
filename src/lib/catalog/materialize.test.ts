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
  vi.restoreAllMocks(); // the write-shape test spies on db.volumes.put/bulkPut
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

  it('adopts the indexed archive size onto a new row', async () => {
    await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry({ archive_size: 193_000_000 })],
      cloudVolumeTitles: CLOUD
    });
    expect((await db.volumes.get('uuid-1'))?.archive_size).toBe(193_000_000);
  });

  it('fills a missing archive size but never replaces the one the row has', async () => {
    await db.volumes.add({
      volume_uuid: 'uuid-1',
      series_uuid: 's',
      series_title: 'Dr Stone',
      volume_title: 'Volume 1',
      mokuro_version: '0.4.11',
      page_count: 200,
      character_count: 5000,
      page_char_counts: [],
      metadata_only: true
    } as never);

    await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry({ archive_size: 193_000_000 })],
      cloudVolumeTitles: CLOUD
    });
    expect((await db.volumes.get('uuid-1'))?.archive_size).toBe(193_000_000);

    await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry({ archive_size: 7 })],
      cloudVolumeTitles: CLOUD
    });
    expect((await db.volumes.get('uuid-1'))?.archive_size).toBe(193_000_000);
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

  it('never touches an installed row of ANOTHER series holding the same uuid', async () => {
    // uuids are title-independent, so the same uuid can legitimately name a row
    // filed under a differently-punctuated series ('Dr. Stone' vs 'Dr Stone').
    // Writing the index entry over it would wipe a measured, installed volume
    // and orphan its OCR/files rows.
    await db.volumes.add({
      volume_uuid: 'uuid-1',
      series_uuid: 'other-series',
      series_title: 'Dr. Stone',
      volume_title: 'Volume 7',
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
    expect(row).toMatchObject({
      series_title: 'Dr. Stone',
      volume_title: 'Volume 7',
      page_count: 999
    });
    expect(row?.metadata_only).toBeUndefined();
    // And no duplicate was minted for the entry either.
    expect(await db.volumes.count()).toBe(1);
  });

  it('treats a whitespace-variant series title as the same series', async () => {
    // The indexed `equalsIgnoreCase` lookup misses 'Dr  Stone', but the uuid
    // collision guard finds the row and normalizeSeriesKey says it is ours.
    await db.volumes.add({
      volume_uuid: 'uuid-1',
      series_uuid: 's',
      series_title: 'Dr  Stone',
      volume_title: 'Volume 1',
      mokuro_version: 'unknown',
      page_count: 0,
      character_count: 0,
      page_char_counts: [],
      metadata_only: true
    } as never);

    expect(
      await materializeSeriesVolumes({
        seriesTitle: 'Dr Stone',
        entries: [entry()],
        cloudVolumeTitles: CLOUD
      })
    ).toBe(1);

    const row = await db.volumes.get('uuid-1');
    expect(row?.page_count).toBe(200);
    expect(row?.series_title).toBe('Dr  Stone'); // its own spelling is left alone
    expect(await db.volumes.count()).toBe(1);
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

  it('writes a whole series in ONE bulk write, not one put per volume', async () => {
    // Each mutation of `volumes` re-derives the whole catalog downstream, so
    // a series' worth of new rows must cost one write, not one per volume.
    const put = vi.spyOn(db.volumes, 'put');
    const bulkPut = vi.spyOn(db.volumes, 'bulkPut');

    const changed = await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [
        entry({ volume_uuid: 'uuid-1', volume_title: 'Volume 1' }),
        entry({ volume_uuid: 'uuid-2', volume_title: 'Volume 2' }),
        entry({ volume_uuid: 'uuid-3', volume_title: 'Volume 3' })
      ],
      cloudVolumeTitles: new Set(['Volume 1', 'Volume 2', 'Volume 3'])
    });

    expect(changed).toBe(3);
    expect(put).not.toHaveBeenCalled();
    expect(bulkPut).toHaveBeenCalledTimes(1);
    expect(bulkPut.mock.calls[0][0]).toHaveLength(3);

    // ...and the batch stored exactly what the per-row puts stored.
    expect(await db.volumes.count()).toBe(3);
    expect(await db.volumes.get('uuid-2')).toMatchObject({
      series_title: 'Dr Stone',
      volume_title: 'Volume 2',
      page_count: 200,
      character_count: 5000,
      metadata_only: true
    });
  });

  it('applies a later entry filling a row an earlier entry in the SAME batch created', async () => {
    // Two archives sharing one mokuro uuid: the fill used to run as an
    // `update` against a row the previous `put` had already written. Batched,
    // that row is still only queued — the fill has to reach the queued row
    // itself or it would vanish when the bulk write lands.
    const changed = await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [
        entry({
          volume_uuid: 'dupe',
          volume_title: 'Volume 1',
          page_count: 0,
          spine_width: undefined
        }),
        entry({ volume_uuid: 'dupe', volume_title: 'Volume 1', page_count: 200, spine_width: 12 })
      ],
      cloudVolumeTitles: CLOUD
    });

    expect(changed).toBe(2); // one create, one fill
    const row = await db.volumes.get('dupe');
    expect(row?.page_count).toBe(200);
    expect(row?.spine_width).toBe(12);
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

describe('a no-metadata entry never mints or fills an image-only claim', () => {
  const noMetadata = () =>
    entry({
      mokuro_version: '',
      page_count: 0,
      character_count: 0,
      spine_width: undefined
    });

  it("creates the row with mokuro_version 'unknown', not the wire's ''", async () => {
    // `buildNoMetadataEntry`'s shape: a sidecar-less archive, whose mokuro is
    // probably embedded in the .cbz. The durable row must say "don't know",
    // never wear the image-only claim the catalog badge renders.
    const created = await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [noMetadata()],
      cloudVolumeTitles: CLOUD
    });
    expect(created).toBe(1);
    const row = await db.volumes.get('uuid-1');
    expect(row?.metadata_only).toBe(true);
    expect(row?.mokuro_version).toBe('unknown');
  });

  it("never overwrites a row's honest 'unknown' from a no-metadata entry", async () => {
    await db.volumes.add({
      volume_uuid: 'uuid-1',
      series_uuid: 's1',
      series_title: 'Dr Stone',
      volume_title: 'Volume 1',
      mokuro_version: 'unknown',
      page_count: 0,
      character_count: 0,
      page_char_counts: [],
      metadata_only: true
    } as never);

    await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [noMetadata()],
      cloudVolumeTitles: CLOUD
    });
    const row = await db.volumes.get('uuid-1');
    expect(row?.mokuro_version).toBe('unknown');
  });

  it('still fills a genuinely MEASURED image-only claim through the same path', async () => {
    // Positive control for the test above: identical setup, but the entry
    // carries measured pages — proof the fill path is reachable and that
    // `hasMeasuredContent`, not some earlier gate, is what decides.
    await db.volumes.add({
      volume_uuid: 'uuid-1',
      series_uuid: 's1',
      series_title: 'Dr Stone',
      volume_title: 'Volume 1',
      mokuro_version: 'unknown',
      page_count: 0,
      character_count: 0,
      page_char_counts: [],
      metadata_only: true
    } as never);

    await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [entry({ mokuro_version: '', page_count: 200, character_count: 0 })],
      cloudVolumeTitles: CLOUD
    });
    const row = await db.volumes.get('uuid-1');
    expect(row?.mokuro_version).toBe('');
    expect(row?.page_count).toBe(200);
  });
});

describe('a cover sidecar without a mokuro IS a genuine image-only signal', () => {
  it("mints the row with '' when the zero-content entry carries cover stamps", async () => {
    const created = await materializeSeriesVolumes({
      seriesTitle: 'Dr Stone',
      entries: [
        entry({
          mokuro_version: '',
          page_count: 0,
          character_count: 0,
          spine_width: undefined,
          cover_size: 12345,
          cover_modified: 1_700_000_000
        })
      ],
      cloudVolumeTitles: CLOUD
    });
    expect(created).toBe(1);
    const row = await db.volumes.get('uuid-1');
    expect(row?.mokuro_version).toBe('');
  });
});
