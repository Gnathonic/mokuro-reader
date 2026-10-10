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

/** The JSON inside a segment, to check what the encoder wrote. */
async function inflate(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(stream).text());
}

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

    it.each([
      [
        'a resolve without a target dictionary',
        { rows: [[5, 1, T, 0, 0, 7, 0]] },
        /unknown target device/
      ],
      [
        'an unknown target device index',
        { targets: ['dev-b'], rows: [[5, 1, T, 0, 1, 7, 0]] },
        /unknown target device/
      ],
      [
        'an empty target device',
        { targets: [''], rows: [[5, 1, T, 0, 0, 7, 0]] },
        /unknown target device/
      ],
      [
        'a string target device index',
        { targets: ['dev-b'], rows: [[5, 1, T, 0, '0', 7, 0]] },
        /malformed integer cell/
      ],
      [
        'a target dictionary that is not a list of strings',
        { targets: [7], rows: [[5, 1, T, 0, 0, 7, 0]] },
        /malformed segment header/
      ],
      ['a target seq of 0', { targets: ['dev-b'], rows: [[5, 1, T, 0, 0, 0, 0]] }, /target seq/],
      [
        'pause answer 3',
        { targets: ['dev-b'], rows: [[5, 1, T, 0, 0, 7, 3]] },
        /unknown pause answer/
      ],
      [
        'a resolve in a legacy segment',
        { legacy: true, targets: ['dev-b'], rows: [[5, 1, T, 0, 0, 7, 0]] },
        /resolve in a legacy segment/
      ]
    ])('%s', async (_label, body, message) => {
      const error = await decodeSegment(await raw(body)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SegmentFormatError);
      expect(String((error as Error).message)).toMatch(message);
    });
  });

  it('round-trips a legacy segment: per-volume legacy devices, uploader in the header', async () => {
    const legacy: ReadingEvent[] = [
      { device: 'legacy:vol-2', seq: T + 5, t: T + 5, kind: 'restart', volume: 'vol-2' },
      {
        device: 'legacy:vol-1',
        seq: T,
        t: T,
        kind: 'page',
        volume: 'vol-1',
        first_page: 4,
        last_page: 4,
        page_chars: [0],
        chars_before: 400,
        dwell_ms: 30000,
        layout: 'unknown',
        orientation: 'unknown',
        viewport: null
      },
      { device: 'legacy:vol-1', seq: T + 9, t: T + 9, kind: 'restart', volume: 'vol-1' }
    ];
    const bytes = await encodeSegment('dev-a', 'legacy', legacy, { legacy: true });
    const { header, events: out } = await decodeSegment(bytes);
    expect(header).toMatchObject({ device: 'dev-a', month: 'legacy', legacy: true, count: 3 });
    expect(out).toEqual([legacy[1], legacy[2], legacy[0]]);
  });

  it('refuses a non-legacy event in a legacy segment, and a legacy event in a native one', async () => {
    await expect(encodeSegment('dev-a', 'legacy', events, { legacy: true })).rejects.toThrow(
      SegmentFormatError
    );
    const legacyEvent: ReadingEvent = {
      device: 'legacy:v',
      seq: 1,
      t: 1,
      kind: 'restart',
      volume: 'v'
    };
    await expect(encodeSegment('dev-a', '1970-01', [legacyEvent])).rejects.toThrow(
      SegmentFormatError
    );
  });

  it('round-trips position answers (jump, stay, reset)', async () => {
    const answers: ReadingEvent[] = [
      {
        device: DEV,
        seq: 1,
        t: T,
        kind: 'position',
        volume: 'vol-1',
        answer: 'jump',
        through: T - 5,
        page: 120
      },
      {
        device: DEV,
        seq: 2,
        t: T + 1,
        kind: 'position',
        volume: 'vol-1',
        answer: 'stay',
        through: T - 4,
        page: 41
      },
      {
        device: DEV,
        seq: 3,
        t: T + 2,
        kind: 'position',
        volume: 'vol-2',
        answer: 'reset',
        through: T - 3,
        page: 0
      }
    ];
    const { events: out } = await decodeSegment(await encodeSegment(DEV, '2026-10', answers));
    expect(out).toEqual(answers);
  });

  describe('resolve (kind 5)', () => {
    const resolves: ReadingEvent[] = [
      {
        device: DEV,
        seq: 7,
        t: T,
        kind: 'resolve',
        volume: 'vol-1',
        target: [DEV, 6],
        count: 'full'
      },
      {
        device: DEV,
        seq: 8,
        t: T + 1,
        kind: 'resolve',
        volume: 'vol-2',
        target: ['dev-b', 41],
        count: 'typical'
      },
      {
        device: DEV,
        seq: 9,
        t: T + 2,
        kind: 'resolve',
        volume: 'vol-1',
        target: ['dev-b', 3],
        count: 'none'
      }
    ];

    it('round-trips answers aimed at this device and at another (full, typical, none)', async () => {
      const bytes = await encodeSegment(DEV, '2026-10', resolves);
      const { header, events: out } = await decodeSegment(bytes);
      expect(header).toEqual({
        format: 1,
        device: DEV,
        month: '2026-10',
        first_seq: 7,
        last_seq: 9,
        count: 3
      });
      expect(out).toEqual(resolves);
    });

    it('round-trips a resolve beside the page it answers', async () => {
      const both = [...events, { ...resolves[0], seq: 11, target: [DEV, 5] as [string, number] }];
      const { events: out } = await decodeSegment(await encodeSegment(DEV, '2026-10', both));
      expect(out).toEqual(both);
    });

    it('writes a target dictionary only when the segment holds a resolve', async () => {
      const plain = await inflate(await encodeSegment(DEV, '2026-10', events));
      expect(plain).not.toHaveProperty('targets');
      expect(Object.keys(plain)).toEqual([
        'format',
        'device',
        'month',
        'first_seq',
        'last_seq',
        'count',
        'volumes',
        'rows'
      ]);
      const answered = await inflate(await encodeSegment(DEV, '2026-10', resolves));
      expect(answered.targets).toEqual([DEV, 'dev-b']);
      expect(answered.rows).toEqual([
        [5, 7, T, 0, 0, 6, 0],
        [5, 1, 1, 1, 1, 41, 1],
        [5, 1, 1, 0, 1, 3, 2]
      ]);
    });

    it('refuses a resolve in a legacy segment', async () => {
      await expect(encodeSegment(DEV, 'legacy', [resolves[0]], { legacy: true })).rejects.toThrow(
        SegmentFormatError
      );
    });
  });
});
