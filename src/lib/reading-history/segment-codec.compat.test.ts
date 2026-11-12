import { describe, expect, it } from 'vitest';
import { decodeSegment, encodeSegment } from './segment-codec';
import * as released from './test-fixtures/segment-codec-v1.11.0';
import type { ReadingEvent } from './types';

/**
 * What an app that has NOT updated (the v1.11.0 codec, frozen in
 * `test-fixtures/`) does with what this one writes (#224 spec 5.2): every
 * segment without a credit is byte-for-byte what it always wrote, and a
 * segment with one is refused as an unknown format — which its importer
 * answers by keeping the old stamp, so the segment is read once it updates.
 */

const DEV = 'dev-a';
const T = Date.UTC(2026, 10, 7, 12);

const page = (seq: number, first: number): ReadingEvent => ({
  device: DEV,
  seq,
  t: T + seq * 1000,
  kind: 'page',
  volume: 'vol-1',
  first_page: first,
  last_page: first,
  page_chars: [40],
  chars_before: (first - 1) * 40,
  dwell_ms: 30000,
  layout: 'single',
  orientation: 'portrait',
  viewport: { w: 800, h: 1200 }
});

const plain: ReadingEvent[] = [
  page(1, 1),
  page(2, 2),
  {
    device: DEV,
    seq: 3,
    t: T + 3000,
    kind: 'adjust',
    volume: 'vol-1',
    time_delta_ms: 60000,
    chars_delta: 0
  },
  {
    device: DEV,
    seq: 4,
    t: T + 4000,
    kind: 'resolve',
    volume: 'vol-1',
    target: [DEV, 2],
    count: 'none'
  },
  { device: DEV, seq: 5, t: T + 5000, kind: 'restart', volume: 'vol-1' }
];

const credit: ReadingEvent = {
  device: DEV,
  seq: 6,
  t: T + 6000,
  kind: 'credit',
  volume: 'vol-1',
  pages: [3, 4, 5],
  page_chars: [40, 40, 40],
  time_ms: 120000
};

describe('segments as an app that has not updated reads them', () => {
  it('a segment without credits is the same bytes the released app writes', async () => {
    const ours = await encodeSegment(DEV, '2026-11', plain);
    const theirs = await released.encodeSegment(DEV, '2026-11', plain);
    expect([...ours]).toEqual([...theirs]);
    const decoded = await released.decodeSegment(ours);
    expect(decoded.header.format).toBe(1);
    expect(decoded.events).toEqual(plain);
  });

  it('a legacy segment is the same bytes too', async () => {
    const legacy: ReadingEvent[] = [
      { device: 'legacy:vol-1', seq: T, t: T, kind: 'restart', volume: 'vol-1' }
    ];
    const ours = await encodeSegment(DEV, 'legacy', legacy, { legacy: true });
    const theirs = await released.encodeSegment(DEV, 'legacy', legacy, { legacy: true });
    expect([...ours]).toEqual([...theirs]);
  });

  it('a segment holding a credit is refused as an unknown format, not misread', async () => {
    const ours = await encodeSegment(DEV, '2026-11', [...plain, credit]);
    const error = await released.decodeSegment(ours).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(released.SegmentFormatError);
    expect(String((error as Error).message)).toMatch(/unsupported segment format 2/);
  });

  it('a segment holding only a retract is refused the same way', async () => {
    const retract: ReadingEvent = {
      device: DEV,
      seq: 7,
      t: T + 7000,
      kind: 'retract',
      volume: 'vol-1',
      target: [DEV, 6]
    };
    const ours = await encodeSegment(DEV, '2026-11', [retract]);
    await expect(released.decodeSegment(ours)).rejects.toThrow(/unsupported segment format 2/);
  });

  it('this app still reads what the released app wrote', async () => {
    const theirs = await released.encodeSegment(DEV, '2026-11', plain);
    expect((await decodeSegment(theirs)).events).toEqual(plain);
  });
});
