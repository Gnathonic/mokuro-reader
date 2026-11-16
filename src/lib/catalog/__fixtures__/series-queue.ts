/**
 * Queue file v2's series file (`<Series>/.mokuro-series-queue.json`) as
 * mokuro-bunko writes it: its contract fixtures `series-queue-http` (the
 * virtual file a seeded Bunko serves, with `live`) and `series-queue-shapes`
 * (a made-up series with every job state, from Bunko's real renderer), in
 * `interop/contract/bunko/` (see `$lib/interop/contract`). Without a Bunko
 * checkout that has them, the snapshots below, taken from those fixtures.
 * `bunko-contract.test.ts` checks they still equal Bunko's.
 *
 * Times are Bunko's epoch sentinel (946684800 = 2000-01-01T00:00:00Z) plus
 * the offsets the renderer produced.
 */
import { bunkoBodyIfPresent } from '#lib/interop/contract.js';

const HTTP_LIVE = {
  held: { reason: 'no-processor' } as { reason: string } | null,
  held_rows: [] as string[],
  clock: [
    [946684800, 946684800],
    [946771200, 946771200]
  ],
  clock_at: 946684800,
  batch_s: 5
};

const NOVA_ON_PPOCR = {
  kind: 'ocr',
  id: 'hayai-nova',
  parts: [
    { role: 'recognizer', name: 'Hayai Nova', version: '2.5' },
    { role: 'detector', name: 'PP-OCR Manga', version: '0.3' }
  ]
};

/** `series-queue-http`'s body as exported: the seeded volume without OCR, unpriced. */
export const SERIES_QUEUE_HTTP_SNAPSHOT = {
  v: 2,
  instance_id: '<id-1>',
  rev: 1,
  at: 946684800,
  clock_at: 946684800,
  series: 'Contract Series',
  rows: [NOVA_ON_PPOCR],
  vols: { 'Volume 02': [[0, 'q', null]] } as Record<string, unknown[][]>,
  done: {} as Record<string, number>,
  live: HTTP_LIVE
};

/** `series-queue-shapes`'s body as exported: every job state, one finished volume. */
export const SERIES_QUEUE_SHAPES_SNAPSHOT = {
  v: 2,
  instance_id: '<id-1>',
  rev: 2,
  at: 946684920,
  clock_at: 946684800,
  series: 'Example Saga',
  rows: [
    NOVA_ON_PPOCR,
    {
      kind: 'layer',
      id: 'paddle',
      parts: [{ role: 'recognizer', name: 'PaddleOCR-VL', version: '0.3' }]
    }
  ],
  vols: {
    'Example Saga 02': [[0, 'r', 946684680, 946685400]],
    'Example Saga 03': [
      [0, 'q', 946686600],
      [1, 'q', 946693800]
    ],
    'Example Saga 04': [[0, 'c']],
    'Example Saga 05': [[0, 'q', null]]
  } as Record<string, unknown[][]>,
  done: { 'Example Saga 01': 946684920 } as Record<string, number>,
  live: {
    ...HTTP_LIVE,
    held: null as { reason: string } | null,
    held_rows: ['paddle']
  }
};

/** The virtual file a seeded Bunko serves for `Contract Series`. */
export function servedSeriesQueue(): typeof SERIES_QUEUE_HTTP_SNAPSHOT {
  // Rebased onto the sentinel itself: the renderer's own offsets stay readable.
  return bunkoBodyIfPresent('series-queue-http', SERIES_QUEUE_HTTP_SNAPSHOT, 946684800000);
}

/** Every job state, as Bunko's renderer writes them. */
export function seriesQueueShapes(): typeof SERIES_QUEUE_SHAPES_SNAPSHOT {
  return bunkoBodyIfPresent('series-queue-shapes', SERIES_QUEUE_SHAPES_SNAPSHOT, 946684800000);
}
