import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db: any = new Dexie('library-series-test');
  db.version(1).stores({
    volumes: 'volume_uuid, series_uuid, series_title',
    volume_ocr: 'volume_uuid'
  });
  return { db };
});

import { db } from '$lib/catalog/db';
import {
  existingVolumeCount,
  listLibrarySeries,
  matchLibraryVolumes,
  noteVolumesInFlight,
  settleVolumesInFlight
} from '../library-series';
import { groupCandidates } from '../image-only-review';
import { generateDeterministicUUID } from '$lib/util/series-extraction';

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

describe('volumes approved but not saved yet (final review #3)', () => {
  beforeEach(async () => {
    await db.volumes.clear();
    await (db.volumes as any).bulkPut([row('kb1', 'Killing Bites'), row('kb2', 'Killing Bites')]);
  });
  afterEach(() => settleVolumesInFlight(['n1', 'n2', 'kb1']));

  it('count toward their series until they save or fail', async () => {
    noteVolumesInFlight([
      { uuid: 'n1', series: 'Killing Bites' },
      { uuid: 'n2', series: 'Killing Bites' }
    ]);
    expect(await existingVolumeCount('Killing Bites')).toBe(4);
    expect(await existingVolumeCount('Dorohedoro')).toBe(0);
    settleVolumesInFlight(['n1']);
    expect(await existingVolumeCount('Killing Bites')).toBe(3);
  });

  it('a volume saved while still noted counts once; the group being reviewed never counts', async () => {
    noteVolumesInFlight([
      { uuid: 'kb1', series: 'Killing Bites' },
      { uuid: 'n1', series: 'Killing Bites' }
    ]);
    expect(await existingVolumeCount('Killing Bites')).toBe(3);
    expect(await existingVolumeCount('Killing Bites', ['n1'])).toBe(2);
  });

  it('counts under the stored (sanitized) series title', async () => {
    noteVolumesInFlight([{ uuid: 'n1', series: 'Re: Zero?' }]);
    expect(await existingVolumeCount('Re: Zero?')).toBe(1);
  });
});

describe('matching review candidates to the library (final review #1)', () => {
  const legacyKb = generateDeterministicUUID('Killing Bites/Volume 01');
  const legacyCs = generateDeterministicUUID('Chained Soldier (Semi-Color)/Volume 01');

  beforeEach(async () => {
    await db.volumes.clear();
    await (db as any).volume_ocr.clear();
    await (db.volumes as any).bulkPut([
      row(legacyKb, 'Killing Bites', { metadata_only: true }),
      row(legacyCs, 'Chained Soldier (Semi-Color)')
    ]);
    await (db as any).volume_ocr.put({ volume_uuid: legacyCs, pages: [] });
  });

  it('finds the row a volume already is under any identity it had, keys only', async () => {
    const groups = groupCandidates([
      {
        id: 'k',
        basePath: 'Killing Bites v01',
        titlePath: 'Downloads/Killing Bites v01',
        source: 'k'
      },
      { id: 'c1', basePath: 'Chained Soldier (Semi-Color)/01', source: 'c1' },
      { id: 'c2', basePath: 'Chained Soldier (Semi-Color)/02', source: 'c2' }
    ]);
    const reads = ['toArray', 'each', 'get', 'bulkGet'].flatMap((m) => [
      vi.spyOn(db.volumes, m as any),
      vi.spyOn((db as any).volume_ocr, m as any)
    ]);
    await matchLibraryVolumes(groups);
    for (const spy of reads) expect(spy).not.toHaveBeenCalled();

    const [chained, kb] = groups;
    expect(kb.matches.get('k')).toEqual({ uuid: legacyKb, installed: false });
    expect(kb.ownUuids).toEqual([]);
    expect(chained.matches.get('c1')).toEqual({ uuid: legacyCs, installed: true });
    expect(chained.matches.has('c2')).toBe(false);
    expect(chained.ownUuids).toEqual([
      generateDeterministicUUID('Chained Soldier (Semi-Color)/02')
    ]);
  });

  it('a bare volume name ("01") never matches another series\' row (follow-up #2)', async () => {
    // Pre-branch rows: "A.zip" → inner "01" (legacy key "0/Volume 1"), and "A/01".
    const legacyBare = generateDeterministicUUID('0/Volume 1');
    const legacyA = generateDeterministicUUID('A/Volume 01');
    await (db.volumes as any).bulkPut([
      row(legacyBare, 'A', { metadata_only: true }),
      row(legacyA, 'A', { metadata_only: true }),
      row(generateDeterministicUUID('01'), 'Other', { metadata_only: true })
    ]);
    const groups = groupCandidates([
      { id: 'b', basePath: '01', titlePath: 'Series B/01', source: 'Series B.zip' },
      { id: 'l', basePath: '01', source: '01.cbz' },
      { id: 'd', basePath: 'Downloads/01', source: 'Downloads/01' }
    ]);
    await matchLibraryVolumes(groups);
    for (const group of groups) expect([...group.matches]).toEqual([]);
  });

  it('a series folder of bare numbers still finds its pre-branch rows', async () => {
    const groups = groupCandidates([
      { id: 'c1', basePath: 'Chained Soldier (Semi-Color)/01', source: 'c1' }
    ]);
    await matchLibraryVolumes(groups);
    expect(groups[0].matches.get('c1')?.uuid).toBe(legacyCs);
  });

  it('a new volume matches nothing', async () => {
    const groups = groupCandidates([{ id: 'g', basePath: 'Gleipnir v01', source: 'g' }]);
    await matchLibraryVolumes(groups);
    expect(groups[0].matches.size).toBe(0);
  });
});
