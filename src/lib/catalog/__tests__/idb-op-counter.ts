const STORE_OPS = [
  'getAll',
  'get',
  'put',
  'add',
  'delete',
  'count',
  'openCursor',
  // The KEYS-ONLY cursor, counted alongside `openCursor` so the two can be
  // told apart. A query that reads keys never deserializes a row, so on a
  // blob-carrying store (`cloud_covers`) the difference between these two ops
  // is the difference between ~0 and hundreds of megabytes — see
  // `cloud-covers-store.test.ts`, which asserts the value-reading ops are zero
  // and anchors on this one being non-zero.
  'openKeyCursor',
  'getAllKeys'
] as const;
const INDEX_OPS = ['getAll', 'openCursor', 'openKeyCursor', 'count', 'getAllKeys'] as const;

/**
 * The counter the permanent `IDBDatabase.transaction` wrapper below reports
 * into, or `null` when no `countIdbOps` call is in flight.
 */
let activeCounts: Record<string, number> | null = null;

/**
 * Transactions cannot be counted the way store and index operations are.
 *
 * Dexie captures `idbdb.transaction.bind(idbdb)` ONCE, when it opens the
 * database, and every later transaction goes through that bound reference —
 * so a prototype patch installed after the database is open is never reached
 * (measured: the counted block sees zero transactions), and a per-call patch
 * installed before it would leave Dexie bound to the FIRST call's counter
 * forever, silently attributing later work to a stale object. Store and index
 * methods have no such problem: Dexie re-derives `trans.objectStore(name)` per
 * query, so those go through the prototype every time.
 *
 * So this wrapper is installed once, permanently, at module load — which means
 * this module must be imported before the database under test is opened, which
 * a test file gets for free (a Dexie instance opens lazily, on its first
 * operation, inside a test body). It stays cheap when idle: with no counter
 * active it is one null check.
 */
function installTransactionCounter(): void {
  const dbProto = IDBDatabase.prototype as unknown as Record<string, unknown>;
  const orig = dbProto.transaction as ((...a: unknown[]) => unknown) | undefined;
  if (!orig) return;
  dbProto.transaction = function (this: IDBDatabase, ...a: unknown[]) {
    if (activeCounts) {
      const names = a[0];
      // The spec allows a single store name, an array, or a DOMStringList.
      const stores = typeof names === 'string' ? [names] : Array.from(names as ArrayLike<string>);
      // Mode is part of the key because only a READWRITE commit broadcasts
      // `storagemutated`: reads are what a catalog does constantly and cheaply,
      // writes are what make it re-derive. A bound that could not tell them
      // apart would be dominated by reads and could never see a write storm.
      const mode = typeof a[1] === 'string' ? (a[1] as string) : 'readonly';
      activeCounts['transactions'] = (activeCounts['transactions'] ?? 0) + 1;
      const key = `tx.${[...stores].sort().join('+')}.${mode}`;
      activeCounts[key] = (activeCounts[key] ?? 0) + 1;
    }
    return orig.apply(this, a);
  };
}

if (typeof IDBDatabase !== 'undefined') installTransactionCounter();

/**
 * Counts IndexedDB operations issued while `fn` runs, keyed `"<store>.<op>"`
 * (index reads are keyed `"<store>.idx.<op>"`).
 *
 * TRANSACTIONS are counted too: `"transactions"` is the grand total, and
 * `"tx.<stores>.<mode>"` counts the ones opened over a particular store set
 * (sorted and `+`-joined) in a particular mode — e.g. `"tx.volumes.readwrite"`.
 * That last one is the most load-bearing number in this suite: Dexie
 * broadcasts `storagemutated` once per readwrite COMMIT, so for the catalog,
 * write-transaction count is change-signal count is full-re-derive count.
 * Round-trip counts cannot see it — N writes batched into one transaction and
 * N writes in N transactions issue exactly the same N `put`s.
 *
 * These counts are the assertion surface for our performance contracts: the
 * behaviours this suite guards are all "how many times", never "what result",
 * so an ordinary correctness test cannot see a regression in them.
 */
export async function countIdbOps(fn: () => Promise<void>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const bump = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  const storeProto = IDBObjectStore.prototype as unknown as Record<string, unknown>;
  const indexProto = IDBIndex.prototype as unknown as Record<string, unknown>;
  const saved: Array<[Record<string, unknown>, string, unknown]> = [];

  for (const op of STORE_OPS) {
    const orig = storeProto[op] as ((...a: unknown[]) => unknown) | undefined;
    if (!orig) continue;
    saved.push([storeProto, op, orig]);
    storeProto[op] = function (this: IDBObjectStore, ...a: unknown[]) {
      bump(`${this.name}.${op}`);
      return orig.apply(this, a);
    };
  }
  for (const op of INDEX_OPS) {
    const orig = indexProto[op] as ((...a: unknown[]) => unknown) | undefined;
    if (!orig) continue;
    saved.push([indexProto, `idx.${op}`, orig]);
    indexProto[op] = function (this: IDBIndex, ...a: unknown[]) {
      bump(`${this.objectStore.name}.idx.${op}`);
      return orig.apply(this, a);
    };
  }

  // Point the permanent transaction wrapper at this call's counter. Saved and
  // restored rather than simply nulled, so a nested `countIdbOps` hands the
  // outer one its counter back instead of switching counting off entirely.
  const previousCounts = activeCounts;
  activeCounts = counts;

  try {
    await fn();
    return counts;
  } finally {
    activeCounts = previousCounts;
    for (const [proto, key, orig] of saved) {
      proto[key.startsWith('idx.') ? key.slice(4) : key] = orig;
    }
  }
}
