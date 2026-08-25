import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import type { VolumeMetadata } from '$lib/types';
import { providerManager } from '$lib/util/sync/provider-manager';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { isCbzFile } from '$lib/util/sync/syncable-file';
import { isCatalogFilePath } from './catalog-file';
import { scheduleCatalogFileWrite } from './catalog-file-sync';
import { hasSeriesFacts, isSeriesFilePath } from './series-file';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from './series-key';
import { backfillNewlyLinkedSeries, backfillSeriesEntries } from './series-backfill';
import {
  getAllSeriesMetadata,
  registerFactsChangeListener,
  registerIndexChangeListener
} from './store';

/**
 * The automatic half of the `series.json` index: local fact edits (link,
 * unlink, titles, synonyms, tag) publish themselves to the cloud after a short
 * quiet period. There is no button — the file is a cache of what the library
 * already knows, and a user editing a title should not have to think about it.
 *
 * Three rules keep this from becoming a nuisance or a loop:
 *
 * - Debounced per series, so typing in the tag field writes once, not per keystroke.
 * - Gated on a *writable* connected provider and on the series having either a
 *   backup or local facts for an existing cloud folder — publishing an index
 *   for a series that exists nowhere in the cloud would create folders out of
 *   thin air.
 * - Driven by `registerFactsChangeListener` and `registerIndexChangeListener`,
 *   which only fire for local edits — facts, or the shelf alignment. Anything
 *   arriving FROM a sidecar (`upsertFromSeriesFile`) never schedules a write,
 *   so two devices cannot ping-pong the same file.
 * - Preceded by ONE cloud listing refresh per flush (shared by every series in
 *   it), because the write merges and prunes against that listing.
 *
 * Failures are logged and dropped: the next edit or backup rewrites the file.
 */

/** Long enough to swallow a burst of field edits, short enough to feel immediate. */
export const SERIES_FILE_WRITE_DEBOUNCE_MS = 2000;

/** series_key → pending timer. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** series_key → the title to write with (the folder name, never derived). */
const pendingTitles = new Map<string, string>();
/** series_key → the options the pending write was last scheduled with. */
const pendingOptions = new Map<string, ScheduleOptions>();

interface ScheduleOptions {
  /**
   * This write was scheduled from inside a backup run's own upload-completion
   * handler (`backup-queue.ts`'s `noteSeriesNeedingIndexWrite` call sites),
   * not from a fact edit or the reconcile pass.
   *
   * DECISION (2026-08-23, user-directed amendment): a run-scheduled write must
   * cost the queue nothing extra —
   *
   * 1. No `ensureFreshCloudListing()` call. A run primes the listing before
   *    it starts uploading and adds every upload to the provider's file cache
   *    via `cache.add` as it goes (see `uploadFile`); that is already the
   *    freshest truth mid-run; a debounced write's own whole-account refetch
   *    would just be pure waste layered on top, exactly the case the design
   *    was written to avoid. This is the saving that mattered — one
   *    whole-account fetch per write, gone.
   * 2. The 2 s debounce stays. It was never contention control — the
   *    concurrency cap and the per-series serialized write chain already
   *    make concurrent writes race-free — it is PUT-rate coalescing: ten
   *    volumes finishing within the window still cost one or two PUTs
   *    instead of ten.
   *
   * REVISION (2026-08-23, review): this option no longer suppresses the
   * WRITER's own `series.json` re-read, which an earlier draft forwarded as
   * `writeSeriesFile(title, { skipRemoteRefresh: true })` in the name of "zero
   * network reads". That read is gated on the cloud listing showing a stamp our
   * cached record does not have: for a write of OUR OWN the stamp matches and
   * nothing is fetched anyway, so the flag bought nothing there — the only time
   * it fired was when ANOTHER device had written the file, and suppressing it
   * exactly there meant the mid-run PUT overwrote that device's index with our
   * stale cached copy. The zero-read intent survives for every self-write path
   * it was written for; the rare foreign-write case pays one GET, which is the
   * price of not clobbering.
   */
  duringBackupRun?: boolean;
}

/** Is there a connected provider that can actually be written to? */
function hasWritableProvider(): boolean {
  const status = get(providerManager.status);
  if (!status.hasAnyAuthenticated) return false;
  const type = status.currentProviderType;
  if (!type) return false;
  return status.providers[type]?.isReadOnly !== true;
}

/**
 * Does this series have at least one volume backed up? Checked per volume
 * against the cloud listing rather than "the folder exists", so a stray sidecar
 * or an empty folder does not qualify.
 *
 * Both sides folded with `normalizeVolumeTitleKey` — the SERIES title and the
 * volume titles — because a backend that decomposes names decomposes the
 * filenames too, not just the folder. The listing's `.cbz` titles are matched
 * exactly the way `buildSeriesFile`'s prune matches them, so this gate and the
 * file it gates agree about which volumes the cloud is showing.
 *
 * The FOLDER half is folded inside `cloudVolumeTitlesFor`, which resolves the
 * title to the folder name the listing spells (see `resolveCloudFolderTitle`) —
 * `seriesTitle` here is the listing's own spelling when the reconcile pass
 * scheduled the write, but the local composed one for every fact edit and
 * per-completion schedule, and both have to find the same folder or the write is
 * dropped for good once the folder has a series.json.
 *
 * A byte-wise match here disagrees with `reconcileMissingMetadataFiles`, which
 * folds before scheduling: the folder would be scheduled, dropped here, and
 * scheduled again on the very next listing — forever, at one volumes scan each.
 *
 * The listing is read first so a folder with no archive costs no table scan.
 */
async function hasBackedUpVolume(seriesTitle: string): Promise<boolean> {
  const cloudKeys = new Set(
    [...unifiedCloudManager.cloudVolumeTitlesFor(seriesTitle)].map(normalizeVolumeTitleKey)
  );
  if (cloudKeys.size === 0) return false;

  const key = normalizeVolumeTitleKey(seriesTitle);
  const volumes = (await db.volumes.toArray()) as VolumeMetadata[];
  return volumes.some((volume) => {
    if (volume.isPlaceholder) return false;
    if (normalizeVolumeTitleKey(volume.series_title) !== key) return false;
    return cloudKeys.has(normalizeVolumeTitleKey(volume.volume_title));
  });
}

/**
 * Facts with a folder to land in: the user linked or named a series this
 * device holds nothing of (a placeholder library, browsed straight off the
 * cloud). A facts-only `series.json` is worth publishing INTO AN EXISTING
 * folder — the volume entries fill in later: a download here, another device's
 * backup, or a server (bunko) compiling them from the archives it holds. But a
 * folder is never CREATED for facts: a local-only series that was never backed
 * up has no cloud seat for them yet, and a factless series has nothing to say.
 *
 * Matched by folded title against the whole metadata table, never by keyed
 * lookup: `seriesTitle` may be the listing's own (possibly NFD) spelling when
 * the reconcile pass scheduled the write, while the record was keyed off the
 * composed local title. A byte-wise `get` would miss, the write would drop, and
 * the reconcile pass would schedule it again on every listing — the loop
 * `locallyKnownSeriesKeys` exists to prevent, so both use the same fold.
 */
async function hasPublishableFacts(seriesTitle: string): Promise<boolean> {
  if (unifiedCloudManager.cloudVolumeTitlesFor(seriesTitle).size === 0) return false;
  const key = normalizeVolumeTitleKey(seriesTitle);
  const metas = await getAllSeriesMetadata();
  return Object.values(metas).some(
    (meta) => normalizeVolumeTitleKey(meta.series_title) === key && hasSeriesFacts(meta)
  );
}

/**
 * The link-event trigger for the sidecar backfill: a fact edit just made
 * `series.json` PUBLISHABLE for a series this device has nothing local for
 * (the exact `hasBackedUpVolume` false / `hasPublishableFacts` true split that
 * decides whether `runWrite` below publishes a facts-only file into an
 * existing cloud folder). That is precisely "a series the user linked without
 * downloading anything" from the feature's own framing — worth converging
 * immediately rather than waiting for a later series open or reconcile pass.
 *
 * Hooked off the FACTS-CHANGE side deliberately, never off `writeSeriesFile`'s
 * own completion: the backfill's own publish goes through that same function,
 * and hooking a trigger onto "a write just finished" would have the backfill
 * re-enqueue itself. `registerFactsChangeListener` only fires for a genuine
 * local fact edit (never for `upsertFromSeriesFile`, which applies what a
 * sidecar already says), so there is no such loop here.
 *
 * Every other gate (writable provider, not server-compiled, one in flight per
 * series) is still enforced inside `backfillNewlyLinkedSeries` itself — this
 * only decides whether the "nothing local for this series" precondition
 * holds. Best-effort: never throws, never surfaces UI.
 */
async function maybeBackfillNewlyLinkedSeries(seriesTitle: string): Promise<void> {
  try {
    if (await hasBackedUpVolume(seriesTitle)) return;
    if (!(await hasPublishableFacts(seriesTitle))) return;
    await backfillNewlyLinkedSeries(seriesTitle);
  } catch (error) {
    console.debug(`[series-file-sync] could not backfill newly linked '${seriesTitle}':`, error);
  }
}

/**
 * The listing refresh shared by everything flushed together, or `null` between
 * flushes.
 *
 * `writeSeriesFile` merges on top of the cloud copy the listing points at and
 * prunes against the volumes the listing shows, so a listing that predates
 * another device's write would erase that device's link and its newer volumes
 * on every edit. The refresh closes that window — but there is no per-folder
 * listing in the provider interface, so it is a whole-account fetch and a
 * burst of edits must not stack one per series: the first flusher starts it and
 * everyone flushed while it is in flight awaits the same promise. A listing
 * that succeeded within `LISTING_TTL_MS` is reused outright (an import batch or
 * a tagging spree schedules one flush per series), and a refresh that hangs
 * past `LISTING_TIMEOUT_MS` counts as failed so it cannot pin the writer for
 * the rest of the session.
 */
let listingRefresh: Promise<boolean> | null = null;
let lastListingAt = 0;
export const LISTING_TTL_MS = 30_000;
export const LISTING_TIMEOUT_MS = 60_000;

/**
 * Record that a whole-account listing just completed OUTSIDE this module, so
 * `ensureFreshCloudListing()` reuses it for the rest of the TTL.
 *
 * The backup run fetches that listing itself before publishing its indexes;
 * without this stamp the writes it triggers would immediately fetch the whole
 * account a second time. Only for callers that really did fetch everything —
 * the TTL still applies, so a stamp cannot license writes against an ancient
 * view forever.
 */
export function markListingFresh(): void {
  lastListingAt = Date.now();
}

/** Test hook: forget the last successful listing time and any in-flight refresh. */
export function _resetListingRefreshForTests(): void {
  listingRefresh = null;
  lastListingAt = 0;
}

/**
 * Refresh the cloud listing (coalesced, TTL-cached). `false` = the view is still
 * stale. Shared by both metadata writers (`series.json` and `catalog.json`):
 * both merge and prune against the listing, and a burst of edits must cost at
 * most one whole-account fetch.
 */
export function ensureFreshCloudListing(): Promise<boolean> {
  if (listingRefresh) return listingRefresh;
  if (lastListingAt && Date.now() - lastListingAt < LISTING_TTL_MS) return Promise.resolve(true);

  // Deferred to a microtask so the promise identity below exists before the
  // body can settle, whatever the provider does synchronously.
  const refresh = Promise.resolve().then(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // No index refresh: that pass downloads sidecars, and this is a write
      // path that is about to publish one.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`listing refresh exceeded ${LISTING_TIMEOUT_MS} ms`)),
          LISTING_TIMEOUT_MS
        );
      });
      await Promise.race([
        unifiedCloudManager.fetchAllCloudVolumes({ refreshIndexes: false }),
        timeout
      ]);
      lastListingAt = Date.now();
      return true;
    } catch (error) {
      console.debug('[series-file-sync] could not refresh the cloud listing:', error);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  listingRefresh = refresh;
  // Cleared once settled, so the NEXT flush gets its own listing.
  void refresh.finally(() => {
    if (listingRefresh === refresh) listingRefresh = null;
  });
  return refresh;
}

/**
 * How many series writes may be in flight at once.
 *
 * The debounce is per series but not staggered, so a burst puts every timer on
 * the SAME 2000 ms mark and they all come due together: a reconcile pass over a
 * 200-folder library, an import batch, a tagging spree. Uncapped that is 200
 * concurrent `db.volumes.toArray()` scans and 200 concurrent PUTs at a provider
 * that will rate-limit or simply fall over. Two keeps the pipe busy across the
 * round trip without becoming a stampede.
 */
const WRITE_CONCURRENCY = 2;
let activeWrites = 0;
const waitingWrites: Array<() => void> = [];

function acquireWriteSlot(): Promise<void> {
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

function releaseWriteSlot(): void {
  activeWrites -= 1;
  waitingWrites.shift()?.();
}

/**
 * series_key → the write currently running for it.
 *
 * A timer that has already fired is past cancelling: the write is inside its
 * gates or out on its PUT. Anyone who is about to write the SAME file (the
 * backup drain) has to be able to WAIT for it instead, so this module stays the
 * one place where writes for a series are serialized. Entries live only for the
 * duration of a run and never reject — `runWrite` swallows its own failures.
 */
const inFlightWrites = new Map<string, Promise<void>>();

/** Test hook: drop the write-concurrency and in-flight bookkeeping. */
export function _resetWriteSlotsForTests(): void {
  activeWrites = 0;
  waitingWrites.length = 0;
  inFlightWrites.clear();
}

function runWrite(seriesKey: string): Promise<void> {
  const run = performWrite(seriesKey);
  inFlightWrites.set(seriesKey, run);
  void run.finally(() => {
    if (inFlightWrites.get(seriesKey) === run) inFlightWrites.delete(seriesKey);
  });
  return run;
}

async function performWrite(seriesKey: string): Promise<void> {
  timers.delete(seriesKey);
  const seriesTitle = pendingTitles.get(seriesKey);
  pendingTitles.delete(seriesKey);
  const options = pendingOptions.get(seriesKey);
  pendingOptions.delete(seriesKey);
  if (!seriesTitle) return;

  // Taken around the WHOLE body, gates included: the volume scan costs as much
  // as the upload on a large library, and both are what must not fan out.
  await acquireWriteSlot();
  try {
    if (!hasWritableProvider()) return;
    // Both gates below normally read the listing, so refresh it first — and
    // skip the write entirely when that fails rather than publish a file
    // built from a view we know may be hours old. A run-scheduled write skips
    // this refresh on purpose (see `ScheduleOptions.duringBackupRun`): the run
    // already primed the listing and keeps it current via `cache.add` as it
    // uploads, so refreshing again here would be a redundant whole-account
    // fetch mid-run.
    if (!options?.duringBackupRun) {
      if (!(await ensureFreshCloudListing())) return;
    }
    if (!(await hasBackedUpVolume(seriesTitle)) && !(await hasPublishableFacts(seriesTitle))) {
      return;
    }
    // Always the plain call, run-scheduled or not: the writer's own re-read is
    // already free for a self-write (the listing stamp matches our cache) and
    // is the only thing standing between a mid-run PUT and another device's
    // series.json (see `ScheduleOptions.duringBackupRun`'s REVISION note).
    await unifiedCloudManager.writeSeriesFile(seriesTitle);
  } catch (error) {
    // Best-effort by contract: a server that compiles series.json itself
    // rejects the write by design, and the next fact edit or backup rewrites
    // the file anyway. Never a warning, never UI.
    console.debug(`[series-file-sync] could not write series.json for '${seriesTitle}':`, error);
  } finally {
    releaseWriteSlot();
  }
}

/**
 * Queue a `series.json` write for this series, coalescing anything already
 * queued for it. Safe to call from any edit path — the gates are evaluated when
 * the timer fires, not now.
 *
 * `options.duringBackupRun` is read once, HERE, at schedule time — not when
 * the timer later fires. The two `backup-queue.ts` call sites pass
 * `isBackupRunActive()`, captured synchronously inside the same
 * upload-completion handler that just finished; by the time the 2 s debounce
 * elapses the run may well have drained, so re-reading a "run active" signal
 * at fire time would be answering the wrong question. A later call for the
 * same series (a fact edit, another volume's completion) coalesces exactly
 * like `pendingTitles` does — its options simply win, same as its title does.
 */
export function scheduleSeriesFileWrite(seriesTitle: string, options?: ScheduleOptions): void {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return;

  pendingTitles.set(key, seriesTitle);
  pendingOptions.set(key, options ?? {});
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => void runWrite(key), SERIES_FILE_WRITE_DEBOUNCE_MS)
  );
}

/**
 * Drop a queued write for this series and hand back whatever is ALREADY running
 * for it, so the caller can wait the file free.
 *
 * For a caller that is about to write the SAME file itself: the drain pass at
 * the end of a backup run (`writeSeriesIndexesForRun`) writes every series the
 * run backed up directly, and the live per-completion schedules are still
 * pending for those very series. Left alone, each timer fires seconds later and
 * PUTs byte-identical content — mtime churn that makes every other device
 * re-download the file.
 *
 * Cancelling the timer only covers the writes that have not started. The drain
 * runs immediately after a whole-account listing fetch, which is easily longer
 * than the 2 s debounce, so the live write is often already past its timer and
 * inside its gates or out on its PUT — and the concurrency cap orders writes
 * THROUGH this module only, so the drain's own write would not queue behind it.
 * Returning the in-flight promise is what closes that: `await` it and the two
 * writers for one series are strictly sequential again.
 *
 * A cancelled write is not a lost one: the caller is writing the same file with
 * the same builder. Anything scheduled AFTER the cancel is a new edit and keeps
 * its own timer.
 */
export function cancelScheduledSeriesFileWrite(seriesTitle: string): Promise<void> {
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return Promise.resolve();
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
  pendingTitles.delete(key);
  pendingOptions.delete(key);
  return inFlightWrites.get(key) ?? Promise.resolve();
}

/**
 * The reconcile pass currently running. Not the dedupe that matters — the
 * per-key debounce already collapses repeat schedules for the same folder — it
 * just stops two overlapping listings from each paying for the volumes scan.
 */
let reconcileInFlight: Promise<void> | null = null;

/** Test hook: forget an in-flight reconcile pass. */
export function _resetReconcileForTests(): void {
  reconcileInFlight = null;
}

/** A cloud listing entry, narrowed to the only field this pass reads. */
type ListedFile = { path: string };

/** What the listing shows for one cloud folder. */
interface FolderState {
  /** At least one `<folder>/*.cbz`: something is actually backed up here. */
  hasArchive: boolean;
  /** `<folder>/series.json` is already published. */
  hasSidecar: boolean;
}

/**
 * Group the listing by folder, keyed by the folder name VERBATIM — the same
 * identity `cloudSeriesTitles` uses. Folding case/whitespace here would let
 * `Berserk/series.json` vouch for a separate `berserk/` folder (they really are
 * two folders on any case-sensitive backend) and suppress the write it needs.
 */
function walkListing(files: ListedFile[]): {
  folders: Map<string, FolderState>;
  hasCatalog: boolean;
} {
  const folders = new Map<string, FolderState>();
  let hasCatalog = false;

  for (const file of files) {
    const path = (file?.path ?? '').replace(/^\/+|\/+$/g, '');
    if (!path) continue;
    if (isCatalogFilePath(path)) {
      hasCatalog = true;
      continue;
    }

    // Series folders are exactly one level deep, same rule the catalog writer
    // uses to enumerate them (`cloudSeriesTitles`).
    const parts = path.split('/');
    if (parts.length !== 2) continue;
    const [folder, basename] = parts;
    if (!folder || !basename) continue;

    const state = folders.get(folder) ?? { hasArchive: false, hasSidecar: false };
    if (isCbzFile(basename)) state.hasArchive = true;
    else if (isSeriesFilePath(path)) state.hasSidecar = true;
    folders.set(folder, state);
  }

  return { folders, hasCatalog };
}

/**
 * The series this device could actually publish an index for: at least one
 * NON-PLACEHOLDER row filed under that title.
 *
 * Deliberately the same test `hasBackedUpVolume` applies downstream, no
 * stricter — metadata-only rows count. A library whose files were removed from
 * this device keeps its rows, its uuids and its history, its archives are still
 * in the cloud, and `writeSeriesFile` builds a perfectly good index from them;
 * excluding it would leave exactly those libraries without one forever.
 *
 * The point of the test is convergence, not thrift. `runWrite` will drop a
 * schedule whose series has neither a local row nor local facts, so without the
 * same test here such a folder is scheduled, dropped, and scheduled again on
 * the very next listing — forever, at one full volumes scan each time. What it
 * excludes is the series this device has nothing to say about: never imported,
 * never linked, rows synthesised from the listing only.
 *
 * Facts count the same way they do in `hasPublishableFacts`: a series the user
 * linked without downloading anything is worth a facts-only index in its
 * (existing) folder.
 *
 * Folded with `normalizeVolumeTitleKey` rather than `normalizeSeriesKey`: the
 * folder name comes off a filesystem and can arrive decomposed (NFD) while the
 * local row stays composed, and the two spell the same series.
 */
async function locallyKnownSeriesKeys(): Promise<Set<string>> {
  const volumes = (await db.volumes.toArray()) as VolumeMetadata[];
  const keys = new Set<string>();
  for (const volume of volumes) {
    if (volume.isPlaceholder) continue;
    keys.add(normalizeVolumeTitleKey(volume.series_title));
  }
  const metas = await getAllSeriesMetadata();
  for (const meta of Object.values(metas)) {
    if (hasSeriesFacts(meta)) keys.add(normalizeVolumeTitleKey(meta.series_title));
  }
  return keys;
}

async function runReconcile(files?: ListedFile[]): Promise<void> {
  const listing = files ?? (unifiedCloudManager.getAllCloudVolumes() as ListedFile[]);
  // An empty listing means "not fetched" as often as "empty cloud", and every
  // writer downstream refuses to publish against one. Nothing to reconcile.
  if (!listing || listing.length === 0) return;

  const { folders, hasCatalog } = walkListing(listing);

  let seriesFolders = 0;
  const candidates: string[] = [];
  for (const [title, state] of folders) {
    if (!state.hasArchive) continue;
    seriesFolders += 1;
    if (!state.hasSidecar) {
      candidates.push(title);
    } else {
      // The OTHER half of convergence: a folder that already has a
      // series.json may still be missing entries for archives the listing
      // shows (facts-only, or partial). Fire-and-forget and re-entrancy-safe
      // per series — a folder with nothing to fill costs one cached index
      // read and zero downloads, so sweeping every sidecar-bearing folder on
      // every reconcile pass is cheap in the common case.
      void backfillSeriesEntries(title);
    }
  }
  if (seriesFolders === 0) return;

  let scheduled = 0;
  if (candidates.length > 0) {
    // ONE scan for the whole pass, and only when something might be scheduled.
    const localKeys = await locallyKnownSeriesKeys();
    for (const title of candidates) {
      if (!localKeys.has(normalizeVolumeTitleKey(title))) continue;
      scheduleSeriesFileWrite(title);
      scheduled += 1;
    }
  }

  // A missing root catalog is worth a write on its own — the per-series files
  // can all be present while the index that lists them never got written. The
  // catalog writer's content-equality skip absorbs the redundant case.
  if (scheduled > 0 || !hasCatalog) scheduleCatalogFileWrite();
}

/**
 * Backfill the metadata files a cloud folder should have but does not.
 *
 * The three producers of `series.json` / `catalog.json` all need an *event*: a
 * backup run that actually uploads something, a local fact edit while
 * connected, or a rename. A library whose volumes were uploaded by an older
 * build — or whose facts were set before it was ever connected — therefore sits
 * there with `.cbz`s and no index, and "Backup all series" cannot fix it
 * because it early-returns when everything is already backed up.
 *
 * This pass closes that hole: every folder the listing shows with at least one
 * archive, no `series.json`, and at least one non-placeholder local row gets a
 * write queued, and the catalog follows if anything was queued or the root
 * `catalog.json` is missing outright.
 *
 * A SECOND hole gets closed here too, for a folder that already HAS a
 * `series.json`: the file can still be facts-only or partial (a series linked
 * without downloading anything, or one whose entries never finished
 * converging). Every such folder is swept through `backfillSeriesEntries`
 * (`series-backfill.ts`), which pulls just the missing/stale archives'
 * sidecars and republishes the file — see that module for the trigger scope,
 * the gap-OR-stale rule and its own gates. Fire-and-forget the same as the
 * missing-sidecar half, and equally cheap for a folder with nothing to fill:
 * one cached index read and zero downloads.
 *
 * Idempotent by construction — a completed write shows up in the next listing
 * and stops qualifying — and convergent, because the local-row test mirrors the
 * gate `runWrite` applies anyway (see `locallyKnownSeriesKeys`).
 * Otherwise deliberately gate-free: `runWrite` still checks the writable
 * provider, the fresh listing and the per-series backup, and `writeCatalogFile`
 * still checks read-only / server-compiled / loaded cache. Duplicating any of
 * that here would only let the two copies disagree.
 *
 * Fire-and-forget by contract: never throws, never surfaces UI.
 */
export function reconcileMissingMetadataFiles(files?: ListedFile[]): Promise<void> {
  if (reconcileInFlight) return reconcileInFlight;

  // Deferred to a microtask so the promise identity below exists before the
  // body can settle.
  const run = Promise.resolve()
    .then(() => runReconcile(files))
    .catch((error) => {
      console.debug('[series-file-sync] could not reconcile the cloud metadata files:', error);
    });

  reconcileInFlight = run;
  void run.finally(() => {
    if (reconcileInFlight === run) reconcileInFlight = null;
  });
  return run;
}

/** Run every queued write now (cancelling its timer). For tests and teardown. */
export async function flushSeriesFileWrites(): Promise<void> {
  const keys = [...timers.keys()];
  for (const key of keys) {
    clearTimeout(timers.get(key)!);
    timers.delete(key);
  }
  await Promise.all(keys.map((key) => runWrite(key)));
}

let teardown: (() => void) | null = null;

/**
 * Subscribe the debounced writer to local fact edits. Idempotent — a second
 * call while one is live returns the same disposer instead of registering the
 * listener twice. Mounted once in `+layout.svelte`.
 */
export function initSeriesFileSync(): () => void {
  if (!browser) return () => {};
  if (teardown) return teardown;

  const unregisterFacts = registerFactsChangeListener((seriesTitle) => {
    scheduleSeriesFileWrite(seriesTitle);
    void maybeBackfillNewlyLinkedSeries(seriesTitle);
  });
  // The non-facts trigger: a shelf alignment change republishes the sidecar
  // with the SAME facts stamp (see `registerIndexChangeListener`). Both funnel
  // into the same per-series debounce, so an edit that moves both costs one write.
  const unregisterIndex = registerIndexChangeListener((seriesTitle) =>
    scheduleSeriesFileWrite(seriesTitle)
  );

  const dispose = () => {
    if (teardown !== dispose) return;
    teardown = null;
    unregisterFacts();
    unregisterIndex();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pendingTitles.clear();
    pendingOptions.clear();
  };

  teardown = dispose;
  return dispose;
}
