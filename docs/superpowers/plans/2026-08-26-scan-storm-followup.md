# Scan-Storm Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the full-table-scan storm that returns on a large library whose `series.json` sidecars have not been compiled yet.

**Architecture:** Three independent changes that compound. (1) The catalog's `volumes` liveQuery debounces the RE-QUERY instead of the emission, so a burst of writes costs one scan rather than one per write. (2) Cloud cover blobs stop landing on rows that have no relationship to the user, which is what makes a scan expensive. (3) Case-3 placeholder resolution batches its row writes instead of writing one row per resolved volume.

**Tech Stack:** SvelteKit 5 (runes), Dexie 4 / IndexedDB, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-25-cloud-metadata-cache-design.md` (this plan closes gaps found when that plan's work was measured against the full-size library).

## Measured starting point (2026-08-26, ~1,032-series library, sidecars mostly absent)

|                                                 | Value                                                 |
| ----------------------------------------------- | ----------------------------------------------------- |
| `volumes` rows                                  | 1,194 → 1,419 **and still climbing while idle**       |
| Of those: installed                             | **0** — every row is metadata-only                    |
| Rows carrying a thumbnail blob                  | **730**                                               |
| Series with rows / with a cached `series_index` | **288 / 108**                                         |
| Full scans                                      | **145 in 20 s**, queueing to **16,560 ms** worst case |
| Cumulative scan time in that window             | **257 s**                                             |
| `cloud_covers` cursor reads in the same window  | 12 (the cache side is not the problem)                |
| Main-thread long tasks                          | 0 — the IndexedDB backend is saturated, not the CPU   |

Prior isolated benchmark on this machine, which sizes fix 2: **12,000 rows without blobs = 62 ms; the same 12,000 with blobs = 433 ms.**

## Global Constraints

- **Behaviour must not change** except where a task explicitly says so. These are cost fixes.
- **A cover blob belongs on a `volumes` row only when the user has a relationship with that volume** — installed, or carrying reading history. Everything else belongs in `cloud_covers`.
- **Never reintroduce a per-write full scan.** Any new code that reads `db.volumes.toArray()` in response to a write is a defect.
- Svelte 5: `$derived` runs per component instance; no expensive work there.
- The full suite must stay green (2434 at plan time). `npx prettier --write` touched files; explicit git pathspecs only, never `git add -A` (shared worktree).

## Benchmark protocol (run after EVERY task, not just at the end)

The controller runs this against the same ~1,032-series library between tasks, so each fix's
contribution is attributed separately rather than the whole delta being credited to whichever
landed last. Identical steps every time, or the numbers are not comparable:

1. Hard-reload `http://localhost:5173/#/catalog`.
2. Immediately patch `IDBObjectStore.prototype.getAll` to count `volumes` full scans
   (`name === 'volumes' && range == null && count == null`) and record each one's duration,
   and `openCursor` to count `cloud_covers` reads.
3. Observe for a fixed **20-second** window.
4. Record, every time: scan count, the first 8 scan durations in order (a climbing series means
   queue pileup), worst duration, cumulative scan ms, `cloud_covers` cursor reads, main-thread
   long tasks, `volumes` row count at start and end of the window (it drifts as the library
   converges, so a raw scan count is uninterpretable without it), and how many rows carry a
   `thumbnail`.

Baseline to beat, taken this way before Task 1:

| Metric                      | Baseline                                                    |
| --------------------------- | ----------------------------------------------------------- |
| Full scans / 20 s           | **145**                                                     |
| Durations                   | 469 → 941 → 1489 …, worst **16,560 ms** (climbing = pileup) |
| Cumulative scan time        | **257 s** inside a 20 s window                              |
| `cloud_covers` cursor reads | 12                                                          |
| Long tasks                  | 0                                                           |
| `volumes` rows              | 1,194 → 1,419, still climbing                               |
| Rows carrying a thumbnail   | 730                                                         |

---

### Task 1: Debounce the re-query, not the emission

**Files:**

- Modify: `src/lib/catalog/index.ts` (the `volumes` readable)
- Modify: `src/lib/catalog/catalog-store.test.ts`

**Interfaces:**

- Produces: unchanged public surface — `volumes` is still `Readable<Record<string, VolumeMetadata> | undefined>`, still `undefined` until the first real read completes.

The current code calls `liveQuery(async () => db.volumes.toArray())` and debounces the subscriber. Dexie re-executes that querier on **every** mutation, so the expensive scan has already happened by the time the debounce runs — only the downstream recompute is collapsed. The fix inverts it: subscribe to a **cheap** query as a change signal, and run the expensive read once per quiet period.

`db.volumes.count()` is the signal. It touches the whole store, so Dexie re-fires it on any mutation in the table — including updates, which a key-list query would miss — and it costs an index count rather than a row deserialization.

- [x] **Step 1: Write the failing test**

```ts
// in catalog-store.test.ts — the db mock must count toArray calls
it('runs ONE toArray for a burst of writes, not one per write', async () => {
  vi.useFakeTimers();
  toArrayCalls.length = 0;
  const unsubscribe = volumes.subscribe(() => {});

  // 20 mutations inside one quiet period
  for (let i = 0; i < 20; i++) emitMutationSignal();
  await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS * 2);

  expect(toArrayCalls.length).toBe(1);
  unsubscribe();
  vi.useRealTimers();
});

it('re-reads again after a later, separate burst', async () => {
  vi.useFakeTimers();
  toArrayCalls.length = 0;
  const unsubscribe = volumes.subscribe(() => {});

  emitMutationSignal();
  await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS * 2);
  emitMutationSignal();
  await vi.advanceTimersByTimeAsync(VOLUMES_EMISSION_COALESCE_MS * 2);

  expect(toArrayCalls.length).toBe(2);
  unsubscribe();
  vi.useRealTimers();
});
```

Extend the file's existing `dexie` mock so `liveQuery` is driven by an `emitMutationSignal()` hook and `db.volumes.toArray` pushes to `toArrayCalls`.

- [x] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/catalog/catalog-store.test.ts`
Expected: FAIL — 20 `toArray` calls, not 1.

- [x] **Step 3: Implement**

```ts
export const volumes = readable<Record<string, VolumeMetadata> | undefined>(undefined, (set) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let dirty = false;

  /**
   * The expensive read, run at most once per quiet period.
   *
   * `liveQuery` re-executes its querier on EVERY mutation, so putting
   * `db.volumes.toArray()` inside one means a burst of writes costs a full
   * scan each — measured at 145 scans in 20 seconds on a large library, with
   * later scans queueing behind earlier ones until they reported 16 seconds.
   * The querier below is therefore only a CHANGE SIGNAL; this is the read.
   */
  const runQuery = async () => {
    if (running) {
      // A mutation landed while we were reading: the result we are about to
      // deliver is already stale, so schedule one more pass rather than
      // dropping it.
      dirty = true;
      return;
    }
    running = true;
    try {
      const rows = await db.volumes.toArray();
      set(
        rows.reduce(
          (acc, vol) => {
            acc[vol.volume_uuid] = vol;
            return acc;
          },
          {} as Record<string, VolumeMetadata>
        )
      );
    } catch (err) {
      console.error(err);
    } finally {
      running = false;
      if (dirty) {
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
      }, VOLUMES_EMISSION_COALESCE_MS);
  };

  /**
   * `count()` touches the whole store, so Dexie re-fires it on any mutation
   * in the table — including an update, which a key-list query would miss —
   * and it costs an index count rather than deserializing every row and its
   * thumbnail blob.
   */
  const subscription = liveQuery(() => db.volumes.count()).subscribe({
    next: schedule,
    error: (err) => console.error(err)
  });

  return () => {
    if (timer) clearTimeout(timer);
    subscription.unsubscribe();
  };
});
```

- [x] **Step 4: Run the tests — expect PASS**

Run: `npx vitest run src/lib/catalog/catalog-store.test.ts`

- [x] **Step 5: Full suite, then commit**

```bash
npx vitest run && npm run check
npx prettier --write src/lib/catalog/index.ts src/lib/catalog/catalog-store.test.ts
git add src/lib/catalog/index.ts src/lib/catalog/catalog-store.test.ts
git commit -m "perf(catalog): debounce the volumes re-query, not just its emission"
```

- [x] **Step 6: Benchmark**

Controller runs the benchmark protocol above and records the result in the ledger before Task 2
starts. This task should cut the SCAN COUNT sharply while leaving row growth untouched — if scan
count does not fall, the debounce is still on the wrong side.

---

### Task 2: Keep cloud cover blobs off relationship-less rows

**Files:**

- Modify: `src/lib/catalog/cover-persist.ts` (the row branch inside the flush transaction)
- Modify: `src/lib/catalog/cover-persist.test.ts`

**Interfaces:**

- Consumes: the reading-state store `volumes` from `$lib/settings/volume-data` (localStorage-backed; read synchronously with svelte's `get`), `isVolumeInstalled` from `$lib/catalog/volume-state`.
- Produces: unchanged public surface.

The flush currently routes a cover onto **any** existing row (`if (fresh)`). Since Task 5 of the previous plan, rows also get minted by case-3 placeholder resolution — so a browsed volume gets a row, and then its cover lands on that row instead of in `cloud_covers`. 730 rows on the measured library carry a blob this way, and blobs are ~85% of scan cost (62 ms vs 433 ms for 12,000 rows in the isolated benchmark).

The rule: a blob belongs on the row only when the user has a **relationship** with the volume — it is installed, or it carries reading history (the stats and history pages read thumbnails from rows). Otherwise the cover goes to `cloud_covers` exactly as it does for a row-less volume.

- [x] **Step 1: Write the failing test**

```ts
it('sends a browsed volume’s cover to cloud_covers even though a row exists', async () => {
  // A row minted by case-3 resolution: metadata-only, no reading history.
  await db.volumes.put(metadataOnlyRow({ volume_uuid: 'browsed-1' }) as never);
  installCover(
    { volume_uuid: 'browsed-1', cloudPath: 'Dr Stone/Volume 01.cbz' },
    {
      file: new File([new Uint8Array([1])], 'c.webp', { type: 'image/webp' }),
      width: 250,
      height: 350
    }
  );
  await flushPendingCoverPersists();

  expect((await db.volumes.get('browsed-1'))?.thumbnail).toBeUndefined();
  expect(putCloudCoversMock).toHaveBeenCalled();
});

it('still puts the cover on a row that carries reading history', async () => {
  await db.volumes.put(metadataOnlyRow({ volume_uuid: 'read-1' }) as never);
  setReadingHistory({ 'read-1': { progress: 12, completed: false } });
  installCover(
    { volume_uuid: 'read-1', cloudPath: 'Dr Stone/Volume 02.cbz' },
    {
      file: new File([new Uint8Array([2])], 'c.webp', { type: 'image/webp' }),
      width: 250,
      height: 350
    }
  );
  await flushPendingCoverPersists();

  expect((await db.volumes.get('read-1'))?.thumbnail).toBeInstanceOf(File);
});
```

Add whatever `setReadingHistory` helper the file's mocking style calls for.

- [x] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/catalog/cover-persist.test.ts`
Expected: FAIL — the browsed row received the blob.

- [x] **Step 3: Implement**

In the flush's row branch, replace the bare `if (fresh)` acceptance with a relationship test. Read the reading-state map ONCE per flush (outside the loop — it is a synchronous store read, but do not repeat it per entry):

```ts
// Which volumes the user actually has a relationship with. A cover belongs
// on the row only for those: installed volumes, and metadata-only rows kept
// for their reading history (the stats and history pages read thumbnails
// from rows). A row minted purely by browsing — case-3 placeholder
// resolution — is catalog knowledge, and its blob belongs in `cloud_covers`,
// because blobs on rows are what make a full `volumes` scan expensive.
const readingHistory = get(readingState);
```

Then inside the loop, when `fresh` exists:

```ts
const hasRelationship = isVolumeInstalled(fresh) || !!readingHistory[volumeUuid];
if (fresh && hasRelationship) {
  // ...existing row-update path, unchanged...
  continue;
}
// fall through to the cache path
```

The existing transactional re-check (`needsDownload`, `mode === 'fill'` guards) stays exactly as it is inside the relationship branch.

- [x] **Step 4: Run the tests — expect PASS**

Run: `npx vitest run src/lib/catalog/cover-persist.test.ts`

- [x] **Step 5: Full suite, then commit**

```bash
npx vitest run && npm run check
npx prettier --write src/lib/catalog/cover-persist.ts src/lib/catalog/cover-persist.test.ts
git add src/lib/catalog/cover-persist.ts src/lib/catalog/cover-persist.test.ts
git commit -m "perf(catalog): keep cloud cover blobs off relationship-less rows"
```

- [x] **Step 6: Benchmark**

Controller runs the benchmark protocol and records the result before Task 3 starts. This task
should cut per-scan DURATION (fewer blobs to deserialize) and the thumbnail-carrying row count,
while leaving scan count roughly where Task 1 left it.

---

### Task 3: Batch case-3 row writes

**Files:**

- Modify: `src/lib/catalog/materialize.ts` (batch the write; keep every guard per-row)
- Modify: `src/lib/catalog/cover-service.ts` (queue case-3 entries instead of materializing one at a time)
- Modify: `src/lib/catalog/materialize.test.ts`, `src/lib/catalog/cover-service.test.ts`

**Interfaces:**

- Produces: `materializeSeriesVolumes` keeps its signature and return type.

Two separate write amplifications:

**(a) `materialize.ts:149` writes one row at a time** — `await db.volumes.put(row)` inside the loop. Each is its own mutation. The per-row guards (uuid collision, never-touch-installed, title-already-taken) must still run per row, but the WRITES can be collected and issued as a single `bulkPut` at the end of the transaction.

**(b) `cover-service.ts:327` calls `materializeSeriesVolumes` with `entries: [entry]` — one volume per resolution.** Even with (a), that is one mutation per resolved volume, which is what produced 54 writes in 12 seconds. Case-3 resolutions must be queued and flushed together, the same way `cover-persist` already coalesces its writes.

- [x] **Step 1: Write the failing test**

```ts
// materialize.test.ts
it('writes a whole series in ONE bulk write, not one put per volume', async () => {
  const changed = await materializeSeriesVolumes({
    seriesTitle: 'Dr Stone',
    entries: [entryFor('Volume 01'), entryFor('Volume 02'), entryFor('Volume 03')],
    cloudVolumeTitles: new Set(['Volume 01', 'Volume 02', 'Volume 03'])
  });
  expect(changed).toBe(3);
  expect(putCalls).toBe(0);
  expect(bulkPutCalls).toBe(1);
});

// cover-service.test.ts
it('coalesces case-3 resolutions into one materialize write', async () => {
  materializeMock.mockClear();
  for (let i = 0; i < 5; i++) requestCover(barePlaceholder({ volume_uuid: 'bare-' + i }));
  await settleCoverService();
  expect(materializeMock.mock.calls.length).toBe(1);
  expect(materializeMock.mock.calls[0][0].entries.length).toBe(5);
});
```

- [x] **Step 2: Run them and confirm they fail**

Run: `npx vitest run src/lib/catalog/materialize.test.ts src/lib/catalog/cover-service.test.ts`
Expected: FAIL — 3 puts / 0 bulkPuts, and 5 separate materialize calls.

- [x] **Step 3: Implement (a) — batch inside materialize**

Collect the rows that pass every guard into an array, then issue one `await db.volumes.bulkPut(rows)` before the transaction closes. Keep `owners`/`titlesTaken` bookkeeping updated per row as the loop goes, since later rows' guards depend on earlier rows' decisions.

- [x] **Step 4: Implement (b) — queue case-3 resolutions**

In `cover-service.ts`, replace the immediate `materializeSeriesVolumes` call with an append to a per-series pending map plus a scheduled flush, mirroring `cover-persist.ts`'s existing queue+timer shape (reuse its constants/backoff if that reads cleanly; do not invent a second unrelated cadence). The flush issues ONE `materializeSeriesVolumes` per series with all queued entries, and one `scheduleSeriesFileWrite` carrying all of them as `cloudMeasuredVolumes` — that option already accumulates across coalesced calls by design.

Everything the current code does per resolution must still happen: the entry still reaches `cloudMeasuredVolumes`, and a failed pull is still retryable.

- [x] **Step 5: Run the tests — expect PASS**

Run: `npx vitest run src/lib/catalog/materialize.test.ts src/lib/catalog/cover-service.test.ts`

- [x] **Step 6: Full suite, then commit**

```bash
npx vitest run && npm run check
npx prettier --write src/lib/catalog/materialize.ts src/lib/catalog/cover-service.ts src/lib/catalog/materialize.test.ts src/lib/catalog/cover-service.test.ts
git add src/lib/catalog/materialize.ts src/lib/catalog/cover-service.ts src/lib/catalog/materialize.test.ts src/lib/catalog/cover-service.test.ts
git commit -m "perf(catalog): batch case-3 row writes"
```

- [x] **Step 7: Benchmark**

Controller runs the benchmark protocol and records the result. This task should cut the number of
WRITES, and therefore both scan count and row-growth rate, without changing what ends up stored.

---

### Task 4: Re-measure against the same library

**Files:**

- Modify: `docs/superpowers/specs/2026-08-25-cloud-metadata-cache-design.md` (append the follow-up numbers)

- [x] **Step 1: Reload the catalog and instrument before convergence**

Patch `IDBObjectStore.prototype.getAll` to count `volumes` full scans and record their durations, as in the measurement that produced this plan's starting numbers.

- [x] **Step 2: Measure a 20-second window**

Expected, against the starting point above: full scans well under 145, no queue pileup (durations flat rather than climbing), and `volumes` growth per unit time sharply reduced.

- [x] **Step 3: Confirm blobs left the table**

Count rows carrying `thumbnail` in `volumes`. Expected: only installed volumes and rows with reading history — not the 730 measured before.

- [x] **Step 4: Record and commit**

Append a "Follow-up measured" table to the spec with the same rows as the starting-point table so the two are directly comparable, then commit with an explicit pathspec.

---

### Task 5: Lock the wins in with operation-count regression tests

Every fix in this plan and its predecessor is an **operation-count** property: "one scan per
burst, not 145", "one bulkPut, not 137 puts", "zero row writes when merely browsing". None of
those survive a refactor unless a test asserts them, and none are visible to an ordinary
correctness test — the code returns the right answer either way, just far too slowly. The
manual browser benchmarks in this plan cannot run in CI: they need a 12,520-file WebDAV account.

So the regression net is a Vitest suite that counts IndexedDB operations against
`fake-indexeddb` and asserts bounds. This is the same technique that already caught the
Task 1 defect (`catalog-store.test.ts` proved the debounce sat on the wrong side), promoted
from an ad-hoc assertion into a named contract file.

**Files:**

- Create: `src/lib/catalog/__tests__/perf-contracts.test.ts`
- Create: `src/lib/catalog/__tests__/idb-op-counter.ts` (shared helper)

**Interfaces:**

- Consumes: `db` from `$lib/catalog/db`, `volumes`/`volumesWithPlaceholders` from
  `$lib/catalog/index`, `queueCoverPersist`/`flushCoverPersist` from
  `$lib/catalog/cover-persist`, `materializeSeriesVolumes` from `$lib/catalog/materialize`.
- Produces: `countIdbOps(fn)` → `Promise<Record<string, number>>` keyed `"<store>.<op>"`.

- [x] **Step 1: Write the op counter helper**

It patches the prototypes for the duration of one callback and restores them in a `finally`, so
a failing assertion cannot leak the patch into the next test.

```ts
// src/lib/catalog/__tests__/idb-op-counter.ts
const STORE_OPS = [
  'getAll',
  'get',
  'put',
  'add',
  'delete',
  'count',
  'openCursor',
  'getAllKeys'
] as const;
const INDEX_OPS = ['getAll', 'openCursor', 'count', 'getAllKeys'] as const;

/**
 * Counts IndexedDB operations issued while `fn` runs, keyed `"<store>.<op>"`
 * (index reads are keyed `"<store>.idx.<op>"`).
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

  try {
    await fn();
    return counts;
  } finally {
    for (const [proto, key, orig] of saved) {
      proto[key.startsWith('idx.') ? key.slice(4) : key] = orig;
    }
  }
}
```

- [x] **Step 2: Verify the helper actually counts, before trusting it**

A counter that silently counts nothing would make every contract below pass vacuously. Assert a
known-nonzero baseline first.

```ts
it('counts the operations it wraps', async () => {
  const counts = await countIdbOps(async () => {
    await db.volumes.toArray();
    await db.volumes.get('nope');
  });
  expect(counts['volumes.getAll']).toBe(1);
  expect(counts['volumes.get']).toBe(1);
});
```

Run: `npx vitest run src/lib/catalog/__tests__/perf-contracts.test.ts -t "counts the operations"`
Expected: PASS. If either count is 0 or undefined, the helper is broken — fix it before writing
any contract, because the contracts are only as trustworthy as this test.

- [x] **Step 3: Write the contracts**

Each has a comment naming the regression it guards and the measured number behind it, so a
future reader knows what the bound is protecting rather than treating it as an arbitrary
constant. Bounds are deliberately loose — they catch order-of-magnitude regressions (the real
failure mode: 1 → 145), not a fix that legitimately shifts a count by one.

```ts
// CONTRACT 1 — a burst of writes triggers ONE full scan, not one per write.
// Regression guarded: the catalog liveQuery re-ran db.volumes.toArray() on every
// mutation. Measured against a real 12,520-file library: 145 scans in a 20s window,
// individual durations queueing to 16,560ms. Task 1 of the scan-storm plan took it to 0.
it('coalesces a burst of writes into a single full scan', async () => {
  const counts = await countIdbOps(async () => {
    const stop = subscribeToVolumes();
    await settle();
    for (let i = 0; i < 20; i++) await db.volumes.put(makeRow(`v${i}`));
    await settle();
    stop();
  });
  expect(counts['volumes.getAll'] ?? 0).toBeLessThanOrEqual(3);
});

// CONTRACT 2 — cover persistence writes cached covers in bulk, not one transaction each.
// Regression guarded: 137 covers must arrive as one bulkPut (Dexie issues N underlying
// puts inside ONE transaction), never as 137 separate transactions.
it('persists a batch of covers without a per-cover full scan', async () => {
  const counts = await countIdbOps(async () => {
    for (let i = 0; i < 30; i++) queueCoverPersist(makeCover(`/s/v${i}.cbz`));
    await flushCoverPersist();
  });
  expect(counts['volumes.getAll'] ?? 0).toBe(0);
});

// CONTRACT 3 — browsing cloud-only series mints no `volumes` rows.
// Regression guarded: render-demand materialization grew the table from 434 to 11,354
// rows carrying 417MB of blobs. Cloud enrichment belongs in cloud_covers.
it('writes no volumes rows when only cloud covers are cached', async () => {
  const before = await db.volumes.count();
  for (let i = 0; i < 10; i++) queueCoverPersist(makeCover(`/cloud/v${i}.cbz`));
  await flushCoverPersist();
  expect(await db.volumes.count()).toBe(before);
  expect(await db.cloud_covers.count()).toBe(10);
});
```

Fill `subscribeToVolumes`, `settle`, `makeRow`, and `makeCover` from the existing helpers in
`src/lib/catalog/catalog-store.test.ts` rather than writing new ones — that file already solved
the liveQuery-settling problem, and duplicating it would let the two drift.

- [x] **Step 4: Prove each contract bites (mutation test)**

For EACH of the three contracts, temporarily break the code it guards and confirm the test
fails; then revert. Record in the report which mutation you used and the failure message.
A contract that still passes when its guarded code is broken is worse than no test — it is a
false assurance. Suggested mutations: (1) remove the `running`/`dirty` guard in
`src/lib/catalog/index.ts`; (2) replace `bulkPut` with a `for` loop of awaited `put`s;
(3) route a cover to the row branch unconditionally in `cover-persist.ts`.

- [x] **Step 5: Full suite, then commit**

```bash
npx vitest run && npm run check
npx prettier --write src/lib/catalog/__tests__/perf-contracts.test.ts src/lib/catalog/__tests__/idb-op-counter.ts
git add src/lib/catalog/__tests__/perf-contracts.test.ts src/lib/catalog/__tests__/idb-op-counter.ts
git commit -m "test(catalog): operation-count contracts guarding the scan-storm fixes"
```

**Note on ordering:** this task runs LAST, after Tasks 2 and 3, so the contracts encode the
final intended behaviour rather than an intermediate state.
