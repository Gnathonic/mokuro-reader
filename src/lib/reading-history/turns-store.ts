import { get, writable, type Readable } from 'svelte/store';
import type { PageTurn } from '$lib/settings/volume-data';
import type { HistoryDexie } from './history-db';
import { projectVolume } from './project-turns';
import { onEventsRecorded } from './record';
import type { ReadingEvent } from './types';

/**
 * Page turns projected from the merged event table (`projectTurns`), for the
 * stats that still read `PageTurn[]` (phase 2b; phase 3 reads events
 * directly). Loaded once; afterwards only the volumes new events touch are
 * re-projected, at most once per microtask, so a page view costs one volume
 * and a large import one emission.
 *
 * `adjust` events are not kept in memory: nothing here reads them yet.
 */

const store = writable<Map<string, PageTurn[]>>(new Map());
const eventsByVolume = new Map<string, Map<string, ReadingEvent>>();
let loaded = false;
/** Events that arrive while the initial read is in flight; applied after it. */
let arrivedWhileLoading: ReadingEvent[] | null = null;
let pendingVolumes: Set<string> | null = null;

let resolveReady!: () => void;
let ready = new Promise<void>((resolve) => (resolveReady = resolve));

export const historyTurns: Readable<Map<string, PageTurn[]>> = { subscribe: store.subscribe };

export function historyTurnsLoaded(): boolean {
  return loaded;
}

/**
 * Settles once the first load has finished — or failed, in which case the
 * records' own turns are what there is. Anything that writes a permanent
 * conclusion from turns (goal snapshots, completion back-dating) waits for it.
 */
export function historyTurnsReady(): Promise<void> {
  return ready;
}

/** Every kept event of one volume (empty until loaded). */
export function getVolumeEvents(volume: string): ReadingEvent[] {
  return [...(eventsByVolume.get(volume)?.values() ?? [])];
}

type ChangeListener = (volumes: Set<string> | 'all') => void;
const changeListeners = new Set<ChangeListener>();

/** Hear which volumes' events changed: `'all'` after a full load. */
export function onHistoryChanged(listener: ChangeListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function announce(volumes: Set<string> | 'all'): void {
  for (const listener of changeListeners) {
    try {
      listener(volumes);
    } catch (error) {
      console.warn('[reading-history] history change listener failed:', error);
    }
  }
}

/** The volume's projected turns; `undefined` until loaded, or when it has none. */
export function getHistoryTurns(volume: string): PageTurn[] | undefined {
  return loaded ? get(store).get(volume) : undefined;
}

/** Full (re)load from the database — on start, and after a big import. */
export async function loadHistoryTurns(db?: HistoryDexie): Promise<void> {
  arrivedWhileLoading = [];
  try {
    const target = db ?? (await import('./history-db')).historyDb();
    const all = await target.reading_events.toArray();
    eventsByVolume.clear();
    for (const event of all) keep(event);
    // Committed after our read began: their notifications came here instead.
    for (const event of arrivedWhileLoading) keep(event);
    const next = new Map<string, PageTurn[]>();
    for (const [volume, events] of eventsByVolume) {
      const turns = projectVolume([...events.values()]);
      if (turns.length > 0) next.set(volume, turns);
    }
    loaded = true;
    store.set(next);
    announce('all');
  } finally {
    arrivedWhileLoading = null;
    resolveReady();
  }
}

function keep(event: ReadingEvent): void {
  // `page`/`forget` shape the projection; `restart`/`position` decide
  // cross-device position offers (`position-offer.ts`). `adjust` is phase 3.
  if (event.kind === 'adjust') return;
  let events = eventsByVolume.get(event.volume);
  if (!events) eventsByVolume.set(event.volume, (events = new Map()));
  events.set(`${event.device}\u0000${event.seq}`, event);
}

onEventsRecorded((events) => {
  if (arrivedWhileLoading) {
    arrivedWhileLoading.push(...events);
    return;
  }
  if (!loaded) return; // never loaded: the next load reads them from the database
  const first = pendingVolumes === null;
  pendingVolumes ??= new Set();
  for (const event of events) {
    keep(event);
    pendingVolumes.add(event.volume);
  }
  if (first) queueMicrotask(flushPending);
});

/**
 * Apply recorded events to the projection now, not at the end of the
 * microtask — the cut-over calls this before stripping turns from records, so
 * no store emission ever sees a record without its turns AND a projection
 * without them.
 */
export function flushHistoryTurns(): void {
  flushPending();
}

function flushPending(): void {
  const touched = pendingVolumes;
  pendingVolumes = null;
  if (!touched || touched.size === 0) return;
  store.update((current) => {
    const next = new Map(current);
    for (const volume of touched) {
      const events = eventsByVolume.get(volume);
      const turns = events ? projectVolume([...events.values()]) : [];
      if (turns.length > 0) next.set(volume, turns);
      else next.delete(volume);
    }
    return next;
  });
  announce(touched);
}

/** Test hook: a loaded projection, without a database. */
export function _setHistoryTurnsForTest(turns: Map<string, PageTurn[]>): void {
  loaded = true;
  resolveReady();
  store.set(turns);
}

/** Test hook. */
export function _resetHistoryTurns(): void {
  eventsByVolume.clear();
  loaded = false;
  arrivedWhileLoading = null;
  pendingVolumes = null;
  ready = new Promise<void>((resolve) => (resolveReady = resolve));
  store.set(new Map());
}
