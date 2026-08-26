import type { Readable, Subscriber, Unsubscriber } from 'svelte/store';
import { db } from './db';
import { activeAccountScope, normalizeCachePath } from './cloud-cache-key';
import type { CloudCover } from './cloud-covers';

/**
 * ONE CARD, ONE COVER, ONE KEYED READ.
 *
 * Covers used to reach a card by travelling through catalog derivation:
 * `cloudCoverMap` re-materialised EVERY cover row (blobs included) on every
 * commit to `cloud_covers`, that Map fed `volumesWithPlaceholders`, which
 * minted fresh placeholder objects, which re-rendered every mounted card.
 * Measured on a 1,027-series library: 3,886 MB deserialized in 59 s, worst
 * main-thread long task 1,784 ms. Freezing just the re-derive — same writes,
 * same reads — dropped that to 122 ms, so the freeze was the derive/render
 * chain, not the bytes.
 *
 * This module is the replacement primitive. A card asks for the cover at ONE
 * path and gets back a handle; the read is a single `IDBObjectStore.get` on
 * the `[account_scope+path]` primary key, so inserting one cover costs one
 * keyed read for the one card that wants it, never work proportional to the
 * table. Nothing here touches a store, a liveQuery, or catalog derivation.
 *
 * THE PATH MUST COME FROM THE LISTING, NOT FROM A ROW. `VolumeMetadata`'s
 * `cloudPath` is decorated onto the catalog's in-memory COPY of a row
 * (`cloudFieldsForRemovedVolume`) and is NEVER persisted —
 * `materializeSeriesVolumes`, the only writer that mints those rows, writes
 * no cloud fields at all (see `cover-install.ts`'s `foldArchiveIndex` for the
 * same finding, which cost one wasted fix before it was written down). A
 * caller that re-reads a row from Dexie and hands us its `cloudPath` will
 * hand us `undefined` and silently get a miss.
 *
 * WHAT A CARD ACTUALLY NEEDS. Both shapes, so {@link ResolvedCover} carries
 * both: `CompositeCanvas` (the catalog card) decodes a `File` through
 * `thumbnailCache`, while `PlaceholderThumbnail` / `CatalogListItem` paint an
 * `<img src>` from an object URL. The URL is created LAZILY, on first read of
 * `.url`, so the ~4,000 canvas-drawn covers of a large catalog never mint one
 * — and it is revoked exactly once, when the last holder releases.
 */
export interface ResolvedCover {
  /** The cached cover blob, for `thumbnailCache`-style decoding. */
  file: File;
  width: number;
  height: number;
  /**
   * An object URL over {@link file}, created on FIRST ACCESS and shared by
   * every holder of this path. Revoked once the last holder releases, so a
   * reader must not stash it past its handle's lifetime.
   *
   * Note for tests: jsdom implements neither `URL.createObjectURL` nor
   * `URL.revokeObjectURL`, so a test that reads this must stub them (see
   * `PlaceholderThumbnail.test.ts` for the established shape). A test that
   * never reads it needs no stub — that is the point of it being lazy.
   */
  readonly url: string;
}

/**
 * One holder's claim on one path's cover.
 *
 * A Svelte `Readable`, so a component can `$handle` it or subscribe by hand.
 * `subscribe` is only a notification channel: the CLAIM is the acquire, and
 * every {@link acquireCover} must be paired with exactly one
 * {@link CoverHandle.release}. Releasing also detaches this handle's own
 * subscriptions, so a caller that releases cannot keep receiving.
 */
export interface CoverHandle extends Readable<ResolvedCover | undefined> {
  /** The resolved cover, or `undefined` while unread, on a miss, or once released. */
  readonly current: ResolvedCover | undefined;
  /**
   * Settles when the CURRENT keyed read finishes — hit or miss, never
   * rejecting. Re-read as a getter after {@link refreshCovers}: a refresh of
   * an already-settled handle installs a NEW promise. A refresh that lands
   * while a read is still in flight instead keeps THIS promise pending until
   * the re-read settles, so a caller already awaiting it is never handed the
   * pre-write snapshot that the refresh exists to correct.
   */
  readonly ready: Promise<ResolvedCover | undefined>;
  /** Idempotent. The last release drops the entry and revokes its object URL. */
  release(): void;
}

interface CoverEntry {
  key: string;
  scope: string;
  /** Already through `normalizeCachePath`. */
  path: string;
  refs: number;
  value: ResolvedCover | undefined;
  /** A read has completed (hit or miss); do not read again without a refresh. */
  settled: boolean;
  reading: boolean;
  /**
   * A {@link refreshCovers} that arrived while a read was in flight, to be
   * honoured by {@link settle} — `'force'` re-reads unconditionally, `'miss'`
   * only if the finished read is still a miss. See `refreshCovers`.
   */
  pendingRefresh: 'miss' | 'force' | null;
  /** Identity of the ROW behind {@link value}; see {@link coverSignature}. */
  signature: string | null;
  /** Non-null only once someone has read `ResolvedCover.url`. */
  url: string | null;
  ready: Promise<ResolvedCover | undefined>;
  resolveReady: ((value: ResolvedCover | undefined) => void) | null;
  subscribers: Set<Subscriber<ResolvedCover | undefined>>;
}

/**
 * Live entries by `<scope>\0<normalized path>`.
 *
 * Keyed by SCOPE as well as path so switching accounts cannot serve one
 * account's blob under the other's path — the same discipline `cloud_covers`'
 * composite primary key enforces on disk. An entry lives exactly as long as
 * someone holds it: the last `release()` deletes it, so a card that unmounts
 * and remounts gets a fresh read (which is also how a cover that landed while
 * the card was gone gets picked up).
 */
const entries = new Map<string, CoverEntry>();

/** The already-settled `ready` for anything that can never resolve: an unheld path, a released handle. */
const RESOLVED_MISS: Promise<ResolvedCover | undefined> = Promise.resolve(undefined);

/**
 * The keyed read, and the whole point of this module.
 *
 * `IDBObjectStore.get` on the composite primary key — ONE row, one round
 * trip, cost independent of how many covers the table holds. Deliberately not
 * `getCloudCovers(scope, [path])`: that one is shaped for a path SET and goes
 * through `where(...).anyOf(...)`, which is fine but makes "this is a point
 * read" something you have to reason about rather than see. The op-count
 * contract in the test file asserts the shape directly (`cloud_covers.get`
 * exactly 1; no `getAll`, no cursor, no index read), and a scan reintroduced
 * here fails it.
 */
async function readCover(scope: string, path: string): Promise<CloudCover | undefined> {
  return db.cloud_covers.get([scope, path]);
}

/**
 * Which stored row a resolved value came from, as a comparable string.
 *
 * Used to answer "is this re-read the cover we are already showing?", which
 * cannot be answered by object identity: IndexedDB structured-CLONES on every
 * read, so two reads of one unchanged row hand back two different `File`
 * objects (verified against fake-indexeddb, and it is what the spec requires
 * of a real one) — an identity check would be permanently false and the
 * replacement it is meant to skip would always happen. These are exactly the
 * fields that survive the clone, and `cached_at` is the decisive one: it is
 * stamped once per WRITE and never refreshed (see `cloud-covers.ts`), so an
 * overwrite — the self-heal case a forced refresh exists for — always changes
 * it, while a re-read of untouched bytes never does.
 */
function coverSignature(row: CloudCover): string {
  const file = row.thumbnail;
  return [
    row.cached_at,
    row.width,
    row.height,
    file.size,
    file.type,
    file.name,
    file.lastModified
  ].join('\u0000');
}

function makeResolved(entry: CoverEntry, row: CloudCover): ResolvedCover {
  const file = row.thumbnail;
  /**
   * The URL this value has already handed out, so it can hand out the same
   * one after it stops being the entry's live value.
   *
   * A holder can outlive the value it holds — an async decode continuation, a
   * stale reactive read — and both `dropEntry` and a replacing `settle` leave
   * `entry.url` null. A getter that minted whenever it found null would then
   * create a FRESH object URL against an entry no longer in `entries`, which
   * nothing can ever revoke (one per churned card, at 1,027 cards); on the
   * replacement path it would do something worse still — park its own bytes'
   * URL in `entry.url`, where the LIVE value's getter would find it and paint
   * the superseded cover.
   */
  let minted = '';
  const resolved: ResolvedCover = {
    file,
    width: row.width,
    height: row.height,
    get url(): string {
      // Not the entry's live value any more (released, or superseded): give
      // back what was already given, and mint nothing.
      if (entry.value !== resolved) return minted;
      if (entry.url === null) entry.url = URL.createObjectURL(file);
      minted = entry.url;
      return minted;
    }
  };
  return resolved;
}

/**
 * Give up this entry's object URL, at most once.
 *
 * The field is cleared BEFORE the revoke call so a throwing
 * `revokeObjectURL` (or an environment that has none — jsdom) can never leave
 * a URL that a later release would revoke a second time.
 */
function revokeEntryUrl(entry: CoverEntry): void {
  const url = entry.url;
  if (url === null) return;
  entry.url = null;
  try {
    URL.revokeObjectURL(url);
  } catch (error) {
    console.debug('[cover-resolver] could not revoke a cover object URL:', error);
  }
}

function emit(entry: CoverEntry): void {
  // Over a COPY, and of one captured value: a subscriber may release
  // synchronously from inside its own callback, and that release can run
  // `dropEntry`, which clears this set and blanks `entry.value` mid-broadcast.
  // Iterating the set itself would silently skip every subscriber after that
  // one — the cover would reach the first card and no other.
  const value = entry.value;
  for (const run of [...entry.subscribers]) run(value);
}

function settle(entry: CoverEntry, row: CloudCover | undefined): void {
  // Cleared HERE and not in a trailing `.finally`, so "the read is over" and
  // "`ready` has resolved" are the same instant. A `.finally` runs a microtask
  // LATER than the `ready` continuation it competes with, which left a
  // `refreshCovers` issued straight after an `await handle.ready` looking at
  // `reading === true` and silently skipping its re-read.
  entry.reading = false;
  entry.settled = true;
  const next = row ? makeResolved(entry, row) : undefined;
  const signature = row ? coverSignature(row) : null;
  // A forced re-read that came back with the SAME row must leave the live
  // value (and its object URL) alone: replacing it revokes a URL a holder may
  // have painted imperatively into an `<img src>`, which subscribing cannot
  // repair because nothing about the cover actually changed.
  const sameCover =
    next !== undefined && entry.value !== undefined && entry.signature === signature;
  const changed = !sameCover && !(next === undefined && entry.value === undefined);
  if (changed) {
    // An overwrite (a self-heal cover replacing an earlier one) points the old
    // URL at bytes nobody will show again.
    revokeEntryUrl(entry);
    entry.value = next;
    entry.signature = signature;
  }

  // A refresh that arrived DURING this read is not answered by this row. The
  // read's readonly snapshot can pre-date the write that prompted the refresh
  // — which is precisely the ingest sequence: card mounts, read is issued,
  // cover commits, the keys-only liveQuery calls `refreshCovers`. Honouring it
  // here (rather than letting `startRead`'s `reading` bail swallow it) is what
  // keeps that card from settling on the pre-write miss and staying blank
  // until it remounts. `ready` is deliberately left UNRESOLVED across the
  // re-read, so a caller already awaiting it gets the answer that includes the
  // write instead of the snapshot that missed it.
  const pending = entry.pendingRefresh;
  entry.pendingRefresh = null;
  if (pending === 'force' || (pending === 'miss' && entry.value === undefined)) {
    entry.settled = false;
    if (changed) emit(entry);
    startRead(entry);
    return;
  }

  const resolveReady = entry.resolveReady;
  entry.resolveReady = null;
  resolveReady?.(entry.value);
  if (changed) emit(entry);
}

function startRead(entry: CoverEntry): void {
  // Bailing on `reading` is safe only because a refresh that finds a read in
  // flight parks itself on `entry.pendingRefresh` instead of calling here
  // (see `refreshCovers`) — dropping it silently is what left cards blank.
  if (entry.reading || entry.settled) return;
  entry.reading = true;
  if (entry.resolveReady === null) {
    entry.ready = new Promise((resolve) => {
      entry.resolveReady = resolve;
    });
  }
  void readCover(entry.scope, entry.path).then(
    (row) => {
      // Dropped mid-read (last holder released): applying now would resurrect
      // a dead entry and mint an object URL with nobody left to revoke it.
      if (entries.get(entry.key) === entry) settle(entry, row);
    },
    (error) => {
      // A failed read is a miss, never a rejection reaching a card.
      console.debug('[cover-resolver] keyed cover read failed:', error);
      if (entries.get(entry.key) === entry) settle(entry, undefined);
    }
  );
}

function dropEntry(entry: CoverEntry): void {
  // Not `entries.delete(entry.key)` unconditionally: this entry may already
  // have been replaced under its key (dropped mid-read, then re-acquired), and
  // evicting the LIVE entry would strand its holders — `refreshCovers` would
  // no longer find them, so their covers would never arrive.
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  entry.subscribers.clear();
  entry.value = undefined;
  entry.signature = null;
  entry.pendingRefresh = null;
  entry.settled = false;
  revokeEntryUrl(entry);
  const resolveReady = entry.resolveReady;
  entry.resolveReady = null;
  resolveReady?.(undefined);
}

/** A handle for "there is nothing to resolve": no account, or no path. */
function detachedHandle(): CoverHandle {
  return {
    get current() {
      return undefined;
    },
    get ready() {
      return RESOLVED_MISS;
    },
    subscribe(run: Subscriber<ResolvedCover | undefined>): Unsubscriber {
      run(undefined);
      return () => {};
    },
    release() {}
  };
}

function makeHandle(entry: CoverEntry): CoverHandle {
  const mine = new Set<Subscriber<ResolvedCover | undefined>>();
  let released = false;

  return {
    get current() {
      return released ? undefined : entry.value;
    },
    get ready() {
      return released ? RESOLVED_MISS : entry.ready;
    },
    subscribe(run: Subscriber<ResolvedCover | undefined>, _invalidate?: () => void): Unsubscriber {
      if (released) {
        run(undefined);
        return () => {};
      }
      entry.subscribers.add(run);
      mine.add(run);
      run(entry.value);
      return () => {
        entry.subscribers.delete(run);
        mine.delete(run);
      };
    },
    release() {
      if (released) return;
      released = true;
      for (const run of mine) entry.subscribers.delete(run);
      mine.clear();
      entry.refs--;
      if (entry.refs <= 0) dropEntry(entry);
    }
  };
}

/**
 * Claim the cached cover for one cloud path, reading it by key.
 *
 * The FIRST claim on a path issues the read; every later claim joins the same
 * entry and issues none — two cards showing the same volume cost one
 * `cloud_covers.get` between them, and a claim made after the read settled
 * gets the answer with no read at all.
 *
 * `path` is the ARCHIVE path from the current cloud listing (what every
 * `cloud_covers` writer keys on — see `cover-install.ts`), normalized here so
 * a caller cannot land on a key nothing else uses. A blank path, or no
 * connected account, yields a handle that is permanently `undefined` and
 * never touches the database — a miss, never a throw.
 *
 * Pair every call with exactly one {@link CoverHandle.release}.
 */
export function acquireCover(path: string | null | undefined): CoverHandle {
  const scope = activeAccountScope();
  const normalized = path ? normalizeCachePath(path) : '';
  if (!scope || !normalized) return detachedHandle();

  const key = `${scope}\u0000${normalized}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      key,
      scope,
      path: normalized,
      refs: 0,
      value: undefined,
      settled: false,
      reading: false,
      pendingRefresh: null,
      signature: null,
      url: null,
      ready: RESOLVED_MISS,
      resolveReady: null,
      subscribers: new Set()
    };
    entries.set(key, entry);
  }
  entry.refs++;
  startRead(entry);
  return makeHandle(entry);
}

/**
 * Re-read the covers for `paths` that someone is currently holding.
 *
 * TASK 2/3 MUST WIRE THIS. A handle is read once and then never again on its
 * own — that is what makes "two subscribers, one read" unconditional, but it
 * also means a card that resolved a MISS before its cover finished
 * downloading would stay blank until it remounted. Drive this from the
 * keys-only cover key set (the liveQuery that replaces `cloudCoverMap`): when
 * a path appears in it, refresh that path.
 *
 * Self-limiting by default: only handles that are still a miss are re-read,
 * so handing this the whole key set costs a Map lookup per path and issues a
 * read only for the cards actually waiting on one. Paths nobody holds are
 * skipped entirely.
 *
 * `force` re-reads even a resolved handle, for a genuine overwrite (a
 * self-heal cover replacing stale bytes); the superseded object URL is
 * revoked when the new value lands — but only if the row that lands really is
 * a different one (see {@link coverSignature}), so a forced re-read of
 * unchanged bytes leaves the live URL intact.
 *
 * A path whose read is still IN FLIGHT is refreshed too, after that read
 * settles: the in-flight read may have snapshotted the store before the write
 * being announced here, and dropping the refresh in that window is what would
 * leave a card blank for the rest of its mount.
 */
export function refreshCovers(paths: Iterable<string>, options: { force?: boolean } = {}): void {
  const scope = activeAccountScope();
  if (!scope) return;
  for (const raw of paths) {
    const normalized = raw ? normalizeCachePath(raw) : '';
    if (!normalized) continue;
    const entry = entries.get(`${scope}\u0000${normalized}`);
    if (!entry) continue;
    if (!options.force && entry.value !== undefined) continue;
    if (entry.reading) {
      // The read in flight CANNOT be trusted to answer this refresh: its
      // readonly snapshot may have been taken before the write that prompted
      // it, and `startRead` bails on `reading`, so nothing would be issued and
      // the card would settle on the pre-write miss and stay blank until it
      // remounted. Record the intent instead; `settle` re-enters `startRead`
      // once this read lands. A plain refresh cannot downgrade a pending
      // `force`.
      if (options.force || entry.pendingRefresh === null) {
        entry.pendingRefresh = options.force ? 'force' : 'miss';
      }
      continue;
    }
    entry.settled = false;
    startRead(entry);
  }
}

/** Test hook: drop every entry (revoking any live object URL) as if all holders released. */
export function _resetCoverResolverForTests(): void {
  for (const entry of [...entries.values()]) dropEntry(entry);
  entries.clear();
}

/** Test hook: how many paths are currently held — 0 means nothing leaked. */
export function _heldCoverCountForTests(): number {
  return entries.size;
}
