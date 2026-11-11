/**
 * The series page's OCR queue loop (queue file v2, bunko
 * `docs/design/queue-file-v2.md` §8.4). The reader reads queue state ONLY
 * here: the open series' `<Series>/.mokuro-series-queue.json`, through the
 * connected provider's folder-aware `readControlFile` — no app-start reads, no
 * grid or library reads, no root queue file.
 *
 * 1. Pick the source. A Bunko server over WebDAV serves the file virtually,
 *    with a `live` block, trusted as is; a 404 for a series the listing holds
 *    means an older Bunko, and that server's v1 root-file poller takes over
 *    for the session. On a cloud or Local Folder library a fresh lease holder
 *    whose marker carries `series_queue` is required, else nothing is shown.
 * 2. Read with the memo's version token (a conditional read).
 * 3. Parse, check trust, and publish the series' slice only if what the cards
 *    show changed.
 * 4. Detect completions (a job gone, a newer `done` entry) and hand them on.
 * 5. Repeat every `max(provider floor, batch_s)` — MEGA on its change events
 *    plus a free 10-minute look — while the page is mounted, the tab is
 *    visible, and the slice has jobs, the series holds a watched volume, or
 *    fewer than 2 reads were taken.
 * 6. On unmount, stop. The memo (token, file, read time) is kept, so coming
 *    back within the interval costs no read.
 */
import { foldFolderName, SERIES_QUEUE_FILE_NAME } from '$lib/util/sync/syncable-file';
import type { SyncProvider } from '$lib/util/sync/provider-interface';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { onCloudSeriesQueueChange, type MarkerNodeRecord } from './cloud-bunko-marker';
import { publishSeriesQueueSlice } from './server-ocr-pending';
import {
  parseSeriesQueueFile,
  pickTrustedCopy,
  seriesCompletions,
  seriesQueueSlice,
  type SeriesQueueBlock,
  type SeriesQueueFile
} from './series-queue';

/** Waits after the 1st, 2nd, … consecutive failed read; the last repeats. */
export const SERIES_QUEUE_BACKOFF_MS: readonly number[] = [60_000, 120_000, 240_000, 600_000];
/** MEGA's reads cost nothing and its tree pushes changes: a safety look this often. */
export const MEGA_SAFETY_READ_MS = 10 * 60_000;
/** At most this often, a series file newer than the marker's clock re-reads the marker. */
export const MARKER_REREAD_SPACING_MS = 60_000;
/** Reads a series page takes even when it shows nothing (a fresh upload may be judged soon). */
const MIN_READS = 2;

/** What the loop needs from the app (injected by tests). */
export interface SeriesQueueEnv {
  provider(): Promise<SyncProvider | null>;
  /**
   * Which account a memo belongs to: the provider type, plus the server for
   * WebDAV — one server's file is never shown under another.
   */
  scopeOf(provider: SyncProvider): Promise<string>;
  /** The v1 root-file URL when the connected WebDAV is a Bunko server, else null. */
  bunkoServer(provider: SyncProvider): Promise<string | null>;
  /** Is this Bunko server already known to be older than queue file v2? */
  isV1Server(queueUrl: string): boolean;
  /** It is (a 404 for a series it holds): its v1 poller takes over. */
  fallBackToV1(queueUrl: string, firstTime: boolean): void;
  /** The series folder as the listing spells it (`resolveCloudFolderTitle`). */
  folderFor(seriesTitle: string): string;
  /** Does the listing hold this folder? */
  folderListed(folder: string): boolean;
  holder(scope: string): MarkerNodeRecord | null;
  refreshMarker(provider: SyncProvider): Promise<boolean>;
  /** Keys (`volumeQueueKey`) of the volumes watched on this device. */
  watchedKeys(): string[];
  /** Floor between reads per provider type, seconds. */
  floorS(type: string): number;
  /** Stems of `folder` whose OCR finished (§8.6). */
  onCompleted(c: {
    provider: SyncProvider;
    bunkoQueueUrl: string | null;
    folder: string;
    stems: string[];
  }): void;
  isHidden(): boolean;
  now(): number;
}

interface Memo {
  /** The provider's version of the node set, handed back as `ifNoneMatch`. */
  token: string | undefined;
  /** Text of the nodes last parsed (no re-parse, no re-publish of equal bytes). */
  bytes: string | null;
  /** The trusted copy, or EMPTY (the series owes nothing), or null (nothing trusted yet). */
  file: SeriesQueueFile | null;
  /** Local ms of the last read that landed. */
  readAt: number;
  reads: number;
  intervalMs: number;
  /** Over Bunko's own WebDAV (the file carries `live`). */
  bunko: boolean;
}

/** The series owes nothing: no file (a stored one is deleted once its `done` tail expired). */
const EMPTY: SeriesQueueFile = {
  v: 2,
  instance_id: '',
  rev: -1,
  at: 0,
  clock_at: 0,
  series: '',
  rows: [],
  vols: new Map(),
  done: new Map(),
  live: null
};

const memos = new Map<string, Memo>();
let lastMarkerReread = -Infinity;

/**
 * What one look at a series file found (`lookSeriesQueue`): nothing to read
 * there now (`none`: no provider, or no Bunko writing series files), a Bunko
 * server older than v2 (`v1`, handed to its v1 poller), or the file — the
 * trusted copy (with no jobs when the series owes nothing), or null when no
 * copy is trusted — under its library-wide block, and the window to read again
 * in.
 */
export type SeriesQueueLook =
  | { kind: 'none' }
  | { kind: 'v1' }
  | {
      kind: 'file';
      file: SeriesQueueFile | null;
      block: SeriesQueueBlock | null;
      intervalMs: number;
    };

export class SeriesQueueFollower {
  readonly seriesKey: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fetching = false;
  private again = false;
  private paused = false;
  private stopped = false;
  private errors = 0;
  private scope: string | null = null;
  private providerType: string | null = null;
  private folder: string | null = null;
  private offMarker: (() => void) | null = null;
  private offFeed: (() => void) | null = null;
  private feedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly seriesTitle: string,
    private readonly env: SeriesQueueEnv,
    /** One look and done (`lookSeriesQueue`): no timer, no feed listener. */
    private readonly oneShot = false
  ) {
    this.seriesKey = normalizeSeriesKey(seriesTitle);
  }

  start(): void {
    // A refit, a hold or a new holder changes what the cards show, without a read.
    this.offMarker = onCloudSeriesQueueChange(() => this.rerender());
    void this.firstLook();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    if (this.feedTimer) clearTimeout(this.feedTimer);
    this.feedTimer = null;
    this.offMarker?.();
    this.offMarker = null;
    this.offFeed?.();
    this.offFeed = null;
  }

  onVisibilityChange(): void {
    if (this.stopped) return;
    if (this.env.isHidden()) {
      if (this.timer || this.fetching) this.paused = true;
      this.clearTimer();
      return;
    }
    if (!this.paused) return;
    this.paused = false;
    void this.firstLook();
  }

  /** A read now (a feed event); coalesced with one in flight. */
  trigger(): void {
    if (this.stopped) return;
    if (this.env.isHidden()) {
      this.clearTimer();
      this.paused = true;
      return;
    }
    if (this.fetching) {
      this.again = true;
      return;
    }
    this.clearTimer();
    void this.read();
  }

  /** Coming back within the interval costs no read: the memo stands until it is due. */
  private async firstLook(): Promise<void> {
    const provider = await this.env.provider();
    const key = provider ? await this.memoKey(provider) : null;
    if (this.stopped) return;
    const memo = key ? memos.get(key) : undefined;
    if (provider && key && memo && memo.readAt > 0) {
      this.scope = key;
      this.providerType = provider.type;
      this.rerender();
      if (!memo.bunko) this.followFeed(provider, this.env.folderFor(this.seriesTitle));
      const due = memo.readAt + memo.intervalMs - this.env.now();
      if (due > 0) {
        if (this.wantsMore(memo)) this.schedule(due);
        return;
      }
    } else {
      // Nothing known under this provider: what an earlier one showed goes.
      publishSeriesQueueSlice(this.seriesKey, null);
    }
    this.trigger();
  }

  private async memoKey(provider: SyncProvider): Promise<string> {
    return `${await this.env.scopeOf(provider)}\u0000${this.seriesKey}`;
  }

  private memo(key: string): Memo {
    let memo = memos.get(key);
    if (!memo) {
      memo = {
        token: undefined,
        bytes: null,
        file: null,
        readAt: 0,
        reads: 0,
        intervalMs: 30_000,
        bunko: false
      };
      memos.set(key, memo);
    }
    return memo;
  }

  /** One look, for `lookSeriesQueue`. Throws on a failed read. */
  look(): Promise<SeriesQueueLook> {
    return this.readOnce();
  }

  private async read(): Promise<void> {
    if (this.stopped) return;
    if (this.env.isHidden()) {
      this.paused = true;
      return;
    }
    this.fetching = true;
    try {
      await this.readOnce();
      this.errors = 0;
    } catch (error) {
      const wait =
        SERIES_QUEUE_BACKOFF_MS[Math.min(this.errors, SERIES_QUEUE_BACKOFF_MS.length - 1)];
      this.errors++;
      console.warn(
        `[OCR queue] ${this.seriesTitle}: series queue unavailable; next look in ${wait / 1000} s:`,
        error instanceof Error ? error.message : error
      );
      if (!this.stopped) this.schedule(wait);
    } finally {
      this.fetching = false;
      if (this.again && !this.stopped) {
        this.again = false;
        this.clearTimer();
        void this.read();
      }
    }
  }

  private async readOnce(): Promise<SeriesQueueLook> {
    const NONE = { kind: 'none' } as const;
    const provider = await this.env.provider();
    if (this.stopped) return NONE;
    if (!provider?.readControlFile) {
      publishSeriesQueueSlice(this.seriesKey, null);
      return NONE;
    }
    const key = await this.memoKey(provider);
    if (this.stopped) return NONE;
    this.scope = key;
    this.providerType = provider.type;
    const memo = this.memo(key);
    const bunkoQueueUrl = await this.env.bunkoServer(provider);
    memo.bunko = bunkoQueueUrl !== null;
    if (bunkoQueueUrl && this.env.isV1Server(bunkoQueueUrl)) {
      publishSeriesQueueSlice(this.seriesKey, null);
      this.env.fallBackToV1(bunkoQueueUrl, false);
      return { kind: 'v1' };
    }
    const holder = bunkoQueueUrl ? null : this.env.holder(provider.type);
    if (!bunkoQueueUrl && !holder?.series_queue) {
      // No Bunko manages this library with series files right now: nothing to
      // read. A marker change (`rerender`) brings the loop back.
      publishSeriesQueueSlice(this.seriesKey, null);
      memo.intervalMs = this.intervalMs(provider, null);
      return NONE;
    }

    const folder = this.env.folderFor(this.seriesTitle);
    this.followFeed(provider, folder);
    const result = await provider.readControlFile(SERIES_QUEUE_FILE_NAME, {
      folder,
      ifNoneMatch: memo.token
    });
    if (this.stopped) return NONE;
    const previous = memo.file;
    const sinceS = memo.readAt > 0 ? Math.floor(memo.readAt / 1000) : null;
    memo.readAt = this.env.now();
    memo.reads++;

    let next: SeriesQueueFile | null = previous;
    if (result === 'not-modified') {
      // Nothing to parse; the clock may still have moved (rerender below).
    } else if (result === null) {
      memo.token = undefined;
      memo.bytes = null;
      if (bunkoQueueUrl && this.env.folderListed(folder)) {
        // A Bunko that answers 404 for a series it holds is older than v2.
        publishSeriesQueueSlice(this.seriesKey, null);
        this.env.fallBackToV1(bunkoQueueUrl, true);
        return { kind: 'v1' };
      }
      next = EMPTY;
    } else {
      memo.token = result.etag;
      const texts = await Promise.all(result.nodes.map((n) => n.blob.text()));
      if (this.stopped) return NONE;
      const bytes = JSON.stringify(texts);
      if (bytes !== memo.bytes) {
        memo.bytes = bytes;
        const parsed: SeriesQueueFile[] = [];
        let torn = false;
        for (const text of texts) {
          let file: SeriesQueueFile | null = null;
          try {
            file = parseSeriesQueueFile(JSON.parse(text));
          } catch {
            // Half-written (a non-atomic PUT, MEGA's two-node window).
          }
          if (file) parsed.push(file);
          else torn = true;
        }
        const trusted = pickTrustedCopy(
          parsed,
          bunkoQueueUrl ? { kind: 'live' } : { kind: 'holder', instanceId: holder!.instance_id }
        );
        if (!trusted) {
          // Torn JSON keeps the last good copy; a copy no trusted writer made
          // (another Bunko's, before the holder rewrote it) shows nothing.
          if (!(torn && previous && previous !== EMPTY)) next = null;
        } else if (
          previous &&
          previous !== EMPTY &&
          previous.instance_id === trusted.instance_id &&
          trusted.rev < previous.rev
        ) {
          // A stale replica of an older write.
        } else {
          next = trusted;
        }
      }
    }
    memo.file = next;

    const block = await this.blockFor(provider, next, holder);
    if (this.stopped) return NONE;
    this.publish(next, block);
    memo.intervalMs = this.intervalMs(provider, block);

    if (next) {
      const watched = this.watchedInSeries();
      // A read that found no file is a real observation (the series owed
      // nothing then): a file that appears afterwards with `done` entries
      // names volumes that finished since — one queued and finished within a
      // single write window is never listed in `vols` at all.
      const stems = seriesCompletions(previous, next === EMPTY ? null : next, {
        sinceS,
        watched
      });
      // EMPTY → EMPTY, or a first read of nothing: no completions to report.
      if (stems.length > 0) {
        this.env.onCompleted({ provider, bunkoQueueUrl, folder, stems });
      }
    }
    if (!this.oneShot && this.wantsMore(memo)) this.schedule(memo.intervalMs);
    const look = { kind: 'file', file: next, block, intervalMs: memo.intervalMs } as const;
    this.lastLook = look;
    return look;
  }

  /**
   * What the last read of this loop found (null before one landed): a watched
   * volume's schedule reads it instead of the file while the page is open.
   */
  lastLook: Extract<SeriesQueueLook, { kind: 'file' }> | null = null;

  /**
   * The library-wide block a file is rendered under: its own `live` over a
   * Bunko server, else the holder's marker block. A file whose clock is newer
   * than the marker's re-reads the marker first, at most once a minute.
   */
  private async blockFor(
    provider: SyncProvider,
    file: SeriesQueueFile | null,
    holder: MarkerNodeRecord | null
  ): Promise<SeriesQueueBlock | null> {
    if (file?.live) return file.live;
    let block = holder?.series_queue ?? null;
    if (
      file &&
      file !== EMPTY &&
      block &&
      file.clock_at > (block.clock_at ?? 0) &&
      this.env.now() - lastMarkerReread >= MARKER_REREAD_SPACING_MS
    ) {
      lastMarkerReread = this.env.now();
      if (await this.env.refreshMarker(provider)) {
        block = this.env.holder(provider.type)?.series_queue ?? null;
      }
    }
    return block;
  }

  private publish(file: SeriesQueueFile | null, block: SeriesQueueBlock | null): void {
    if (!file) {
      publishSeriesQueueSlice(this.seriesKey, null);
      return;
    }
    publishSeriesQueueSlice(this.seriesKey, seriesQueueSlice(file, block));
  }

  /** The marker moved (a refit, a hold, a new or lost holder): redraw from the memo, no read. */
  private rerender(): void {
    if (this.stopped || !this.scope || !this.providerType) return;
    const memo = memos.get(this.scope);
    if (!memo) return;
    if (memo.bunko) return; // its block rides in the file
    const holder = this.env.holder(this.providerType);
    if (!holder?.series_queue) {
      publishSeriesQueueSlice(this.seriesKey, null);
      return;
    }
    if (memo.file && memo.file !== EMPTY && memo.file.instance_id !== holder.instance_id) {
      // Another Bunko holds the lease now: what the old one wrote is not its word.
      memo.file = null;
      memo.bytes = null;
    }
    if (!memo.file) {
      // A holder appeared (or changed): look now.
      if (!this.timer && !this.fetching) this.trigger();
      return;
    }
    this.publish(memo.file, holder.series_queue);
  }

  /** MEGA's live tree pushes series-file changes: a look at once (debounced) for ours. */
  private followFeed(provider: SyncProvider, folder: string): void {
    if (this.oneShot || this.offFeed || !provider.onControlFileChange) {
      this.folder = folder;
      return;
    }
    this.folder = folder;
    this.offFeed = provider.onControlFileChange((name, eventFolder) => {
      if (eventFolder === undefined || this.folder === null) return;
      if (foldFolderName(name) !== foldFolderName(SERIES_QUEUE_FILE_NAME)) return;
      if (foldFolderName(eventFolder) !== foldFolderName(this.folder)) return;
      if (this.feedTimer) return;
      this.feedTimer = setTimeout(() => {
        this.feedTimer = null;
        this.trigger();
      }, 1_000);
    });
  }

  private intervalMs(provider: SyncProvider, block: SeriesQueueBlock | null): number {
    if (provider.type === 'mega') return MEGA_SAFETY_READ_MS;
    const floor = this.env.floorS(provider.type);
    return Math.max(floor, block?.batch_s ?? 0) * 1000;
  }

  private watchedInSeries(): Set<string> {
    const prefix = `${this.seriesKey}\u0000`;
    const out = new Set<string>();
    for (const key of this.env.watchedKeys()) {
      if (key.startsWith(prefix)) out.add(key.slice(prefix.length));
    }
    return out;
  }

  /** Keep reading while the slice has jobs, a volume of the series is watched, or under 2 reads. */
  private wantsMore(memo: Memo): boolean {
    if (memo.reads < MIN_READS) return true;
    if (memo.file && memo.file.vols.size > 0) return true;
    return this.watchedInSeries().size > 0;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.read();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Tests: is a read scheduled? */
  get waiting(): boolean {
    return this.timer !== null;
  }
}

// ---------------------------------------------------------------- one per open series page

const followers = new Map<string, { follower: SeriesQueueFollower; refs: number }>();
let visibilityHooked = false;

function hookVisibility(): void {
  if (visibilityHooked || typeof document === 'undefined') return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    for (const { follower } of followers.values()) follower.onVisibilityChange();
  });
}

/**
 * Follow the OCR queue of the series page `seriesTitle` (the route's title)
 * while it is mounted; returns the stop. Two mounts of one series share one
 * loop.
 */
export function followSeriesQueue(seriesTitle: string, env: SeriesQueueEnv): () => void {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return () => {};
  hookVisibility();
  let entry = followers.get(key);
  if (!entry) {
    entry = { follower: new SeriesQueueFollower(seriesTitle, env), refs: 0 };
    followers.set(key, entry);
    entry.follower.start();
  }
  entry.refs++;
  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs--;
    if (held.refs <= 0) {
      held.follower.stop();
      if (followers.get(key) === held) followers.delete(key);
    }
  };
}

/**
 * One look at the series file of `seriesTitle` outside its page (a watched
 * volume's schedule, §8.7), through the same memo, trust, publish and
 * completion path as the page's loop: a page opened afterwards within the
 * interval costs no read. Throws on a failed read.
 */
export async function lookSeriesQueue(
  seriesTitle: string,
  env: SeriesQueueEnv
): Promise<SeriesQueueLook> {
  if (!normalizeSeriesKey(seriesTitle)) return { kind: 'none' };
  const follower = new SeriesQueueFollower(seriesTitle, env, true);
  try {
    return await follower.look();
  } finally {
    follower.stop();
  }
}

/** Tests: is a series page's loop running? */
export function seriesQueueFollower(seriesTitle: string): SeriesQueueFollower | null {
  return followers.get(normalizeSeriesKey(seriesTitle))?.follower ?? null;
}

/** Tests: stop every loop and forget every memo. */
export function resetSeriesQueueLoopForTest(): void {
  for (const { follower } of followers.values()) follower.stop();
  followers.clear();
  memos.clear();
  lastMarkerReread = -Infinity;
}
