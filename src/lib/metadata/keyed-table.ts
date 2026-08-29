import { liveQuery, type Table } from 'dexie';
import { readable, type Readable } from 'svelte/store';
import { normalizeSeriesKey } from './series-key';

/**
 * The two series-keyed caches — `series_metadata` (store.ts) and `series_index`
 * (series-index.ts) — share a primary key (`normalizeSeriesKey(series_title)`)
 * and therefore share two operations exactly: carrying a row to a new key after
 * a rename, and exposing the table as a reactive `Map`.
 *
 * Both were written out twice, byte-identical apart from the table, the record
 * type and one tiebreak field. That is not a cosmetic problem: two copies of one
 * rule drift, and a rule that drifts here is a row filed under a key nothing
 * reads. (`catalog_index` deliberately does NOT come through here — it holds a
 * single row and re-titles an ENTRY inside it, which is a different operation
 * that only looked similar.)
 */

/** What both tables guarantee: a normalized primary key and the title it came from. */
export interface SeriesKeyedRecord {
  series_key: string;
  series_title: string;
}

export interface MoveKeyedRecordOptions<T extends SeriesKeyedRecord> {
  /**
   * The field a collision is decided on — `updated_at` for the metadata record,
   * `fetched_at` for the cached index. Compared as strings, which is what ISO
   * stamps are ordered by anyway, and the ONE thing that differs between the two
   * callers.
   */
  tiebreak: (record: T) => string;
  /**
   * Build the moved record at its new key and title.
   *
   * A callback rather than a spread inside this function because a record can
   * carry DERIVED fields that a rename invalidates — `series_metadata` indexes
   * `folded_key`, which is computed from `series_title` and would otherwise be
   * carried through, leaving the row indexed under the name it no longer has.
   * The caller owns what "this record, renamed" means.
   */
  rekey: (record: T, seriesKey: string, seriesTitle: string) => T;
}

/**
 * After a series rename: carry the row keyed by `oldTitle` to `newTitle`'s key.
 *
 * Read and write share one `rw` transaction so a concurrent writer cannot slip a
 * put between them. Three cases, in the order they are checked:
 *
 * - nothing stored under the old key — nothing to move;
 * - the two titles normalize to the SAME key (a case or whitespace change): the
 *   row stays where it is and only its display title is rewritten;
 * - a row already sits at the new key: the newer of the two wins by `tiebreak`,
 *   the loser is dropped. Neither table merges here — `series_metadata` is
 *   resolved by its own record clock, and `series_index` is a disposable
 *   download cache whose loser is simply re-fetched.
 */
export async function moveKeyedRecord<T extends SeriesKeyedRecord>(
  table: Table<T>,
  oldTitle: string,
  newTitle: string,
  { tiebreak, rekey }: MoveKeyedRecordOptions<T>
): Promise<void> {
  const oldKey = normalizeSeriesKey(oldTitle);
  const newKey = normalizeSeriesKey(newTitle);

  await table.db.transaction('rw', table, async () => {
    const oldRec = await table.get(oldKey);
    if (!oldRec) return;

    if (oldKey === newKey) {
      await table.put(rekey(oldRec, oldKey, newTitle));
      return;
    }

    const newRec = await table.get(newKey);
    const winner =
      newRec && tiebreak(newRec) > tiebreak(oldRec) ? newRec : rekey(oldRec, newKey, newTitle);
    await table.put(winner);
    await table.delete(oldKey);
  });
}

/**
 * How long a burst of writes is allowed to settle before the table is read back.
 *
 * Trailing-edge: subscribers get the FINAL state of the burst. The same 150 ms
 * the catalog's own `volumes` store uses, and for the same reason — long enough
 * to absorb a batch write, short enough to be imperceptible for a library view.
 */
export const KEYED_TABLE_COALESCE_MS = 150;

/**
 * A whole keyed table as a reactive `Map`, keyed by its primary key. Empty Map
 * until the first read lands.
 *
 * COALESCED, NOT A PLAIN `liveQuery(() => table.toArray())`. Dexie re-executes a
 * liveQuery's querier on EVERY mutation to the table, so putting the expensive
 * read inside one makes a burst of writes cost a full read each — measured on
 * this branch at 145 full `volumes` scans in a 20-second window, with later
 * scans queueing behind earlier ones until one reported 16 seconds. Both tables
 * here back a liveQuery the catalog JOINS, so every emission also re-derives
 * placeholders, display titles and the library sort. So the querier is only a
 * CHANGE SIGNAL — `count()`, which Dexie re-fires on any mutation including an
 * update (a key-list query would miss those) and which costs an index count
 * rather than deserializing every row — and the read runs at most once per quiet
 * period.
 *
 * THE TABLE ARRIVES AS A THUNK, not a `Table`. These stores are module-level
 * constants in modules that plain Svelte components import, so evaluating
 * `db.<table>` to build one would touch the database at IMPORT time — where the
 * old inline `liveQuery` only touched it inside this start callback. Component
 * tests that mock `$lib/catalog/db` down to the one or two exports they actually
 * need would start failing on the import alone, which is a coupling this
 * extraction has no business introducing.
 *
 * THE THREE GUARDS, all load-bearing:
 *
 * - `running` — a mutation landing mid-read means the result about to be
 *   delivered is already stale, so it sets `dirty` and schedules another pass
 *   rather than starting a second concurrent read;
 * - `disposed` before `set` — `readable`'s start callback re-runs on every 0→1
 *   subscriber transition (the hash router swapping views does this) but never
 *   hands out a fresh `set`. Tearing a subscription down can clear a pending
 *   timer and unsubscribe the signal; it cannot abort a read already awaiting
 *   `toArray()`. Without the check, a stale read from a torn-down subscription
 *   can resolve after a fresher one has delivered current data and clobber it;
 * - `disposed` before the dirty reschedule — otherwise a disposed store
 *   resurrects itself by queueing more work.
 */
export function keyedTableMap<T extends object, K extends keyof T & string>(
  getTable: () => Table<T>,
  primaryKey: K
): Readable<Map<string, T>> {
  return readable(new Map<string, T>(), (set) => {
    const table = getTable();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let dirty = false;
    let disposed = false;

    const runQuery = async () => {
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      try {
        const rows = await table.toArray();
        if (disposed) return;
        set(new Map(rows.map((row) => [row[primaryKey] as string, row])));
      } catch (error) {
        console.error(`${table.name} liveQuery failed:`, error);
      } finally {
        running = false;
        if (dirty && !disposed) {
          dirty = false;
          schedule();
        }
      }
    };

    const schedule = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = null;
          void runQuery();
        }, KEYED_TABLE_COALESCE_MS);
    };

    const subscription = liveQuery(() => table.count()).subscribe({
      next: schedule,
      error: (error) => console.error(`${table.name} change signal failed:`, error)
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      subscription.unsubscribe();
    };
  });
}
