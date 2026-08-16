import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { sortVolumes } from '$lib/catalog/sort-volumes';
import { settings } from '$lib/settings/settings';
import { registerCompletionListener, volumes, type VolumeData } from '$lib/settings/volume-data';
import type { VolumeMetadata } from '$lib/types';
import { anilistUser, getAniListToken, handleAniListUnauthorized } from './anilist-auth';
import {
  planProgressPush,
  type LocalPassState,
  type ProgressPushEvent,
  type ProgressPushPlan,
  type RemoteEntry
} from './progress-plan';
import { AniListError, anilistRequest } from './providers/anilist';
import { normalizeSeriesKey } from './series-key';
import { getSeriesMetadata, updateSeriesMetadata } from './store';
import type { SeriesMetadata } from './types';
import { extractVolumeNumber } from './volume-number';

const PENDING_KEY = 'anilist_pending_pushes';

/**
 * How long an identical completion state is treated as already handled. The
 * reader recomputes `completed` on every page turn, so paging off and back
 * onto the last page re-fires the completion listener — without this the
 * 30 req/min AniList budget would be spent on re-reads of the same state.
 */
const COMPLETION_DEBOUNCE_MS = 60_000;

export type PushOutcome = 'pushed' | 'nothing' | 'queued' | 'disabled';

/** One pending intent per series. `restart` dominates `sync` (a restart must be
 *  replayed as the explicit decrease before later completions are applied). */
export interface PendingPush {
  seriesKey: string;
  event: 'restart' | 'sync';
  at: string;
}

// ---------- pure helpers ----------

export function volumeNumberFor(
  volume: VolumeMetadata,
  sortedSeriesVolumes: VolumeMetadata[],
  meta: SeriesMetadata | undefined
): number {
  const override = meta?.tracking?.number_overrides?.[volume.volume_uuid];
  if (typeof override === 'number' && override > 0) return override;
  const parsed = extractVolumeNumber(volume.volume_title, meta?.tracking?.unit ?? 'volumes');
  if (parsed !== undefined) return parsed;
  return sortedSeriesVolumes.findIndex((v) => v.volume_uuid === volume.volume_uuid) + 1;
}

export function computeLocalPassState(
  seriesVolumes: VolumeMetadata[],
  volumesData: Record<string, Pick<VolumeData, 'completed'> | undefined>,
  meta: SeriesMetadata | undefined
): LocalPassState {
  const sorted = [...seriesVolumes].sort(sortVolumes);
  const unit = meta?.tracking?.unit ?? 'volumes';
  let passProgress = 0;
  let allCompleted = sorted.length > 0;
  for (const volume of sorted) {
    if (volumesData[volume.volume_uuid]?.completed) {
      passProgress = Math.max(passProgress, volumeNumberFor(volume, sorted, meta));
    } else {
      allCompleted = false;
    }
  }
  const total = unit === 'chapters' ? meta?.total_chapters : meta?.total_volumes;
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

export function readPendingPushes(): Record<string, PendingPush> {
  if (!browser) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePendingPushes(pending: Record<string, PendingPush>): void {
  if (!browser) return;
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch (error) {
    console.warn('[progress-tracker] could not persist the pending queue:', error);
  }
}

function markPending(seriesKey: string, event: ProgressPushEvent): void {
  const pending = readPendingPushes();
  const existing = pending[seriesKey];
  const next: PendingPush['event'] =
    event === 'restart' || existing?.event === 'restart' ? 'restart' : 'sync';
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

function pushEnabled(meta: SeriesMetadata | undefined): meta is SeriesMetadata {
  if (!meta?.tracking?.enabled) return false;
  if (!meta.external_ids.anilist) return false;
  return get(settings)?.catalogSettings?.pushProgressToAniList !== false;
}

/** Serializes pushes per series so two completion fires can never race. */
const pushChains = new Map<string, Promise<unknown>>();
/** Last completion state we already acted on, per series (this session). */
const recentCompletions = new Map<string, { signature: string; at: number }>();
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
function alreadySettled(seriesKey: string, local: LocalPassState, meta: SeriesMetadata): boolean {
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
  return planProgressPush(local, assumedRemote, meta.tracking?.unit ?? 'volumes', 'sync') === null;
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
  if (!pushEnabled(meta)) return 'disabled';
  const mediaId = meta.external_ids.anilist!;
  const tracking = meta.tracking!;
  const unit = tracking.unit ?? 'volumes';

  const token = getAniListToken();
  if (!token) {
    markPending(seriesKey, event);
    return 'queued';
  }

  const seriesVolumes = await getSeriesVolumesByKey(seriesKey);
  const local = computeLocalPassState(seriesVolumes, get(volumes), meta);

  if (event === 'completion') {
    if (alreadySettled(seriesKey, local, meta)) return 'nothing';
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
    await updateSeriesMetadata(meta.series_title, {
      tracking: {
        ...tracking,
        last_pushed: {
          n: local.passProgress,
          status: plan.status ?? remote?.status ?? 'CURRENT',
          at: new Date().toISOString()
        }
      }
    });
    return 'pushed';
  } catch (error) {
    markPending(seriesKey, event);
    if (error instanceof AniListError) {
      if (error.code === 'UNAUTHORIZED') handleAniListUnauthorized();
      else if (error.code === 'RATE_LIMITED') scheduleRetry(error.retryAfterMs ?? 60_000);
      else if (error.code === 'GRAPHQL') {
        // Bad media id or schema mismatch — retrying won't help.
        console.warn('[progress-tracker] AniList rejected the push:', error);
        clearPending(seriesKey);
      }
    } else {
      console.warn('[progress-tracker] push failed:', error);
    }
    return 'queued';
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
  db.volumes
    .get(volumeUuid)
    .then((volume) => {
      if (!volume) return;
      return pushSeries(normalizeSeriesKey(volume.series_title), 'completion');
    })
    .catch((error) => console.warn('[progress-tracker] onVolumeCompleted failed:', error));
}

export function onSeriesRestarted(seriesKey: string): void {
  if (!browser) return;
  // A restart invalidates everything we know about the previous pass.
  recentCompletions.delete(seriesKey);
  pushSeries(seriesKey, 'restart').catch((error) =>
    console.warn('[progress-tracker] onSeriesRestarted failed:', error)
  );
}

export function syncSeriesNow(seriesKey: string): Promise<PushOutcome> {
  recentCompletions.delete(seriesKey);
  return pushSeries(seriesKey, 'sync');
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
      if (pending.event === 'restart') {
        const outcome = await pushSeries(pending.seriesKey, 'restart');
        if (outcome === 'queued' || outcome === 'disabled') continue;
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

  let seenInitialUser = false;
  let hadUser = false;
  const unsubUser = anilistUser.subscribe((user) => {
    const loggedIn = seenInitialUser && !hadUser && !!user;
    seenInitialUser = true;
    hadUser = !!user;
    if (loggedIn) void flushPendingPushes();
  });

  const dispose = () => {
    if (teardown !== dispose) return;
    teardown = null;
    unregister();
    window.removeEventListener('online', onOnline);
    unsubUser();
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
  rateLimitedUntil = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  flushing = false;
  teardown = null;
}
