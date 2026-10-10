# Reading History Phase 2b — Cut-over Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Page turns stop being written to `volume-data.json`; every existing turn becomes a deterministic legacy `page` event that syncs through the history segments, and every existing stat keeps working from turns re-derived from the merged events of all devices.

**Architecture:** A legacy segment (`history/<device>/legacy.events`) carries converted turns under deterministic IDs (`device = 'legacy:' + volume`, `seq = turn time`), so every device converting the same turns produces the same events and the union deduplicates. A projection turns the merged event table back into per-volume `PageTurn[]` (native views, plus legacy turns no native view covers, minus forgotten ones); the public `volumes` store serves those, so goals, speed, time and history views keep their code. A record keeps its turns until they are safely converted, then they are stripped, so the file shrinks without a window where turns exist nowhere. Syncs batch: at most every 3 minutes while reading, plus flushes when the tab hides or the reader closes.

**Tech Stack:** SvelteKit 5, Dexie 4 (`mokuro_history`), Vitest + fake-indexeddb, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md` (Migration and compatibility; Rollout 2). Builds on plan `2026-10-04-reading-history-phase2a-segment-sync.md`.

## Global Constraints

- Legacy key: `device = 'legacy:' + volume_uuid`, `seq = turn timestamp`. Converting the same turns anywhere yields identical events.
- Coverage: a legacy turn counts only when no native `page` event of the same volume covers it (on any device). Applied when turns are projected, never when converting — conversion is deterministic and stateless.
- `archivedReads` become `restart` events (`seq = at`); they also stay in `volume-data.json` (goal counting reads them).
- `timeReadInMinutes` is NOT converted in 2b (the minute counter keeps running until phase 3 retires it). Ruling recorded in the ledger.
- A record's turns are stripped only after their events are durably in `mokuro_history`. If IndexedDB is unavailable, turns stay in the file as before.
- Old app versions are not a concern, but whatever turns they still write are converted by the next new device (the merge unions them in; conversion strips them).
- `forget` (`before`) hides that volume's events with `t < before`; `restart` changes nothing in the projection (turns never reset on restart).
- Never mention the third-party public deployment domain.

## Review Focus

1. IndexedDB unavailable (private mode): turns must stay in `volume-data.json` and stats must not go empty (Task 4 test).
2. A phase-1 device recorded native views AND turns for the same reading: projected turns count that reading once (Task 2 test).
3. A volume whose stats were forgotten, then read again: no pre-forget turns come back through legacy events from another device (Task 2 test).
4. Two devices convert the same volume's turns, one with an extra unsynced turn: both legacy sets merge to the union, no duplicates (Task 1 + Task 5 tests).
5. Sync batching: a page turn every few seconds for 10 minutes causes at most 4 progress syncs, and hiding the tab flushes a pending one immediately (Task 6 test).

---

### Task 1: Legacy segments (paths + codec)

**Files:**

- Modify: `src/lib/reading-history/paths.ts`, `paths.test.ts`
- Modify: `src/lib/reading-history/segment-codec.ts`, `segment-codec.test.ts`

**Interfaces:**

- Produces:
  - `LEGACY_FILE_NAME = 'legacy.events'`; `historyLegacyFilePath(device: string): string`
  - `HistoryPath` gains `{ device: string; kind: 'legacy' }`; `isHistoryFileName('legacy.events') === true`
  - `LEGACY_DEVICE_PREFIX = 'legacy:'`; `legacyDeviceFor(volume: string): string`
  - `encodeSegment(device, month, events, options?: { legacy?: boolean })` — legacy: header `device` = the uploader, `month = 'legacy'`, `legacy: true`; every event's device must be `legacyDeviceFor(event.volume)`; rows identical.
  - `decodeSegment` returns `header.legacy?: true` and rebuilds each event's device as `legacyDeviceFor(volume)` when set.

- [ ] **Step 1: Failing tests** — `paths.test.ts`:

```ts
it('parses a legacy segment path', () => {
  expect(parseHistoryPath(`history/${DEV}/legacy.events`)).toEqual({ device: DEV, kind: 'legacy' });
  expect(historyLegacyFilePath(DEV)).toBe(`history/${DEV}/legacy.events`);
  expect(isHistoryFileName('legacy.events')).toBe(true);
});
```

`segment-codec.test.ts`:

```ts
it('round-trips a legacy segment: per-volume legacy devices, uploader in the header', async () => {
  const legacy: ReadingEvent[] = [
    {
      device: 'legacy:vol-1',
      seq: T,
      t: T,
      kind: 'page',
      volume: 'vol-1',
      first_page: 4,
      last_page: 4,
      page_chars: [0],
      chars_before: 400,
      dwell_ms: 30000,
      layout: 'unknown',
      orientation: 'unknown',
      viewport: null
    },
    { device: 'legacy:vol-2', seq: T + 5, t: T + 5, kind: 'restart', volume: 'vol-2' }
  ];
  const bytes = await encodeSegment('dev-a', 'legacy', legacy, { legacy: true });
  const { header, events: out } = await decodeSegment(bytes);
  expect(header).toMatchObject({ device: 'dev-a', month: 'legacy', legacy: true, count: 2 });
  expect(out).toEqual(legacy);
});

it('refuses a non-legacy event in a legacy segment', async () => {
  await expect(encodeSegment('dev-a', 'legacy', events, { legacy: true })).rejects.toThrow(
    SegmentFormatError
  );
});
```

(Legacy seqs are timestamps from different volumes: rows are sorted by `(device, seq)`; `dSeq` may be negative between volumes — the decoder must accept that for legacy segments. Native segments keep strictly increasing seqs.)

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `paths.ts`: `LEGACY_FILE_NAME`, `historyLegacyFilePath`, a `legacy` branch in `parseHistoryPath`, `isHistoryFileName` accepts it, plus `LEGACY_DEVICE_PREFIX`/`legacyDeviceFor`. Codec: optional `{ legacy }`; validation per mode; header carries `legacy: true` only for legacy; decoder rebuilds devices; the seq-range check applies to native segments only. Drive and MEGA pick the file up through `isHistoryFileName`/`isHistoryFilePath` unchanged.
- [ ] **Step 4: Run** `npx vitest run src/lib/reading-history src/lib/util/sync/syncable-file.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(history): legacy segments for converted page turns`

---

### Task 2: Legacy conversion and the turn projection (pure)

**Files:**

- Create: `src/lib/reading-history/legacy.ts`, `legacy.test.ts`
- Create: `src/lib/reading-history/project-turns.ts`, `project-turns.test.ts`

**Interfaces:**

- Consumes: `PageTurn`, `ArchivedRead` (type-only, `$lib/settings/volume-data`), `legacyDeviceFor`.
- Produces:
  - `convertLegacyRecord(volume: string, record: { recentPageTurns?: number[][]; archivedReads?: { at: number }[] }): ReadingEvent[]`
  - `projectTurns(events: ReadingEvent[]): Map<string, PageTurn[]>`
  - `COVER_SLACK_MS = 2000`

Conversion rules: per volume, turns sorted by time, one per timestamp (the last wins); each turn `[t, page, cum?]` → `page` event `{ device: legacyDeviceFor(volume), seq: t, t, first_page: page, last_page: page, page_chars: [0], chars_before: cum ?? 0, dwell_ms: next ? next.t - t : null, layout: 'unknown', orientation: 'unknown', viewport: null }` (a 2-tuple has no chars: `chars_before: 0`, and it projects back as a 2-tuple — see below). Each archived read → `restart` `{ seq: at, t: at }`.

Projection rules: ignore events of a volume with `t < before` of any `forget` for it; native `page` → turn `[t, last_page, chars_before + sum(page_chars)]`; legacy `page` → dropped if any native `page` of the same volume has `n.t - COVER_SLACK_MS <= t <= n.t + (n.dwell_ms ?? 0) + COVER_SLACK_MS`, else turn `[t, last_page, chars_before]` (a legacy event converted from a 2-tuple — `chars_before === 0 && page_chars[0] === 0` — projects as `[t, page]`); sort each volume's turns by `t`.

- [ ] **Step 1: Failing tests** (`legacy.test.ts` + `project-turns.test.ts`):

```ts
// legacy.test.ts
import { describe, expect, it } from 'vitest';
import { convertLegacyRecord } from './legacy';

describe('convertLegacyRecord', () => {
  it('turns each page turn into a deterministic legacy page event with dwell to the next turn', () => {
    const out = convertLegacyRecord('vol-1', {
      recentPageTurns: [
        [2000, 5, 500],
        [1000, 4, 400]
      ]
    });
    expect(out).toEqual([
      {
        device: 'legacy:vol-1',
        seq: 1000,
        t: 1000,
        kind: 'page',
        volume: 'vol-1',
        first_page: 4,
        last_page: 4,
        page_chars: [0],
        chars_before: 400,
        dwell_ms: 1000,
        layout: 'unknown',
        orientation: 'unknown',
        viewport: null
      },
      {
        device: 'legacy:vol-1',
        seq: 2000,
        t: 2000,
        kind: 'page',
        volume: 'vol-1',
        first_page: 5,
        last_page: 5,
        page_chars: [0],
        chars_before: 500,
        dwell_ms: null,
        layout: 'unknown',
        orientation: 'unknown',
        viewport: null
      }
    ]);
  });

  it('is identical on every device for the same turns, and keeps one event per timestamp', () => {
    const a = convertLegacyRecord('v', {
      recentPageTurns: [
        [1, 1, 10],
        [1, 2, 20]
      ]
    });
    expect(a).toHaveLength(1);
    expect(
      convertLegacyRecord('v', {
        recentPageTurns: [
          [1, 1, 10],
          [1, 2, 20]
        ]
      })
    ).toEqual(a);
  });

  it('converts archived reads to restart events', () => {
    expect(convertLegacyRecord('v', { archivedReads: [{ at: 77 }] })).toEqual([
      { device: 'legacy:v', seq: 77, t: 77, kind: 'restart', volume: 'v' }
    ]);
  });
});
```

```ts
// project-turns.test.ts
import { describe, expect, it } from 'vitest';
import { convertLegacyRecord } from './legacy';
import { projectTurns } from './project-turns';
import type { ReadingEvent } from './types';

const native = (
  t: number,
  page: number,
  dwell: number,
  device = 'dev-a',
  seq = t
): ReadingEvent => ({
  device,
  seq,
  t,
  kind: 'page',
  volume: 'v',
  first_page: page,
  last_page: page + 1,
  page_chars: [10, 20],
  chars_before: page * 100,
  dwell_ms: dwell,
  layout: 'double',
  orientation: 'landscape',
  viewport: { w: 1, h: 1 }
});

describe('projectTurns', () => {
  it('a native view becomes a turn at its start, with chars through its last page', () => {
    expect(projectTurns([native(1000, 3, 5000)]).get('v')).toEqual([[1000, 4, 330]]);
  });

  it('a phase-1 reading recorded both ways counts once: covered legacy turns are dropped', () => {
    const legacy = convertLegacyRecord('v', {
      recentPageTurns: [
        [1500, 3, 300],
        [9000, 9, 900]
      ]
    });
    const turns = projectTurns([native(1000, 3, 5000), ...legacy]).get('v');
    expect(turns).toEqual([
      [1000, 4, 330],
      [9000, 9, 900]
    ]);
  });

  it('merges devices and legacy in time order', () => {
    const turns = projectTurns([
      native(5000, 1, 100, 'dev-b', 1),
      native(1000, 7, 100, 'dev-a', 1),
      ...convertLegacyRecord('v', { recentPageTurns: [[3000, 2, 200]] })
    ]).get('v')!;
    expect(turns.map((t) => t[0])).toEqual([1000, 3000, 5000]);
  });

  it('a forget hides everything recorded before it, on every device, legacy included', () => {
    const forget: ReadingEvent = {
      device: 'dev-a',
      seq: 99,
      t: 4000,
      kind: 'forget',
      volume: 'v',
      before: 4000
    };
    const turns = projectTurns([
      ...convertLegacyRecord('v', { recentPageTurns: [[1000, 1, 10]] }),
      native(2000, 2, 100, 'dev-b', 7),
      forget,
      native(6000, 1, 100, 'dev-a', 100)
    ]).get('v');
    expect(turns).toEqual([[6000, 2, 130]]);
  });

  it('a 2-tuple legacy turn projects back as a 2-tuple', () => {
    const legacy = convertLegacyRecord('v', { recentPageTurns: [[1000, 4]] });
    expect(projectTurns(legacy).get('v')).toEqual([[1000, 4]]);
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** both modules per the rules (`projectTurns` groups by volume once: forget horizon per volume = max `before`; native intervals per volume sorted by `t` for the coverage check). **Step 4: Run** → PASS. **Step 5: Commit** — `feat(history): convert legacy turns; project events back to page turns`

---

### Task 3: The projected-turns store

**Files:**

- Create: `src/lib/reading-history/turns-store.ts`, `turns-store.test.ts`
- Modify: `src/lib/reading-history/record.ts` (notify listeners after a successful append)
- Modify: `src/lib/reading-history/history-sync.ts` (signal after an import that added events)

**Interfaces:**

- Produces:
  - `historyTurns: Readable<Map<string, PageTurn[]>>` — empty map until loaded
  - `loadHistoryTurns(db?: HistoryDexie): Promise<void>` — full reload from `reading_events`
  - `getHistoryTurns(volume: string): PageTurn[] | undefined` — `undefined` until loaded (callers fall back to the record's own turns)
  - `historyTurnsLoaded(): boolean`
  - `onEventsRecorded(listener: (events: ReadingEvent[]) => void): () => void` in `record.ts`; `appendEvent`/`recordEvent` call listeners with the stored event after the transaction commits; `history-sync` and legacy conversion call `notifyEventsRecorded(events)` after their transactions.
- The store recomputes only the affected volumes on an append (re-project that volume's events from an in-memory per-volume event list), and fully on `loadHistoryTurns`.

- [ ] **Step 1: Failing tests** (`fake-indexeddb/auto`): (a) before load `getHistoryTurns('v')` is `undefined`; (b) after `appendEvent` of two native views + `loadHistoryTurns`, `get(historyTurns).get('v')` has 2 turns; (c) a further `recordEvent` with the same db updates the store without a reload (subscribe and await the emission); (d) a failing `appendEvent` (db closed) notifies nothing.
- [ ] **Step 2–4:** run → FAIL; implement; run → PASS.
- [ ] **Step 5: Commit** — `feat(history): projected page turns store`

---

### Task 4: Serve projected turns; stop writing turns

**Files:**

- Modify: `src/lib/settings/volume-data.ts` — `volumes` derived store; `updateProgress` stops appending; `startedFreshPassSince` reads projected turns; `_volumesInternal.subscribe` wraps the localStorage write in try/catch
- Modify: `src/lib/goals/completed-at-backfill.ts` — scans projected turns
- Modify: `src/lib/settings/reading-speed.ts` — drop the 2-tuple `migratePageTurnData` write-back (2-tuples now come from legacy conversion and stay 2-tuples)
- Tests: `src/lib/settings/volume-data.test.ts`, `src/lib/goals/__tests__/completed-at-backfill.test.ts`

**Interfaces:**

- Consumes: `historyTurns`, `getHistoryTurns`, `historyTurnsLoaded` (Task 3).
- Behaviour: `volumes` = derived([`_volumesInternal`, `historyTurns`]): for each live record, `recentPageTurns` = projected turns when the store is loaded AND the volume has any, else the record's own (unconverted) turns — so nothing goes empty before conversion or when IndexedDB is unavailable. Records in `_volumesInternal` are never given projected turns (they must not be written back to the file).
- Ordering note: the projection lags the current view by one (a view's event is written when it ends). Every consumer already tolerates that (they read arrival times of past views).

- [ ] **Step 1: Failing tests**:
  - `updateProgress` no longer grows `recentPageTurns` (a record that had 2 turns still has 2 after a turn).
  - with `historyTurns` mocked to `Map([['v', [[1,1,10],[2,2,20]]]])` and loaded, `get(volumes).v.recentPageTurns` equals that, and `get(volumesWithTrash).v.recentPageTurns` is the record's own.
  - not loaded → `get(volumes).v.recentPageTurns` is the record's own turns.
  - `startedFreshPassSince` sees projected turns (re-dating a genuine re-read still works with turns only in history).
  - completed-at backfill finds the completing turn in projected turns.
  - a localStorage `setItem` that throws (quota) does not throw out of a store update.
- [ ] **Step 2–4:** run → FAIL; implement; run the full suite → PASS (goal, speed, tracker and history-row suites must stay green — they read `volumes`).
- [ ] **Step 5: Commit** — `feat(history): stats read page turns projected from history; stop writing turns`

---

### Task 5: Convert, strip and upload legacy turns

**Files:**

- Create: `src/lib/reading-history/cut-over.ts`, `cut-over.test.ts`
- Modify: `src/lib/settings/volume-data.ts` (`stripConvertedTurns(volume, convertedTurns)` — removes exactly those turns, only from a record whose turns are still a superset)
- Modify: `src/lib/util/sync/unified-sync-service.ts` (run the cut-over after the volume merge, before the history pass)
- Modify: `src/routes/+layout.svelte` (run it once on start, then `loadHistoryTurns()`)
- Modify: `src/lib/reading-history/history-sync.ts` (export/import the legacy segment: mark `uploaded:<provider>:legacy` = `{ count }`; uploads every `legacy:` event this device holds)

**Interfaces:**

- Produces: `cutOverLegacyTurns(db?: HistoryDexie): Promise<{ volumes: number; events: number }>` — for each live record with turns or unconverted archived reads: `convertLegacyRecord`, `bulkPut` (by key; identical content), `notifyEventsRecorded`, then `stripConvertedTurns`. A DB failure → nothing stripped, warn once.

- [ ] **Step 1: Failing tests** (`cut-over.test.ts`, fake-indexeddb, real `volume-data` store):
  - a record with 3 turns → 3 legacy events in the DB, record has no turns, `volumes` still shows 3 turns (projected) after `loadHistoryTurns`.
  - a turn appended to the record between conversion and strip (simulate by updating the store inside a mocked `bulkPut`) is NOT stripped.
  - DB write failure → turns stay.
  - run twice → still 3 events, no change.
  - `history-sync`: device A converts + uploads `legacy.events`; device B imports it; a volume converted on both with one extra turn on B → union, no duplicates.
- [ ] **Step 2–4:** run → FAIL; implement; run → PASS.
- [ ] **Step 5: Commit** — `feat(history): cut over — convert, strip and sync legacy page turns`

---

### Task 6: Batch progress syncs

**Files:**

- Modify: `src/lib/util/activity-tracker.ts` (debounce stays 5 s; a sync starts at most every `SYNC_MIN_INTERVAL_MS = 3 min`; `flush()` syncs a pending change now)
- Modify: `src/lib/views/ReaderView.svelte` (flush on unmount), `src/lib/util/sync/foreground-sync.ts` or `+layout.svelte` (flush on `visibilitychange` → hidden and `pagehide`)
- Test: `src/lib/util/activity-tracker.test.ts` (create or extend)

- [ ] **Step 1: Failing tests** (fake timers, `unifiedCloudManager` mocked): a `recordActivity()` every 4 s for 10 min → `syncProgress` called ≤ 4 times; `flush()` with pending progress → sync now, and not again until new activity; `flush()` with nothing pending → no sync.
- [ ] **Step 2–4:** run → FAIL; implement; run → PASS.
- [ ] **Step 5: Commit** — `perf(sync): batch progress syncs while reading; flush on hide and close`

---

### Task 7: End to end

**Files:**

- Create: `e2e/history-cut-over.spec.ts` (same WebDAV stub as `history-sync.spec.ts`)
- Modify: `CLAUDE.md` (Reading history section: cut-over, projection, legacy segments, batching)

- [ ] Device A starts with a seeded `volumes` localStorage entry holding 5 turns + 1 archived read for one volume (an old client's data), connects, syncs. Assert: the uploaded `volume-data.json` record has no `recentPageTurns`; `history/<A>/legacy.events` exists; `volumes` store shows the 5 turns. Device B (fresh) syncs: its `volumes` store shows the same 5 turns for that volume (from A's legacy segment), and its `volume-data.json` view has none. An old-client write (put turns back into the cloud file by hand, the stub) → A's next sync converts and strips them again.
- [ ] Run with `E2E_PORT`/`E2E_CHROMIUM`; run the earlier history + diverged specs too; full unit suite; `npm run check`; update CLAUDE.md; commit — `test(history): legacy turns cut over across two devices`.
