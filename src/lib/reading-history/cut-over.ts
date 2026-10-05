import { get } from 'svelte/store';
import { migratePageTurnData } from '$lib/settings/reading-speed';
import { VolumeData, volumesWithTrash, type PageTurn } from '$lib/settings/volume-data';
import type { HistoryDexie } from './history-db';
import { convertLegacyRecord } from './legacy';
import { notifyEventsRecorded } from './record';
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
 * Safe by order: a turn is stripped only after its event is committed, and
 * only the exact turns that were converted (one that arrived meanwhile stays).
 * If the history database cannot be written, nothing is stripped and the file
 * keeps its turns as before. `archivedReads` are recorded as `restart` events
 * but stay in the record — goal counting reads them.
 */
export async function cutOverLegacyTurns(
  db?: HistoryDexie
): Promise<{ volumes: number; events: number }> {
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
    events.push(...convertLegacyRecord(volume, { ...record, recentPageTurns: upgraded }));
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
