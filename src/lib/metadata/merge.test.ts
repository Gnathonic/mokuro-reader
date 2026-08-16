import { describe, expect, it } from 'vitest';
import { mergeSeriesMetadata } from './merge';
import { createEmptySeriesMetadata, type SeriesMetadata } from './types';

function rec(title: string, updated_at: string, tag?: string): SeriesMetadata {
  return { ...createEmptySeriesMetadata(title, updated_at), tag };
}

describe('mergeSeriesMetadata', () => {
  it('unions keys from both sides', () => {
    const merged = mergeSeriesMetadata(
      { a: rec('A', '2026-01-01T00:00:00.000Z') },
      { b: rec('B', '2026-01-01T00:00:00.000Z') }
    );
    expect(Object.keys(merged).sort()).toEqual(['a', 'b']);
  });

  it('newest updated_at wins per key', () => {
    const merged = mergeSeriesMetadata(
      { a: rec('A', '2026-01-01T00:00:00.000Z', 'local') },
      { a: rec('A', '2026-02-01T00:00:00.000Z', 'cloud') }
    );
    expect(merged.a.tag).toBe('cloud');
    const merged2 = mergeSeriesMetadata(
      { a: rec('A', '2026-03-01T00:00:00.000Z', 'local') },
      { a: rec('A', '2026-02-01T00:00:00.000Z', 'cloud') }
    );
    expect(merged2.a.tag).toBe('local');
  });

  it('tie keeps local', () => {
    const merged = mergeSeriesMetadata(
      { a: rec('A', '2026-01-01T00:00:00.000Z', 'local') },
      { a: rec('A', '2026-01-01T00:00:00.000Z', 'cloud') }
    );
    expect(merged.a.tag).toBe('local');
  });

  it('skips malformed cloud entries', () => {
    const merged = mergeSeriesMetadata(
      {},
      { a: { nope: true } as unknown as SeriesMetadata, b: rec('B', '2026-01-01T00:00:00.000Z') }
    );
    expect(Object.keys(merged)).toEqual(['b']);
  });

  it('does not mutate inputs', () => {
    const local = { a: rec('A', '2026-01-01T00:00:00.000Z', 'local') };
    const cloud = { a: rec('A', '2026-02-01T00:00:00.000Z', 'cloud') };
    mergeSeriesMetadata(local, cloud);
    expect(local.a.tag).toBe('local');
  });
});
