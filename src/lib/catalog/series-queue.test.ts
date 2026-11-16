import { describe, expect, it } from 'vitest';
import { seriesQueueShapes, servedSeriesQueue } from './__fixtures__/series-queue';
import { describePendingOcr } from './server-ocr-pending';
import {
  clockAt,
  parseClock,
  parseSeriesQueueBlock,
  parseSeriesQueueFile,
  pickTrustedCopy,
  seriesCompletions,
  seriesQueueSlice,
  type SeriesQueueFile
} from './series-queue';

/** Bunko's sentinel epoch: the fixtures' times are offsets from it. */
const T = 946684800;
const iso = (s: number) => new Date(s * 1000).toISOString();

function body(over: Record<string, unknown> = {}) {
  return {
    v: 2,
    instance_id: 'aaa',
    rev: 5,
    at: T,
    clock_at: T,
    series: 'Example Saga',
    rows: [{ kind: 'ocr', id: 'hayai-nova' }],
    vols: { 'Example Saga 01': [[0, 'q', T + 600]] },
    done: {},
    ...over
  };
}

const parse = (over: Record<string, unknown> = {}) => parseSeriesQueueFile(body(over))!;

describe('parseSeriesQueueFile', () => {
  it('reads every job shape Bunko renders', () => {
    const f = parseSeriesQueueFile(seriesQueueShapes())!;
    expect(f).not.toBeNull();
    expect(f.rows.map((r) => r && `${r.kind}:${r.id}`)).toEqual(['ocr:hayai-nova', 'layer:paddle']);
    expect([...f.vols]).toEqual([
      ['Example Saga 02', [{ row: 0, state: 'r', t0: T - 120, e: T + 600 }]],
      [
        'Example Saga 03',
        [
          { row: 0, state: 'q', w: T + 1800 },
          { row: 1, state: 'q', w: T + 9000 }
        ]
      ],
      ['Example Saga 04', [{ row: 0, state: 'c' }]],
      ['Example Saga 05', [{ row: 0, state: 'q', w: null }]]
    ]);
    expect([...f.done]).toEqual([['Example Saga 01', T + 120]]);
    expect(f.live).toEqual({
      held: null,
      held_rows: ['paddle'],
      clock: [
        [T, T],
        [T + 86_400, T + 86_400]
      ],
      clock_at: T,
      batch_s: 5
    });
  });

  it('reads the virtual file a seeded Bunko serves', () => {
    const f = parseSeriesQueueFile(servedSeriesQueue())!;
    expect(f.series).toBe('Contract Series');
    expect([...f.vols]).toEqual([['Volume 02', [{ row: 0, state: 'q', w: null }]]]);
    expect(f.live?.held).toEqual({ reason: 'no-processor' });
  });

  it('only v 2: another version or a body without an instance is nothing', () => {
    expect(parseSeriesQueueFile(body({ v: 3 }))).toBeNull();
    expect(parseSeriesQueueFile(body({ v: '2' }))).toBeNull();
    expect(parseSeriesQueueFile({ version: 1, volumes: [] })).toBeNull();
    expect(parseSeriesQueueFile(body({ instance_id: '' }))).toBeNull();
    expect(parseSeriesQueueFile(body({ rev: 'x' }))).toBeNull();
    expect(parseSeriesQueueFile(null)).toBeNull();
  });

  it('ignores unknown fields at every level', () => {
    const f = parseSeriesQueueFile(
      body({
        future: 1,
        rows: [{ kind: 'ocr', id: 'hayai-nova', extra: true }],
        vols: { 'Example Saga 01': [[0, 'q', T + 600, 'more', 7]] }
      })
    )!;
    expect([...f.vols]).toEqual([['Example Saga 01', [{ row: 0, state: 'q', w: T + 600 }]]]);
  });

  it('drops a malformed job on its own, and a volume left with none', () => {
    const f = parseSeriesQueueFile(
      body({
        rows: [
          { kind: 'ocr', id: 'hayai-nova' },
          { kind: 'weird', id: 'x' }
        ],
        vols: {
          'Example Saga 01': [
            [0, 'q', T + 600],
            [1, 'q', T + 700], // its row is malformed
            [5, 'q', T + 800], // no such row
            [0, 'z'], // unknown state
            [0, 'r'], // running without a start
            [0, 'q', 'soon'], // w not a number
            'junk'
          ],
          'Example Saga 02': [[1, 'c']],
          'Example Saga 03': 'junk'
        },
        done: { 'Example Saga 00': T, 'Example Saga 09': 'yesterday' }
      })
    )!;
    expect([...f.vols]).toEqual([['Example Saga 01', [{ row: 0, state: 'q', w: T + 600 }]]]);
    expect([...f.done]).toEqual([['Example Saga 00', T]]);
  });

  it('two stems that fold together keep the first', () => {
    const f = parse({
      vols: { 'Example Saga 01': [[0, 'c']], 'example saga 01': [[0, 'q', null]] }
    });
    expect([...f.vols.keys()]).toEqual(['Example Saga 01']);
  });

  it('a running job may have no predicted finish', () => {
    const f = parse({ vols: { 'Example Saga 01': [[0, 'r', T, null]] } });
    expect(f.vols.get('Example Saga 01')).toEqual([{ row: 0, state: 'r', t0: T, e: null }]);
  });
});

describe('the work clock', () => {
  const two = parseClock([
    [100, 1000],
    [200, 1200]
  ])!;
  const three = parseClock([
    [100, 1000],
    [200, 1200],
    [300, 1300]
  ])!;

  it('interpolates and extrapolates with 2 knots', () => {
    expect(clockAt(two, 150)).toBe(1100);
    expect(clockAt(two, 100)).toBe(1000);
    expect(clockAt(two, 50)).toBe(900);
    expect(clockAt(two, 300)).toBe(1400);
  });

  it('interpolates per segment with 3 knots, and extrapolates along the end segments', () => {
    expect(clockAt(three, 150)).toBe(1100);
    expect(clockAt(three, 250)).toBe(1250);
    expect(clockAt(three, 400)).toBe(1400);
    expect(clockAt(three, 0)).toBe(800);
  });

  it('takes 2 to 16 knots, strictly increasing in both', () => {
    expect(parseClock([[1, 1]])).toBeNull();
    expect(parseClock(Array.from({ length: 17 }, (_, i) => [i, i]))).toBeNull();
    expect(parseClock(Array.from({ length: 16 }, (_, i) => [i, i]))).toHaveLength(16);
    expect(
      parseClock([
        [1, 1],
        [1, 2]
      ])
    ).toBeNull();
    expect(
      parseClock([
        [1, 2],
        [2, 2]
      ])
    ).toBeNull();
    expect(parseClock([[1, 1], 'x'])).toBeNull();
    expect(parseClock('x')).toBeNull();
  });

  it("the first clock is the identity: a job's ETA is its w", () => {
    const identity = parseClock([
      [T, T],
      [T + 86_400, T + 86_400]
    ])!;
    expect(clockAt(identity, T + 600)).toBe(T + 600);
  });
});

describe('parseSeriesQueueBlock', () => {
  it('a live block has no v; a marker block must say 2', () => {
    const block = {
      held: null,
      held_rows: [],
      clock: [
        [0, 0],
        [1, 1]
      ],
      clock_at: 0,
      batch_s: 5
    };
    expect(parseSeriesQueueBlock(block)?.batch_s).toBe(5);
    expect(parseSeriesQueueBlock(block, { requireVersion: true })).toBeNull();
    expect(parseSeriesQueueBlock({ ...block, v: 2 }, { requireVersion: true })?.batch_s).toBe(5);
    expect(parseSeriesQueueBlock({ ...block, v: 3 })).toBeNull();
    expect(parseSeriesQueueBlock([])).toBeNull();
  });
});

describe('pickTrustedCopy', () => {
  const a = parse({ rev: 5 });
  const b = parse({ rev: 9 });
  const foreign = parse({ instance_id: 'bbb', rev: 99 });

  it('a stored copy counts only when the holder wrote it; the highest rev wins', () => {
    expect(pickTrustedCopy([a, foreign, b], { kind: 'holder', instanceId: 'aaa' })).toBe(b);
    expect(pickTrustedCopy([foreign], { kind: 'holder', instanceId: 'aaa' })).toBeNull();
  });

  it("Bunko's virtual file is trusted by its live block; a stored copy's live is ignored", () => {
    const live = parseSeriesQueueFile(servedSeriesQueue())!;
    expect(pickTrustedCopy([a, live], { kind: 'live' })).toBe(live);
    expect(pickTrustedCopy([a], { kind: 'live' })).toBeNull();
    const stored = pickTrustedCopy([{ ...live, instance_id: 'aaa' }], {
      kind: 'holder',
      instanceId: 'aaa'
    });
    expect(stored?.live).toBeNull();
  });
});

describe('seriesQueueSlice + describePendingOcr', () => {
  const shapes = parseSeriesQueueFile(seriesQueueShapes())!;
  const NOW = (T + 240) * 1000;

  it('renders every state under the block: running, queued by clock, starting, unpriced, held row', () => {
    const slice = seriesQueueSlice(shapes, shapes.live);
    expect([...slice.keys()]).toEqual([
      'example saga 02',
      'example saga 03',
      'example saga 04',
      'example saga 05'
    ]);
    expect(slice.get('example saga 02')!.jobs).toEqual([
      expect.objectContaining({
        id: 'hayai-nova',
        state: 'running',
        startedAt: iso(T - 120),
        eta: iso(T + 600),
        progress: null
      })
    ]);
    expect(slice.get('example saga 03')!.jobs.map((j) => [j.id, j.state, j.eta])).toEqual([
      ['hayai-nova', 'queued', iso(T + 1800)],
      // `paddle` is in held_rows: held, its ETA hidden.
      ['paddle', 'held', null]
    ]);
    expect(slice.get('example saga 04')!.jobs[0].state).toBe('starting');
    expect(slice.get('example saga 05')!.jobs[0]).toMatchObject({ state: 'queued', eta: null });

    const lines = (key: string, now = NOW) =>
      describePendingOcr(slice.get(key), now)!.lines.map((l) => l.short);
    // (now − t0) / (e − t0) = 360 / 720.
    expect(lines('example saga 02')[0]).toMatch(/^50% · ~\d\d:\d\d$/);
    expect(lines('example saga 02', (T + 601) * 1000)).toEqual(['finishing']);
    expect(lines('example saga 03')).toEqual(['in ~26 min', 'held']);
    expect(lines('example saga 03', (T + 1790) * 1000)).toEqual(['soon', 'held']);
    expect(lines('example saga 03', (T + 4000) * 1000)).toEqual(['soon', 'held']);
    expect(lines('example saga 04')).toEqual(['starting']);
    expect(lines('example saga 05')).toEqual(['queued']);
  });

  it('progress is clamped to 0–99 % before the finish', () => {
    const slice = seriesQueueSlice(shapes, shapes.live);
    const early = describePendingOcr(slice.get('example saga 02'), (T - 500) * 1000)!;
    expect(early.lines[0].short).toMatch(/^0% /);
    const late = describePendingOcr(slice.get('example saga 02'), (T + 599) * 1000)!;
    expect(late.lines[0].short).toMatch(/^99% /);
  });

  it('a global hold shows every job held with its reason, and no ETA', () => {
    const slice = seriesQueueSlice(shapes, { ...shapes.live!, held: { reason: 'paused' } });
    for (const status of slice.values()) {
      for (const job of status.jobs) expect(job).toMatchObject({ state: 'held', eta: null });
      expect(describePendingOcr(status, NOW)!.lines[0].short).toBe('held: queue paused');
    }
  });

  it('the clock moves queued ETAs only', () => {
    const slower = seriesQueueSlice(shapes, {
      ...shapes.live!,
      clock: [
        [T, T],
        [T + 86_400, T + 2 * 86_400]
      ]
    });
    expect(slower.get('example saga 03')!.jobs[0].eta).toBe(iso(T + 3600));
    expect(slower.get('example saga 02')!.jobs[0].eta).toBe(iso(T + 600));
  });

  it('without a clock a queued job is unpriced', () => {
    const slice = seriesQueueSlice(shapes, null);
    expect(slice.get('example saga 03')!.jobs.map((j) => j.eta)).toEqual([null, null]);
  });

  it('starting sorts after running and before queued', () => {
    const f = parse({
      rows: [
        { kind: 'ocr', id: 'a' },
        { kind: 'layer', id: 'b' },
        { kind: 'layer', id: 'c' }
      ],
      vols: {
        'Example Saga 01': [
          [2, 'q', T + 60_000],
          [1, 'c'],
          [0, 'r', T, T + 600]
        ]
      }
    });
    const view = describePendingOcr(seriesQueueSlice(f, null).get('example saga 01'), T * 1000)!;
    expect(view.lines.map((l) => l.key)).toEqual(['ocr:a', 'layer:b', 'layer:c']);
  });
});

describe('seriesCompletions', () => {
  const withJobs = (vols: Record<string, unknown>, done: Record<string, number> = {}) =>
    parse({
      rows: [
        { kind: 'ocr', id: 'hayai-nova' },
        { kind: 'layer', id: 'paddle' }
      ],
      vols,
      done
    });
  const two = withJobs({
    'Example Saga 01': [
      [0, 'r', T, T + 600],
      [1, 'q', T + 900]
    ],
    'Example Saga 02': [[0, 'q', T + 1200]]
  });

  it('a job seen before and gone now completes its volume', () => {
    const next = withJobs({
      'Example Saga 01': [[1, 'q', T + 900]],
      'Example Saga 02': [[0, 'r', T, T + 1200]]
    });
    expect(seriesCompletions(two, next, { sinceS: T })).toEqual(['Example Saga 01']);
  });

  it('nothing gone and nothing new done: nothing', () => {
    expect(seriesCompletions(two, two, { sinceS: T })).toEqual([]);
  });

  it('a done entry newer than the previous read completes, once', () => {
    const next = withJobs(
      { 'Example Saga 02': [[0, 'q', T + 1200]] },
      { 'Example Saga 07': T + 30 }
    );
    expect(seriesCompletions(two, next, { sinceS: T }).sort()).toEqual([
      'Example Saga 01',
      'Example Saga 07'
    ]);
    expect(seriesCompletions(next, next, { sinceS: T + 60 })).toEqual([]);
    // Older than the previous read: it was already in the listing.
    const old = withJobs({}, { 'Example Saga 08': T - 30 });
    expect(seriesCompletions(two, old, { sinceS: T }).includes('Example Saga 08')).toBe(false);
  });

  it('a first read reports done entries of watched volumes only', () => {
    const next = withJobs({}, { 'Example Saga 01': T, 'Example Saga 02': T });
    expect(
      seriesCompletions(null, next, { sinceS: null, watched: new Set(['example saga 02']) })
    ).toEqual(['Example Saga 02']);
    expect(seriesCompletions(null, next, { sinceS: null })).toEqual([]);
  });

  it('the file gone (nothing owed) completes what it listed', () => {
    expect(seriesCompletions(two, null, { sinceS: T }).sort()).toEqual([
      'Example Saga 01',
      'Example Saga 02'
    ]);
  });

  it('a stem respelled by case is the same volume', () => {
    const next = withJobs({
      'example saga 01': [
        [0, 'r', T, T + 600],
        [1, 'q', T + 900]
      ],
      'Example Saga 02': [[0, 'q', T + 1200]]
    });
    expect(seriesCompletions(two, next as SeriesQueueFile, { sinceS: T })).toEqual([]);
  });
});
