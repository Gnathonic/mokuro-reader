import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db: any = new Dexie('library-series-test');
  db.version(1).stores({ volumes: 'volume_uuid, series_uuid, series_title' });
  return { db };
});

import { db } from '$lib/catalog/db';
import { existingVolumeCount, listLibrarySeries } from '../library-series';

const row = (volume_uuid: string, series_title: string, extra: object = {}) => ({
  volume_uuid,
  series_uuid: 's',
  series_title,
  volume_title: volume_uuid,
  thumbnail: new File([new Uint8Array(64)], 't.webp'),
  ...extra
});

describe('library series (#285)', () => {
  beforeEach(async () => {
    await db.volumes.clear();
    await (db.volumes as any).bulkPut([
      row('kb1', 'Killing Bites'),
      row('kb2', 'Killing Bites', { metadata_only: true }),
      row('d1', 'Dorohedoro'),
      row('r1', 'Re： Zero？')
    ]);
  });

  it('lists each series once with its volume count, metadata-only rows included', async () => {
    expect(await listLibrarySeries()).toEqual([
      { title: 'Dorohedoro', count: 1 },
      { title: 'Killing Bites', count: 2 },
      { title: 'Re： Zero？', count: 1 }
    ]);
  });

  it('reads keys only, never a row', async () => {
    const reads = ['toArray', 'each', 'get', 'bulkGet'].map((m) => vi.spyOn(db.volumes, m as any));
    await listLibrarySeries();
    await existingVolumeCount('Killing Bites', []);
    for (const spy of reads) expect(spy).not.toHaveBeenCalled();
  });

  it('counts a series without the volumes of the group being reviewed', async () => {
    expect(await existingVolumeCount('Killing Bites')).toBe(2);
    expect(await existingVolumeCount('Killing Bites', ['kb2'])).toBe(1);
    expect(await existingVolumeCount('Nothing Yet')).toBe(0);
  });

  it('counts the series as it is stored (sanitized)', async () => {
    expect(await existingVolumeCount('Re: Zero?')).toBe(1);
  });
});
