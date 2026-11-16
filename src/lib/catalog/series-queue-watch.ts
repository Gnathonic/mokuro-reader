/**
 * When the series file of a WATCHED volume is read while its series page is
 * not open (queue file v2, bunko `docs/design/queue-file-v2.md` §8.7). A
 * watch is a volume this device uploaded to a library a Bunko runs OCR for,
 * or a deep-link import whose server was still making its OCR; it lasts 24 h.
 *
 * Per series (and source), with one timer for all of them:
 * - first at the watch's creation + 2 W (W = the store's window, the larger
 *   of the provider floor and the marker's `batch_s`);
 * - then at the soonest watched ETA + W, never sooner than W and never
 *   later than 15 min ({@link WATCH_MAX_WAIT_MS}) — the 15-minute reads are
 *   also what a volume with no ETA (unpriced, claimed, running without a
 *   predicted finish) gets;
 * - at most {@link WATCH_ROTATION} series are read at all, the oldest watches
 *   first; the rest wait for a slot.
 *
 * A watched volume that is done (a `done` entry) or vanished (seen, now gone)
 * was handed to the scoped pull by the read itself (`seriesCompletions`); its
 * watch ends here. One never seen after 2 reads gets ONE scoped pull: a
 * `.mokuro` newer than the watch completes it, otherwise the 15-minute reads
 * go on until it expires. Paused while the tab is hidden.
 *
 * Pure scheduling: what a read and a pull ARE is the caller's
 * (`server-ocr-queue.ts`), injected for tests.
 */
import { normalizeSeriesKey } from '#lib/metadata/series-key.js';
import type { WatchEntry } from './server-ocr-queue';

/** The longest wait between two reads of a watched series. */
export const WATCH_MAX_WAIT_MS = 15 * 60_000;
/** At most this many watched series are read at all. */
export const WATCH_ROTATION = 20;
/** Waits after the 1st, 2nd, … consecutive failed read; the last repeats. */
export const WATCH_BACKOFF_MS: readonly number[] = [60_000, 120_000, 240_000, 600_000];
/** Reads a never-seen watched volume waits through before its one scoped pull. */
const ABSENT_READS = 2;

/** One series of one source, and its watches. */
export interface WatchGroup {
  id: string;
  watches: WatchEntry[];
}

export type WatchLook =
  /** Not readable now (its account is not connected; no Bunko writes series files there). */
  | { kind: 'wait'; retryMs?: number }
  /** A Bunko server older than v2: its v1 poller owns these watches. */
  | { kind: 'handed-off' }
  | {
      kind: 'read';
      /** The store's window W, ms. */
      windowMs: number;
      /** Watched volumes (by watch key) the file lists, with their soonest ETA (ms) or null. */
      present: Map<string, number | null>;
      /** Watched volumes (by watch key) the file names as done. */
      done: Set<string>;
    };

export interface WatchScheduleDeps {
  /** Every live watch. */
  watches(): WatchEntry[];
  /** The window W to assume before a group's first read, ms. */
  windowMs(group: WatchGroup): number;
  /** One read of the group's series file. Throws on a failed read. */
  look(group: WatchGroup): Promise<WatchLook>;
  /**
   * The one scoped pull of a watched volume its series file never listed:
   * true when it completed (the caller has then ended the watch). Not waited
   * for: a pull is debounced and spaced, and other series read meanwhile.
   */
  pullAbsent(group: WatchGroup, watch: WatchEntry): Promise<boolean>;
  /**
   * The watched volume is done or vanished: end its watch (a read through the
   * connected library already handed it to the scoped pull; a link's watch
   * pulls through its manifest first).
   */
  complete(group: WatchGroup, watch: WatchEntry): void;
  isHidden(): boolean;
  now(): number;
}

interface GroupState {
  nextAt: number;
  windowMs: number;
  /** The last look could not read (`wait`): a wake looks again at once. */
  waiting: boolean;
  handedOff: boolean;
  errors: number;
  seen: Set<string>;
  absentReads: Map<string, number>;
  absentPulled: Set<string>;
}

/** The group a watch belongs to: its source and its series. */
export function watchGroupId(w: Pick<WatchEntry, 'queue_url' | 'series'>): string {
  return `${w.queue_url}\u0000${normalizeSeriesKey(w.series)}`;
}

export class WatchSchedule {
  private states = new Map<string, GroupState>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;
  private running = false;
  private again = false;
  private paused = false;
  private stopped = false;

  constructor(private readonly deps: WatchScheduleDeps) {}

  /** The watches changed (one added, app start): plan again. */
  kick(): void {
    if (this.stopped) return;
    this.plan();
  }

  /** What kept groups waiting may have changed (a login, a switch): look at them now. */
  wake(): void {
    if (this.stopped) return;
    const now = this.deps.now();
    for (const st of this.states.values()) {
      if (st.waiting) st.nextAt = Math.min(st.nextAt, now);
    }
    this.plan();
  }

  onVisibilityChange(): void {
    if (this.stopped) return;
    if (this.deps.isHidden()) {
      this.paused = true;
      this.clearTimer();
      return;
    }
    if (!this.paused) return;
    this.paused = false;
    this.plan();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.states.clear();
  }

  /** Tests: when the next read is due (epoch ms), or null when none is planned. */
  get nextAt(): number | null {
    return this.timer ? this.timerAt : null;
  }

  private groups(): Map<string, WatchGroup> {
    const out = new Map<string, WatchGroup>();
    for (const w of this.deps.watches()) {
      const id = watchGroupId(w);
      const group = out.get(id);
      if (group) group.watches.push(w);
      else out.set(id, { id, watches: [w] });
    }
    return out;
  }

  /** The groups read at all: the oldest watches first, at most {@link WATCH_ROTATION}. */
  private rotation(groups: Map<string, WatchGroup>): WatchGroup[] {
    const oldest = (g: WatchGroup) => Math.min(...g.watches.map((w) => w.added_at));
    return [...groups.values()]
      .filter((g) => !this.states.get(g.id)?.handedOff)
      .sort((a, b) => oldest(a) - oldest(b))
      .slice(0, WATCH_ROTATION);
  }

  private plan(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    const groups = this.groups();
    for (const id of [...this.states.keys()]) if (!groups.has(id)) this.states.delete(id);
    let soonest = Infinity;
    for (const group of this.rotation(groups)) {
      let st = this.states.get(group.id);
      if (!st) {
        const windowMs = this.deps.windowMs(group);
        const created = Math.min(...group.watches.map((w) => w.added_at));
        st = {
          nextAt: created + 2 * windowMs,
          windowMs,
          waiting: false,
          handedOff: false,
          errors: 0,
          seen: new Set(),
          absentReads: new Map(),
          absentPulled: new Set()
        };
        this.states.set(group.id, st);
      }
      soonest = Math.min(soonest, st.nextAt);
    }
    this.clearTimer();
    if (soonest === Infinity || this.paused) return;
    if (this.deps.isHidden()) {
      this.paused = true;
      return;
    }
    this.timerAt = soonest;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.timerAt = Infinity;
        void this.tick();
      },
      Math.max(0, soonest - this.deps.now())
    );
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.deps.isHidden()) {
      this.paused = true;
      return;
    }
    this.running = true;
    try {
      for (const group of this.rotation(this.groups())) {
        if (this.stopped) return;
        const st = this.states.get(group.id);
        if (!st || st.handedOff || st.nextAt > this.deps.now()) continue;
        await this.lookAt(group, st);
      }
    } finally {
      this.running = false;
      this.again = false;
      this.plan();
    }
  }

  private async lookAt(group: WatchGroup, st: GroupState): Promise<void> {
    let look: WatchLook;
    try {
      look = await this.deps.look(group);
      st.errors = 0;
    } catch (error) {
      const wait = WATCH_BACKOFF_MS[Math.min(st.errors, WATCH_BACKOFF_MS.length - 1)];
      st.errors++;
      console.warn(
        `[OCR queue] a watched series could not be read; next look in ${wait / 1000} s:`,
        error instanceof Error ? error.message : error
      );
      st.nextAt = this.deps.now() + wait;
      return;
    }
    if (look.kind === 'handed-off') {
      st.handedOff = true;
      return;
    }
    if (look.kind === 'wait') {
      st.waiting = true;
      st.nextAt = this.deps.now() + (look.retryMs ?? WATCH_MAX_WAIT_MS);
      return;
    }
    st.waiting = false;
    st.windowMs = look.windowMs;
    const W = look.windowMs;
    const live = new Set(this.deps.watches().map((w) => w.key));
    let soonest = Infinity;
    let early = false;
    for (const w of group.watches) {
      if (!live.has(w.key)) continue; // completed meanwhile
      if (look.present.has(w.key)) {
        st.seen.add(w.key);
        const eta = look.present.get(w.key);
        if (eta !== null && eta !== undefined) soonest = Math.min(soonest, eta);
        continue;
      }
      if (look.done.has(w.key) || st.seen.has(w.key)) {
        this.deps.complete(group, w);
        continue;
      }
      const reads = (st.absentReads.get(w.key) ?? 0) + 1;
      st.absentReads.set(w.key, reads);
      if (reads < ABSENT_READS) {
        early = true;
        continue;
      }
      if (!st.absentPulled.has(w.key)) {
        st.absentPulled.add(w.key);
        void this.deps
          .pullAbsent(group, w)
          .catch((error) =>
            console.debug('[OCR queue] the pull of a watched volume failed:', error)
          );
      }
    }
    const now = this.deps.now();
    let wait = WATCH_MAX_WAIT_MS;
    if (soonest < Infinity) wait = Math.min(wait, Math.max(W, soonest + W - now));
    if (early) wait = Math.min(wait, 2 * W);
    st.nextAt = now + wait;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }
}
