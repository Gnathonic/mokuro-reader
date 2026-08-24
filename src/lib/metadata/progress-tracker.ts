import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { sortVolumes } from '$lib/catalog/sort-volumes';
import { settings } from '$lib/settings/settings';
import {
  getSeriesReadingState,
  updateSeriesReadingState,
  type SeriesReadingState
} from '$lib/settings/series-data';
import { registerCompletionListener, volumes, type VolumeData } from '$lib/settings/volume-data';
import type { VolumeMetadata } from '$lib/types';
import { anilistConnected, getAniListToken, handleAniListUnauthorized } from './anilist-auth';
import {
  planProgressPush,
  type LocalPassState,
  type ProgressPushEvent,
  type ProgressPushPlan,
  type RemoteEntry
} from './progress-plan';
import { AniListError, anilistRequest } from './providers/anilist';
import { normalizeSeriesKey } from './series-key';
import { getSeriesIndex } from './series-index';
import { getAllSeriesMetadata, getSeriesMetadata } from './store';
import { resolveTrackingUnit } from './tracking-unit';
import type { SeriesMetadata, SeriesTotals, SeriesTracking, TrackingUnit } from './types';
import { extractVolumeNumber } from './volume-number';

const PENDING_KEY = 'anilist_pending_pushes';

/**
 * How long an identical completion state is treated as already handled. The
 * reader recomputes `completed` on every page turn, so paging off and back
 * onto the last page re-fires the completion listener — without this the
 * 30 req/min AniList budget would be spent on re-reads of the same state.
 */
const COMPLETION_DEBOUNCE_MS = 60_000;

/**
 * - `pushed`   — AniList accepted a change.
 * - `nothing`  — the remote already reflects the local pass; no write was made.
 * - `queued`   — a retryable failure (offline, rate limited, expired session);
 *   the intent stays in the pending queue and is replayed by `flushPendingPushes`.
 * - `failed`   — a non-retryable failure (AniList rejected the document, e.g. a
 *   stale media id); the intent has been dropped. Callers should surface this as
 *   an error, never as "queued".
 * - `disabled` — nothing to push for this series: it is not linked to AniList,
 *   or the master switch in Settings is off. There is no per-series opt-in.
 */
export type PushOutcome = 'pushed' | 'nothing' | 'queued' | 'failed' | 'disabled';

/**
 * One pending intent per series. `restart` dominates `read_count`, which
 * dominates `sync`: both carry an explicit decrease the user asked for, and
 * collapsing them into a plain sync (which only ever moves forward) would
 * silently drop it. The follow-up sync runs anyway once they land.
 *
 * A restart and a read-count correction are two separate writes, though — the
 * restart zeroes progress, the correction sets `repeat` — so when both are
 * waiting, `alsoReadCount` keeps the second one instead of letting the restart
 * swallow it.
 */
export interface PendingPush {
  seriesKey: string;
  event: 'restart' | 'read_count' | 'sync';
  /** A read-count correction is queued behind this restart. */
  alsoReadCount?: true;
  at: string;
}

// ---------- pure helpers ----------

/**
 * `unit` is a parameter, not something resolved here: detection regex-scans
 * every title in the series, so resolving it per volume would be O(n²) on a
 * long series — and this runs inside `$derived`s on the series page.
 */
export function volumeNumberFor(
  volume: VolumeMetadata,
  sortedSeriesVolumes: VolumeMetadata[],
  tracking: SeriesTracking | undefined,
  unit: TrackingUnit
): number {
  const override = tracking?.number_overrides?.[volume.volume_uuid];
  if (typeof override === 'number' && override > 0) return override;
  const parsed = extractVolumeNumber(volume.volume_title, unit);
  if (parsed !== undefined) return parsed;
  return sortedSeriesVolumes.findIndex((v) => v.volume_uuid === volume.volume_uuid) + 1;
}

/**
 * `unit` is resolved by the caller — from the FULL title list (cloud
 * placeholders included), which this function's `seriesVolumes` deliberately is
 * not. `state` is the series' reading state; `undefined` means "never read".
 *
 * `totals` are AniList's, and nothing stores them: only the push path has them
 * (it fetches them with the list entry), so everywhere else `passComplete` is
 * false — a pass cannot be "complete" against a total nobody knows.
 */
export function computeLocalPassState(
  seriesVolumes: VolumeMetadata[],
  volumesData: Record<string, Pick<VolumeData, 'completed'> | undefined>,
  state: SeriesReadingState | undefined,
  unit: TrackingUnit,
  totals?: SeriesTotals
): LocalPassState {
  const sorted = [...seriesVolumes].sort(sortVolumes);
  let passProgress = 0;
  let allCompleted = sorted.length > 0;
  for (const volume of sorted) {
    if (volumesData[volume.volume_uuid]?.completed) {
      passProgress = Math.max(passProgress, volumeNumberFor(volume, sorted, state?.tracking, unit));
    } else {
      allCompleted = false;
    }
  }
  const readCount = state?.read_count ?? 0;
  const total = unit === 'chapters' ? totals?.chapters : totals?.volumes;
  const passComplete = typeof total === 'number' && total > 0 && passProgress >= total;
  return {
    passProgress,
    allCompleted,
    passComplete,
    timesRead: readCount + (allCompleted ? 1 : 0),
    rereading: readCount >= 1 && !allCompleted
  };
}

// ---------- pending queue ----------

/**
 * A queue entry is only usable when its key matches its `seriesKey` (that is
 * what `clearPending` deletes by) and its event is one we know how to replay —
 * anything else would sit in localStorage forever, so it is dropped on read.
 */
function isPendingPush(key: string, value: unknown): value is PendingPush {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<PendingPush>;
  if (typeof entry.seriesKey !== 'string' || entry.seriesKey !== key) return false;
  return entry.event === 'restart' || entry.event === 'read_count' || entry.event === 'sync';
}

export function readPendingPushes(): Record<string, PendingPush> {
  if (!browser) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const pending: Record<string, PendingPush> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isPendingPush(key, value)) continue;
    const entry: PendingPush = {
      seriesKey: value.seriesKey,
      event: value.event,
      at: typeof value.at === 'string' ? value.at : new Date(0).toISOString()
    };
    if (value.alsoReadCount === true && value.event === 'restart') entry.alsoReadCount = true;
    pending[key] = entry;
  }
  return pending;
}

function writePendingPushes(pending: Record<string, PendingPush>): void {
  if (!browser) return;
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch (error) {
    console.warn('[progress-tracker] could not persist the pending queue:', error);
  }
}

function mergePendingEvent(
  event: ProgressPushEvent,
  existing: PendingPush['event'] | undefined
): PendingPush['event'] {
  if (event === 'restart' || existing === 'restart') return 'restart';
  if (event === 'read_count' || existing === 'read_count') return 'read_count';
  return 'sync';
}

function markPending(seriesKey: string, event: ProgressPushEvent): void {
  const pending = readPendingPushes();
  const existing = pending[seriesKey];
  const next: PendingPush = {
    seriesKey,
    event: mergePendingEvent(event, existing?.event),
    at: new Date().toISOString()
  };
  const readCountWaiting =
    event === 'read_count' || existing?.event === 'read_count' || existing?.alsoReadCount === true;
  if (next.event === 'restart' && readCountWaiting) next.alsoReadCount = true;
  pending[seriesKey] = next;
  writePendingPushes(pending);
}

function clearPending(seriesKey: string): void {
  const pending = readPendingPushes();
  if (pending[seriesKey]) {
    delete pending[seriesKey];
    writePendingPushes(pending);
  }
}

// ---------- AniList I/O ----------

const REMOTE_QUERY =
  'query ($id: Int) { Media(id: $id, type: MANGA) { volumes chapters mediaListEntry { status progress progressVolumes repeat } } }';
const SAVE_MUTATION =
  'mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $progressVolumes: Int, $repeat: Int) { SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, progressVolumes: $progressVolumes, repeat: $repeat) { status progress progressVolumes repeat } }';

/** The list entry (or `null`) plus the series totals the same node carries. */
interface RemoteState {
  entry: RemoteEntry | null;
  totals: SeriesTotals;
}

async function fetchRemoteEntry(mediaId: number, token: string): Promise<RemoteState> {
  const data = await anilistRequest<{
    Media: {
      volumes: number | null;
      chapters: number | null;
      mediaListEntry: {
        status: string | null;
        progress: number | null;
        progressVolumes: number | null;
        repeat: number | null;
      } | null;
    } | null;
  }>(REMOTE_QUERY, { id: mediaId }, token);

  const media = data.Media;
  const totals: SeriesTotals = {};
  if (typeof media?.volumes === 'number' && media.volumes > 0) totals.volumes = media.volumes;
  if (typeof media?.chapters === 'number' && media.chapters > 0) totals.chapters = media.chapters;

  const entry = media?.mediaListEntry;
  return {
    totals,
    entry: entry
      ? {
          status: entry.status ?? null,
          progress: entry.progress ?? 0,
          progressVolumes: entry.progressVolumes ?? 0,
          repeat: entry.repeat ?? 0
        }
      : null
  };
}

async function sendPlan(mediaId: number, plan: ProgressPushPlan, token: string): Promise<void> {
  // undefined plan fields are dropped by JSON.stringify → AniList leaves them untouched
  await anilistRequest(SAVE_MUTATION, { mediaId, ...plan }, token);
}

// ---------- core ----------

async function getSeriesVolumesByKey(seriesKey: string): Promise<VolumeMetadata[]> {
  const all = await db.volumes.toArray();
  return all.filter((v) => normalizeSeriesKey(v.series_title) === seriesKey);
}

/**
 * The unit for a push, resolved from the SAME titles the series page shows.
 *
 * `db.volumes` holds only what is installed here, but the series page also
 * lists the cloud-only volumes from the cached `series.json` index — and those
 * titles are usually the majority of a long series. Detecting from the local
 * subset alone would let the UI say "Auto (chapters)" while the push writes
 * `progressVolumes`. The index is only read when detection actually has to run:
 * a stored `unit` fact answers on its own.
 *
 * The titles it collected come back with the answer, so the totals-aware
 * re-resolve after the fetch (see `runPush`) costs no second read. They are
 * empty when a stored fact answered — there is nothing left to re-resolve.
 */
async function resolveUnitForPush(
  seriesKey: string,
  meta: SeriesMetadata | undefined,
  localVolumes: VolumeMetadata[]
): Promise<{ unit: TrackingUnit; titles: Pick<VolumeMetadata, 'volume_title'>[] }> {
  if (meta?.unit === 'volumes' || meta?.unit === 'chapters') {
    return { unit: meta.unit, titles: [] };
  }

  const byUuid = new Map<string, { volume_title: string }>();
  for (const volume of localVolumes) {
    byUuid.set(volume.volume_uuid, { volume_title: volume.volume_title });
  }
  try {
    const index = await getSeriesIndex(seriesKey);
    for (const entry of index?.file?.volumes ?? []) {
      if (!byUuid.has(entry.volume_uuid)) byUuid.set(entry.volume_uuid, entry);
    }
  } catch (error) {
    // The cache is disposable; a read failure must not stop a push.
    console.warn('[progress-tracker] could not read the cached series index:', error);
  }
  const titles = [...byUuid.values()];
  return { unit: resolveTrackingUnit(meta, titles).unit, titles };
}

/**
 * Pushing needs exactly two things: a series linked to AniList, and the one
 * global switch in Settings. There is no per-series opt-in — whether a series
 * counts is answered by "did you link it".
 */
function pushEnabled(meta: SeriesMetadata | undefined): meta is SeriesMetadata {
  if (!meta?.external_ids?.anilist) return false;
  return get(settings)?.catalogSettings?.pushProgressToAniList !== false;
}

/** Serializes pushes per series so two completion fires can never race. */
const pushChains = new Map<string, Promise<unknown>>();
/** Last completion state we already acted on, per series (this session). */
const recentCompletions = new Map<string, { signature: string; at: number }>();
/**
 * Completion fires already handled, per volume. `Reader.svelte` calls
 * `updateProgress(..., isComplete)` on every page change, so scrolling across
 * the end of a volume re-fires the listener — this is checked before any
 * IndexedDB access so a repeat costs nothing at all.
 */
const recentCompletionFires = new Map<string, { at: number; seriesKey?: string }>();
/** Set from a 429's Retry-After; no request is attempted before it passes. */
let rateLimitedUntil = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function passSignature(local: LocalPassState): string {
  return [
    local.passProgress,
    local.allCompleted,
    local.passComplete,
    local.timesRead,
    local.rereading
  ].join('|');
}

/**
 * The cheap half of the completion gate: this exact pass state was already acted
 * on moments ago, so there is nothing to do and no request to spend.
 *
 * Both sides of the comparison are always taken BEFORE the fetch, from the
 * totals-blind state, so they are on the same scale — see `runPush`.
 */
function recentlyHandled(seriesKey: string, local: LocalPassState): boolean {
  const recent = recentCompletions.get(seriesKey);
  return (
    !!recent &&
    recent.signature === passSignature(local) &&
    Date.now() - recent.at < COMPLETION_DEBOUNCE_MS
  );
}

/**
 * True when the state we last pushed already covers this pass, so a completion
 * fire has nothing to add.
 *
 * `last_pushed` is only written after a push that succeeded, and the plan it
 * carried always included the repeat count desired at that moment — and
 * `timesRead` can only move when `read_count` changes (a restart, which resets
 * every volume and therefore the progress/status too) or when `allCompleted`
 * flips (which moves progress or status as well). So re-planning against the
 * state we last pushed, with repeat assumed caught up, is a faithful
 * "nothing could have changed" test. A remote edited by hand on anilist.co is
 * deliberately not detected here: that is what "Sync now" (`sync`) is for.
 *
 * It runs AFTER the fetch, deliberately, and that costs one GET per completion
 * that turns out to be settled. `last_pushed.n` was recorded in the unit the
 * push resolved WITH AniList's totals; replaying it against a pass measured
 * without them compares two scales — a bare-numbered chapter folder records
 * chapter 1050 and then re-reads as volume 1 (sort position), so every later
 * completion looks settled until someone syncs by hand. Running it here also
 * keeps the COMPLETED upgrade reachable from a completion fire: `passComplete`
 * only exists once the totals are in hand.
 */
function settledByLastPush(
  local: LocalPassState,
  state: SeriesReadingState,
  unit: TrackingUnit
): boolean {
  const lastPushed = state.tracking?.last_pushed;
  if (!lastPushed) return false;
  const assumedRemote: RemoteEntry = {
    status: lastPushed.status,
    progress: lastPushed.n,
    progressVolumes: lastPushed.n,
    repeat: Math.max(0, local.timesRead - 1)
  };
  return planProgressPush(local, assumedRemote, unit, 'sync') === null;
}

/** Forget both debounce layers for a series — its pass state just changed. */
function clearSeriesDebounce(seriesKey: string): void {
  recentCompletions.delete(seriesKey);
  for (const [volumeUuid, entry] of recentCompletionFires) {
    if (entry.seriesKey === seriesKey) recentCompletionFires.delete(volumeUuid);
  }
}

/** Keep the per-volume map from growing without bound in a long session. */
function pruneCompletionFires(now: number): void {
  if (recentCompletionFires.size < 64) return;
  for (const [volumeUuid, entry] of recentCompletionFires) {
    if (now - entry.at >= COMPLETION_DEBOUNCE_MS) recentCompletionFires.delete(volumeUuid);
  }
}

function scheduleRetry(delayMs: number): void {
  if (!browser) return;
  const delay = Math.max(1000, delayMs);
  rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + delay);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    rateLimitedUntil = 0;
    void flushPendingPushes();
  }, delay + 100);
}

async function runPush(seriesKey: string, event: ProgressPushEvent): Promise<PushOutcome> {
  const meta = await getSeriesMetadata(seriesKey);
  if (!pushEnabled(meta)) {
    // The series was unlinked (or the master switch turned off) after the
    // intent was queued: nothing will ever be pushed for it, so don't leave it
    // in the queue to be retried on every flush forever.
    clearPending(seriesKey);
    return 'disabled';
  }
  const mediaId = meta.external_ids.anilist!;

  const token = getAniListToken();
  if (!token) {
    markPending(seriesKey, event);
    return 'queued';
  }

  const seriesVolumes = await getSeriesVolumesByKey(seriesKey);
  // The reading state is a plain synchronous store, so this needs no round trip
  // and cannot go stale between here and the write below (which patches
  // functionally anyway).
  const state = getSeriesReadingState(seriesKey);
  // Volumes or chapters is a property of the archives, either stated on the
  // record (someone corrected it) or read off their titles.
  const { unit: detectedUnit, titles } = await resolveUnitForPush(seriesKey, meta, seriesVolumes);
  // Without totals a pass is never "complete", so this state is only ever fed to
  // the session debounce below, which compares it against another state measured
  // exactly the same way. Everything that plans a write waits for the totals.
  const localBeforeFetch = computeLocalPassState(seriesVolumes, get(volumes), state, detectedUnit);

  if (event === 'completion') {
    // The free half of the gate. The `last_pushed` replay is the other half and
    // needs the totals, so it waits until after the fetch — one GET is the price
    // of never swallowing a real push (see `settledByLastPush`).
    if (recentlyHandled(seriesKey, localBeforeFetch)) return 'nothing';
    recentCompletions.set(seriesKey, {
      signature: passSignature(localBeforeFetch),
      at: Date.now()
    });
  }

  if (Date.now() < rateLimitedUntil) {
    markPending(seriesKey, event);
    return 'queued';
  }

  try {
    const { entry: remote, totals } = await fetchRemoteEntry(mediaId, token);
    // The totals arrived with the entry: they are what makes the overshoot
    // tie-break usable, and what decides whether this pass is COMPLETED.
    const unit = titles.length > 0 ? resolveTrackingUnit(meta, titles, totals).unit : detectedUnit;
    const local = computeLocalPassState(seriesVolumes, get(volumes), state, unit, totals);
    // Both sides of this replay are now on the same scale: the unit and the pass
    // were resolved with the totals `last_pushed.n` was recorded under.
    if (event === 'completion' && settledByLastPush(local, state, unit)) return 'nothing';
    const plan = planProgressPush(local, remote, unit, event);
    if (!plan) {
      clearPending(seriesKey);
      return 'nothing';
    }
    await sendPlan(mediaId, plan, token);
    clearPending(seriesKey);
    // A repeat-only push (a manual "Read N times" correction) moved no progress
    // at all, so there is no figure to record: keep what AniList already holds,
    // else what we last sent. Fabricating the local pass here would let the
    // fast path in `alreadySettled` swallow the next real push.
    const unchangedProgress =
      (unit === 'chapters' ? remote?.progress : remote?.progressVolumes) ??
      state.tracking?.last_pushed?.n ??
      0;
    // A functional patch, resolved against the state as it is now: two round
    // trips happened since `state` was read and a number override may have
    // landed in between.
    updateSeriesReadingState(seriesKey, (existing) => ({
      tracking: {
        ...(existing.tracking ?? {}),
        last_pushed: {
          // The progress AniList actually received — 0 for a restart, and the
          // last known figure for a status-only push.
          n:
            plan.progressVolumes ??
            plan.progress ??
            (event === 'read_count' ? unchangedProgress : local.passProgress),
          status: plan.status ?? remote?.status ?? 'CURRENT',
          at: new Date().toISOString()
        }
      }
    }));
    return 'pushed';
  } catch (error) {
    if (
      error instanceof AniListError &&
      (error.code === 'NETWORK' || error.code === 'RATE_LIMITED' || error.code === 'UNAUTHORIZED')
    ) {
      markPending(seriesKey, event);
      if (error.code === 'UNAUTHORIZED') handleAniListUnauthorized();
      else if (error.code === 'RATE_LIMITED') scheduleRetry(error.retryAfterMs ?? 60_000);
      return 'queued';
    }
    // Non-retryable: a stale media id, a schema mismatch, or an unexpected
    // failure. Replaying it would only fail again, so drop the intent.
    console.warn('[progress-tracker] AniList rejected the push:', error);
    clearPending(seriesKey);
    return 'failed';
  }
}

/** Never rejects, and never runs two pushes for the same series concurrently. */
function pushSeries(seriesKey: string, event: ProgressPushEvent): Promise<PushOutcome> {
  const run = async (): Promise<PushOutcome> => {
    try {
      return await runPush(seriesKey, event);
    } catch (error) {
      console.warn('[progress-tracker] push failed before reaching AniList:', error);
      markPending(seriesKey, event);
      return 'queued';
    }
  };
  const previous = pushChains.get(seriesKey) ?? Promise.resolve();
  const result = previous.then(run, run);
  const tail = result.then(
    () => {},
    () => {}
  );
  pushChains.set(seriesKey, tail);
  void tail.then(() => {
    if (pushChains.get(seriesKey) === tail) pushChains.delete(seriesKey);
  });
  return result;
}

// ---------- public API ----------

export function onVolumeCompleted(volumeUuid: string): void {
  if (!browser) return;
  const now = Date.now();
  const handled = recentCompletionFires.get(volumeUuid);
  // Cheapest possible exit: no IndexedDB read, no store read, no request.
  if (handled && now - handled.at < COMPLETION_DEBOUNCE_MS) return;
  pruneCompletionFires(now);
  // Claimed synchronously so simultaneous fires can't both reach the catalog.
  recentCompletionFires.set(volumeUuid, { at: now });
  db.volumes
    .get(volumeUuid)
    .then((volume) => {
      if (!volume) return;
      const seriesKey = normalizeSeriesKey(volume.series_title);
      recentCompletionFires.set(volumeUuid, { at: Date.now(), seriesKey });
      return pushSeries(seriesKey, 'completion');
    })
    .catch((error) => console.warn('[progress-tracker] onVolumeCompleted failed:', error));
}

export function onSeriesRestarted(seriesKey: string): void {
  if (!browser) return;
  // A restart invalidates everything we know about the previous pass.
  clearSeriesDebounce(seriesKey);
  pushSeries(seriesKey, 'restart').catch((error) =>
    console.warn('[progress-tracker] onSeriesRestarted failed:', error)
  );
}

/**
 * "Read N times" was corrected by hand in the series panel. That figure is
 * AniList's `repeat`, and a correction is meant in both directions — so it gets
 * its own event rather than riding along with a sync (which only moves forward).
 */
export function onReadCountChanged(seriesKey: string): Promise<PushOutcome> {
  clearSeriesDebounce(seriesKey);
  return pushSeries(seriesKey, 'read_count');
}

export function syncSeriesNow(seriesKey: string): Promise<PushOutcome> {
  clearSeriesDebounce(seriesKey);
  return pushSeries(seriesKey, 'sync');
}

/** Outcome tally of one `syncAllSeriesNow` pass. */
export type SyncAllTally = Record<PushOutcome, number> & { total: number };

/**
 * Pause between series. AniList allows 30 requests a minute and a sync spends
 * up to two per series, so a library of any size would trip the limiter at full
 * speed. A 429 is still handled (`rateLimitedUntil` + the pending queue); this
 * just keeps an ordinary run from provoking one.
 */
const SYNC_ALL_GAP_MS = 500;

let syncAllInFlight: Promise<SyncAllTally> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * "Sync all linked series now" from Settings: one sequential pass over every
 * series with an AniList id.
 *
 * Sequential rather than parallel because the budget above is per account, not
 * per series, and because `pushSeries` only serializes within a series. A second
 * invocation while one is running joins the first instead of doubling the
 * traffic.
 */
export function syncAllSeriesNow(): Promise<SyncAllTally> {
  if (syncAllInFlight) return syncAllInFlight;

  const run = async (): Promise<SyncAllTally> => {
    const tally: SyncAllTally = {
      pushed: 0,
      nothing: 0,
      queued: 0,
      failed: 0,
      disabled: 0,
      total: 0
    };
    const records = Object.values(await getAllSeriesMetadata()).filter(
      (record) => !!record.external_ids?.anilist
    );

    // With the master switch off every series would report `disabled` one by
    // one; answer for the whole library at once instead of walking it.
    if (get(settings)?.catalogSettings?.pushProgressToAniList === false) {
      tally.disabled = records.length;
      tally.total = records.length;
      return tally;
    }

    let requested = false;
    for (const record of records) {
      // The gap only pays for AniList's rate limit, so it is charged after a
      // series that actually reached the network — never after a `disabled`.
      if (requested) await sleep(SYNC_ALL_GAP_MS);
      const outcome = await syncSeriesNow(record.series_key);
      tally[outcome]++;
      tally.total++;
      requested = outcome !== 'disabled';
    }
    return tally;
  };

  syncAllInFlight = run().finally(() => {
    syncAllInFlight = null;
  });
  return syncAllInFlight;
}

let flushing = false;
export async function flushPendingPushes(): Promise<void> {
  if (!browser || flushing) return;
  if (!getAniListToken()) return;
  if (Date.now() < rateLimitedUntil) return;
  flushing = true;
  try {
    for (const pending of Object.values(readPendingPushes())) {
      if (Date.now() < rateLimitedUntil) break;
      if (pending.event === 'restart' || pending.event === 'read_count') {
        const outcome = await pushSeries(pending.seriesKey, pending.event);
        // Only fall through to the follow-up sync once the decrease landed.
        if (outcome !== 'pushed' && outcome !== 'nothing') continue;
        if (pending.event === 'restart' && pending.alsoReadCount) {
          // The restart just reset progress; the correction still owes AniList
          // its repeat count. (A failure here re-queues it on its own.)
          const corrected = await pushSeries(pending.seriesKey, 'read_count');
          if (corrected !== 'pushed' && corrected !== 'nothing') continue;
        }
      }
      await pushSeries(pending.seriesKey, 'sync');
    }
  } finally {
    flushing = false;
  }
}

let teardown: (() => void) | null = null;

/** Wire the tracker to completions, connectivity and login. Returns a cleanup.
 *  Calling it twice is a no-op: the same cleanup is handed back. */
export function initProgressTracker(): () => void {
  if (!browser) return () => {};
  if (teardown) return teardown;

  const unregister = registerCompletionListener(onVolumeCompleted);
  const onOnline = () => void flushPendingPushes();
  window.addEventListener('online', onOnline);

  // Watch the session flag, not the resolved user: a login whose Viewer lookup
  // failed (offline for that one request) still has a usable token, and its
  // queued pushes must flush too.
  let seenInitialConnected = false;
  let wasConnected = false;
  const unsubConnected = anilistConnected.subscribe((connected) => {
    const justConnected = seenInitialConnected && !wasConnected && connected;
    seenInitialConnected = true;
    wasConnected = connected;
    if (justConnected) void flushPendingPushes();
  });

  const dispose = () => {
    if (teardown !== dispose) return;
    teardown = null;
    unregister();
    window.removeEventListener('online', onOnline);
    unsubConnected();
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };
  teardown = dispose;

  void flushPendingPushes();
  return dispose;
}

/** Test seam: drop every piece of module-level state. */
export function _resetTrackerStateForTests(): void {
  pushChains.clear();
  recentCompletions.clear();
  recentCompletionFires.clear();
  rateLimitedUntil = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  flushing = false;
  teardown = null;
  syncAllInFlight = null;
}
