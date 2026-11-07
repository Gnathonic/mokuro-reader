import { get } from 'svelte/store';
import { migratePageTurnData } from '$lib/settings/reading-speed';
import { VolumeData, projectedTurnsOf, volumesWithTrash } from '$lib/settings/volume-data';
import { turnKey } from '$lib/util/sync/volume-record-merge';
import type { HistoryDexie } from './history-db';
import { convertLegacyRecord } from './legacy';
import { notifyEventsRecorded } from './record';
import { flushHistoryTurns, historyTurnsLoaded, nativeCoverageOf } from './turns-store';
import type { ReadingEvent } from './types';

/**
 * The phase-2b cut-over (spec: Migration and compatibility): page turns still
 * held in `volume-data.json` records become legacy events in reading history,
 * then leave the records — so the file stops carrying them.
 *
 * Runs on start and inside every progress sync, between the merge and the
 * upload (the merge brings back turns an older client or an unconverted
 * device still had; they are converted and stripped before the file goes up).
 *
 * Safe by order: nothing is stripped unless the projection is loaded; a turn
 * is stripped only after its event is committed AND projected, and
 * only the exact turns that were converted (one that arrived meanwhile stays,
 * as does a same-millisecond twin the conversion did not keep).
 * If the history database cannot be written, nothing is stripped and the file
 * keeps its turns as before. `archivedReads` are recorded as `restart` events
 * but stay in the record — goal counting reads them.
 *
 * The spec's coverage rule applies here as well as in the projection: a turn
 * a native view of the volume already covers is that view's own reading (a
 * phase-1 device recorded both; or an older client's file carried this
 * device's views as turns and the merge brought them back) — it is stripped,
 * since the native event is its record, but never stored as a legacy event.
 */
export async function cutOverLegacyTurns(
  db?: HistoryDexie
): Promise<{ volumes: number; events: number }> {
  // Stripped turns are served from the projection; without it loaded (the
  // load failed, or has not run) the stats would go empty. Keep them.
  if (!historyTurnsLoaded()) return { volumes: 0, events: 0 };
  const snapshot = get(volumesWithTrash);
  const candidates = Object.entries(snapshot).filter(
    ([, record]) =>
      !record.deletedOn && (record.recentPageTurns.length > 0 || record.archivedReads.length > 0)
  );
  if (candidates.length === 0) return { volumes: 0, events: 0 };

  const target = db ?? (await import('./history-db')).historyDb();
  const converted = new Map<string, Set<string>>();
  const events: ReadingEvent[] = [];
  for (const [volume, record] of candidates) {
    // Turns without character counts (the oldest format) are upgraded from the
    // installed volume's OCR where possible, so they count toward speed.
    const upgraded =
      (await migratePageTurnData(volume, record, record.recentPageTurns)) ?? record.recentPageTurns;
    // One event per key: a turn and an archived read on the same millisecond
    // share `[legacy:<volume>, t]`; a duplicate would abort the whole batch.
    const seen = new Set<number>();
    const keys = new Set<string>();
    const covered = nativeCoverageOf(volume);
    for (const event of convertLegacyRecord(volume, { ...record, recentPageTurns: upgraded })) {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
      if (event.kind === 'page') {
        // Converted or covered: either way history now stands for this turn.
        keys.add(turnKey([event.t, event.first_page]));
        if (covered(event.t)) continue;
      }
      events.push(event);
    }
    converted.set(volume, keys);
  }

  let added: ReadingEvent[] = [];
  try {
    await target.transaction('rw', target.reading_events, async () => {
      const stored = await target.reading_events.bulkGet(
        events.map((e) => [e.device, e.seq] as [string, number])
      );
      added = events.filter((_, i) => !stored[i]);
      if (added.length > 0) await target.reading_events.bulkAdd(added);
    });
  } catch (error) {
    console.warn('[reading-history] could not convert page turns; keeping them:', error);
    return { volumes: 0, events: 0 };
  }
  notifyEventsRecorded(added);
  flushHistoryTurns();

  let stripped = 0;
  volumesWithTrash.update((all) => {
    const next = { ...all };
    for (const [volume, keys] of converted) {
      const current = next[volume];
      if (!current || current.recentPageTurns.length === 0) continue;
      const remaining = current.recentPageTurns.filter((turn) => !keys.has(turnKey(turn)));
      if (remaining.length === current.recentPageTurns.length) continue;
      // Not a user action: no new stamp. The merge unions turns, so a copy
      // elsewhere that still has them converges once that device converts.
      next[volume] = new VolumeData({ ...current, recentPageTurns: remaining });
      stripped++;
    }
    return next;
  });
  return { volumes: stripped, events: added.length };
}

/**
 * The records as they go into `volume-data.json` while the cloud does not (yet)
 * hold their turns as history: each live record carries its own turns plus
 * the turns history projects for it. Never written back into the store.
 *
 * Which turns depends on whether the provider syncs history. Where it does
 * (`historySyncs`), only the CONVERTED turns ride — until this device's
 * `legacy.events` is confirmed uploaded, the file is their only cloud copy.
 * Native views travel as this device's own months; put into the file too,
 * they would come back through the merge as turns and be converted into
 * legacy events. Where it cannot carry history at all (mokuro-bunko < 0.7.8,
 * read-only), the file is the only copy that reaches other devices, so every
 * projected turn rides exactly as before the cut-over.
 */
export async function attachProjectedTurns(
  records: Record<string, VolumeData>,
  { historySyncs }: { historySyncs: boolean }
): Promise<Record<string, VolumeData>> {
  const out: Record<string, VolumeData> = {};
  for (const [volume, record] of Object.entries(records)) {
    if (record.deletedOn) {
      out[volume] = record;
      continue;
    }
    const turns = projectedTurnsOf(volume, record, { legacyOnly: historySyncs });
    out[volume] =
      turns === record.recentPageTurns
        ? record
        : new VolumeData({ ...record, recentPageTurns: turns });
  }
  return out;
}
