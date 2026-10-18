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
 * visit ends — the reader closes, moves on, or the tab is hidden — and a
 * restore drops them.
 */

import { get } from 'svelte/store';
import { liveView } from '$lib/reading-history/live-view';
import { getVolumeEvents, onHistoryChanged } from '$lib/reading-history/turns-store';
import type { ReadingEvent } from '$lib/reading-history/types';
import { VISIT_GAP_MS, isLookupVisit, type ViewLike } from '$lib/reading-history/visits';
import {
  registerCompletionHold,
  registerPositionListener,
  releaseHeldCompletion,
  restoreVolumePosition,
  volumesWithTrash
} from '$lib/settings/volume-data';
import { newestUploaded, unwatchEscapes, watchEscapes } from './escapes';

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
  /** Every stamp the record carried during the visit. */
  seen: Set<number>;
  /** Start times of views that ended here and whose events have not landed. */
  pending: Set<number>;
  open: boolean;
}

let device: string | null = null;
let visit: Visit | null = null;
let restoring = false;

function stampOf(iso: string | undefined): number {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? 0 : t;
}

function snapshotOf(volume: string): Snapshot | null {
  const record = get(volumesWithTrash)[volume];
  if (!record || record.deletedOn) return null;
  return {
    progress: record.progress,
    chars: record.chars,
    completed: record.completed,
    completedAt: record.completedAt,
    stamp: stampOf(record.lastProgressUpdate)
  };
}

function ownViews(volume: string, since: number): PageEvent[] {
  if (!device) return [];
  return getVolumeEvents(volume)
    .filter((e): e is PageEvent => e.kind === 'page' && e.device === device && e.t >= since)
    .sort((a, b) => a.t - b.t || a.seq - b.seq);
}

function check(volume: string): void {
  const v = visit;
  if (!v?.open || v.volume !== volume || !v.snapshot || restoring) return;
  const record = get(volumesWithTrash)[volume];
  if (!record || record.deletedOn) return;
  const stamp = stampOf(record.lastProgressUpdate);
  if (!v.own.has(stamp)) return;
  for (const seen of v.seen) if (!v.own.has(seen) && seen !== v.snapshot.stamp) return;

  const views: ViewLike[] = ownViews(volume, v.since);
  // Until every ended view's event has landed the visit is not whole, and
  // judging it now could miss read pages.
  for (const e of views) v.pending.delete(e.t);
  if (v.pending.size > 0) return;
  const live = get(liveView);
  if (live && live.view.volume === volume) {
    const { first_page, last_page, page_chars } = live.view;
    views.push({ first_page, last_page, page_chars, dwell_ms: 0, t: live.since });
  }
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
    restoreVolumePosition(volume, v.snapshot, at, { announce: escaped });
  } finally {
    restoring = false;
  }
}

/** Position listener, history change, completion hold, hidden tab → release. */
export function initVisitTracking(ownDevice: string): () => void {
  device = ownDevice;
  const stopPositions = registerPositionListener((volume) => {
    const v = visit;
    if (restoring || !v?.open || v.volume !== volume) return;
    v.own.add(stampOf(get(volumesWithTrash)[volume]?.lastProgressUpdate));
    // After the other listeners: the push marks the turn's stamp, and the
    // restore then leaves that mark stale instead of marking the old stamp.
    queueMicrotask(() => check(volume));
  });
  const stopRecords = volumesWithTrash.subscribe((records) => {
    const v = visit;
    if (!v?.open) return;
    const record = records[v.volume];
    if (record) v.seen.add(stampOf(record.lastProgressUpdate));
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
    v.pending.add(prev.since);
  });
  const stopHistory = onHistoryChanged((volumes) => {
    const v = visit;
    if (v?.open && (volumes === 'all' || volumes.has(v.volume))) check(v.volume);
  });
  const stopHold = registerCompletionHold(
    (volume) => visit?.open === true && visit.volume === volume
  );
  const onVisibility = () => {
    if (document.visibilityState === 'hidden' && visit) releaseHeldCompletion(visit.volume);
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stopPositions();
    stopRecords();
    stopLive();
    stopHistory();
    stopHold();
    document.removeEventListener('visibilitychange', onVisibility);
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
    pending: new Set(),
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
 * is still completed. The visit is kept, and its escapes watched, so a reopen
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
