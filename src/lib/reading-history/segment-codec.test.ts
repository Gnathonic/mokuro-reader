import { describe, expect, it } from 'vitest';
import { decodeSegment, encodeSegment, SegmentFormatError } from './segment-codec';
import type { ReadingEvent } from './types';

const DEV = 'dev-a';
const T = Date.UTC(2026, 9, 3, 12);
const events: ReadingEvent[] = [
  {
    device: DEV,
    seq: 4,
    t: T,
    kind: 'page',
    volume: 'vol-1',
    first_page: 3,
    last_page: 4,
    page_chars: [120, 0],
    chars_before: 300,
    dwell_ms: 41000,
    layout: 'double',
    orientation: 'landscape',
    viewport: { w: 1920, h: 1080 }
  },
  {
    device: DEV,
    seq: 5,
    t: T + 41000,
    kind: 'page',
    volume: 'vol-1',
    first_page: 5,
    last_page: 5,
    page_chars: [88],
    chars_before: 420,
    dwell_ms: null,
    layout: 'unknown',
    orientation: 'unknown',
    viewport: null
  },
  {
    device: DEV,
    seq: 6,
    t: T + 60000,
    kind: 'adjust',
    volume: 'vol-2',
    time_delta_ms: -60000,
    chars_delta: 0
  },
  { device: DEV, seq: 9, t: T + 61000, kind: 'restart', volume: 'vol-2' },
  { device: DEV, seq: 10, t: T + 62000, kind: 'forget', volume: 'vol-1', before: T + 62000 }
];

describe('segment codec', () => {
  it('round-trips every event kind exactly, in seq order', async () => {
    const bytes = await encodeSegment(DEV, '2026-10', [...events].reverse());
    const { header, events: out } = await decodeSegment(bytes);
    expect(header).toEqual({
      format: 1,
      device: DEV,
      month: '2026-10',
      first_seq: 4,
      last_seq: 10,
      count: 5
    });
    expect(out).toEqual(events);
  });

  it('is much smaller than the JSON it replaces', async () => {
    const many: ReadingEvent[] = Array.from({ length: 500 }, (_, i) => ({
      ...(events[0] as Extract<ReadingEvent, { kind: 'page' }>),
      seq: i + 1,
      t: T + i * 30000,
      first_page: i + 1,
      last_page: i + 1,
      page_chars: [100 + (i % 7)],
      chars_before: i * 100
    }));
    const bytes = await encodeSegment(DEV, '2026-10', many);
    expect(bytes.length * 5).toBeLessThan(JSON.stringify(many).length);
  });

  it('refuses events from another device', async () => {
    await expect(encodeSegment('dev-b', '2026-10', events)).rejects.toThrow(SegmentFormatError);
  });

  it.each([
    ['garbage', new Uint8Array([1, 2, 3, 4])],
    ['empty', new Uint8Array()]
  ])('rejects %s bytes', async (_l, bytes) => {
    await expect(decodeSegment(bytes)).rejects.toThrow(SegmentFormatError);
  });

  it('rejects a truncated file', async () => {
    const bytes = await encodeSegment(DEV, '2026-10', events);
    await expect(decodeSegment(bytes.slice(0, Math.floor(bytes.length / 2)))).rejects.toThrow(
      SegmentFormatError
    );
  });

  it('rejects a newer format it cannot read', async () => {
    const json = JSON.stringify({
      format: 2,
      device: DEV,
      month: '2026-10',
      first_seq: 1,
      last_seq: 1,
      count: 0,
      volumes: [],
      rows: []
    });
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    await expect(decodeSegment(bytes)).rejects.toThrow(/format 2/);
  });

  describe('rejects decodable files with malformed cells', () => {
    async function raw(body: Record<string, unknown>): Promise<Uint8Array> {
      const json = JSON.stringify({
        format: 1,
        device: DEV,
        month: '2026-10',
        first_seq: 1,
        last_seq: 1,
        count: 1,
        volumes: ['vol-1'],
        ...body
      });
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    it.each([
      ['a string seq delta', { rows: [[2, '1', T, 0]] }],
      ['a missing t delta', { rows: [[2, 1, null, 0]] }],
      [
        'a repeated seq',
        {
          count: 2,
          last_seq: 1,
          rows: [
            [2, 1, T, 0],
            [2, 0, 1, 0]
          ]
        }
      ],
      ['page_chars that is not a list', { rows: [[0, 1, T, 0, 1, 1, 'x', 0, 5, 0, 0, 1, 1]] }],
      ['a non-numeric page', { rows: [[0, 1, T, 0, 'one', 1, [1], 0, 5, 0, 0, 1, 1]] }],
      ['a string header seq', { first_seq: '1', rows: [[2, 1, T, 0]] }],
      ['an adjust without numbers', { rows: [[1, 1, T, 0, 'x', 0]] }]
    ])('%s', async (_label, body) => {
      await expect(decodeSegment(await raw(body))).rejects.toThrow(SegmentFormatError);
    });
  });
});
