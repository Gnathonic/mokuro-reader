import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { updateSeriesMetadata } = vi.hoisted(() => ({
  // Typed args so `mock.calls[i][n]` stays type-safe under svelte-check.
  updateSeriesMetadata: vi.fn(async (_seriesTitle: string, _patch: unknown) => undefined)
}));
vi.mock('./store', () => ({ updateSeriesMetadata }));

import {
  SPINE_OFFSET_WRITE_DELAY_MS,
  flushSpineOffsetWrites,
  getSpineOffsets,
  scheduleSpineOffsetWrite,
  volumeOffsetsByIndex
} from './spine-offsets';
import { createEmptySeriesMetadata, type SeriesMetadata } from './types';
import type { VolumeMetadata } from '$lib/types';

/** Resolve the functional patch a scheduled write handed to the store. */
function resolvePatch(callIndex: number, existing: SeriesMetadata) {
  const [, patch] = updateSeriesMetadata.mock.calls[callIndex] as unknown as [
    string,
    (existing: SeriesMetadata) => Partial<SeriesMetadata>
  ];
  expect(typeof patch).toBe('function');
  return patch(existing);
}

function stored(overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return {
    ...createEmptySeriesMetadata('One Piece', '2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

function vol(uuid: string): VolumeMetadata {
  return { volume_uuid: uuid } as VolumeMetadata;
}

describe('getSpineOffsets', () => {
  it('defaults to no offsets when there is no record', () => {
    expect(getSpineOffsets(undefined)).toEqual({ spineOffset: 0, volumeOffsets: {} });
  });

  it('reads the stored values', () => {
    expect(getSpineOffsets(stored({ spine_offset: 3.5, volume_offsets: { a: -4 } }))).toEqual({
      spineOffset: 3.5,
      volumeOffsets: { a: -4 }
    });
  });

  it('ignores non-finite/junk values that slipped past the sanitizer', () => {
    const meta = stored({
      spine_offset: Number.NaN,
      volume_offsets: { a: Number.POSITIVE_INFINITY, b: 'x', c: 0, d: 2 } as unknown as Record<
        string,
        number
      >
    });
    expect(getSpineOffsets(meta)).toEqual({ spineOffset: 0, volumeOffsets: { d: 2 } });
  });
});

describe('volumeOffsetsByIndex', () => {
  it('keys the px offsets by the volume position in the given list', () => {
    const map = volumeOffsetsByIndex([vol('a'), vol('b'), vol('c')], { b: 5, c: -3 });
    expect([...map.entries()]).toEqual([
      [1, 5],
      [2, -3]
    ]);
  });

  it('follows the volume, not the index, when the list is reordered/filtered', () => {
    // e.g. "hide read volumes" drops the first volume from the stack
    const map = volumeOffsetsByIndex([vol('b'), vol('c')], { b: 5, c: -3 });
    expect([...map.entries()]).toEqual([
      [0, 5],
      [1, -3]
    ]);
  });

  it('skips volumes with no offset and zero/non-finite offsets', () => {
    const map = volumeOffsetsByIndex([vol('a'), vol('b'), vol('c')], {
      a: 0,
      b: Number.NaN,
      c: 7
    });
    expect([...map.entries()]).toEqual([[2, 7]]);
  });
});

describe('scheduleSpineOffsetWrite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateSeriesMetadata.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await flushSpineOffsetWrites();
    updateSeriesMetadata.mockClear();
  });

  it('coalesces a burst of wheel ticks into ONE write with the last value', async () => {
    scheduleSpineOffsetWrite('One Piece', { spineOffset: 0.25 });
    vi.advanceTimersByTime(100);
    scheduleSpineOffsetWrite('One Piece', { spineOffset: 0.5 });
    vi.advanceTimersByTime(100);
    scheduleSpineOffsetWrite('One Piece', { spineOffset: 0.75 });
    expect(updateSeriesMetadata).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);

    expect(updateSeriesMetadata).toHaveBeenCalledTimes(1);
    expect(updateSeriesMetadata.mock.calls[0][0]).toBe('One Piece');
    expect(resolvePatch(0, stored())).toEqual({ spine_offset: 0.75 });
  });

  it('debounces per series — two series get their own write', async () => {
    scheduleSpineOffsetWrite('One Piece', { spineOffset: 1 });
    scheduleSpineOffsetWrite('Naruto', { spineOffset: -1 });

    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);

    expect(updateSeriesMetadata).toHaveBeenCalledTimes(2);
    expect(updateSeriesMetadata.mock.calls.map((c) => c[0]).sort()).toEqual([
      'Naruto',
      'One Piece'
    ]);
  });

  it('writes a functional patch that touches only the offset fields', async () => {
    scheduleSpineOffsetWrite('One Piece', { spineOffset: 2, volumeOffsets: { 'uuid-b': 3 } });
    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);

    const existing = stored({
      tag: '[color]',
      read_count: 4,
      external_ids: { anilist: 30013 },
      volume_offsets: { 'uuid-a': -2 }
    });
    const patch = resolvePatch(0, existing);
    // Other fields are absent from the patch, so the store's merge keeps them.
    expect(Object.keys(patch).sort()).toEqual(['spine_offset', 'volume_offsets']);
    // Volume offsets merge into whatever the record holds at write time.
    expect(patch).toEqual({ spine_offset: 2, volume_offsets: { 'uuid-a': -2, 'uuid-b': 3 } });
  });

  it('merges volume offsets from several ticks over different volumes', async () => {
    scheduleSpineOffsetWrite('One Piece', { volumeOffsets: { 'uuid-a': 1 } });
    scheduleSpineOffsetWrite('One Piece', { volumeOffsets: { 'uuid-b': 2 } });
    scheduleSpineOffsetWrite('One Piece', { volumeOffsets: { 'uuid-a': 2 } });
    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);

    expect(updateSeriesMetadata).toHaveBeenCalledTimes(1);
    expect(resolvePatch(0, stored())).toEqual({
      volume_offsets: { 'uuid-a': 2, 'uuid-b': 2 }
    });
  });

  it('a zero value deletes that volume key (reset one volume)', async () => {
    scheduleSpineOffsetWrite('One Piece', { volumeOffsets: { 'uuid-a': 0 } });
    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);

    const patch = resolvePatch(0, stored({ volume_offsets: { 'uuid-a': 5, 'uuid-b': -2 } }));
    expect(patch).toEqual({ volume_offsets: { 'uuid-b': -2 } });
  });

  it('an empty map resets every volume offset (field dropped)', async () => {
    scheduleSpineOffsetWrite('One Piece', { volumeOffsets: {} });
    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);

    const patch = resolvePatch(0, stored({ volume_offsets: { 'uuid-a': 5, 'uuid-b': -2 } }));
    // `undefined` is stripped by the store, so the field disappears from the synced JSON.
    expect(patch).toEqual({ volume_offsets: undefined });
  });

  it('a reset queued before further nudges still clears the untouched volumes', async () => {
    scheduleSpineOffsetWrite('One Piece', { volumeOffsets: {} });
    scheduleSpineOffsetWrite('One Piece', { volumeOffsets: { 'uuid-c': 4 } });
    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);

    const patch = resolvePatch(0, stored({ volume_offsets: { 'uuid-a': 5, 'uuid-b': -2 } }));
    expect(patch).toEqual({ volume_offsets: { 'uuid-c': 4 } });
  });

  it('a zero series offset clears the field instead of storing 0', async () => {
    scheduleSpineOffsetWrite('One Piece', { spineOffset: 0 });
    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);

    expect(resolvePatch(0, stored({ spine_offset: 4 }))).toEqual({ spine_offset: undefined });
  });

  it('a second burst after the first landed writes again', async () => {
    scheduleSpineOffsetWrite('One Piece', { spineOffset: 1 });
    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);
    scheduleSpineOffsetWrite('One Piece', { spineOffset: 2 });
    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);

    expect(updateSeriesMetadata).toHaveBeenCalledTimes(2);
    expect(resolvePatch(1, stored())).toEqual({ spine_offset: 2 });
  });

  it('the returned promise resolves once the write has landed', async () => {
    let landed = false;
    updateSeriesMetadata.mockImplementationOnce(async () => {
      landed = true;
      return undefined;
    });

    const done = scheduleSpineOffsetWrite('One Piece', { spineOffset: 1 });
    let resolved = false;
    void done.then(() => (resolved = true));

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);
    expect(landed).toBe(true);
    expect(resolved).toBe(true);
  });

  it('a rejected write still resolves the caller (fire-and-forget handlers)', async () => {
    const err = vi.spyOn(console, 'warn').mockImplementation(() => {});
    updateSeriesMetadata.mockImplementationOnce(async () => {
      throw new Error('db gone');
    });

    const done = scheduleSpineOffsetWrite('One Piece', { spineOffset: 1 });
    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS);
    await expect(done).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('flushSpineOffsetWrites writes immediately without waiting for the timer', async () => {
    scheduleSpineOffsetWrite('One Piece', { spineOffset: 1 });
    scheduleSpineOffsetWrite('Naruto', { spineOffset: 2 });

    await flushSpineOffsetWrites();

    expect(updateSeriesMetadata).toHaveBeenCalledTimes(2);

    // Nothing left pending: advancing past the debounce writes nothing more.
    await vi.advanceTimersByTimeAsync(SPINE_OFFSET_WRITE_DELAY_MS * 2);
    expect(updateSeriesMetadata).toHaveBeenCalledTimes(2);
  });

  it('flushSpineOffsetWrites is a no-op when nothing is pending', async () => {
    await expect(flushSpineOffsetWrites()).resolves.toBeUndefined();
    expect(updateSeriesMetadata).not.toHaveBeenCalled();
  });
});
