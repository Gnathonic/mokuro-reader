import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { sortVolumes } from '$lib/catalog/sort-volumes';
import { settings } from '$lib/settings/settings';
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
import { getAllSeriesMetadata, getSeriesMetadata, updateSeriesMetadata } from './store';
import { resolveTrackingUnit } from './tracking-unit';
import type { SeriesMetadata, TrackingUnit } from './types';
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
 */
export interface PendingPush {
  seriesKey: string;
  event: 'restart' | 'read_count' | 'sync';
  at: string;
}

// ---------- pure helpers ----------

/**
 * `unit` is a parameter, not something resolved here: detection regex-scans
 * every title in the series, so resolving it per volume would be O(n²) on a
 * long series — and this runs inside `$derived`s on the series page. Callers
 * that already know the unit (everything in this module does) pass it.
 */
export function volumeNumberFor(
  volume: VolumeMetadata,
  sortedSeriesVolumes: VolumeMetadata[],
  meta: SeriesMetadata | undefined,
  unit?: TrackingUnit
): number {
  const override = meta?.tracking?.number_overrides?.[volume.volume_uuid];
  if (typeof override === 'number' && override > 0) return override;
  const resolved = unit ?? resolveTrackingUnit(meta, sortedSeriesVolumes).unit;
  const parsed = extractVolumeNumber(volume.volume_title, resolved);
  if (parsed !== undefined) return parsed;
  return sortedSeriesVolumes.findIndex((v) => v.volume_uuid === volume.volume_uuid) + 1;
}

/**
 * Pass `unit` when the caller already resolved it — detection is O(titles) and
 * the series page resolves it anyway (from a title list that includes cloud
 * placeholders, which `seriesVolumes` here deliberately does not).
 */
export function computeLocalPassState(
  seriesVolumes: VolumeMetadata[],
  volumesData: Record<string, Pick<VolumeData, 'completed'> | undefined>,
  meta: SeriesMetadata | undefined,
  unit?: TrackingUnit
): LocalPassState {
  const sorted = [...seriesVolumes].sort(sortVolumes);
  const resolved = unit ?? resolveTrackingUnit(meta, sorted).unit;
  let passProgress = 0;
  let allCompleted = sorted.length > 0;
  for (const volume of sorted) {
    if (volumesData[volume.volume_uuid]?.completed) {
      passProgress = Math.max(passProgress, volumeNumberFor(volume, sorted, meta, resolved));
    } else {
      allCompleted = false;
    }
  }
  const total = resolved === 'chapters' ? meta?.total_chapters : meta?.total_volumes;
  const passComplete = typeof total === 'number' && total > 0 && passProgress >= total;
  const readCount = meta?.read_count ?? 0;
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
    pending[key] = {
      seriesKey: value.seriesKey,
      event: value.event,
      at: typeof value.at === 'string' ? value.at : new Date(0).toISOString()
    };
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
  const next = mergePendingEvent(event, pending[seriesKey]?.event);
  pending[seriesKey] = { seriesKey, event: next, at: new Date().toISOString() };
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
  'query ($id: Int) { Media(id: $id, type: MANGA) { mediaListEntry { status progress progressVolumes repeat } } }';
const SAVE_MUTATION =
  'mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $progressVolumes: Int, $repeat: Int) { SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, progressVolumes: $progressVolumes, repeat: $repeat) { status progress progressVolumes repeat } }';

async function fetchRemoteEntry(mediaId: number, token: string): Promise<RemoteEntry | null> {
  const data = await anilistRequest<{
    Media: {
      mediaListEntry: {
        status: string | null;
        progress: number | null;
        progressVolumes: number | null;
        repeat: number | null;
      } | null;
    } | null;
  }>(REMOTE_QUERY, { id: mediaId }, token);
  const entry = data.Media?.mediaListEntry;
  if (!entry) return null;
  return {
    status: entry.status ?? null,
    progress: entry.progress ?? 0,
    progressVolumes: entry.progressVolumes ?? 0,
    repeat: entry.repeat ?? 0
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
 */
async function resolveUnitForPush(
  seriesKey: string,
  meta: SeriesMetadata | undefined,
  localVolumes: VolumeMetadata[]
): Promise<TrackingUnit> {
  if (meta?.unit === 'volumes' || meta?.unit === 'chapters') return meta.unit;

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
  return resolveTrackingUnit(meta, [...byUuid.values()]).unit;
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
 * True when this exact completion state cannot change anything on AniList, so
 * the remote read can be skipped entirely.
 *
 * `last_pushed` is only written after a push that succeeded, and the plan it
 * carried always included the repeat count desired at that moment — and
 * `timesRead` can only move when `read_count` changes (a restart, which resets
 * every volume and therefore the progress/status too) or when `allCompleted`
 * flips (which moves progress or status as well). So re-planning against the
 * state we last pushed, with repeat assumed caught up, is a faithful
 * "nothing could have changed" test. A remote edited by hand on anilist.co is
 * deliberately not detected here: that is what "Sync now" (`sync`) is for.
 */
function alreadySettled(
  seriesKey: string,
  local: LocalPassState,
  meta: SeriesMetadata,
  unit: TrackingUnit
): boolean {
  const recent = recentCompletions.get(seriesKey);
  if (
    recent &&
    recent.signature === passSignature(local) &&
    Date.now() - recent.at < COMPLETION_DEBOUNCE_MS
  ) {
    return true;
  }
  const lastPushed = meta.tracking?.last_pushed;
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
  // Volumes or chapters is a property of the archives, either stated on the
  // record (someone corrected it) or read off their titles.
  const unit = await resolveUnitForPush(seriesKey, meta, seriesVolumes);
  const local = computeLocalPassState(seriesVolumes, get(volumes), meta, unit);

  if (event === 'completion') {
    if (alreadySettled(seriesKey, local, meta, unit)) return 'nothing';
    recentCompletions.set(seriesKey, { signature: passSignature(local), at: Date.now() });
  }

  if (Date.now() < rateLimitedUntil) {
    markPending(seriesKey, event);
    return 'queued';
  }

  try {
    const remote = await fetchRemoteEntry(mediaId, token);
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
      meta.tracking?.last_pushed?.n ??
      0;
    // Two round-trips happened since `meta` was read; a tracking edit (a number
    // override) may have landed in between. The patch is functional so the
    // record it spreads is the one in the database at write time, not the stale
    // copy this push started from.
    const current = (await getSeriesMetadata(seriesKey)) ?? meta;
    await updateSeriesMetadata(current.series_title, (existing) => ({
      tracking: {
        ...(existing.tracking ?? current.tracking ?? {}),
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
    for (let i = 0; i < records.length; i++) {
      if (i > 0) await sleep(SYNC_ALL_GAP_MS);
      const outcome = await syncSeriesNow(records[i].series_key);
      tally[outcome]++;
      tally.total++;
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
