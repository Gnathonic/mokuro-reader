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
  upsertFromSeriesFile,
  moveSeriesMetadataKey,
  getAllSeriesMetadata,
  replaceAllSeriesMetadata
} from './store';
import { toSeriesMetadataPatch } from './providers/anilist';
import { FACTLESS_UPDATED_AT, type SeriesFile } from './series-file';
import { createEmptySeriesMetadata } from './types';

/** A minimal series.json carrying only the facts the store reads. */
function seriesFile(facts: Omit<SeriesFile, 'version' | 'series_title' | 'volumes'>): SeriesFile {
  return { version: 2, series_title: 'One Piece', volumes: [], ...facts };
}

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

  it('ignores a write with a blank series title instead of creating a junk "" record', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const meta = await updateSeriesMetadata('', { tag: '[bw]' });
      expect(meta.series_key).toBe('');
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      // No row was actually written for the blank key.
      expect(await getSeriesMetadata('')).toBeUndefined();
      expect(await (db as any).table('series_metadata').count()).toBe(0);

      // Whitespace-only titles normalize to the same blank key and are ignored too.
      await updateSeriesMetadata('   ', { tag: '[bw]' });
      expect(await (db as any).table('series_metadata').count()).toBe(0);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('resolves a functional patch against the record as stored, not a stale copy', async () => {
    await updateSeriesMetadata('One Piece', {
      read_count: 1,
      tracking: { number_overrides: { a: 2 } }
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
      tracking: { ...existing.tracking!, number_overrides: { a: 5 } }
    }));
    // The functional patch saw last_pushed even though the caller never did.
    expect(next.tracking).toEqual({
      number_overrides: { a: 5 },
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
      tracking: { number_overrides: { a: 2 } }
    });
    await Promise.all([
      // The tracker's last_pushed write…
      updateSeriesMetadata('One Piece', (existing) => ({
        tracking: {
          ...existing.tracking!,
          last_pushed: { n: 3, status: 'CURRENT', at: '2026-08-15T10:00:00.000Z' }
        }
      })),
      // …racing the panel's number-override edit.
      updateSeriesMetadata('One Piece', (existing) => ({
        tracking: { ...existing.tracking!, number_overrides: { a: 9 } }
      }))
    ]);
    const stored = await getSeriesMetadata('one piece');
    expect(stored?.tracking).toEqual({
      number_overrides: { a: 9 },
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
      unit: 'chapters',
      tracking: { number_overrides: { a: 2 } }
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
    // The unit describes the archives in the folder, not the link that was removed.
    expect(meta.unit).toBe('chapters');
    expect(meta.tracking).toEqual({ number_overrides: { a: 2 } });
    expect(Object.keys(meta)).not.toContain('format'); // undefined keys stripped, not stored
  });

  it('moves facts_updated_at only when a shareable fact actually changes', async () => {
    const linked = await updateSeriesMetadata('One Piece', {
      external_ids: { anilist: 30013 },
      titles: { english: 'One Piece' }
    });
    expect(linked.facts_updated_at).toBe(linked.updated_at);

    // A catalog spine nudge / reread / tracking push is per-user state: it bumps
    // the record, but publishing that stamp with the facts would unlink the series
    // on every other device.
    const nudged = await updateSeriesMetadata('One Piece', { spine_offset: 12, read_count: 1 });
    expect(nudged.updated_at > linked.updated_at).toBe(true);
    expect(nudged.facts_updated_at).toBe(linked.facts_updated_at);

    // Re-writing the same facts is not a change either.
    const rewritten = await updateSeriesMetadata('One Piece', {
      external_ids: { anilist: 30013 },
      titles: { english: 'One Piece' }
    });
    expect(rewritten.facts_updated_at).toBe(linked.facts_updated_at);

    const tagged = await updateSeriesMetadata('One Piece', { tag: '[color]' });
    expect(tagged.facts_updated_at).toBe(tagged.updated_at);

    // The tracking unit is a shared fact too: correcting it must schedule a
    // series.json write, and re-writing the same value must not.
    const united = await updateSeriesMetadata('One Piece', { unit: 'chapters' });
    expect(united.facts_updated_at).toBe(united.updated_at);
    const again = await updateSeriesMetadata('One Piece', { unit: 'chapters' });
    expect(again.facts_updated_at).toBe(united.facts_updated_at);

    const unlinked = await unlinkSeries('One Piece');
    expect(unlinked.facts_updated_at).toBe(unlinked.updated_at);
    expect(unlinked.spine_offset).toBe(12); // per-user state survives an unlink
  });

  it('leaves facts_updated_at unset on a record that has never carried facts', async () => {
    // A catalog spine nudge creates the record; it says nothing about the series,
    // so it must not claim a facts clock — that would outrank a real sidecar.
    const nudged = await updateSeriesMetadata('One Piece', { spine_offset: 12 });
    expect(nudged.facts_updated_at).toBeUndefined();
    expect(Object.keys(nudged)).not.toContain('facts_updated_at');
    expect(await getSeriesMetadataForTitle('One Piece')).toEqual(nudged);

    const reread = await updateSeriesMetadata('One Piece', { read_count: 1 });
    expect(reread.facts_updated_at).toBeUndefined();

    // An unlink IS a deliberate fact edit, even though it leaves the facts empty.
    await updateSeriesMetadata('One Piece', { external_ids: { anilist: 30013 } });
    const unlinked = await unlinkSeries('One Piece');
    expect(unlinked.facts_updated_at).toBe(unlinked.updated_at);
    expect(unlinked.external_ids).toEqual({});
  });

  it('a stamp-less factless record adopts even an older sidecar', async () => {
    await updateSeriesMetadata('One Piece', { spine_offset: 12 });
    const before = await getSeriesMetadataForTitle('One Piece');
    expect(before?.facts_updated_at).toBeUndefined();

    // Older than the record's own clock, but the record has no facts opinion at all.
    await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: { anilist: 30013 },
        titles: { english: 'One Piece' },
        synonyms: [],
        updated_at: '2020-01-01T00:00:00.000Z'
      })
    );
    const meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({ anilist: 30013 });
    expect(meta?.facts_updated_at).toBe('2020-01-01T00:00:00.000Z');
    expect(meta?.spine_offset).toBe(12);
    expect(meta?.updated_at).toBe(before?.updated_at); // record clock never moves backwards
  });

  it('upsertFromSeriesFile ignores a factless sidecar for a series it has no record for', async () => {
    // A device that never linked the series publishes an index-only file. It
    // says nothing about the facts, so it must not conjure an empty record —
    // and, through the root metadata merge, unlink the series everywhere.
    const applied = await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: '2026-08-17T00:00:00.000Z'
      })
    );

    expect(applied).toBe(false);
    expect(await getSeriesMetadataForTitle('One Piece')).toBeUndefined();
    expect(await (db as any).table('series_metadata').count()).toBe(0);
  });

  it('an index-only sidecar from an unlinked device never unlinks a linked series', async () => {
    // Device B (never linked One Piece) backs it up: `buildSeriesFile` stamps
    // its factless file with the epoch sentinel. Device A imports/refreshes it
    // and must keep its link.
    await updateSeriesMetadata('One Piece', { external_ids: { anilist: 30013 } });
    const linked = await getSeriesMetadataForTitle('One Piece');

    const applied = await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: FACTLESS_UPDATED_AT
      })
    );

    expect(applied).toBe(false);
    expect((await getSeriesMetadataForTitle('One Piece'))?.external_ids).toEqual({
      anilist: 30013
    });
    expect((await getSeriesMetadataForTitle('One Piece'))?.facts_updated_at).toBe(
      linked?.facts_updated_at
    );
  });

  it('upsertFromSeriesFile compares against facts_updated_at, not the record stamp', async () => {
    // Linked on 2026-02-01, then a per-user write bumped the record to 2026-09-01.
    await replaceAllSeriesMetadata({
      'one piece': {
        ...createEmptySeriesMetadata('One Piece', '2026-09-01T00:00:00.000Z'),
        external_ids: { anilist: 30013 },
        facts_updated_at: '2026-02-01T00:00:00.000Z',
        spine_offset: 12
      }
    });

    // Older than the facts stamp → ignored.
    await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: { anilist: 111 },
        titles: {},
        synonyms: [],
        updated_at: '2026-01-01T00:00:00.000Z'
      })
    );
    expect((await getSeriesMetadataForTitle('One Piece'))?.external_ids).toEqual({
      anilist: 30013
    });

    // Newer than the facts stamp (but older than the record stamp) → applied.
    await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: { anilist: 99999 },
        titles: { romaji: 'Some Oneshot' },
        synonyms: [],
        updated_at: '2026-03-01T00:00:00.000Z'
      })
    );
    const meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({ anilist: 99999 });
    expect(meta?.facts_updated_at).toBe('2026-03-01T00:00:00.000Z');
    // The record stamp never moves backwards, or the root series-metadata.json
    // merge would hand the win back to a pre-link copy on another device.
    expect(meta?.updated_at).toBe('2026-09-01T00:00:00.000Z');
    expect(meta?.spine_offset).toBe(12);
  });

  it('upsertFromSeriesFile writes when local is missing or older, ignores when local is newer', async () => {
    await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: { anilist: 30013 },
        titles: { romaji: 'ONE PIECE' },
        synonyms: [],
        tag: '[color]',
        updated_at: '2026-02-01T00:00:00.000Z'
      })
    );
    let meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({ anilist: 30013 });
    expect(meta?.tag).toBe('[color]');
    expect(meta?.updated_at).toBe('2026-02-01T00:00:00.000Z');
    expect(meta?.linked_at).toBe('2026-02-01T00:00:00.000Z');

    // older file → ignored
    await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: '2026-01-01T00:00:00.000Z'
      })
    );
    meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({ anilist: 30013 });

    // newer file without ids → a REAL unlink, which still propagates
    const applied = await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: '2026-03-01T00:00:00.000Z'
      })
    );
    expect(applied).toBe(true);
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

  it('upsertFromSeriesFile clears the previous link facts when the file points elsewhere', async () => {
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

    // Same link, newer file → the fetched facts survive.
    await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: { anilist: 30013, mal: 13 },
        titles: { english: 'One Piece' },
        synonyms: [],
        updated_at: '2999-01-01T00:00:00.000Z'
      })
    );
    let meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.total_volumes).toBe(110);
    expect(meta?.linked_at).toBe('2020-01-01T00:00:00.000Z');

    // Different link → the old link's facts are dropped instead of being kept.
    await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: { anilist: 99999 },
        titles: { romaji: 'Some Oneshot' },
        synonyms: [],
        updated_at: '2999-01-02T00:00:00.000Z'
      })
    );
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

  it('fills missing spine offsets from a sidecar without touching the facts stamp', async () => {
    await updateSeriesMetadata('One Piece', { external_ids: { anilist: 13 } });
    const before = (await getSeriesMetadataForTitle('One Piece'))!;

    const applied = await upsertFromSeriesFile('One Piece', {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT,
      spine_offset: 9,
      volumes: [
        {
          volume_uuid: 'vol-1',
          volume_title: 'Vol 1',
          page_count: 1,
          character_count: 1,
          mokuro_version: '0.4.11',
          offset: -20
        }
      ]
    });

    expect(applied).toBe(true);
    const after = (await getSeriesMetadataForTitle('One Piece'))!;
    expect(after.spine_offset).toBe(9);
    expect(after.volume_offsets).toEqual({ 'vol-1': -20 });
    // Index data, not facts: the link and its stamp are untouched.
    expect(after.external_ids).toEqual({ anilist: 13 });
    expect(after.facts_updated_at).toBe(before.facts_updated_at);
  });

  it('never overrides an offset this library already has', async () => {
    await updateSeriesMetadata('One Piece', {
      spine_offset: 3,
      volume_offsets: { 'vol-1': 7 }
    });

    await upsertFromSeriesFile('One Piece', {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT,
      spine_offset: 9,
      volumes: [
        {
          volume_uuid: 'vol-1',
          volume_title: 'Vol 1',
          page_count: 1,
          character_count: 1,
          mokuro_version: '0.4.11',
          offset: -20
        },
        {
          volume_uuid: 'vol-2',
          volume_title: 'Vol 2',
          page_count: 1,
          character_count: 1,
          mokuro_version: '0.4.11',
          offset: 4
        }
      ]
    });

    const after = (await getSeriesMetadataForTitle('One Piece'))!;
    expect(after.spine_offset).toBe(3);
    expect(after.volume_offsets).toEqual({ 'vol-1': 7, 'vol-2': 4 });
  });

  it('creates a record from an offsets-only sidecar without giving it a facts clock', async () => {
    const applied = await upsertFromSeriesFile('Berserk', {
      version: 2,
      series_title: 'Berserk',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT,
      spine_offset: 6,
      volumes: []
    });

    expect(applied).toBe(true);
    const record = (await getSeriesMetadataForTitle('Berserk'))!;
    expect(record.spine_offset).toBe(6);
    expect(record.facts_updated_at).toBeUndefined();
  });

  it('converges: re-reading an offsets-only sidecar applies nothing and mints no facts clock', async () => {
    const file: SeriesFile = {
      version: 2,
      series_title: 'Berserk',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT,
      spine_offset: 6,
      volumes: []
    };

    expect(await upsertFromSeriesFile('Berserk', file)).toBe(true);
    // Callers schedule a series.json write on `true`; a second read must not
    // schedule another, or every cloud refresh would trigger an upload.
    expect(await upsertFromSeriesFile('Berserk', file)).toBe(false);

    const record = (await getSeriesMetadataForTitle('Berserk'))!;
    expect(record.spine_offset).toBe(6);
    // The file's epoch stamp is NOT a facts clock this library earned.
    expect(record.facts_updated_at).toBeUndefined();
    expect(Object.keys(record)).not.toContain('facts_updated_at');
  });
});

describe('the tracking unit as a shared fact', () => {
  beforeEach(async () => {
    await (db as any).table('series_metadata').clear();
  });

  it('applies a sidecar unit and clears it again when a newer sidecar drops it', async () => {
    await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: { anilist: 30013 },
        titles: {},
        synonyms: [],
        unit: 'chapters',
        updated_at: '2026-08-16T00:00:00.000Z'
      })
    );
    expect((await getSeriesMetadataForTitle('One Piece'))?.unit).toBe('chapters');

    await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: { anilist: 30013 },
        titles: {},
        synonyms: [],
        updated_at: '2026-08-17T00:00:00.000Z'
      })
    );
    const cleared = await getSeriesMetadataForTitle('One Piece');
    expect(cleared?.unit).toBeUndefined();
    expect(Object.keys(cleared!)).not.toContain('unit');
  });

  it('ignores an older sidecar unit', async () => {
    await updateSeriesMetadata('One Piece', {
      external_ids: { anilist: 30013 },
      unit: 'chapters'
    });
    await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: { anilist: 30013 },
        titles: {},
        synonyms: [],
        unit: 'volumes',
        updated_at: '2020-01-01T00:00:00.000Z'
      })
    );
    expect((await getSeriesMetadataForTitle('One Piece'))?.unit).toBe('chapters');
  });
});
