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
import { toSeriesMetadataPatch } from './providers/anilist';
import { createEmptySeriesMetadata } from './types';

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

  it('resolves a functional patch against the record as stored, not a stale copy', async () => {
    await updateSeriesMetadata('One Piece', {
      read_count: 1,
      tracking: { enabled: true, unit: 'volumes' }
    });
    // Stale snapshot from before the write below — exactly what a component
    // holding a lagging liveQuery value would build its patch from.
    const stale = await getSeriesMetadata('one piece');
    await updateSeriesMetadata('One Piece', {
      tracking: {
        ...stale!.tracking!,
        last_pushed: { n: 4, status: 'CURRENT', at: '2026-08-15T10:00:00.000Z' }
      }
    });

    const next = await updateSeriesMetadata('One Piece', (existing) => ({
      tracking: { ...existing.tracking!, enabled: false }
    }));
    // The functional patch saw last_pushed even though the caller never did.
    expect(next.tracking).toEqual({
      enabled: false,
      unit: 'volumes',
      last_pushed: { n: 4, status: 'CURRENT', at: '2026-08-15T10:00:00.000Z' }
    });
  });

  it('two concurrent functional patches both land (no lost update)', async () => {
    await updateSeriesMetadata('One Piece', { read_count: 0 });
    // Fired without awaiting the first: get+put runs inside one rw transaction,
    // so the second sees what the first stored instead of the same start value.
    const [, second] = await Promise.all([
      updateSeriesMetadata('One Piece', (existing) => ({ read_count: existing.read_count + 1 })),
      updateSeriesMetadata('One Piece', (existing) => ({ read_count: existing.read_count + 1 }))
    ]);
    expect(second.read_count).toBe(2);
    expect((await getSeriesMetadata('one piece'))?.read_count).toBe(2);
  });

  it('a functional patch and a whole-object writer do not clobber each other', async () => {
    await updateSeriesMetadata('One Piece', {
      read_count: 0,
      tracking: { enabled: true, unit: 'volumes' }
    });
    await Promise.all([
      // The tracker's last_pushed write…
      updateSeriesMetadata('One Piece', (existing) => ({
        tracking: {
          ...existing.tracking!,
          last_pushed: { n: 3, status: 'CURRENT', at: '2026-08-15T10:00:00.000Z' }
        }
      })),
      // …racing the panel's unit change.
      updateSeriesMetadata('One Piece', (existing) => ({
        tracking: { ...existing.tracking!, unit: 'chapters' as const }
      }))
    ]);
    const stored = await getSeriesMetadata('one piece');
    expect(stored?.tracking).toEqual({
      enabled: true,
      unit: 'chapters',
      last_pushed: { n: 3, status: 'CURRENT', at: '2026-08-15T10:00:00.000Z' }
    });
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

  it('re-linking clears facts the new link does not have', async () => {
    // "Change": link to a series with 110 volumes, then to one AniList has no counts for.
    await updateSeriesMetadata(
      'One Piece',
      toSeriesMetadataPatch({
        provider: 'anilist',
        id: 30013,
        idMal: 13,
        titles: { english: 'One Piece' },
        synonyms: [],
        format: 'MANGA',
        status: 'RELEASING',
        volumes: 110,
        chapters: 1100,
        coverUrl: 'https://img/op.jpg',
        siteUrl: 'https://anilist.co/manga/30013'
      })
    );
    expect((await getSeriesMetadataForTitle('One Piece'))?.total_volumes).toBe(110);

    const meta = await updateSeriesMetadata(
      'One Piece',
      toSeriesMetadataPatch({
        provider: 'anilist',
        id: 99999,
        titles: { romaji: 'Some Oneshot' },
        synonyms: [],
        siteUrl: 'https://anilist.co/manga/99999'
      })
    );
    expect(meta.external_ids).toEqual({ anilist: 99999 });
    expect(meta.total_volumes).toBeUndefined();
    expect(meta.total_chapters).toBeUndefined();
    expect(meta.format).toBeUndefined();
    expect(meta.status).toBeUndefined();
    expect(meta.cover_url).toBeUndefined();
    expect(Object.keys(meta)).not.toContain('total_volumes');
    expect(await getSeriesMetadataForTitle('One Piece')).toEqual(meta);
  });

  it('updateSeriesMetadata supersedes a future-dated existing record', async () => {
    // A bad clock (or hand-edited cloud JSON) must not make local edits unmergeable.
    await replaceAllSeriesMetadata({
      'one piece': {
        ...createEmptySeriesMetadata('One Piece', '2999-01-01T00:00:00.000Z'),
        tag: '[stale]'
      }
    });
    const meta = await updateSeriesMetadata('One Piece', { tag: '[fresh]' });
    expect(meta.tag).toBe('[fresh]');
    expect(meta.updated_at > '2999-01-01T00:00:00.000Z').toBe(true);
    expect(meta.updated_at).toBe('2999-01-01T00:00:00.001Z');
  });

  it('upsertFromEmbedded clears the previous link facts when the embed points elsewhere', async () => {
    await updateSeriesMetadata('One Piece', {
      external_ids: { anilist: 30013, mal: 13 },
      titles: { english: 'One Piece' },
      format: 'MANGA',
      status: 'RELEASING',
      total_volumes: 110,
      total_chapters: 1100,
      cover_url: 'https://img/op.jpg',
      linked_at: '2020-01-01T00:00:00.000Z'
    });

    // Same link, newer embed → the fetched facts survive.
    await upsertFromEmbedded('One Piece', {
      external_ids: { anilist: 30013, mal: 13 },
      titles: { english: 'One Piece' },
      synonyms: [],
      updated_at: '2999-01-01T00:00:00.000Z'
    });
    let meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.total_volumes).toBe(110);
    expect(meta?.linked_at).toBe('2020-01-01T00:00:00.000Z');

    // Different link → the old link's facts are dropped instead of being kept.
    await upsertFromEmbedded('One Piece', {
      external_ids: { anilist: 99999 },
      titles: { romaji: 'Some Oneshot' },
      synonyms: [],
      updated_at: '2999-01-02T00:00:00.000Z'
    });
    meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({ anilist: 99999 });
    expect(meta?.total_volumes).toBeUndefined();
    expect(meta?.total_chapters).toBeUndefined();
    expect(meta?.format).toBeUndefined();
    expect(meta?.status).toBeUndefined();
    expect(meta?.cover_url).toBeUndefined();
    expect(meta?.linked_at).toBe('2999-01-02T00:00:00.000Z');
    expect(Object.keys(meta!)).not.toContain('format');
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

  it('clears title_preference when the patch sets it to undefined', async () => {
    await updateSeriesMetadata('One Piece', { title_preference: 'native' });
    await updateSeriesMetadata('One Piece', { title_preference: undefined });
    expect((await getSeriesMetadataForTitle('One Piece'))?.title_preference).toBeUndefined();
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
