import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { HistoryDexie } from './history-db';
import {
  _resetRecordWarning,
  appendEvent,
  appendView,
  getOrCreateDeviceId,
  onEventsRecorded,
  recordEvent,
  recordResolve,
  recordView
} from './record';
import type { PagePayload, ReadingEvent } from './types';

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

describe('appendView', () => {
  it('stores the page and the answer aimed at it under consecutive seqs, heard once', async () => {
    const db = freshDb();
    await appendEvent(db, page(1), 50);
    const heard: ReadingEvent[][] = [];
    const off = onEventsRecorded((events) => heard.push(events));
    const out = await appendView(db, page(2), 100, { count: 'typical', t: 400 });
    off();
    const device = await getOrCreateDeviceId(db);
    expect(out).toEqual([
      { ...page(2), device, seq: 2, t: 100 },
      {
        kind: 'resolve',
        volume: 'vol-1',
        target: [device, 2],
        count: 'typical',
        device,
        seq: 3,
        t: 400
      }
    ]);
    expect(heard).toEqual([out]);
    expect(
      await db.reading_events.bulkGet([
        [device, 2],
        [device, 3]
      ])
    ).toEqual(out);
    expect((await appendEvent(db, page(3), 500)).seq).toBe(4);
  });

  it('stores only the page when the view was not answered', async () => {
    const db = freshDb();
    const out = await appendView(db, page(1), 100, null);
    expect(out.map((e) => [e.kind, e.seq])).toEqual([['page', 1]]);
    expect(await db.reading_events.count()).toBe(1);
    expect((await appendEvent(db, page(2), 200)).seq).toBe(2);
  });

  it('stores neither event when the answer cannot be stored', async () => {
    const db = freshDb();
    const device = await getOrCreateDeviceId(db);
    // A row already sits where the answer would go, so the transaction aborts.
    await db.reading_events.add({ ...page(9), device, seq: 2, t: 1 });
    await expect(appendView(db, page(1), 100, { count: 'none', t: 200 })).rejects.toThrow();
    expect(await db.reading_events.get([device, 1])).toBeUndefined();
    expect((await appendEvent(db, page(3), 300)).seq).toBe(1);
  });

  it('never shares a seq with concurrent appends on another connection', async () => {
    const name = `history_test_${n++}`;
    const a = freshDb(name);
    const b = freshDb(name);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 2
          ? appendView(a, page(i + 1), i, { count: 'full', t: i + 1 })
          : appendEvent(b, page(i + 1), i).then((e) => [e])
      )
    );
    const seqs = results
      .flat()
      .map((e) => e.seq)
      .sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    for (const [view, answer] of results.filter((r) => r.length === 2)) {
      expect(answer).toMatchObject({ kind: 'resolve', seq: view.seq + 1 });
      expect(answer).toMatchObject({ target: [view.device, view.seq] });
    }
  });
});

describe('recordView', () => {
  it('writes the view and its answer through to the given database', async () => {
    const db = freshDb();
    const out = await recordView(page(1), 100, { count: 'full', t: 300 }, db);
    expect(out?.map((e) => [e.kind, e.seq])).toEqual([
      ['page', 1],
      ['resolve', 2]
    ]);
  });

  it('writes only the page for an unanswered view', async () => {
    const db = freshDb();
    const out = await recordView(page(1), 100, null, db);
    expect(out?.map((e) => e.kind)).toEqual(['page']);
    expect(await db.reading_events.count()).toBe(1);
  });

  it('swallows a failing database, sharing the once-per-session warning', async () => {
    _resetRecordWarning();
    const db = freshDb();
    vi.spyOn(db, 'transaction').mockImplementation((() =>
      Promise.reject(new Error('QuotaExceededError'))) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordView(page(1), 1, { count: 'none', t: 2 }, db)).resolves.toBeNull();
    await expect(recordEvent(page(2), 3, db)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('recordResolve', () => {
  it('records an answer aimed at a page of any device (the review list)', async () => {
    const db = freshDb();
    const e = await recordResolve('vol-1', ['dev-b', 41], 'none', 700, db);
    expect(e).toMatchObject({
      kind: 'resolve',
      volume: 'vol-1',
      target: ['dev-b', 41],
      count: 'none',
      seq: 1,
      t: 700
    });
    expect(await db.reading_events.get([e!.device, 1])).toEqual(e);
  });
});
