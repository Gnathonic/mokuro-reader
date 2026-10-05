import { get } from 'svelte/store';
import { migratePageTurnData } from '$lib/settings/reading-speed';
import {
  VolumeData,
  projectedTurnsOf,
  volumesWithTrash,
  type PageTurn
} from '$lib/settings/volume-data';
import type { HistoryDexie } from './history-db';
import { convertLegacyRecord } from './legacy';
import { notifyEventsRecorded } from './record';
import { flushHistoryTurns, historyTurnsLoaded } from './turns-store';
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
 * only the exact turns that were converted (one that arrived meanwhile stays).
 * If the history database cannot be written, nothing is stripped and the file
 * keeps its turns as before. `archivedReads` are recorded as `restart` events
 * but stay in the record — goal counting reads them.
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
    for (const event of convertLegacyRecord(volume, { ...record, recentPageTurns: upgraded })) {
      if (seen.has(event.seq)) continue;
      seen.add(event.seq);
      events.push(event);
    }
    converted.set(volume, new Set(record.recentPageTurns.map(turnKey)));
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

function turnKey(turn: PageTurn | number[]): string {
  return `${turn[0]}|${turn[1]}`;
}

/**
 * The records as they go into `volume-data.json` while the cloud does not (yet)
 * hold their turns as history: each live record carries its own turns plus
 * every turn history projects for it. Used when the provider cannot carry
 * history at all (mokuro-bunko, read-only) — turns keep travelling in the file
 * exactly as before the cut-over — and until this device's converted turns are
 * confirmed uploaded. Never written back into the store.
 */
export async function attachProjectedTurns(
  records: Record<string, VolumeData>
): Promise<Record<string, VolumeData>> {
  const out: Record<string, VolumeData> = {};
  for (const [volume, record] of Object.entries(records)) {
    if (record.deletedOn) {
      out[volume] = record;
      continue;
    }
    const projected = projectedTurnsOf(volume, record);
    if (projected === record.recentPageTurns || projected.length === 0) {
      out[volume] = record;
      continue;
    }
    const byKey = new Map<string, PageTurn>();
    for (const turn of [...record.recentPageTurns, ...projected]) byKey.set(turnKey(turn), turn);
    const turns = [...byKey.values()].sort((a, b) => a[0] - b[0]);
    out[volume] = new VolumeData({ ...record, recentPageTurns: turns });
  }
  return out;
}
