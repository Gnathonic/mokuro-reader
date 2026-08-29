/**
 * The `series.json` PUT concurrency budget — shared by EVERY producer of the
 * file, not just the debounced fact-edit writer (`series-file-sync.ts`) that
 * originally needed it.
 *
 * A burst of debounce timers all come due on the same 2000ms mark (a
 * reconcile pass over a 200-folder library, an import batch, a tagging
 * spree), and the sidecar backfill (`series-backfill.ts`) can independently
 * fan out over just as many series from the SAME reconcile pass. Uncapped,
 * either source alone is N concurrent `db.volumes.toArray()` scans and N
 * concurrent PUTs at a provider that will rate-limit or simply fall over —
 * and if both sources fire together they must still share ONE budget, not
 * two independent ones that each think they are the only writer. Two keeps
 * the pipe busy across the round trip without becoming a stampede.
 *
 * Extracted into its own module (rather than living in `series-file-sync.ts`)
 * specifically so `series-backfill.ts` can acquire the SAME pool around its
 * own publish without importing `series-file-sync.ts` directly — the two
 * already sit in a dependency cycle through `unified-cloud-manager.ts`, and
 * this keeps that cycle from growing a second, tighter edge.
 */
export const WRITE_CONCURRENCY = 2;

let activeWrites = 0;
const waitingWrites: Array<() => void> = [];

export function acquireWriteSlot(): Promise<void> {
  if (activeWrites < WRITE_CONCURRENCY) {
    activeWrites += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waitingWrites.push(() => {
      activeWrites += 1;
      resolve();
    });
  });
}

export function releaseWriteSlot(): void {
  activeWrites -= 1;
  waitingWrites.shift()?.();
}

/** Test hook: forget the write-concurrency bookkeeping. */
export function _resetWriteSlotForTests(): void {
  activeWrites = 0;
  waitingWrites.length = 0;
}
