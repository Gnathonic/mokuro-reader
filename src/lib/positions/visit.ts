/**
 * The open visit, live (spec: "Look-up visits claim nothing"). A visit
 * remembers the record as it stood when the reader opened (after the open
 * check). When the reader comes back to the home view and the visit so far is
 * a look-up (`isLookupVisit`, the same rule history applies), the record is put
 * back: the page the user sees is the same, only the claim goes.
 *
 * - Nothing of the visit left the device: the old stamp comes back exactly,
 *   and the push has nothing to send.
 * - A stamp of the visit went up (`escapes.ts`): the home values are written
 *   1 ms above the newest upload, so the visited page does not stick in the
 *   cloud. That beats only this device's own visit.
 * - Restore only while every stamp the record took during the visit was one
 *   this visit set. Another device's position landing mid-visit (a
 *   volume-data merge) spoils the visit: there is nothing to undo.
 * - A view that just ended is judged only once its event has landed: the turn
 *   home moves the record at once, the history write follows (`pending`).
 *
 * Completions of the open volume are held (`registerCompletionHold`) until the
 * visit ends — the reader closes, moves on, or the tab is hidden or unloaded
 * (`pagehide`) — and a restore drops them.
 */

import { get } from 'svelte/store';
import { liveView } from '$lib/reading-history/live-view';
import { getVolumeEvents, onHistoryChanged } from '$lib/reading-history/turns-store';
import type { ReadingEvent } from '$lib/reading-history/types';
import {
  LOOKUP_MAX_READ_PAGES,
  VISIT_GAP_MS,
  isLookupVisit,
  pagesReadAway,
  type ViewLike
} from '$lib/reading-history/visits';
import {
  registerCompletionHold,
  registerPositionListener,
  releaseHeldCompletion,
  restoreVolumePosition,
  volumesWithTrash
} from '$lib/settings/volume-data';
import { stampMs } from '$lib/util/volume-helpers';
import { newestUploaded, unwatchEscapes, watchEscapes } from './escapes';
import { noteReaderTurned } from './reader-open';

type PageEvent = Extract<ReadingEvent, { kind: 'page' }>;

interface Snapshot {
  progress: number;
  chars: number;
  completed: boolean;
  completedAt?: string;
  stamp: number;
}

interface Visit {
  volume: string;
  /** Own page events from here on belong to the visit. */
  since: number;
  /** null: the volume had no record to put back. */
  snapshot: Snapshot | null;
  /** Stamps this visit set (its turns, its restores). */
  own: Set<number>;
  /** Every stamp the record carried during the visit, open or closed. */
  seen: Set<number>;
  /** Views that ended here and whose events have not landed, by start time. */
  pending: Map<number, ViewLike>;
  /** The stamp of the last restore: nothing to do again until the record moves. */
  restoredAt: number | null;
  open: boolean;
}

let device: string | null = null;
let visit: Visit | null = null;
let restoring = false;

function snapshotOf(volume: string): Snapshot | null {
  const record = get(volumesWithTrash)[volume];
  if (!record || record.deletedOn) return null;
  return {
    progress: record.progress,
    chars: record.chars,
    completed: record.completed,
    completedAt: record.completedAt,
    stamp: stampMs(record.lastProgressUpdate)
  };
}

function ownViews(volume: string, since: number): PageEvent[] {
  if (!device) return [];
  return getVolumeEvents(volume)
    .filter((e): e is PageEvent => e.kind === 'page' && e.device === device && e.t >= since)
    .sort((a, b) => a.t - b.t || a.seq - b.seq);
}

/** Another device's position landed during the visit: there is nothing to undo. */
function spoiled(v: Visit & { snapshot: Snapshot }): boolean {
  for (const seen of v.seen) if (!v.own.has(seen) && seen !== v.snapshot.stamp) return true;
  return false;
}

/** The view on screen, as it stands now (`dwell` so far, or 0). */
function liveViewOf(volume: string, dwellUntil: number | null): ViewLike | null {
  const live = get(liveView);
  if (!live || live.view.volume !== volume) return null;
  const { first_page, last_page, page_chars } = live.view;
  const dwell_ms = dwellUntil === null ? 0 : Math.max(0, dwellUntil - live.since);
  return { first_page, last_page, page_chars, dwell_ms, t: live.since };
}

/** The visit's views so far: landed events, then ended views still on their way. */
function visitViews(v: Visit): ViewLike[] {
  const views: ViewLike[] = ownViews(v.volume, v.since);
  for (const e of views) v.pending.delete(e.t);
  views.push(...v.pending.values());
  return views.sort((a, b) => a.t - b.t);
}

/**
 * Could this visit still come home as a look-up? Only then is a completion
 * held: a visit that already read more than `LOOKUP_MAX_READ_PAGES` pages away
 * from home is reading, and its completion is announced at once, as always.
 */
function couldBeLookup(volume: string): boolean {
  const v = visit;
  if (!v?.open || v.volume !== volume || !v.snapshot || spoiled({ ...v, snapshot: v.snapshot })) {
    return false;
  }
  // The view on screen counts with its time so far: the record moves before
  // the view tracker hears of the turn.
  const current = liveViewOf(volume, Date.now());
  const views = visitViews(v);
  if (current) views.push(current);
  return pagesReadAway(views) <= LOOKUP_MAX_READ_PAGES;
}

function check(volume: string): void {
  const v = visit;
  if (!v?.open || v.volume !== volume || !v.snapshot || restoring) return;
  const snapshot = v.snapshot;
  const record = get(volumesWithTrash)[volume];
  if (!record || record.deletedOn) return;
  const stamp = stampMs(record.lastProgressUpdate);
  if (!v.own.has(stamp) || stamp === v.restoredAt) return;
  if (spoiled({ ...v, snapshot })) return;
  // The page on screen stays: a restore that moved it would scroll the reader
  // (continuous mode shows several pages; its position is one of them).
  if ((record.progress || 1) !== (snapshot.progress || 1)) return;

  // Until every ended view's event has landed the visit is not whole, and
  // judging it now could miss read pages.
  const views: ViewLike[] = ownViews(volume, v.since);
  for (const e of views) v.pending.delete(e.t);
  if (v.pending.size > 0) return;
  const current = liveViewOf(volume, null);
  if (current) views.push(current);
  if (views.length === 0) return;
  const home = views[0];
  const page = Math.max(1, record.progress);
  if (page < home.first_page || page > home.last_page) return;
  if (!isLookupVisit(views)) return;

  const uploaded = newestUploaded(volume);
  const escaped = uploaded > v.snapshot.stamp;
  const at = escaped ? uploaded + 1 : v.snapshot.stamp;
  v.own.add(at);
  restoring = true;
  try {
    if (restoreVolumePosition(volume, snapshot, at, { announce: escaped })) v.restoredAt = at;
  } finally {
    restoring = false;
  }
  // The position is the user's now, whatever its stamp says: a newer one from
  // another device is an offer, not a move under the reader.
  noteReaderTurned(volume);
}

/** Position listener, history change, completion hold, hidden tab → release. */
export function initVisitTracking(ownDevice: string): () => void {
  device = ownDevice;
  const stopPositions = registerPositionListener((volume) => {
    const v = visit;
    if (restoring || !v?.open || v.volume !== volume) return;
    v.own.add(stampMs(get(volumesWithTrash)[volume]?.lastProgressUpdate));
    // After the other listeners: the push marks the turn's stamp, and the
    // restore then leaves that mark stale instead of marking the old stamp.
    queueMicrotask(() => check(volume));
  });
  const stopRecords = volumesWithTrash.subscribe((records) => {
    // Closed too: a merge between two opens of one continued visit spoils it.
    const v = visit;
    if (!v) return;
    const record = records[v.volume];
    if (record) v.seen.add(stampMs(record.lastProgressUpdate));
  });
  // A view of the visit that ends (the next view opened, or none) is owed an event.
  let shown = get(liveView);
  const stopLive = liveView.subscribe((next) => {
    const prev = shown;
    shown = next;
    const v = visit;
    if (!v?.open || !prev || prev.view.volume !== v.volume || prev.since < v.since) return;
    // The same view re-announced (an answer preset on it) has not ended.
    if (next && next.since === prev.since && next.view.volume === prev.view.volume) return;
    const ended = next?.since ?? Date.now();
    const { first_page, last_page, page_chars } = prev.view;
    v.pending.set(prev.since, {
      first_page,
      last_page,
      page_chars,
      dwell_ms: Math.max(0, ended - prev.since),
      t: prev.since
    });
  });
  const stopHistory = onHistoryChanged((volumes) => {
    const v = visit;
    if (v?.open && (volumes === 'all' || volumes.has(v.volume))) check(v.volume);
  });
  const stopHold = registerCompletionHold(couldBeLookup);
  // A held completion lives in memory only. The tab going out of view or
  // away releases it; a tab killed while visible (a crash, the OS reclaiming
  // it) loses it, and the AniList push with it — `becameCompleted` needs the
  // flag to rise again. Closing that too would mean persisting the held set
  // and re-announcing it at the next start, once the restored record is
  // known to be still completed; not done, the window is small.
  const release = () => {
    if (visit) releaseHeldCompletion(visit.volume);
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') release();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', release);
  return () => {
    stopPositions();
    stopRecords();
    stopLive();
    stopHistory();
    stopHold();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', release);
    if (device === ownDevice) device = null;
  };
}

/**
 * The reader opened `volume` (after the open check). Continues the last visit
 * of this volume when its own last view ended at most `VISIT_GAP_MS` ago, as
 * history would draw it; otherwise a new visit snapshots the record now.
 */
export function startVisit(volume: string, now: number = Date.now()): void {
  if (visit && visit.volume === volume && !visit.open) {
    const views = ownViews(volume, visit.since);
    const end = views.reduce((max, e) => Math.max(max, e.t + (e.dwell_ms ?? 0)), -Infinity);
    if (views.length > 0 && now - end <= VISIT_GAP_MS) {
      visit.open = true;
      return;
    }
  }
  if (visit) unwatchEscapes(visit.volume);
  const snapshot = snapshotOf(volume);
  visit = {
    volume,
    since: now,
    snapshot,
    own: new Set(),
    seen: new Set(snapshot ? [snapshot.stamp] : []),
    pending: new Map(),
    restoredAt: null,
    open: true
  };
  watchEscapes(volume);
}

/**
 * A late answer of the open check moved the page before any turn here: the
 * visit's home is where the reader now is (live only — history still sees the
 * first view at the old page and rates the visit ordinary reading).
 */
export function rehomeVisit(volume: string): void {
  const v = visit;
  if (!v?.open || v.volume !== volume || v.own.size > 0) return;
  v.snapshot = snapshotOf(volume);
  v.since = Date.now();
  v.seen = new Set(v.snapshot ? [v.snapshot.stamp] : []);
}

/**
 * The reader left `volume`. A held completion is announced now if the record
 * is still completed (a completion is held only while the visit could still
 * be a look-up). The visit is kept, and its escapes watched, so a reopen
 * within the gap continues it.
 */
export function endVisit(volume: string): void {
  if (visit?.volume !== volume) return;
  visit.open = false;
  releaseHeldCompletion(volume);
}

export function _resetVisitsForTests(): void {
  if (visit) unwatchEscapes(visit.volume);
  visit = null;
  restoring = false;
}
