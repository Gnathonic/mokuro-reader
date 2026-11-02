import { describe, expect, it } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import type { Series } from './catalog';
import { createSeriesIdentityMemo } from './series-identity';

function vol(uuid: string, extra: Partial<VolumeMetadata> = {}): VolumeMetadata {
  return {
    volume_uuid: uuid,
    series_uuid: 's',
    series_title: 'S',
    volume_title: uuid,
    mokuro_version: '0.2.0',
    page_count: 10,
    character_count: 100,
    page_char_counts: [10, 20],
    ...extra
  };
}

function series(title: string, volumes: VolumeMetadata[], displayTitle = title): Series {
  return { title, displayTitle, searchTerms: [title.toLowerCase()], series_uuid: title, volumes };
}

/** A fresh read of the same content: new objects all the way down, like a Dexie `toArray()`. */
function cover(bytes: string, lastModified: number): File {
  return new File([bytes], 'cover.webp', { type: 'image/webp', lastModified });
}

describe('createSeriesIdentityMemo', () => {
  it('hands back the PREVIOUS series object when a fresh read carries the same content', () => {
    const keep = createSeriesIdentityMemo();
    const first = keep([
      series('A', [vol('a1', { thumbnail: cover('xx', 1) })]),
      series('B', [vol('b1')])
    ]);
    const second = keep([
      series('A', [vol('a1', { thumbnail: cover('xx', 1) })]),
      series('B', [vol('b1')])
    ]);
    expect(second[0]).toBe(first[0]);
    expect(second[0].volumes).toBe(first[0].volumes);
    expect(second[1]).toBe(first[1]);
  });

  it('replaces only the series whose content changed', () => {
    const keep = createSeriesIdentityMemo();
    const first = keep([series('A', [vol('a1')]), series('B', [vol('b1')])]);
    const second = keep([series('A', [vol('a1')]), series('B', [vol('b1'), vol('b2')])]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1].volumes.map((v) => v.volume_uuid)).toEqual(['b1', 'b2']);
  });

  it('treats a replaced cover as a change even at the same byte size', () => {
    const keep = createSeriesIdentityMemo();
    const first = keep([series('A', [vol('a1', { thumbnail: cover('xx', 1) })])]);
    const second = keep([series('A', [vol('a1', { thumbnail: cover('yy', 2) })])]);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].volumes[0].thumbnail?.lastModified).toBe(2);
  });

  it('sees a change in any row field, the display title, or a cloud decoration', () => {
    const keep = createSeriesIdentityMemo();
    const base = keep([series('A', [vol('a1')])]);
    expect(keep([series('A', [vol('a1', { metadata_only: true })])])[0]).not.toBe(base[0]);
    const next = keep([series('A', [vol('a1')], 'A (Tag)')]);
    expect(next[0].displayTitle).toBe('A (Tag)');
    const decorated = keep([
      series('A', [{ ...vol('a1'), cloudPath: 'A/a1.cbz' } as VolumeMetadata], 'A (Tag)')
    ]);
    expect(decorated[0]).not.toBe(next[0]);
  });

  it('keeps the order and membership of the list it is given', () => {
    const keep = createSeriesIdentityMemo();
    keep([series('A', [vol('a1')]), series('B', [vol('b1')])]);
    const reordered = keep([series('B', [vol('b1')]), series('C', [vol('c1')])]);
    expect(reordered.map((s) => s.title)).toEqual(['B', 'C']);
  });

  it('forgets series that left the list, so they cannot come back stale', () => {
    const keep = createSeriesIdentityMemo();
    const first = keep([series('A', [vol('a1')])]);
    keep([]);
    expect(keep([series('A', [vol('a1')])])[0]).not.toBe(first[0]);
  });
});
