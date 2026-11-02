import { generateUUID } from '$lib/util/uuid';
import type { HistoryDexie } from './history-db';
import type { EventPayload, PagePayload, PauseCount, ReadingEvent } from './types';

const DEVICE_ID_KEY = 'device_id';
const NEXT_SEQ_KEY = 'next_seq';

/**
 * This install's device ID, created on first call. Read-or-create runs in one
 * rw transaction, so two tabs racing on first run still agree on one ID.
 */
export async function getOrCreateDeviceId(db: HistoryDexie): Promise<string> {
  return db.transaction('rw', db.history_meta, async () => {
    const row = await db.history_meta.get(DEVICE_ID_KEY);
    if (typeof row?.value === 'string') return row.value;
    const id = generateUUID();
    await db.history_meta.put({ key: DEVICE_ID_KEY, value: id });
    return id;
  });
}

/**
 * This device and the first of `count` consecutive fresh seqs. Call it inside
 * the caller's rw transaction over `history_meta` and `reading_events`: the
 * counter is read and advanced in the same transaction as the writes, and
 * IndexedDB serialises rw transactions on a store across every connection, so
 * two tabs of one device can never hand out the same `seq`.
 */
async function takeSeqs(db: HistoryDexie, count: number): Promise<{ device: string; seq: number }> {
  const device = await getOrCreateDeviceId(db);
  const next = await db.history_meta.get(NEXT_SEQ_KEY);
  const seq = typeof next?.value === 'number' ? next.value : 1;
  await db.history_meta.put({ key: NEXT_SEQ_KEY, value: seq + count });
  return { device, seq };
}

/** Store one event under this device's next `seq`. */
export async function appendEvent(
  db: HistoryDexie,
  payload: EventPayload,
  t: number
): Promise<ReadingEvent> {
  const event = await db.transaction('rw', db.history_meta, db.reading_events, async () => {
    const { device, seq } = await takeSeqs(db, 1);
    const stored = { ...payload, device, seq, t } as ReadingEvent;
    await db.reading_events.add(stored);
    return stored;
  });
  // After the commit: listeners only ever hear about durable events.
  notifyEventsRecorded([event]);
  return event;
}

/**
 * Store a finished view: its `page` event under seq n and, when the user
 * answered its long pause, a `resolve` under n+1 aimed at it. One rw
 * transaction, so a page is never stored without the answer given for it.
 */
export async function appendView(
  db: HistoryDexie,
  page: PagePayload,
  t: number,
  answer: { count: PauseCount; t: number } | null
): Promise<ReadingEvent[]> {
  const events = await db.transaction('rw', db.history_meta, db.reading_events, async () => {
    const { device, seq } = await takeSeqs(db, answer ? 2 : 1);
    const stored: ReadingEvent[] = [{ ...page, device, seq, t }];
    if (answer) {
      stored.push({
        kind: 'resolve',
        volume: page.volume,
        target: [device, seq],
        count: answer.count,
        device,
        seq: seq + 1,
        t: answer.t
      });
    }
    await db.reading_events.bulkAdd(stored);
    return stored;
  });
  notifyEventsRecorded(events);
  return events;
}

type EventsListener = (events: ReadingEvent[]) => void;
const listeners = new Set<EventsListener>();

/** Hear about events once they are stored (recorded here, imported, converted). */
export function onEventsRecorded(listener: EventsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called after a transaction that stored events has committed. */
export function notifyEventsRecorded(events: ReadingEvent[]): void {
  if (events.length === 0) return;
  for (const listener of listeners) {
    try {
      listener(events);
    } catch (error) {
      console.warn('[reading-history] events listener failed:', error);
    }
  }
}

let warned = false;

/**
 * Fire-and-forget recording for UI and store code. Never throws: history is
 * worth less than the reading it describes, so a failing database (private
 * mode, quota, blocked upgrade) logs once per session and is otherwise ignored.
 *
 * The database module is loaded on first use, not imported: `volume-data.ts`
 * imports this file, and loading it must not evaluate the Dexie subclass
 * (many suites mock `dexie` without a default export).
 */
export function recordEvent(
  payload: EventPayload,
  t: number = Date.now(),
  db?: HistoryDexie
): Promise<ReadingEvent | null> {
  if (!db && typeof indexedDB === 'undefined') return Promise.resolve(null);
  return historyFor(db)
    .then((resolved) => appendEvent(resolved, payload, t))
    .catch(warnOnce);
}

/** `recordEvent` for a finished view and its answer (`appendView`): never throws. */
export function recordView(
  page: PagePayload,
  t: number,
  answer: { count: PauseCount; t: number } | null,
  db?: HistoryDexie
): Promise<ReadingEvent[] | null> {
  if (!db && typeof indexedDB === 'undefined') return Promise.resolve(null);
  return historyFor(db)
    .then((resolved) => appendView(resolved, page, t, answer))
    .catch(warnOnce);
}

/** An answer given after the view ended (the review list): never throws. */
export function recordResolve(
  volume: string,
  target: [device: string, seq: number],
  count: PauseCount,
  t: number = Date.now(),
  db?: HistoryDexie
): Promise<ReadingEvent | null> {
  return recordEvent({ kind: 'resolve', volume, target, count }, t, db);
}

function historyFor(db?: HistoryDexie): Promise<HistoryDexie> {
  return db ? Promise.resolve(db) : import('./history-db').then((m) => m.historyDb());
}

function warnOnce(error: unknown): null {
  if (!warned) {
    warned = true;
    console.warn('[reading-history] could not record event:', error);
  }
  return null;
}

/** Test hook: re-arm the once-per-session warning. */
export function _resetRecordWarning(): void {
  warned = false;
}
