import { readable, type Readable } from 'svelte/store';
import { getVolumeEvents, historyVolumes, onHistoryChanged } from './turns-store';
import type { ReadingEvent } from './types';
import { eventKey, lookupVisits } from './visits';

/**
 * "Last read" from reading history (spec: "Last read is not the merge key").
 * `lastProgressUpdate` is the merge key of `volume-data.json` and of
 * `positions.json`, so any write that must win a merge moves it — a look-up's
 * restore, a cover toggle, a stat edit. Recency is the newest end of a view
 * that was reading instead: legacy (converted) views, and native views outside
 * look-up visits, after the volume's `forget` horizon.
 */

/** null = no page events; 0 = page events, none of them reading. */
export function lastReadFromEvents(events: ReadingEvent[]): number | null {
  let horizon = -Infinity;
  let pages = false;
  for (const e of events) {
    if (e.kind === 'forget' && e.before > horizon) horizon = e.before;
    if (e.kind === 'page') pages = true;
  }
  if (!pages) return null;
  const live = events.filter((e) => e.t >= horizon);
  const { lookup } = lookupVisits(live);
  let newest = 0;
  for (const e of live) {
    if (e.kind !== 'page' || lookup.has(eventKey(e))) continue;
    newest = Math.max(newest, e.t + (e.dwell_ms ?? 0));
  }
  return newest;
}

/**
 * Every volume with page events → its last read. Rebuilt per volume when its
 * events change, never on a record write.
 */
export const lastReadTimes: Readable<ReadonlyMap<string, number>> = readable<
  ReadonlyMap<string, number>
>(new Map(), (set) => {
  let times = new Map<string, number>();
  const rebuild = (volumes: Iterable<string>) => {
    for (const volume of volumes) {
      const at = lastReadFromEvents(getVolumeEvents(volume));
      if (at === null) times.delete(volume);
      else times.set(volume, at);
    }
  };
  rebuild(historyVolumes());
  set(times);
  return onHistoryChanged((volumes) => {
    if (volumes === 'all') {
      times = new Map();
      rebuild(historyVolumes());
    } else {
      times = new Map(times);
      rebuild(volumes);
    }
    set(times);
  });
});

export function lastReadTime(
  volume: string,
  record: { lastProgressUpdate?: string } | undefined,
  times: ReadonlyMap<string, number>
): number {
  const fromHistory = times.get(volume);
  if (fromHistory !== undefined) return fromHistory;
  const stamp = Date.parse(record?.lastProgressUpdate ?? '');
  return Number.isNaN(stamp) ? 0 : stamp;
}

/** Smart sort's recency: the newest last read over the series' volumes past page 1. */
export function seriesLastRead(
  volumeIds: string[],
  records: Record<string, { progress?: number; lastProgressUpdate?: string }>,
  times: ReadonlyMap<string, number>
): number {
  let newest = 0;
  for (const id of volumeIds) {
    const record = records[id];
    if ((record?.progress || 0) <= 1) continue;
    newest = Math.max(newest, lastReadTime(id, record, times));
  }
  return newest;
}
