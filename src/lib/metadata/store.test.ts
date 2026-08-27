import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db = new Dexie('series-metadata-store-test');
  db.version(1).stores({ series_metadata: 'series_key, folded_key' });
  return { db };
});

import { db } from '$lib/catalog/db';
import {
  getSeriesMetadata,
  getSeriesMetadataByFoldedTitle,
  getSeriesMetadataByFoldedTitles,
  getSeriesMetadataForTitle,
  updateSeriesMetadata,
  unlinkSeries,
  upsertFromSeriesFile,
  upsertManyFromSeriesFiles,
  moveSeriesMetadataKey,
  getAllSeriesMetadata,
  replaceAllSeriesMetadata,
  registerIndexChangeListener,
  registerFactsChangeListener
} from './store';
import { updateSeriesReadingState } from '$lib/settings/series-data';
import { toSeriesMetadataPatch } from './providers/anilist';
import { FACTLESS_UPDATED_AT, type SeriesFile } from './series-file';
import { createEmptySeriesMetadata } from './types';
import { countIdbOps } from '$lib/catalog/__tests__/idb-op-counter';

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
      spine_offset: 1,
      volume_offsets: { a: 2 }
    });
    // Stale snapshot from before the write below — exactly what a component
    // holding a lagging liveQuery value would build its patch from.
    const stale = await getSeriesMetadata('one piece');
    await updateSeriesMetadata('One Piece', {
      volume_offsets: { ...stale!.volume_offsets!, b: 4 }
    });

    const next = await updateSeriesMetadata('One Piece', (existing) => ({
      volume_offsets: { ...existing.volume_offsets!, a: 5 }
    }));
    // The functional patch saw the `b` nudge even though the caller never did.
    expect(next.volume_offsets).toEqual({ a: 5, b: 4 });
  });

  it('two concurrent functional patches both land (no lost update)', async () => {
    await updateSeriesMetadata('One Piece', { spine_offset: 0 });
    // Fired without awaiting the first: get+put runs inside one rw transaction,
    // so the second sees what the first stored instead of the same start value.
    const [, second] = await Promise.all([
      updateSeriesMetadata('One Piece', (existing) => ({
        spine_offset: (existing.spine_offset ?? 0) + 1
      })),
      updateSeriesMetadata('One Piece', (existing) => ({
        spine_offset: (existing.spine_offset ?? 0) + 1
      }))
    ]);
    expect(second.spine_offset).toBe(2);
    expect((await getSeriesMetadata('one piece'))?.spine_offset).toBe(2);
  });

  it('a functional patch and a whole-object writer do not clobber each other', async () => {
    await updateSeriesMetadata('One Piece', {
      volume_offsets: { a: 2 }
    });
    await Promise.all([
      // One card's nudge…
      updateSeriesMetadata('One Piece', (existing) => ({
        volume_offsets: { ...existing.volume_offsets!, b: 3 }
      })),
      // …racing another card's.
      updateSeriesMetadata('One Piece', (existing) => ({
        volume_offsets: { ...existing.volume_offsets!, a: 9 }
      }))
    ]);
    const stored = await getSeriesMetadata('one piece');
    expect(stored?.volume_offsets).toEqual({ a: 9, b: 3 });
  });

  it('unlinkSeries clears the link facts but keeps everything this library owns', async () => {
    await updateSeriesMetadata('One Piece', {
      external_ids: { anilist: 30013, mal: 13 },
      titles: { english: 'One Piece' },
      synonyms: ['ワンピース'],
      linked_at: '2026-01-01T00:00:00.000Z',
      tag: '[bw]',
      unit: 'chapters',
      spine_offset: 12
    });
    const meta = await unlinkSeries('One Piece');
    expect(meta.external_ids).toEqual({});
    expect(meta.titles).toEqual({});
    expect(meta.synonyms).toEqual([]);
    expect(meta.linked_at).toBeUndefined();
    expect(Object.keys(meta)).not.toContain('linked_at'); // undefined keys stripped, not stored
    expect(meta.tag).toBe('[bw]');
    expect(meta.spine_offset).toBe(12);
    // The unit describes the archives in the folder, not the link that was removed.
    expect(meta.unit).toBe('chapters');
  });

  it('moves facts_updated_at only when a shareable fact actually changes', async () => {
    const linked = await updateSeriesMetadata('One Piece', {
      external_ids: { anilist: 30013 },
      titles: { english: 'One Piece' }
    });
    expect(linked.facts_updated_at).toBe(linked.updated_at);

    // A catalog spine nudge is per-user state: it bumps the record, but
    // publishing that stamp with the facts would unlink the series on every
    // other device.
    const nudged = await updateSeriesMetadata('One Piece', { spine_offset: 12 });
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

    const perVolume = await updateSeriesMetadata('One Piece', { volume_offsets: { 'vol-1': 4 } });
    expect(perVolume.facts_updated_at).toBeUndefined();

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
    // The record stamp never moves backwards, or `moveSeriesMetadataKey` would
    // hand a rename collision back to a pre-link copy of the record.
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

  it('re-linking replaces the previous link’s facts instead of merging into them', async () => {
    // "Change": link to One Piece, then to a one-shot with no MAL id and no
    // synonyms — nothing of the first link may survive.
    await updateSeriesMetadata(
      'One Piece',
      toSeriesMetadataPatch({
        provider: 'anilist',
        id: 30013,
        idMal: 13,
        titles: { english: 'One Piece', native: 'ONE PIECE' },
        synonyms: ['ワンピース'],
        volumes: 110,
        chapters: 1100,
        coverUrl: 'https://img/op.jpg',
        siteUrl: 'https://anilist.co/manga/30013'
      })
    );
    expect((await getSeriesMetadataForTitle('One Piece'))?.external_ids).toEqual({
      anilist: 30013,
      mal: 13
    });

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
    expect(meta.titles).toEqual({ romaji: 'Some Oneshot' });
    expect(meta.synonyms).toEqual([]);
    // AniList's display data was never stored, so a re-link has none to strand.
    expect(Object.keys(meta)).not.toContain('total_volumes');
    expect(Object.keys(meta)).not.toContain('cover_url');
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

  it('upsertFromSeriesFile replaces the previous link when the file points elsewhere', async () => {
    await updateSeriesMetadata('One Piece', {
      external_ids: { anilist: 30013, mal: 13 },
      titles: { english: 'One Piece' },
      synonyms: ['ワンピース'],
      linked_at: '2020-01-01T00:00:00.000Z'
    });

    // Same link, newer file → the link is the same one, so linked_at stands.
    await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: { anilist: 30013, mal: 13 },
        titles: { english: 'One Piece' },
        synonyms: ['ワンピース'],
        updated_at: '2999-01-01T00:00:00.000Z'
      })
    );
    let meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.external_ids).toEqual({ anilist: 30013, mal: 13 });
    expect(meta?.linked_at).toBe('2020-01-01T00:00:00.000Z');

    // Different link → the file's facts are written whole, and the link is new,
    // so it is dated from the file. (There is no display data to strand any
    // more: the totals and the cover were never stored in the first place.)
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
    expect(meta?.titles).toEqual({ romaji: 'Some Oneshot' });
    expect(meta?.synonyms).toEqual([]);
    expect(meta?.linked_at).toBe('2999-01-02T00:00:00.000Z');
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

  it('clears a field when the patch sets it to undefined', async () => {
    await updateSeriesMetadata('One Piece', { tag: '[color]' });
    await updateSeriesMetadata('One Piece', { tag: undefined });
    const meta = await getSeriesMetadataForTitle('One Piece');
    expect(meta?.tag).toBeUndefined();
    expect(Object.keys(meta!)).not.toContain('tag'); // stripped, not stored as undefined
  });

  it('getAll/replaceAll round-trip a record map', async () => {
    await updateSeriesMetadata('A', { tag: '1' });
    await updateSeriesMetadata('B', { tag: '2' });
    const all = await getAllSeriesMetadata();
    expect(Object.keys(all).sort()).toEqual(['a', 'b']);
    await replaceAllSeriesMetadata({ ...all, b: { ...all.b, tag: '22' } });
    expect((await getSeriesMetadataForTitle('B'))?.tag).toBe('22');
  });

  it('never adopts a published offset into this library’s own record', async () => {
    // Inheritance is a JOIN at display time (`getSpineOffsets` against the
    // cached `series_index` file), never an adoption. Copying the published
    // value in here would turn it into OUR value: we would republish it
    // forever, and the device that measured it could never correct or reset it.
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

    // Nothing to apply: no facts, no clock to relay, and offsets are not ours.
    expect(applied).toBe(false);
    const after = (await getSeriesMetadataForTitle('One Piece'))!;
    expect(after.spine_offset).toBeUndefined();
    expect(after.volume_offsets).toBeUndefined();
    // The link and its stamp are untouched.
    expect(after.external_ids).toEqual({ anilist: 13 });
    expect(after.facts_updated_at).toBe(before.facts_updated_at);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it('leaves a local offset edit alone — it is ours, and it publishes', async () => {
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
    // `vol-2` is NOT pulled in: the record holds only what this user edited.
    expect(after.volume_offsets).toEqual({ 'vol-1': 7 });
  });

  it('creates no record at all from an offsets-only sidecar', async () => {
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

    // There is nothing this library owns in such a file — the alignment reaches
    // the shelf from the cached index instead.
    expect(applied).toBe(false);
    expect(await getSeriesMetadataForTitle('Berserk')).toBeUndefined();
  });

  it('advances an EXISTING factless clock so a relayed unlink keeps propagating', async () => {
    // Device B unlinked at T1, so its record is factless but DOES carry a clock.
    await replaceAllSeriesMetadata({
      'one piece': {
        ...createEmptySeriesMetadata('One Piece', '2026-09-01T00:00:00.000Z'),
        facts_updated_at: '2026-01-01T00:00:00.000Z'
      }
    });

    // Device A unlinks at T2 and publishes a factless file. B has no facts to
    // apply, but it must still adopt the newer clock: otherwise B republishes T1
    // and a device C that linked at T1.5 compares `T1.5 < T1` → false, so the
    // unlink is stranded and never reaches C.
    const applied = await upsertFromSeriesFile(
      'One Piece',
      seriesFile({
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: '2026-02-01T00:00:00.000Z'
      })
    );

    expect(applied).toBe(true);
    expect((await getSeriesMetadataForTitle('One Piece'))?.facts_updated_at).toBe(
      '2026-02-01T00:00:00.000Z'
    );
  });

  it('mints no clock for a record that has never had an opinion', async () => {
    // A local shelf nudge and nothing else: a record with no facts and no facts
    // clock, whose `updated_at` only ever tracked per-user state.
    await updateSeriesMetadata('Berserk', { spine_offset: 6 });

    // A factless file arrives. There is no local clock to advance, so there is
    // nothing to relay — minting one here would invent an opinion.
    await upsertFromSeriesFile(
      'Berserk',
      seriesFile({
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: '2026-02-01T00:00:00.000Z'
      })
    );

    const record = (await getSeriesMetadataForTitle('Berserk'))!;
    expect(record.facts_updated_at).toBeUndefined();
    expect(Object.keys(record)).not.toContain('facts_updated_at');
  });

  it('converges: an offsets-only sidecar applies nothing, on the first read and every one after', async () => {
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

    // Callers schedule a series.json write on `true`; such a file must never
    // report one, or every cloud refresh would trigger an upload.
    expect(await upsertFromSeriesFile('Berserk', file)).toBe(false);
    expect(await upsertFromSeriesFile('Berserk', file)).toBe(false);

    // Not even a shell record: the alignment is displayed from the cached index.
    expect(await getSeriesMetadataForTitle('Berserk')).toBeUndefined();
  });

  it('notifies index listeners for an offset edit and facts listeners for a fact edit', async () => {
    const indexed: string[] = [];
    const facts: string[] = [];
    const offIndex = registerIndexChangeListener((title) => indexed.push(title));
    const offFacts = registerFactsChangeListener((title) => facts.push(title));

    try {
      await updateSeriesMetadata('One Piece', { spine_offset: 4 });
      await updateSeriesMetadata('One Piece', { volume_offsets: { 'vol-1': 8 } });
      await updateSeriesMetadata('One Piece', { tag: 'color' });
      // A re-write of the same values changes nothing and must stay quiet.
      await updateSeriesMetadata('One Piece', { spine_offset: 4 });

      expect(indexed).toEqual(['One Piece', 'One Piece']);
      expect(facts).toEqual(['One Piece']);

      // Link bookkeeping is neither a fact nor an index key: quiet on both.
      await updateSeriesMetadata('One Piece', { linked_at: '2026-01-01T00:00:00.000Z' });

      expect(indexed).toEqual(['One Piece', 'One Piece']);
      expect(facts).toEqual(['One Piece']);

      // The READING state cannot reach this record at all any more — the type
      // does not admit it, so no patch can ever route a read count or the push
      // bookkeeping through the shared record and fire these listeners.
      // @ts-expect-error read_count left SeriesMetadata for the reading-state store
      await updateSeriesMetadata('One Piece', { read_count: 2 });
      // @ts-expect-error tracking left SeriesMetadata for the reading-state store
      await updateSeriesMetadata('One Piece', { tracking: { number_overrides: { a: 2 } } });
      // @ts-expect-error reread_prompt_suppressed left SeriesMetadata too
      await updateSeriesMetadata('One Piece', { reread_prompt_suppressed: true });

      // …and its own store fires neither listener when it is written properly.
      updateSeriesReadingState('one piece', { read_count: 2 });
      updateSeriesReadingState('one piece', { tracking: { number_overrides: { a: 2 } } });

      expect(indexed).toEqual(['One Piece', 'One Piece']);
      expect(facts).toEqual(['One Piece']);
    } finally {
      offIndex();
      offFacts();
    }
  });

  it('notifies both listeners from a single patch that touches a fact and an index key', async () => {
    const indexed: string[] = [];
    const facts: string[] = [];
    const offIndex = registerIndexChangeListener((title) => indexed.push(title));
    const offFacts = registerFactsChangeListener((title) => facts.push(title));

    try {
      await updateSeriesMetadata('One Piece', { tag: 'color', spine_offset: 9 });

      expect(indexed).toEqual(['One Piece']);
      expect(facts).toEqual(['One Piece']);
    } finally {
      offIndex();
      offFacts();
    }
  });

  it('does not notify index listeners when a sidecar fills the offsets', async () => {
    const indexed: string[] = [];
    const off = registerIndexChangeListener((title) => indexed.push(title));

    try {
      await upsertFromSeriesFile('One Piece', {
        version: 2,
        series_title: 'One Piece',
        external_ids: {},
        titles: {},
        synonyms: [],
        updated_at: FACTLESS_UPDATED_AT,
        spine_offset: 6,
        volumes: []
      });

      expect(indexed).toEqual([]);
    } finally {
      off();
    }
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

/**
 * The batched form. The merge rules themselves are `mergeSeriesFileInto`'s, and
 * every one of them is already covered above through `upsertFromSeriesFile`
 * (which is now a thin read/merge/write around the same function) — so what is
 * left to prove here is the wiring the batch adds on top: that it resolves each
 * entry against the row ALREADY STORED, and that entries in one batch see each
 * other rather than racing as two rows in one write.
 *
 * The commit bound and the per-entry error isolation are asserted end-to-end,
 * against the real catalog refresh, in `catalog-index-sync.facts.test.ts`.
 */
describe('upsertManyFromSeriesFiles', () => {
  beforeEach(async () => {
    await (db as any).table('series_metadata').clear();
  });

  function file(seriesTitle: string, anilist: number, updated_at: string): SeriesFile {
    return {
      version: 2,
      series_title: seriesTitle,
      external_ids: { anilist },
      titles: {},
      synonyms: [],
      updated_at,
      volumes: []
    };
  }

  it('applies each entry against the row already stored, newest facts winning', async () => {
    await upsertFromSeriesFile('One Piece', file('One Piece', 1, '2026-05-01T00:00:00.000Z'));
    await upsertFromSeriesFile('Berserk', file('Berserk', 2, '2026-05-01T00:00:00.000Z'));

    const written = await upsertManyFromSeriesFiles([
      // Older than what is stored: must not apply.
      { seriesTitle: 'One Piece', file: file('One Piece', 99, '2020-01-01T00:00:00.000Z') },
      // Newer: must apply.
      { seriesTitle: 'Berserk', file: file('Berserk', 42, '2026-06-01T00:00:00.000Z') },
      // Unknown to this library: must be created.
      { seriesTitle: 'Vinland Saga', file: file('Vinland Saga', 7, '2026-06-01T00:00:00.000Z') }
    ]);

    expect(written).toBe(2);
    expect((await getSeriesMetadataForTitle('One Piece'))?.external_ids.anilist).toBe(1);
    expect((await getSeriesMetadataForTitle('Berserk'))?.external_ids.anilist).toBe(42);
    expect((await getSeriesMetadataForTitle('Vinland Saga'))?.external_ids.anilist).toBe(7);
  });

  it('merges two entries for the same series onto each other, not against each other', async () => {
    // Same normalized key, in one batch. Resolved in order against the running
    // result — so the older one loses to the newer whichever way round they come.
    const written = await upsertManyFromSeriesFiles([
      { seriesTitle: 'One Piece', file: file('One Piece', 5, '2026-06-01T00:00:00.000Z') },
      { seriesTitle: 'ONE PIECE', file: file('ONE PIECE', 6, '2020-01-01T00:00:00.000Z') }
    ]);

    // One row written, not two racing puts.
    expect(written).toBe(1);
    expect((await getSeriesMetadataForTitle('One Piece'))?.external_ids.anilist).toBe(5);
    expect(await (db as any).table('series_metadata').count()).toBe(1);
  });

  it('writes nothing at all for an empty batch', async () => {
    expect(await upsertManyFromSeriesFiles([])).toBe(0);
    expect(await (db as any).table('series_metadata').count()).toBe(0);
  });
});

/**
 * `folded_key` — the secondary index that turned four whole-table scans into
 * index reads.
 *
 * THE UNIT IS OPERATIONS, NOT BYTES. `countIdbOps` meters both, but these rows
 * are ids, titles, synonyms and stamps — no blobs — so their byte meter reads
 * zero either way and could never tell a scan from a keyed read. The op names
 * can: Dexie lowers a full `toArray()` to `IDBObjectStore.getAll`
 * (`series_metadata.getAll`), `.where(...).equals(...)` to `IDBIndex.getAll`
 * (`series_metadata.idx.getAll`) and `.where(...).anyOf(...)` to an
 * `IDBIndex.openCursor` walk. A regression to `getAllSeriesMetadata()` shows up
 * as exactly one `series_metadata.getAll`, which is what these bound at zero.
 */
describe('folded_key lookups', () => {
  // The same name in the two unicode forms a round trip through a filesystem
  // moves between. Byte-different, so they are two DIFFERENT primary keys —
  // which is the entire reason a second key exists.
  const NFC_TITLE = 'Pok\u00e9mon'; // e-acute as ONE code point
  const NFD_TITLE = 'Poke\u0301mon'; // e + a combining acute

  beforeEach(async () => {
    await (db as any).table('series_metadata').clear();
  });

  it('finds a record written under an NFD title when asked with the NFC one', async () => {
    await updateSeriesMetadata(NFD_TITLE, { external_ids: { anilist: 30013 } });

    // THE FIXTURE REACHES THE CODE UNDER TEST. If the primary key could answer
    // this, the index would be dead weight and every assertion below vacuous.
    expect(await getSeriesMetadataForTitle(NFC_TITLE)).toBeUndefined();

    const counts = await countIdbOps(async () => {
      const found = await getSeriesMetadataByFoldedTitle(NFC_TITLE);
      expect(found.map((r) => r.series_title)).toEqual([NFD_TITLE]);
    });

    expect(counts['series_metadata.getAll'] ?? 0).toBe(0);
    // Anchor: it really went through the index rather than answering from
    // nowhere. Without this, a lookup that returned [] would satisfy the bound.
    expect(counts['series_metadata.idx.getAll'] ?? 0).toBe(1);
  });

  it('answers a many-title lookup through the index, reading only the asked-for folds', async () => {
    for (const title of ['One Piece', 'Naruto', 'Bleach', 'Akira', NFD_TITLE]) {
      await updateSeriesMetadata(title, { tag: '[x]' });
    }

    const counts = await countIdbOps(async () => {
      const found = await getSeriesMetadataByFoldedTitles(['naruto', NFC_TITLE]);
      expect(found.map((r) => r.series_title).sort()).toEqual(['Naruto', NFD_TITLE]);
    });

    expect(counts['series_metadata.getAll'] ?? 0).toBe(0);
    expect(counts['series_metadata.idx.openCursor'] ?? 0).toBeGreaterThanOrEqual(1);
  });

  /**
   * EVERY WRITER, because a row that reaches the table without the derived key
   * is not "slightly wrong" — it is invisible to all four keyed call sites, and
   * silently so. Each case writes under the DECOMPOSED title and then looks the
   * row up by the COMPOSED one, so only the stamped key can find it.
   *
   * The primary-key assertion is not decoration: a writer that quietly wrote
   * nothing would otherwise be indistinguishable from one that wrote a row the
   * index cannot see.
   */
  const writers: Array<[string, () => Promise<void>]> = [
    [
      'updateSeriesMetadata',
      async () => void (await updateSeriesMetadata(NFD_TITLE, { tag: '[a]' }))
    ],
    [
      'unlinkSeries',
      async () => {
        await updateSeriesMetadata(NFD_TITLE, { external_ids: { anilist: 1 } });
        await unlinkSeries(NFD_TITLE);
      }
    ],
    [
      'upsertFromSeriesFile',
      async () => {
        await upsertFromSeriesFile(
          NFD_TITLE,
          seriesFile({
            external_ids: { anilist: 7 },
            titles: {},
            synonyms: [],
            updated_at: '2026-08-20T00:00:00.000Z'
          })
        );
      }
    ],
    [
      'upsertManyFromSeriesFiles',
      async () => {
        await upsertManyFromSeriesFiles([
          {
            seriesTitle: NFD_TITLE,
            file: seriesFile({
              external_ids: { anilist: 8 },
              titles: {},
              synonyms: [],
              updated_at: '2026-08-20T00:00:00.000Z'
            })
          }
        ]);
      }
    ],
    [
      'replaceAllSeriesMetadata',
      async () => {
        const record = createEmptySeriesMetadata(NFD_TITLE, '2026-08-20T00:00:00.000Z');
        await replaceAllSeriesMetadata({ [record.series_key]: record });
      }
    ],
    [
      'moveSeriesMetadataKey',
      async () => {
        await updateSeriesMetadata('Pocket Monsters', { tag: '[a]' });
        await moveSeriesMetadataKey('Pocket Monsters', NFD_TITLE);
      }
    ]
  ];

  it.each(writers)('%s stamps folded_key, so the row is findable by fold', async (_name, write) => {
    await write();

    // The row is really there under its own primary key...
    expect(await getSeriesMetadataForTitle(NFD_TITLE)).toBeDefined();
    // ...and the index can see it.
    const found = await getSeriesMetadataByFoldedTitle(NFC_TITLE);
    expect(found).toHaveLength(1);
    expect(found[0].series_title).toBe(NFD_TITLE);
  });

  it('re-derives folded_key on a rename instead of carrying the old one', async () => {
    await updateSeriesMetadata(NFD_TITLE, { tag: '[a]' });
    await moveSeriesMetadataKey(NFD_TITLE, 'Pocket Monsters');

    expect((await getSeriesMetadataByFoldedTitle('Pocket Monsters'))[0]?.series_title).toBe(
      'Pocket Monsters'
    );
    // The renamed row must not still be indexed under the name it no longer
    // has: a carried-through `folded_key` leaves it answering for both.
    expect(await getSeriesMetadataByFoldedTitle(NFC_TITLE)).toEqual([]);
  });
});
