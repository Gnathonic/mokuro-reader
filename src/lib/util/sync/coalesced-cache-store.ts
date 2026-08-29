import {
  writable,
  type Readable,
  type Subscriber,
  type Unsubscriber,
  type Writable
} from 'svelte/store';

/**
 * How long a burst of incremental cache mutations may settle before
 * subscribers hear about it.
 *
 * Trailing-edge, NOT re-arming: the first mutation of a burst starts the
 * clock, later ones ride along, and the flush publishes whatever the state
 * holds AT FIRE TIME — so sustained activity can never starve subscribers,
 * and a burst can never emit more than once per window. The same shape as
 * `keyedTableMap`'s `schedule()` (150 ms), sized up because the producer here
 * is a serial upload stream (one `cache.add` per completed network write,
 * spaced by round-trip latency) and each emission re-derives the whole
 * catalog downstream (`volumesWithPlaceholders` + the OCR-upgrade matcher
 * walk every cloud archive per new Map identity).
 */
export const CACHE_MUTATION_COALESCE_MS = 300;

/**
 * The provider caches' store, with cache STATE split from store EMISSION.
 *
 * Why: every provider cache used one `writable(Map)` as both its source of
 * truth and its broadcast channel, so each post-upload `cache.add` published
 * a brand-new Map — and `unifiedCloudManager.cloudFiles` subscribers
 * (placeholder generation, the cloud-OCR matcher, cover ingest, every backup
 * badge) re-derived the whole catalog once PER UPLOADED FILE. A
 * sidecar-backfill drain with hundreds of files left performed a full
 * 2,000-archive placeholder regeneration after every single sidecar it
 * uploaded — the same per-write whole-catalog re-derive shape as the cover
 * ingest freeze, arriving through the blind-upload path.
 *
 * The split:
 *
 * - {@link read} is the STATE: synchronous, and NEVER lagged. Every
 *   correctness path — the backfill drain re-deriving "sidecar missing"
 *   before each upload, `getCloudVolumesBySeries`, reconcile, the import
 *   feed's gap checks — reads through the caches' own methods, which all
 *   land here. An `add` is visible to them the moment it returns, so a
 *   just-uploaded file can never be re-uploaded because its record was
 *   sitting in a pending emission.
 * - {@link subscribe} is the EMISSION: incremental mutations
 *   ({@link update}) coalesce on the trailing edge above, so a serial
 *   upload stream costs subscribers one re-derive per window, not one per
 *   file. Full-listing installs and clears ({@link set}) publish
 *   IMMEDIATELY — they are one-shot, consumers wait on them, and a logout's
 *   `clear()` must also cancel any pending emission so a dead account's map
 *   can never be published over the cleared cache.
 *
 * The flush publishes the CURRENT state, never a snapshot: mutations landing
 * while the timer runs are all in the published Map.
 */
export class CoalescedCacheStore<V> {
  private state: Map<string, V>;
  private published: Writable<Map<string, V>>;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(initial: Map<string, V> = new Map()) {
    this.state = initial;
    this.published = writable(initial);
  }

  /**
   * The synchronous, never-lagged view of the cache — what `has`/`get`/
   * `getBySeries`/`getAllFiles` and every other correctness read must use.
   * Reading the published side for those (the old `subscribe()()` snapshot
   * idiom) would hand them state up to a window old.
   */
  read(): Map<string, V> {
    return this.state;
  }

  /**
   * Svelte store contract over the PUBLISHED side. An arrow property (not a
   * method) so the store can be handed around detached, as `Readable`
   * consumers do.
   */
  subscribe: Readable<Map<string, V>>['subscribe'] = (
    run: Subscriber<Map<string, V>>,
    invalidate?: () => void
  ): Unsubscriber => this.published.subscribe(run, invalidate);

  /**
   * An INCREMENTAL mutation (post-upload add, delete, description update):
   * applied to the state immediately — synchronous readers see it before
   * this returns — and published on the coalesced trailing edge.
   */
  update(fn: (map: Map<string, V>) => Map<string, V>): void {
    this.state = fn(this.state);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        // The CURRENT state, not a snapshot from arm time: every mutation
        // that landed during the window rides this one emission.
        this.published.set(this.state);
      }, CACHE_MUTATION_COALESCE_MS);
    }
  }

  /**
   * A FULL install (a fetch's atomic swap) or a clear: publishes NOW and
   * supersedes any pending trailing emission. Cancelling is load-bearing
   * twice over — a pending pre-fetch map must not fire after the fresh
   * listing and re-mint every consumer's derivation, and a pending
   * pre-logout map must not fire after `clear()` and hand consumers a dead
   * account's files.
   */
  set(map: Map<string, V>): void {
    this.cancelPending();
    this.state = map;
    this.published.set(map);
  }

  /**
   * Publish a pending emission NOW; a no-op when nothing is pending (so it
   * never spends a Map identity for nothing). For the one caller that
   * finishes a fetch WITHOUT installing a new map — Drive's
   * `sameCacheMap` identity-preservation skip — but whose subscribers may
   * still be owed mutations that were riding the timer.
   */
  flush(): void {
    if (this.timer === null) return;
    this.cancelPending();
    this.published.set(this.state);
  }

  /** Whether a coalesced emission is armed — teardown tests pin this. */
  hasPendingPublish(): boolean {
    return this.timer !== null;
  }

  private cancelPending(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
