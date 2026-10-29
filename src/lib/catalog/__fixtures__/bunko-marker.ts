/**
 * The lease marker (`.mokuro-bunko.json`) as mokuro-bunko writes it: its contract
 * fixture `marker-active` (`interop/contract/bunko/`, see `$lib/interop/contract`),
 * or, without a Bunko checkout, the snapshot below.
 */
import { bunkoBody } from '$lib/interop/contract';

/**
 * `marker-active`'s body as exported (sentinel times and ids). `bunko-contract.test.ts`
 * checks it still equals the fixture whenever a Bunko checkout is there.
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
  queue: '.mokuro-queue.json',
  took_over_from: null as string | null
};

/** The marker Bunko writes, its times rebased onto `now`. */
export function servedMarker(now: number): typeof MARKER_SNAPSHOT {
  return bunkoBody('marker-active', MARKER_SNAPSHOT, now);
}
