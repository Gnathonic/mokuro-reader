import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';
import { KEYED_TABLE_COALESCE_MS, keyedTableMap, moveKeyedRecord } from './keyed-table';

/**
 * A row carrying BOTH tiebreak fields the two real callers use. Nothing stores
 * a record shaped like this — it exists so one fixture can be asked the same
 * question twice with the two different tiebreaks and give two different
 * answers, which is what proves the tiebreak is the CALLER's and not baked in.
 */
interface Row {
  series_key: string;
  series_title: string;
  updated_at: string;
  fetched_at: string;
  derived?: string;
}

let db: Dexie;
let rows: Table<Row>;

beforeEach(async () => {
  db = new Dexie(`keyed-table-test-${Math.random().toString(36).slice(2)}`);
  db.version(1).stores({ rows: 'series_key' });
  await db.open();
  rows = db.table<Row>('rows');
});

afterEach(async () => {
  const name = db.name;
  db.close();
  await Dexie.delete(name);
});

function row(overrides: Partial<Row> & Pick<Row, 'series_key' | 'series_title'>): Row {
  return {
    updated_at: '2026-08-01T00:00:00.000Z',
    fetched_at: '2026-08-01T00:00:00.000Z',
    ...overrides
  };
}

/** The rename both callers pass: set the key and title, derive nothing else. */
const plainRekey = (record: Row, series_key: string, series_title: string): Row => ({
  ...record,
  series_key,
  series_title
});

describe('moveKeyedRecord', () => {
  it('moves the record to the new key and drops the old one', async () => {
    await rows.put(row({ series_key: 'old name', series_title: 'Old Name' }));

    await moveKeyedRecord(rows, 'Old Name', 'New Name', {
      tiebreak: (r) => r.updated_at,
      rekey: plainRekey
    });

    expect(await rows.get('old name')).toBeUndefined();
    expect((await rows.get('new name'))?.series_title).toBe('New Name');
  });

  it('re-titles in place when only case or whitespace changed', async () => {
    await rows.put(row({ series_key: 'one piece', series_title: 'one piece' }));

    await moveKeyedRecord(rows, 'one piece', '  One   Piece ', {
      tiebreak: (r) => r.updated_at,
      rekey: plainRekey
    });

    expect(await rows.count()).toBe(1);
    expect((await rows.get('one piece'))?.series_title).toBe('  One   Piece ');
  });

  it('does nothing when there is no record under the old key', async () => {
    await moveKeyedRecord(rows, 'Absent', 'New Name', {
      tiebreak: (r) => r.updated_at,
      rekey: plainRekey
    });

    expect(await rows.count()).toBe(0);
  });

  /**
   * THE POINT OF THE SHARED HELPER: the tiebreak belongs to the caller.
   *
   * ONE fixture, asked twice. The record being moved is the newer one by
   * `updated_at` and the older one by `fetched_at`, so the two callers' rules
   * give OPPOSITE winners. A helper that hard-coded either field — or ignored
   * the option and always preferred one side — makes both runs agree, and an
   * assertion that both runs agreed is exactly the assertion satisfied
   * identically by both branches. These two must disagree.
   */
  const collision = async () => {
    await rows.put(
      row({
        series_key: 'old name',
        series_title: 'Old Name',
        updated_at: '2026-08-20T00:00:00.000Z', // newer
        fetched_at: '2026-08-01T00:00:00.000Z' // older
      })
    );
    await rows.put(
      row({
        series_key: 'new name',
        series_title: 'Sitting Tenant',
        updated_at: '2026-08-10T00:00:00.000Z', // older
        fetched_at: '2026-08-10T00:00:00.000Z' // newer
      })
    );
  };

  it("resolves a collision by the metadata record's clock when asked for updated_at", async () => {
    await collision();

    await moveKeyedRecord(rows, 'Old Name', 'New Name', {
      tiebreak: (r) => r.updated_at,
      rekey: plainRekey
    });

    // The MOVED record wins: its `updated_at` is the newer one.
    expect((await rows.get('new name'))?.series_title).toBe('New Name');
    expect(await rows.get('old name')).toBeUndefined();
  });

  it("resolves the SAME collision by the cache's stamp when asked for fetched_at", async () => {
    await collision();

    await moveKeyedRecord(rows, 'Old Name', 'New Name', {
      tiebreak: (r) => r.fetched_at,
      rekey: plainRekey
    });

    // The SITTING TENANT wins: its `fetched_at` is the newer one. Opposite
    // outcome, same data — only the tiebreak differed.
    expect((await rows.get('new name'))?.series_title).toBe('Sitting Tenant');
    expect(await rows.get('old name')).toBeUndefined();
  });

  it('builds the moved record through rekey, so derived fields are refreshed', async () => {
    // `series_metadata` needs this: `folded_key` is computed from the title the
    // rename just changed, and a spread would carry the stale one through.
    await rows.put(row({ series_key: 'old name', series_title: 'Old Name', derived: 'old name' }));

    await moveKeyedRecord(rows, 'Old Name', 'New Name', {
      tiebreak: (r) => r.updated_at,
      rekey: (record, series_key, series_title) => ({
        ...record,
        series_key,
        series_title,
        derived: series_title.toLowerCase()
      })
    });

    expect((await rows.get('new name'))?.derived).toBe('new name');
  });

  it('applies rekey on the same-key path too', async () => {
    await rows.put(row({ series_key: 'one piece', series_title: 'One Piece', derived: 'stale' }));

    await moveKeyedRecord(rows, 'One Piece', 'ONE PIECE', {
      tiebreak: (r) => r.updated_at,
      rekey: (record, series_key, series_title) => ({
        ...record,
        series_key,
        series_title,
        derived: series_title.toLowerCase()
      })
    });

    expect((await rows.get('one piece'))?.derived).toBe('one piece');
  });
});

/** Longer than the coalesce window, so a NON-coalesced store has every chance
 * to issue the reads this suite bounds. Under-waiting here would make the
 * bound pass for the wrong reason. */
const SETTLE_MS = KEYED_TABLE_COALESCE_MS * 3;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

describe('keyedTableMap', () => {
  it('emits the table keyed by its primary key', async () => {
    await rows.put(row({ series_key: 'one piece', series_title: 'One Piece' }));

    const store = keyedTableMap(() => rows, 'series_key');
    const seen: Map<string, Row>[] = [];
    const unsubscribe = store.subscribe((m) => seen.push(m));
    try {
      expect(seen[0]).toEqual(new Map()); // empty until the first read lands
      await settle();
      expect(seen.at(-1)?.get('one piece')?.series_title).toBe('One Piece');
    } finally {
      unsubscribe();
    }
  });

  /**
   * THE UNIT IS QUERIER EXECUTIONS AND EMISSIONS, NOT IDB ROUND TRIPS — and
   * that is not a shortcut, it is the only unit that can see this.
   *
   * Dexie 4 answers a re-running liveQuery querier out of its own in-memory
   * cache. Measured here on the naive `liveQuery(() => table.toArray())` shape:
   * a burst of 12 writes produced FIVE querier executions and five emissions
   * but ZERO `IDBObjectStore.getAll` round trips, while the coalesced shape
   * produced ONE execution, one emission and ONE round trip. So a round-trip
   * bound is not merely blind here, it is INVERTED — `getAll === 1` would
   * "pass" for the naive shape and fail for the correct one.
   *
   * The cost being bounded was never the round trip anyway: a cache-served
   * answer still hands the full row set to `set`, and every emission of these
   * two stores re-derives the catalog's placeholders, display titles and sort
   * for the whole library. Executions and emissions are that cost.
   */
  it('costs ONE table read and ONE emission for a burst of writes', async () => {
    const N = 12;
    const store = keyedTableMap(() => rows, 'series_key');
    const seen: Map<string, Row>[] = [];
    const unsubscribe = store.subscribe((m) => seen.push(m));
    const toArray = vi.spyOn(rows, 'toArray');

    try {
      // Let the initial read settle so the burst below is measured on its own.
      await settle();
      toArray.mockClear();
      const emissionsBefore = seen.length;

      for (let i = 0; i < N; i++) {
        await rows.put(row({ series_key: `s${i}`, series_title: `S${i}` }));
      }
      await settle();

      expect(toArray).toHaveBeenCalledTimes(1);
      expect(seen.length - emissionsBefore).toBe(1);
      // ANCHOR: the store delivered the burst's FINAL state. Without this, a
      // store that read once and emitted once at the very start of the burst —
      // dropping the other eleven writes — would satisfy both bounds above.
      expect(seen.at(-1)?.size).toBe(N);
    } finally {
      toArray.mockRestore();
      unsubscribe();
    }
  });

  it('never starts a read for a subscriber that leaves in the same tick', async () => {
    await rows.put(row({ series_key: 'one piece', series_title: 'One Piece' }));

    const store = keyedTableMap(() => rows, 'series_key');
    const toArray = vi.spyOn(rows, 'toArray');
    try {
      store.subscribe(() => {})();
      await settle();
      expect(toArray).not.toHaveBeenCalled();
    } finally {
      toArray.mockRestore();
    }
  });

  it('cancels a read already scheduled when the last subscriber leaves', async () => {
    // The case above proves nothing about `clearTimeout`: an immediate
    // unsubscribe tears the change signal down before it has ever fired, so no
    // timer was ever set. This one waits for the signal to land and schedule
    // the read — a fraction of the coalesce window, so the timer is PENDING and
    // not yet fired — and only then unsubscribes.
    await rows.put(row({ series_key: 'one piece', series_title: 'One Piece' }));

    const store = keyedTableMap(() => rows, 'series_key');
    const toArray = vi.spyOn(rows, 'toArray');
    try {
      const unsubscribe = store.subscribe(() => {});
      await new Promise((resolve) => setTimeout(resolve, KEYED_TABLE_COALESCE_MS / 3));
      // Vacuity guard: if the window had already elapsed, the read would be in
      // flight and this test would be measuring nothing.
      expect(toArray).not.toHaveBeenCalled();

      unsubscribe();
      await settle();
      expect(toArray).not.toHaveBeenCalled();
    } finally {
      toArray.mockRestore();
    }
  });

  it('delivers the final state when a write lands while the read is in flight', async () => {
    // The `running` guard's other half. A mutation arriving mid-read means the
    // rows about to be delivered are already stale, so the pass is marked dirty
    // and re-scheduled from the `finally`. Without that reschedule the burst's
    // last write is simply never delivered — the store settles on stale data
    // and nothing wakes it again until some unrelated write happens.
    const READ_MS = 400;
    const real = rows.toArray.bind(rows);
    // The delay comes AFTER the real read, not before it. Delaying first would
    // make the "stale" pass snapshot the table only once the late write had
    // already landed — a read that is never stale, and a fixture that never
    // reaches the guard under test.
    const toArray = vi
      .spyOn(rows, 'toArray')
      .mockImplementation(() =>
        real().then(
          (result) => new Promise<Row[]>((resolve) => setTimeout(() => resolve(result), READ_MS))
        )
      );

    const store = keyedTableMap(() => rows, 'series_key');
    const seen: Map<string, Row>[] = [];
    const unsubscribe = store.subscribe((m) => seen.push(m));
    try {
      // Past the coalesce window, well inside the slow read: the first pass is
      // running right now.
      await new Promise((resolve) => setTimeout(resolve, KEYED_TABLE_COALESCE_MS + 100));
      expect(toArray).toHaveBeenCalledTimes(1);

      await rows.put(row({ series_key: 'late', series_title: 'Late Arrival' }));
      // Its coalesce timer fires at +150 ms, still inside the 400 ms read.
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(seen.at(-1)?.get('late')?.series_title).toBe('Late Arrival');
    } finally {
      toArray.mockRestore();
      unsubscribe();
    }
  });
});
