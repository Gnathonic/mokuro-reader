import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { HistoryDexie } from './history-db';
import { _resetRecordWarning, appendEvent, getOrCreateDeviceId, recordEvent } from './record';
import type { PagePayload } from './types';

let n = 0;
const dbs: HistoryDexie[] = [];
function freshDb(name = `history_test_${n++}`): HistoryDexie {
  const db = new HistoryDexie(name);
  dbs.push(db);
  return db;
}

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    db.close();
    await HistoryDexie.delete(db.name);
  }
  vi.restoreAllMocks();
});

const page = (p: number): PagePayload => ({
  kind: 'page',
  volume: 'vol-1',
  first_page: p,
  last_page: p,
  page_chars: [10],
  chars_before: 0,
  dwell_ms: 1000,
  layout: 'single',
  orientation: 'portrait',
  viewport: { w: 400, h: 800 }
});

describe('getOrCreateDeviceId', () => {
  it('creates one ID and returns the same one afterwards', async () => {
    const db = freshDb();
    const a = await getOrCreateDeviceId(db);
    const b = await getOrCreateDeviceId(db);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toBe(a);
  });

  it('agrees across two connections to the same database (two tabs)', async () => {
    const name = `history_test_${n++}`;
    const [a, b] = await Promise.all([
      getOrCreateDeviceId(freshDb(name)),
      getOrCreateDeviceId(freshDb(name))
    ]);
    expect(b).toBe(a);
  });
});

describe('appendEvent', () => {
  it('numbers events 1, 2, 3 under this device and stores them', async () => {
    const db = freshDb();
    const e1 = await appendEvent(db, page(1), 100);
    const e2 = await appendEvent(db, page(2), 200);
    const device = await getOrCreateDeviceId(db);
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    expect(e1.device).toBe(device);
    expect(await db.reading_events.get([device, 2])).toMatchObject({ t: 200, first_page: 2 });
  });

  it('never reuses a seq when two connections append concurrently', async () => {
    const name = `history_test_${n++}`;
    const a = freshDb(name);
    const b = freshDb(name);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => appendEvent(i % 2 ? a : b, page(i + 1), i))
    );
    const seqs = results.map((e) => e.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await a.reading_events.count()).toBe(20);
  });
});

describe('recordEvent', () => {
  it('writes through to the given database', async () => {
    const db = freshDb();
    const e = await recordEvent(page(3), 300, db);
    expect(e?.seq).toBe(1);
  });

  it('swallows a failing database, warns once, and returns null', async () => {
    _resetRecordWarning();
    const db = freshDb();
    vi.spyOn(db, 'transaction').mockImplementation((() =>
      Promise.reject(new Error('QuotaExceededError'))) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordEvent(page(1), 1, db)).resolves.toBeNull();
    await expect(recordEvent(page(2), 2, db)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
