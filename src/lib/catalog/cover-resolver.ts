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
   * rejecting. Re-read as a getter after {@link refreshCoverKeys}: a refresh of
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
   * A {@link refreshCoverKeys} that arrived while a read was in flight, to be
   * honoured by {@link settle} — but only if the finished read is still a
   * miss, which is the same rule a refresh applies to a settled entry. See
   * `refreshCoverKeys`.
   */
  pendingRefresh: boolean;
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
 * a `where(...).anyOf(...)` over a one-element path set. That is the shape the
 * old blob-returning read had — `_getCloudCoversForTests` still keeps it, for
 * tests — and it works, but it makes "this is a point read" something you have
 * to reason about rather than see. The op-count contract in the test file
 * asserts the shape directly (`cloud_covers.get` exactly 1; no `getAll`, no
 * cursor, no index read), and a scan reintroduced here fails it.
 */
async function readCover(scope: string, path: string): Promise<CloudCover | undefined> {
  return db.cloud_covers.get([scope, path]);
}

function makeResolved(entry: CoverEntry, row: CloudCover): ResolvedCover {
  const file = row.thumbnail;
  /**
   * The URL this value has already handed out, so it can hand out the same
   * one after it stops being the entry's live value.
   *
   * A holder can outlive the value it holds — an async decode continuation, a
   * stale reactive read — and `dropEntry` blanks `entry.value` and `entry.url`
   * the moment the last holder releases. A getter that minted whenever it
   * found null would then create a FRESH object URL against an entry no longer
   * in `entries`, which nothing can ever revoke: one permanent leak per
   * churned card, at 1,027 cards.
   */
  let minted = '';
  const resolved: ResolvedCover = {
    file,
    width: row.width,
    height: row.height,
    get url(): string {
      // Not the entry's live value any more (its holders all released): give
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
  // `refreshCoverKeys` issued straight after an `await handle.ready` looking at
  // `reading === true` and silently skipping its re-read.
  entry.reading = false;
  entry.settled = true;
  // A FILL, NEVER A REPLACEMENT. A read can only ever settle onto an entry
  // that has no value: `acquireCover` and `startRead` both bail on a settled
  // entry, and `refreshCoverKeys` re-reads only a handle that is still a miss —
  // so `entry.value` is `undefined` on arrival here, and with it `entry.url`
  // (one is minted only for a LIVE value). That is what makes this three
  // lines instead of a row-identity comparison, an object-URL revoke and a
  // replacement branch: those existed for a forced re-read that no production
  // path ever issued (see {@link refreshCoverKeys}), and a `cloud_covers` row is
  // written once and never rewritten (see `cloud-covers.ts`). Anything that
  // makes an overwrite reachable has to bring all three back with it.
  const next = row ? makeResolved(entry, row) : undefined;
  if (next !== undefined) entry.value = next;

  // A refresh that arrived DURING this read is not answered by this row. The
  // read's readonly snapshot can pre-date the write that prompted the refresh
  // — which is precisely the ingest sequence: card mounts, read is issued,
  // cover commits, the keys-only liveQuery calls `refreshCoverKeys`. Honouring it
  // here (rather than letting `startRead`'s `reading` bail swallow it) is what
  // keeps that card from settling on the pre-write miss and staying blank
  // until it remounts. `ready` is deliberately left UNRESOLVED across the
  // re-read, so a caller already awaiting it gets the answer that includes the
  // write instead of the snapshot that missed it.
  const pending = entry.pendingRefresh;
  entry.pendingRefresh = false;
  if (pending && entry.value === undefined) {
    entry.settled = false;
    startRead(entry);
    return;
  }

  const resolveReady = entry.resolveReady;
  entry.resolveReady = null;
  resolveReady?.(entry.value);
  if (next !== undefined) emit(entry);
}

function startRead(entry: CoverEntry): void {
  // Bailing on `reading` is safe only because a refresh that finds a read in
  // flight parks itself on `entry.pendingRefresh` instead of calling here
  // (see `refreshCoverKeys`) — dropping it silently is what left cards blank.
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
  // evicting the LIVE entry would strand its holders — `refreshCoverKeys` would
  // no longer find them, so their covers would never arrive.
  if (entries.get(entry.key) === entry) entries.delete(entry.key);
  entry.subscribers.clear();
  entry.value = undefined;
  entry.pendingRefresh = false;
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

/** Has the keys-only cover watch been started for this session yet? */
let coverKeyWatchStarted = false;

/**
 * Start the thing that drives {@link refreshCoverKeys}, at most once, ON THE
 * CLAIM PATH.
 *
 * `initCoverKeyWatch` (in `cloud-covers-store.ts`) is the ONLY production
 * subscriber to the keys-only cover key set, so it is also what keeps that
 * liveQuery alive — and it is what tells a handle that resolved a MISS
 * mid-ingest that its cover has landed. It used to be called from
 * `+layout.svelte`, one `init*` among many: deleting that single line would
 * have left every late-arriving cover silently unable to reach a mounted
 * card, with every test still green, because the store's own tests call
 * `initCoverKeyWatch` themselves. A driver that can be orphaned by an
 * unrelated edit to an unrelated file is not wired; it is coincidence.
 *
 * Starting it HERE makes the wiring structural: the only way to hold a cover
 * is to acquire one, and acquiring one starts the watch. Lazy, so an app that
 * never draws a cloud cover never subscribes to the cloud listing at all.
 *
 * DYNAMIC IMPORT, deliberately. `cloud-covers-store.ts` imports
 * `refreshCoverKeys` from this module; a static import back would close that
 * into a cycle. Deferring it keeps the module graph one-way (store →
 * resolver) and keeps the listing subscription off the critical path of the
 * first claim. A failure to start is logged and never thrown: a card that
 * cannot get live refreshes still paints whatever its own read found.
 */
function ensureCoverKeyWatch(): void {
  if (coverKeyWatchStarted) return;
  coverKeyWatchStarted = true;
  void import('./cloud-covers-store')
    .then(({ initCoverKeyWatch }) => {
      initCoverKeyWatch();
    })
    .catch((error) => {
      console.debug('[cover-resolver] could not start the cover key watch:', error);
    });
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
  // Before the guards below: a claim made while nothing is connected yet is
  // still this session's first sign that someone wants covers, and the watch
  // has to be running by the time one lands.
  ensureCoverKeyWatch();
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
      pendingRefresh: false,
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
 * Re-read the covers for the held handles at `keys`.
 *
 * A handle is read once and then never again on its own — that is what makes
 * "two subscribers, one read" unconditional, but it also means a card that
 * resolved a MISS before its cover finished downloading would stay blank until
 * it remounted. This is the repair, and `initCoverKeyWatch`
 * (`cloud-covers-store.ts`) is what drives it off the keys-only cover key set:
 * a path APPEARING in that set is the signal that its cover is now on disk.
 *
 * KEYS, ALREADY NORMALIZED — not raw listing paths. Every producer of a cover
 * key folds it on the way in (`putCloudCovers` when writing, `cachedCoverPaths`
 * when reading them back) and `acquireCover` folds at the door, so a path is
 * normalized exactly once, and it is not here. Re-folding was an NFC normalise,
 * a split, a filter and a join PER KEY PER COVER WRITE — invisible to the byte
 * contract, since a keys-only cursor deserializes nothing — over a set that was
 * the whole library. A caller holding a raw provider path must run it through
 * `normalizeCachePath` itself.
 *
 * Self-limiting: only handles that are still a miss are re-read, and keys
 * nobody holds are skipped. That bounds the READS, not the walk — the caller
 * is responsible for not handing this the whole library on every cover write,
 * which is why `initCoverKeyWatch` passes only the keys that just landed.
 *
 * NO `force`, DELIBERATELY. There was one, for the self-heal case: a cover
 * whose bytes change under a path that does not. Nothing could ever call it —
 * NOT because a `cloud_covers` row can never be rewritten. It can:
 * `putCloudCovers` is a `bulkPut`, and `cover-persist.ts`'s ROUTING sends a
 * self-healed cover for a `volumes` row with NO relationship (a
 * `metadata_only` row — a thumbnail, but nothing installed and no reading
 * activity) right back through this same table, overwriting the row at the
 * same key. What's actually true is narrower: that overwrite changes no KEY,
 * and the only thing that would ever call `refreshCoverKeys` with `force` is
 * a key-set diff watching for paths that just LANDED (`initCoverKeyWatch`,
 * off `cachedCoverPathSet`'s liveQuery). A same-key overwrite is invisible to
 * that diff — it emits nothing either way — so nothing ever observes the
 * self-heal to go call the forced re-read in the first place. A held handle
 * just keeps showing the picture it already resolved until it next remounts
 * and reads the row fresh: stale until then, never blank, never lost. Do NOT
 * reinstate `force` to "fix" that staleness — the gap is upstream, in what
 * announces a write, not in what a forced read would do with one it never
 * gets told about. The 14-day TTL prune only DELETES rows; a held handle
 * still showing a pruned row's blob is showing the same picture, and a
 * forced re-read there would blank the card rather than heal it. So a
 * re-read of a resolved handle had nothing new to find, and paid for the
 * possibility with a row-identity comparison and a revoke-on-replace branch
 * in `settle`. Reinstating it means reinstating those: replacing a live
 * value revokes an object URL a holder may already have painted into an
 * `<img src>`, which subscribing cannot repair.
 *
 * A key whose read is still IN FLIGHT is refreshed too, after that read
 * settles: the in-flight read may have snapshotted the store before the write
 * being announced here, and dropping the refresh in that window is what would
 * leave a card blank for the rest of its mount.
 */
export function refreshCoverKeys(keys: Iterable<string>): void {
  const scope = activeAccountScope();
  if (!scope) return;
  for (const key of keys) if (key) refreshOne(scope, key);
}

/** One already-normalized path, for whoever is holding it. */
function refreshOne(scope: string, path: string): void {
  const entry = entries.get(`${scope}\u0000${path}`);
  // Nobody holds it, or the holder already has its cover: there is nothing a
  // re-read could tell them (see `refreshCoverKeys` on why `force` is gone).
  if (!entry || entry.value !== undefined) return;
  if (entry.reading) {
    // The read in flight CANNOT be trusted to answer this refresh: its
    // readonly snapshot may have been taken before the write that prompted
    // it, and `startRead` bails on `reading`, so nothing would be issued and
    // the card would settle on the pre-write miss and stay blank until it
    // remounted. Record the intent instead; `settle` re-enters `startRead`
    // once this read lands.
    entry.pendingRefresh = true;
    return;
  }
  entry.settled = false;
  startRead(entry);
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
