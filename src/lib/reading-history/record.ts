import { generateUUID } from '$lib/util/uuid';
import type { HistoryDexie } from './history-db';
import type { EventPayload, ReadingEvent } from './types';

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
 * Store one event under this device's next `seq`. The counter is read and
 * advanced in the same rw transaction as the write: IndexedDB serialises rw
 * transactions on a store across every connection, so two tabs of one device
 * can never hand out the same `seq`.
 */
export async function appendEvent(
  db: HistoryDexie,
  payload: EventPayload,
  t: number
): Promise<ReadingEvent> {
  return db.transaction('rw', db.history_meta, db.reading_events, async () => {
    const device = await getOrCreateDeviceId(db);
    const next = await db.history_meta.get(NEXT_SEQ_KEY);
    const seq = typeof next?.value === 'number' ? next.value : 1;
    await db.history_meta.put({ key: NEXT_SEQ_KEY, value: seq + 1 });
    const event = { ...payload, device, seq, t } as ReadingEvent;
    await db.reading_events.add(event);
    return event;
  });
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
  const target = db ? Promise.resolve(db) : import('./history-db').then((m) => m.historyDb());
  return target.then((resolved) => appendEvent(resolved, payload, t)).catch(warnOnce);
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
