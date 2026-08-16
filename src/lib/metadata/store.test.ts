import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('series-metadata-store-test');
  db.version(1).stores({ series_metadata: 'series_key' });
  return { db };
});

import { db } from '$lib/catalog/db';
import {
  getSeriesMetadata,
  getSeriesMetadataForTitle,
  updateSeriesMetadata,
  unlinkSeries,
  upsertFromEmbedded,
  moveSeriesMetadataKey,
  getAllSeriesMetadata,
  replaceAllSeriesMetadata
} from './store';

describe('series metadata store', () => {
  beforeEach(async () => {
    await (db as any).table('series_metadata').clear();
  });

  it('updateSeriesMetadata upserts by normalized title and stamps updated_at', async () => {
    const before = Date.now();
    const meta = await updateSeriesMetadata('  One Piece ', { tag: '[color]' });
    expect(meta.series_key).toBe('one piece');
    expect(meta.series_title).toBe('  One Piece ');
    expect(meta.tag).toBe('[color]');
    expect(Date.parse(meta.updated_at)).toBeGreaterThanOrEqual(before);

    const again = await updateSeriesMetadata('one PIECE', { external_ids: { anilist: 30013 } });
    expect(again.tag).toBe('[color]'); // merged, not replaced
    expect(again.external_ids).toEqual({ anilist: 30013 });
    expect(await getSeriesMetadataForTitle('One Piece')).toEqual(again);
    expect(await getSeriesMetadata('one piece')).toEqual(again);
  });

  it('unlinkSeries clears link facts but keeps tag/preferences/read_count/tracking', async () => {
    await updateSeriesMetadata('One Piece', {
      external_ids: { anilist: 30013, mal: 13 },
      titles: { english: 'One Piece' },
      synonyms: ['ワンピース'],
      format: 'MANGA',
      status: 'RELEASING',
      total_volumes: 100,
      cover_url: 'https://x/y.jpg',
      linked_at: '2026-01-01T00:00:00.000Z',
      tag: '[bw]',
      title_preference: 'native',
      read_count: 2,
      tracking: { enabled: true, unit: 'volumes' }
    });
    const meta = await unlinkSeries('One Piece');
    expect(meta.external_ids).toEqual({});
    expect(meta.titles).toEqual({});
    expect(meta.synonyms).toEqual([]);
    expect(meta.format).toBeUndefined();
    expect(meta.total_volumes).toBeUndefined();
    expect(meta.cover_url).toBeUndefined();
    expect(meta.linked_at).toBeUndefined();
    expect(meta.tag).toBe('[bw]');
    expect(meta.title_preference).toBe('native');
    expect(meta.read_count).toBe(2);
    expect(meta.tracking).toEqual({ enabled: true, unit: 'volumes' });
    expect(Object.keys(meta)).not.toContain('format'); // undefined keys stripped, not stored
  });

  it('upsertFromEmbedded writes when local is missing or older, ignores when local is newer', async () => {
    await upsertFromEmbedded('One Piece', {
      external_ids: { anilist: 30013 },
      titles: { romaji: 'ONE PIECE' },
      synonyms: [],
      tag: '[color]',
      updated_at: '2026-02-01T00:00:00.000Z'
    });
    let meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({ anilist: 30013 });
    expect(meta?.tag).toBe('[color]');
    expect(meta?.updated_at).toBe('2026-02-01T00:00:00.000Z');
    expect(meta?.linked_at).toBe('2026-02-01T00:00:00.000Z');

    // older embed → ignored
    await upsertFromEmbedded('One Piece', {
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-01-01T00:00:00.000Z'
    });
    meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({ anilist: 30013 });

    // newer embed without ids → unlink propagates
    await upsertFromEmbedded('One Piece', {
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-03-01T00:00:00.000Z'
    });
    meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({});
    expect(meta?.tag).toBeUndefined();
  });

  it('moveSeriesMetadataKey moves the record; newer record wins on collision', async () => {
    await updateSeriesMetadata('Old Name', { tag: '[old]' });
    await moveSeriesMetadataKey('Old Name', 'New Name');
    expect(await getSeriesMetadataForTitle('Old Name')).toBeUndefined();
    const moved = await getSeriesMetadataForTitle('New Name');
    expect(moved?.series_key).toBe('new name');
    expect(moved?.series_title).toBe('New Name');
    expect(moved?.tag).toBe('[old]');

    // collision: existing 'Third' is NEWER than 'New Name' → keep 'Third'
    await replaceAllSeriesMetadata({
      third: {
        ...moved!,
        series_key: 'third',
        series_title: 'Third',
        tag: '[third]',
        updated_at: '2999-01-01T00:00:00.000Z'
      }
    });
    await moveSeriesMetadataKey('New Name', 'Third');
    expect(await getSeriesMetadataForTitle('New Name')).toBeUndefined();
    expect((await getSeriesMetadataForTitle('Third'))?.tag).toBe('[third]');
  });

  it('moveSeriesMetadataKey keeps the record when only case/whitespace changed', async () => {
    await updateSeriesMetadata('one piece', { tag: '[x]' });
    await moveSeriesMetadataKey('one piece', 'One  Piece');
    const meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.tag).toBe('[x]');
    expect(meta?.series_title).toBe('One  Piece');
  });

  it('getAll/replaceAll round-trip a record map', async () => {
    await updateSeriesMetadata('A', { tag: '1' });
    await updateSeriesMetadata('B', { tag: '2' });
    const all = await getAllSeriesMetadata();
    expect(Object.keys(all).sort()).toEqual(['a', 'b']);
    await replaceAllSeriesMetadata({ ...all, b: { ...all.b, tag: '22' } });
    expect((await getSeriesMetadataForTitle('B'))?.tag).toBe('22');
  });
});
