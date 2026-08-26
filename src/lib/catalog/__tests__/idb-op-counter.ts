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
  // and anchors on this one being non-zero. Keeping BOTH cursor ops here is
  // what lets `"<store>.bytes"` below be checked against the op that produced
  // it: a keys-only read must show a cursor op AND zero bytes.
  'openKeyCursor',
  'getAllKeys'
] as const;
const INDEX_OPS = ['getAll', 'get', 'openCursor', 'openKeyCursor', 'count', 'getAllKeys'] as const;

/**
 * The ops whose RESULT is a deserialized row, and which are therefore metered
 * in BYTES as well as counted.
 *
 * WHY BYTES AT ALL. Counts are blind to the defect this suite now guards: the
 * measured cover-ingest regression was 23 `cloud_covers` reads in 59 s — an
 * utterly unremarkable COUNT — that between them deserialized 3,886 MB of
 * blobs (~437 MB per read) and produced main-thread long tasks up to 1,784 ms.
 * The unit that separates the healthy shape from the pathological one is bytes
 * per operation, so it is measured directly rather than inferred from which op
 * was used.
 *
 * `get` IS METERED, deliberately, even though the defect arrived through a
 * cursor: Dexie's `bulkGet` lowers to `getMany`, which issues one
 * `IDBObjectStore.get` PER KEY, so a regression that re-reads a whole table as
 * a keyed batch is a `get` storm and would be invisible to a counter that only
 * metered `getAll`/`openCursor`. `IDBIndex.get` is metered for the same
 * reason: Dexie 4 does not lower any query to it today (index reads lower to
 * a cursor or `getAll`), so it is a latent path rather than a live one — but a
 * value-reading op left out of `VALUE_OPS` reports 0 bytes no matter what it
 * deserializes, and a byte meter with a latent hole in it is exactly how a
 * future whole-table read through an index would go unmeasured.
 *
 * `openKeyCursor` and `getAllKeys` are deliberately absent: they cannot
 * deserialize a value, which is the entire reason the production code uses
 * them.
 */
const VALUE_OPS: ReadonlySet<string> = new Set(['get', 'getAll', 'openCursor']);

/**
 * Blob bytes carried by one deserialized row.
 *
 * SHALLOW, and own enumerable properties only: the rows this suite measures
 * carry their payload in a single top-level `File` field (`thumbnail` on both
 * `volumes` and `cloud_covers`), and a deep walk would cost more than the
 * queries being measured. `instanceof Blob` rather than a `thumbnail` name
 * check so a row that grows a second blob field is measured rather than
 * silently under-reported.
 */
function blobBytes(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  let total = 0;
  for (const field of Object.values(value as Record<string, unknown>)) {
    if (field instanceof Blob) total += field.size;
  }
  return total;
}

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
 * BYTES are measured too: `"<store>.bytes"` is the total blob payload
 * DESERIALIZED out of that store while `fn` ran, summed over every value-
 * reading op ({@link VALUE_OPS}) and over every row a cursor walked. This is
 * the unit that separates 23 cheap reads from 23 reads costing 437 MB each,
 * which no count can express — see {@link VALUE_OPS}. Writes are not metered:
 * a `put` serializes, it does not deserialize, and the cost this suite bounds
 * is the read side. A store that deserialized nothing has NO `"<store>.bytes"`
 * key rather than a zero one, so read it as `counts['x.bytes'] ?? 0`.
 *
 * Byte attribution happens when a request SUCCEEDS, not when it is issued, so
 * a read started inside `fn` whose result lands just after `fn` resolves is
 * still counted — on purpose. Under-counting is the dangerous direction here
 * (it would make a byte bound pass vacuously); over-counting can only fail a
 * contract, never hide one. To make that guarantee true rather than aspirational,
 * `fn` resolving is NOT the end of the counted window: every request a
 * metered op issued is tracked, and `countIdbOps` drains all of them —
 * including any a straggler success event enqueues while draining — before it
 * returns `counts`. Without this, an un-awaited request from THIS call could
 * fire its `success` event after `counts` had already been handed to the
 * caller, mutating an object the caller believes is final; worse, in a suite
 * that runs several `countIdbOps` blocks back to back (as CONTRACT 8a does),
 * that late mutation lands on whichever object reference is still in scope
 * when the event fires — silently inflating an EARLIER measurement instead of
 * this one. Nothing outside `fn` can attribute at all once draining finishes:
 * the prototypes are restored on the way out, so no later request is ever
 * metered.
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
  const addBytes = (store: string, bytes: number) => {
    if (bytes <= 0) return;
    counts[`${store}.bytes`] = (counts[`${store}.bytes`] ?? 0) + bytes;
  };

  // Every value-reading request `meter` attaches a listener to gets a
  // promise here, pushed SYNCHRONOUSLY when the wrapped store/index method is
  // called — before `fn` can `await` anything — so by the time `fn()`
  // resolves, `pending` already holds an entry for every such request `fn`
  // issued, awaited or not. Draining this (below) before returning `counts`
  // is what closes the straggler window described above.
  const pending: Promise<void>[] = [];

  /**
   * Meter a value-reading request's result. A cursor request fires `success`
   * once per row it walks (each `continue()` re-uses the same request), so one
   * listener accumulates the whole traversal; `getAll` fires once with an
   * array; `get` fires once with a single row.
   *
   * THE TRANSACTION IS THE BACKSTOP, and it is not optional. A cursor's
   * `success` listener resolves on the NULL cursor that ends a full traversal
   * — but a query that stops early never gets one: Dexie lowers `limit`,
   * `until` and `first` over a filtered collection to a cursor it simply stops
   * calling `continue()` on, so the last `success` it fires carries a live
   * cursor and nothing further arrives. Without this backstop that promise
   * stays pending forever and the drain below never returns, so a future
   * contract written over a limited cursor would TIME OUT (measured: 5,000 ms,
   * "Test timed out") instead of failing with its own assertion message.
   * `complete`/`abort` fire strictly after every `success` the transaction will
   * ever deliver, so resolving here can never truncate byte attribution.
   */
  const meter = (request: unknown, store: string, isCursor: boolean): unknown => {
    const req = request as IDBRequest | null;
    if (!req || typeof req.addEventListener !== 'function') return request;
    pending.push(
      new Promise<void>((resolve) => {
        const tx = req.transaction;
        if (tx && typeof tx.addEventListener === 'function') {
          tx.addEventListener('complete', () => resolve(), { once: true });
          tx.addEventListener('abort', () => resolve(), { once: true });
        }
        req.addEventListener('error', () => resolve(), { once: true });
        req.addEventListener('success', () => {
          const result = req.result as unknown;
          if (isCursor) {
            const cursor = result as IDBCursorWithValue | null;
            if (!cursor) {
              // Traversal exhausted — no further `continue()` will come.
              resolve();
              return;
            }
            addBytes(store, blobBytes(cursor.value));
            // NOT resolved yet: a cursor's request is reused by `continue()`,
            // so this same `success` listener fires again for the next row.
            return;
          }
          if (Array.isArray(result)) {
            let total = 0;
            for (const row of result) total += blobBytes(row);
            addBytes(store, total);
          } else {
            addBytes(store, blobBytes(result));
          }
          resolve();
        });
      })
    );
    return request;
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
      const request = orig.apply(this, a);
      return VALUE_OPS.has(op) ? meter(request, this.name, op === 'openCursor') : request;
    };
  }
  for (const op of INDEX_OPS) {
    const orig = indexProto[op] as ((...a: unknown[]) => unknown) | undefined;
    if (!orig) continue;
    saved.push([indexProto, `idx.${op}`, orig]);
    indexProto[op] = function (this: IDBIndex, ...a: unknown[]) {
      const store = this.objectStore.name;
      bump(`${store}.idx.${op}`);
      const request = orig.apply(this, a);
      return VALUE_OPS.has(op) ? meter(request, store, op === 'openCursor') : request;
    };
  }

  // Point the permanent transaction wrapper at this call's counter. Saved and
  // restored rather than simply nulled, so a nested `countIdbOps` hands the
  // outer one its counter back instead of switching counting off entirely.
  const previousCounts = activeCounts;
  activeCounts = counts;

  try {
    await fn();
    // Drain every outstanding request `fn` issued before handing `counts`
    // back. `pending` can grow WHILE this drains — a cursor's `success`
    // firing again via `continue()`, or another request the previous batch's
    // resolution happened to trigger — so this re-snapshots and re-awaits
    // until nothing new shows up, rather than a single `Promise.all` that
    // could miss a straggler of its own.
    while (pending.length) {
      const batch = pending.splice(0, pending.length);
      await Promise.all(batch);
    }
    return counts;
  } finally {
    activeCounts = previousCounts;
    for (const [proto, key, orig] of saved) {
      proto[key.startsWith('idx.') ? key.slice(4) : key] = orig;
    }
  }
}
