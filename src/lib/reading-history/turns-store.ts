import { get, writable, type Readable } from 'svelte/store';
import type { PageTurn } from '$lib/settings/volume-data';
import type { HistoryDexie } from './history-db';
import { projectVolume } from './project-turns';
import { onEventsRecorded } from './record';
import type { ReadingEvent } from './types';

/**
 * Page turns projected from the merged event table (`projectTurns`), for the
 * stats that still read `PageTurn[]` (phase 2b; phase 3 reads events
 * directly). Loaded once; afterwards only the volumes an append touches are
 * re-projected, so a page view costs one volume, not the whole history.
 */

const store = writable<Map<string, PageTurn[]>>(new Map());
const eventsByVolume = new Map<string, Map<string, ReadingEvent>>();
let loaded = false;

export const historyTurns: Readable<Map<string, PageTurn[]>> = { subscribe: store.subscribe };

export function historyTurnsLoaded(): boolean {
  return loaded;
}

/** The volume's projected turns; `undefined` until loaded, or when it has none. */
export function getHistoryTurns(volume: string): PageTurn[] | undefined {
  return loaded ? get(store).get(volume) : undefined;
}

/** Full (re)load from the database — on start, and after a big import. */
export async function loadHistoryTurns(db?: HistoryDexie): Promise<void> {
  const target = db ?? (await import('./history-db')).historyDb();
  const all = await target.reading_events.toArray();
  eventsByVolume.clear();
  for (const event of all) keep(event);
  const next = new Map<string, PageTurn[]>();
  for (const [volume, events] of eventsByVolume) {
    const turns = projectVolume([...events.values()]);
    if (turns.length > 0) next.set(volume, turns);
  }
  loaded = true;
  store.set(next);
}

function keep(event: ReadingEvent): void {
  let events = eventsByVolume.get(event.volume);
  if (!events) eventsByVolume.set(event.volume, (events = new Map()));
  events.set(`${event.device}\u0000${event.seq}`, event);
}

onEventsRecorded((events) => {
  if (!loaded) return;
  const touched = new Set<string>();
  for (const event of events) {
    keep(event);
    touched.add(event.volume);
  }
  store.update((current) => {
    const next = new Map(current);
    for (const volume of touched) {
      const turns = projectVolume([...eventsByVolume.get(volume)!.values()]);
      if (turns.length > 0) next.set(volume, turns);
      else next.delete(volume);
    }
    return next;
  });
});

/** Test hook: a loaded projection, without a database. */
export function _setHistoryTurnsForTest(turns: Map<string, PageTurn[]>): void {
  loaded = true;
  store.set(turns);
}

/** Test hook. */
export function _resetHistoryTurns(): void {
  eventsByVolume.clear();
  loaded = false;
  store.set(new Map());
}
