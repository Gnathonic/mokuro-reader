import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

/**
 * THE COUNTER'S OWN DRAIN.
 *
 * `countIdbOps` does not hand back its counts until every request it metered
 * has settled — that drain is what keeps a straggler `success` from mutating a
 * counts object the caller already believes is final (see the module's own doc
 * comment). Which makes the drain a place a contract suite can HANG rather
 * than fail: a per-request promise that never resolves is not a wrong number,
 * it is no number at all, reported as a bare vitest timeout with nothing in it
 * about IndexedDB.
 *
 * The shape that used to do it: a cursor query that stops early. A metered
 * cursor resolves on the NULL cursor that ends a full traversal, and a query
 * built with `limit`/`until`/`first` over a filtered collection never produces
 * one — Dexie simply stops calling `continue()`, so the last `success` carries
 * a live cursor and no further event ever arrives.
 *
 * This file exists because the counter is test infrastructure that several
 * performance contracts are written on top of: a hole here does not fail those
 * contracts, it makes them unwritable.
 */

vi.mock('$lib/catalog/db', async () => {
  const { CatalogDexieV3 } =
    await vi.importActual<typeof import('$lib/catalog/db-v3')>('$lib/catalog/db-v3');
  return { db: new CatalogDexieV3('mokuro_v3_op_counter_test') };
});

import { db } from '$lib/catalog/db';
import { countIdbOps } from './idb-op-counter';

const SCOPE = 'webdav:op-counter';
const ROW_BYTES = 10;

function cover(n: number) {
  return {
    account_scope: SCOPE,
    path: `One Piece/Volume ${n}.cbz`,
    thumbnail: new File([new Uint8Array(ROW_BYTES)], `v${n}.webp`, { type: 'image/webp' }),
    width: 250,
    height: 350,
    cached_at: 1000 + n
  };
}

async function seed(count: number): Promise<void> {
  await db.cloud_covers.bulkPut(Array.from({ length: count }, (_, i) => cover(i)));
}

/**
 * Run `fn` against a deadline, so a drain that can never finish fails with a
 * sentence about the drain instead of vitest's generic "Test timed out in
 * 5000ms" — which is the whole complaint this file is about.
 */
async function within<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `countIdbOps did not return within ${ms}ms: a request it metered is still ` +
                  'pending, so its drain can never finish. A cursor that stops early ' +
                  '(limit/until/first) never delivers the null cursor the meter resolves on — ' +
                  "the transaction's complete/abort is the backstop that has to resolve it."
              )
            ),
          ms
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  await db.cloud_covers.clear();
});

describe('countIdbOps drains every request it meters', () => {
  it('returns for a cursor that stops before the end of the table', async () => {
    await seed(5);

    // `filter` forces the cursor lowering (a bare `limit` on a table lowers to
    // `getAll`, which cannot exhibit this at all), and `limit(2)` is what stops
    // the traversal three rows short of the null cursor.
    const counts = await within(1000, () =>
      countIdbOps(async () => {
        const rows = await db.cloud_covers
          .filter(() => true)
          .limit(2)
          .toArray();
        expect(rows).toHaveLength(2);
      })
    );

    // Positive proof it really was the cursor path, and that the early
    // resolution did not truncate byte attribution: exactly the two rows the
    // cursor walked were deserialized, not the whole table.
    expect(counts['cloud_covers.openCursor'] ?? 0).toBe(1);
    expect(counts['cloud_covers.bytes'] ?? 0).toBe(2 * ROW_BYTES);
  });

  it('returns for `first()`, which stops after one row', async () => {
    await seed(5);

    const counts = await within(1000, () =>
      countIdbOps(async () => {
        const row = await db.cloud_covers.filter(() => true).first();
        expect(row).toBeDefined();
      })
    );

    expect(counts['cloud_covers.openCursor'] ?? 0).toBe(1);
    expect(counts['cloud_covers.bytes'] ?? 0).toBe(ROW_BYTES);
  });

  it('still counts a full traversal, and every row of it', async () => {
    await seed(4);

    const counts = await within(1000, () =>
      countIdbOps(async () => {
        const rows = await db.cloud_covers.filter(() => true).toArray();
        expect(rows).toHaveLength(4);
      })
    );

    expect(counts['cloud_covers.openCursor'] ?? 0).toBe(1);
    expect(counts['cloud_covers.bytes'] ?? 0).toBe(4 * ROW_BYTES);
  });
});
