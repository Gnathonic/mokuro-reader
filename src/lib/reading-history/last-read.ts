import { readable, type Readable } from 'svelte/store';
import { stampMs } from '$lib/util/volume-helpers';
import { remoteReads, uncoveredRemoteRead, type RemoteRead } from './remote-reads';
import { getVolumeEvents, historyVolumes, onHistoryChanged } from './turns-store';
import type { ReadingEvent } from './types';
import { eventKey, lookupVisits } from './visits';

/**
 * "Last read" from reading history (spec: "Last read is not the merge key").
 * `lastProgressUpdate` is the merge key of `volume-data.json` and of
 * `positions.json`, so any write that must win a merge moves it — a look-up's
 * restore, a cover toggle, a stat edit. Recency is the newest end of a view
 * that was reading instead: legacy (converted) views, and native views outside
 * look-up visits, after the volume's `forget` horizon — plus another device's
 * reading this device adopted before that device's events arrived
 * (`remote-reads.ts`).
 */

export interface LastRead {
  /** Newest end of a view that was reading; 0 = none was. */
  at: number;
  /** The volume's oldest page event: history knows nothing from before it. */
  since: number;
  /**
   * Another device's adopted read that its own events do not cover yet
   * (`uncoveredRemoteRead`); 0 or absent = none.
   */
  remote?: number;
}

/** null = no page events. */
export function lastReadFromEvents(events: ReadingEvent[]): LastRead | null {
  let horizon = -Infinity;
  let since = Infinity;
  for (const e of events) {
    if (e.kind === 'forget' && e.before > horizon) horizon = e.before;
    if (e.kind === 'page' && e.t < since) since = e.t;
  }
  if (since === Infinity) return null;
  const live = events.filter((e) => e.t >= horizon);
  const { lookup } = lookupVisits(live);
  let at = 0;
  for (const e of live) {
    if (e.kind !== 'page' || lookup.has(eventKey(e))) continue;
    at = Math.max(at, e.t + (e.dwell_ms ?? 0));
  }
  return { at, since };
}

/**
 * Every volume with page events → its last read. Rebuilt per volume when its
 * events change or a remote read of it is noted, never on a record write.
 */
export const lastReadTimes: Readable<ReadonlyMap<string, LastRead>> = readable<
  ReadonlyMap<string, LastRead>
>(new Map(), (set) => {
  let times = new Map<string, LastRead>();
  let remote: ReadonlyMap<string, RemoteRead> = new Map();
  const rebuild = (volumes: Iterable<string>) => {
    for (const volume of volumes) {
      const events = getVolumeEvents(volume);
      const at = lastReadFromEvents(events);
      if (at === null) {
        times.delete(volume);
        continue;
      }
      const read = uncoveredRemoteRead(remote.get(volume), events);
      times.set(volume, read > 0 ? { ...at, remote: read } : at);
    }
  };
  let started = false;
  const stopRemote = remoteReads.subscribe((next) => {
    const prev = remote;
    remote = next;
    if (!started) return;
    const changed = new Set<string>();
    for (const [volume, read] of next) if (prev.get(volume) !== read) changed.add(volume);
    for (const volume of prev.keys()) if (!next.has(volume)) changed.add(volume);
    if (changed.size === 0) return;
    times = new Map(times);
    rebuild(changed);
    set(times);
  });
  started = true;
  rebuild(historyVolumes());
  set(times);
  const stopHistory = onHistoryChanged((volumes) => {
    if (volumes === 'all') {
      times = new Map();
      rebuild(historyVolumes());
    } else {
      times = new Map(times);
      rebuild(volumes);
    }
    set(times);
  });
  return () => {
    stopRemote();
    stopHistory();
  };
});

/**
 * History's last read when it saw reading. Otherwise the record's stamp — but
 * with events present, only a stamp from before them: that is reading history
 * never saw (read before history existed), while a later one is a re-stamp
 * (a look-up's restore, a cover toggle), never a read. Either way, another
 * device's adopted read that history does not hold yet counts (`remote`):
 * it IS reading, and its events may come only with the slow sync, or never.
 */
export function lastReadTime(
  volume: string,
  record: { lastProgressUpdate?: string } | undefined,
  times: ReadonlyMap<string, LastRead>
): number {
  const fromHistory = times.get(volume);
  if (!fromHistory) return stampMs(record?.lastProgressUpdate);
  const remote = fromHistory.remote ?? 0;
  if (fromHistory.at > 0) return Math.max(fromHistory.at, remote);
  const stamp = stampMs(record?.lastProgressUpdate);
  return Math.max(stamp < fromHistory.since ? stamp : 0, remote);
}

/** Smart sort's recency: the newest last read over the series' volumes past page 1. */
export function seriesLastRead(
  volumeIds: string[],
  records: Record<string, { progress?: number; lastProgressUpdate?: string }>,
  times: ReadonlyMap<string, LastRead>
): number {
  let newest = 0;
  for (const id of volumeIds) {
    const record = records[id];
    if ((record?.progress || 0) <= 1) continue;
    newest = Math.max(newest, lastReadTime(id, record, times));
  }
  return newest;
}
