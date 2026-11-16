/**
 * The lease marker (`.mokuro-bunko.json`) as mokuro-bunko writes it: its contract
 * fixture `marker-active` (`interop/contract/bunko/`, see `$lib/interop/contract`),
 * or, without a Bunko checkout, the snapshot below.
 */
import { bunkoBody } from '#lib/interop/contract.js';

/**
 * `marker-active`'s body as exported (sentinel times and ids), in its key order.
 * `bunko-contract.test.ts` checks it still equals the fixture whenever a Bunko
 * checkout is there.
 */
export const MARKER_SNAPSHOT = {
  version: 1,
  kind: 'mokuro-bunko',
  instance_id: '<id-1>',
  boot_id: '<id-2>',
  instance_name: 'contract-host',
  bunko_version: '0.0.0',
  epoch: 1,
  claimed_at: '2000-01-01T00:00:00.000Z',
  heartbeat_at: '2000-01-01T00:00:00.000Z',
  ttl_s: 900,
  state: 'active',
  compiles: ['series.json', 'catalog.json'],
  ocr: true,
  // Queue file v2 (B2): no root queue file is stored; the library-wide queue
  // state rides the marker's `series_queue` block. Its clock is the identity
  // with its fit time on the epoch sentinel (`946684800`); the far knot is a
  // day later and is not a sentinel, so it is not rebased.
  queue: null as string | null,
  series_queue: {
    v: 2,
    file: '.mokuro-series-queue.json',
    batch_s: 120,
    held: { reason: 'no-processor' } as { reason: string } | null,
    held_rows: [] as string[],
    clock: [
      [946684800, 946684800],
      [946771200, 946771200]
    ] as [number, number][],
    clock_at: 946684800
  },
  dedup: true,
  curated: true,
  took_over_from: null as string | null,
  per_user_files: ['volume-data.json', 'profiles.json', 'goals.json', 'positions.json', 'history/']
};

/**
 * The marker Bunko writes, its times rebased onto `now`. A 0.8 marker, with
 * `dedup`, `curated` and `per_user_files`: a test of a 0.7 marker deletes them.
 */
export function servedMarker(now: number): typeof MARKER_SNAPSHOT {
  return bunkoBody('marker-active', MARKER_SNAPSHOT, now);
}
