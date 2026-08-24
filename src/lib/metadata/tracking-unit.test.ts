import { describe, expect, it } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import { resolveTrackingUnit } from './tracking-unit';
import { createEmptySeriesMetadata, type SeriesMetadata } from './types';

const vol = (title: string) => ({ volume_title: title }) as VolumeMetadata;

function meta(over: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return { ...createEmptySeriesMetadata('One Piece'), ...over };
}

describe('resolveTrackingUnit', () => {
  it('uses the stored fact when someone has corrected it', () => {
    expect(resolveTrackingUnit(meta({ unit: 'chapters' }), [vol('Vol 01')])).toEqual({
      unit: 'chapters',
      source: 'set'
    });
    expect(resolveTrackingUnit(meta({ unit: 'volumes' }), [vol('Chapter 1')])).toEqual({
      unit: 'volumes',
      source: 'set'
    });
  });

  it('detects from the volume titles when the fact is unset', () => {
    expect(resolveTrackingUnit(meta(), [vol('Chapter 1'), vol('Chapter 2')])).toEqual({
      unit: 'chapters',
      source: 'detected'
    });
    expect(resolveTrackingUnit(meta(), [vol('Vol 01'), vol('Vol 02')])).toEqual({
      unit: 'volumes',
      source: 'detected'
    });
  });

  it('uses the overshoot rule only when the caller supplies totals', () => {
    // Nothing stores the totals any more: only the push path has them (it fetches
    // them with the list entry), so everywhere else detection is marker-based.
    const titles = [vol('150')];

    expect(resolveTrackingUnit(undefined, titles).unit).toBe('volumes');
    expect(resolveTrackingUnit(undefined, titles, { volumes: 20, chapters: 900 }).unit).toBe(
      'chapters'
    );
  });

  it('feeds the caller’s totals into the detection', () => {
    const titles = [vol('One Piece 1050'), vol('One Piece 1051')];
    expect(resolveTrackingUnit(meta(), titles, { volumes: 108, chapters: 1100 })).toEqual({
      unit: 'chapters',
      source: 'detected'
    });
    expect(resolveTrackingUnit(meta(), titles)).toEqual({ unit: 'volumes', source: 'detected' });
  });

  it('detects with no record at all', () => {
    expect(resolveTrackingUnit(undefined, [vol('第12話')])).toEqual({
      unit: 'chapters',
      source: 'detected'
    });
    expect(resolveTrackingUnit(undefined, [])).toEqual({ unit: 'volumes', source: 'detected' });
  });

  it('ignores a junk stored unit and detects instead', () => {
    const junk = meta({ unit: 'tankobon' as never });
    expect(resolveTrackingUnit(junk, [vol('Chapter 1')])).toEqual({
      unit: 'chapters',
      source: 'detected'
    });
  });
});
