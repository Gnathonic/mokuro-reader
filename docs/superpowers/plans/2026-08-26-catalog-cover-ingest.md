# Catalog Cover Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make inserting one cover cost one keyed write and one card update, so cover ingest cannot freeze the catalog.

**Architecture:** Decouple cover data from catalog derivation. Covers stop travelling through `volumesWithPlaceholders`; each card resolves its own cover by key. The cover liveQuery carries keys, not blobs. Cover requests are gated to visible cards, and write batches are capped rather than grown.

**Tech Stack:** SvelteKit 5 runes, Dexie 4 / IndexedDB, Vitest + fake-indexeddb.

**Spec:** `docs/superpowers/specs/2026-08-26-catalog-cover-ingest-design.md`

## Global Constraints

- Never reference the domain "mokuro.moe" in code, comments, or commit messages.
- `account_scope` must never contain a secret or credential — it is persisted to IndexedDB.
- Stage with explicit git pathspecs only. Never `git add -A` / `git add .` — the worktree is shared.
- Do not push. Commit locally only.
- Pre-commit hook runs `prettier --check`; run `npx prettier --write` on changed files first.
- Baseline before this plan: **2454 tests passing, 0 skipped, 0 failed**; `npm run check` 0 errors. Every task must keep both green.
- Measured targets this plan exists to hit: worst long task during cold-start cover ingest **under ~150 ms** (from 1,784 ms), and blob bytes deserialized by the cover liveQuery **≈0** (from 3,886 MB).

---

### Task 1: A per-card cover resolver

**Files:**

- Create: `src/lib/catalog/cover-resolver.ts`
- Test: `src/lib/catalog/cover-resolver.test.ts`

Purely additive — nothing consumes it yet, so the tree stays green.

**Interfaces:**

- Consumes: `getCloudCover`-style keyed read over `cloud_covers` (`[account_scope+path]`), `normalizeCachePath` and `activeAccountScope` from `cloud-cache-key.ts`.
- Produces: `resolveCoverUrl(path: string): { subscribe }` or an equivalent per-path handle, plus `releaseCoverUrl(path)`. Decide the exact shape by reading how `CatalogItem.svelte` consumes covers today, and state the chosen signature in your report — Task 2 depends on it.

- [ ] **Step 1: Read the existing consumption shape first**

Read `src/lib/catalog/cloud-covers.ts`, `src/lib/catalog/cloud-covers-store.ts`, and how `CatalogItem.svelte` / `CompositeCanvas` currently obtain a cover. Do not design the interface before you know what the card actually needs (a `File`, a blob URL, or an `ImageBitmap`).

- [ ] **Step 2: Write failing tests**

Cover: a keyed read returns the cached cover for a path; a miss returns undefined without throwing; two subscribers to the same path share ONE underlying read (no duplicate IDB work); releasing the last subscriber revokes the object URL exactly once; and — the load-bearing one — resolving a cover for path P issues **no read proportional to table size** (assert with an op-counting helper that the read is keyed, not a scan).

- [ ] **Step 3: Implement**

An in-memory map from normalized path to a refcounted entry holding the blob URL and a pending promise. Revoke on last release. Never read the whole table.

- [ ] **Step 4: Full suite, then commit**

```bash
npx vitest run && npm run check
npx prettier --write src/lib/catalog/cover-resolver.ts src/lib/catalog/cover-resolver.test.ts
git add src/lib/catalog/cover-resolver.ts src/lib/catalog/cover-resolver.test.ts
git commit -m "feat(catalog): per-path cover resolver with refcounted object URLs"
```

---

### Task 2: Cards resolve their own covers

**Files:**

- Modify: `src/lib/components/CatalogItem.svelte`, and whichever component paints the cover
- Test: extend the relevant component test

- [ ] **Step 1: Switch the card to the resolver**

The card reads its cover through Task 1's resolver keyed by the volume's cloud path, instead of from the placeholder payload. Release on unmount.

- [ ] **Step 2: Keep the local-thumbnail path intact**

Installed volumes and rows with reading history carry a real `thumbnail` on the row. That path must keep working unchanged — the resolver is for cloud covers only. Verify by test, not by inspection.

- [ ] **Step 3: Full suite, then commit** (same shape as Task 1)

---

### Task 3: Cut cover data out of catalog derivation

This is the task that removes the 1,784 ms block. It is only safe after Tasks 1-2.

**Files:**

- Modify: `src/lib/catalog/cloud-covers-store.ts`, `src/lib/catalog/index.ts`, `src/lib/catalog/placeholders.ts`

- [ ] **Step 1: Make the cover liveQuery keys-only**

`cloudCoverMap` becomes a set of normalized cached paths via `primaryKeys()` (see `cachedCoverPaths` in `cloud-covers.ts` — already proven keys-only). Rename it to reflect that it carries keys.

- [ ] **Step 2: Remove cover data from placeholder generation**

`generatePlaceholders` stops receiving and applying cover blobs. Delete `cloudCoverSignature` from `index.ts` rather than optimising it — with covers gone from the payload it has nothing to guard.

- [ ] **Step 3: Remove `cloudCoverMap` from `volumesWithPlaceholders`'s inputs**

This is the decisive line. After it, a cover landing cannot reach `generatePlaceholders`, cannot mint fresh placeholder objects, and cannot re-render 1,027 components.

Handle `index.ts`'s existing branch that applies a cached cover to a metadata-only row when `!vol.thumbnail` — that data now comes from the per-card resolver, so the branch should go. Confirm no card loses its cover as a result; if the keys-only set is still needed to decide whether a card _has_ a cover worth resolving, keep the set as an input but make sure it changes identity only when the KEY set changes, never when a blob changes.

- [ ] **Step 4: Full suite, then commit**

---

### Task 4: Gate cover requests to visible cards

**Files:**

- Modify: `src/lib/components/CatalogItem.svelte`

Today every one of 1,027 cards requests covers for its top ~4 stacked volumes on mount, producing ~4,347 requests for a library where only a handful of cards are on screen.

- [ ] **Step 1: Request on approach, not on mount**

Use an `IntersectionObserver` with a `rootMargin` prefetch margin so covers arrive slightly before the card is scrolled into view. Pick the margin so scrolling at a normal speed does not show empty covers, and say what you chose and why.

- [ ] **Step 2: Do not re-request on re-entry**

`cover-service.ts` already tracks `settled` uuids. Verify a card leaving and re-entering the viewport does not re-fetch, and add a test that fails if it does.

- [ ] **Step 3: Full suite, then commit**

---

### Task 5: Bounded write batches

**Files:**

- Modify: `src/lib/catalog/cover-persist.ts`
- Test: `src/lib/catalog/cover-persist.test.ts`

Today the flush delay DOUBLES from 750 ms to 8,000 ms under sustained pressure, so batches grow (~270 / 535 / 1,070 / 2,140 covers), and each flush does a sequential `db.volumes.get()` per entry — ~2,140 serialized round-trips against a ~14-row table — before one `bulkPut` of up to ~66 MB.

- [ ] **Step 1: Replace the growing delay with a hard batch cap**

Fixed short delay, plus flush immediately when the cap is reached. Batches must get smaller under pressure, not larger. Choose the cap deliberately and justify it in your report.

- [ ] **Step 2: Replace the sequential per-entry reads with one `bulkGet`**

- [ ] **Step 3: Tests that bite**

Assert a burst of N covers produces batches no larger than the cap, and that the relationship re-check issues one bulk read rather than N. Mutation-test both.

- [ ] **Step 4: Full suite, then commit**

---

### Task 6: Byte-bounded regression contracts

**Files:**

- Modify: `src/lib/catalog/__tests__/idb-op-counter.ts`, `src/lib/catalog/__tests__/perf-contracts.test.ts`

The existing contracts bound operation COUNTS and would not have caught this defect: 23 reads is unremarkable, 437 MB per read is the bug.

- [ ] **Step 1: Teach the counter to measure bytes**

Extend `countIdbOps` to accumulate deserialized blob bytes per store (sum `value.thumbnail.size` seen through cursor/getAll results). Extend the helper self-test to prove the byte counter reports a known-nonzero baseline — a byte counter stuck at 0 would make every contract below pass vacuously, which is exactly the failure this file has already hit twice.

- [ ] **Step 2: CONTRACT — bytes per cover insert are O(1)**

Seed a cover table with N cached covers, insert ONE more, and assert the bytes deserialized by the cover subscription do not scale with N. Pre-fix this was 437 MB for one insert.

- [ ] **Step 3: CONTRACT — a cover insert regenerates no placeholders**

Assert `generatePlaceholders` is not called when only a cover lands.

- [ ] **Step 4: Mutation-test both, report verbatim failures**

If a mutation does not bite, report that plainly rather than tuning the assertion.

- [ ] **Step 5: Full suite, then commit**

---

### Task 7: Re-measure against the real library

**Files:**

- Modify: `docs/superpowers/specs/2026-08-26-catalog-cover-ingest-design.md`

Controller runs this; it needs the browser and the real WebDAV account.

- [ ] **Step 1: Cold-start measurement**

Clear `cloud_covers`, force a REAL reload (`location.reload()` — `navigate(reload:true)` to an identical hash URL does NOT reload; verify `performance.now()` shows a fresh context), arm a read-free instrument, and record: worst long task, worst frame gap, cover writes, blob bytes deserialized, and batch sizes.

- [ ] **Step 2: Compare against the spec's table and append the result**

Targets: worst long task under ~150 ms; blob bytes deserialized by the cover liveQuery ≈0; cover requests bounded by what is on screen rather than 4,347.

- [ ] **Step 3: Confirm by eye**

Scroll during ingest. Volume names, placeholders, and the title bar must stay painted. Counters passing while the UI still stutters means the plan missed something — say so rather than reporting the numbers alone.
