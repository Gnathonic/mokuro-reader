# Look-up Visits and Last Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visit that comes back to the page it started on, having read almost nothing, claims nothing:
no newer position, no catalog re-order, no completion, no characters read. And "last read" stops being
the merge key.

**Architecture:** One pure rule (`reading-history/visits.ts`) draws visits from history events and rates
them. History-side consumers (offers, stats, last read) apply it to every device's events alike. A live
module (`positions/visit.ts`) applies the same rule to this device's open visit and restores the record
when it comes home, escape-aware: a stamp that already left the device is beaten by 1 ms. The catalog's
smart sort and the progress tracker read last-read times from history, with `lastProgressUpdate` only as
the fallback.

**Tech Stack:** SvelteKit 5 / TypeScript, Svelte stores, Vitest (jsdom), Playwright with
`e2e/helpers/webdav-stub.ts`.

**Spec:** `docs/superpowers/specs/2026-10-16-sync-tiers-design.md`, sections "Look-up visits claim
nothing" and "Last read is not the merge key". Built on the position-file plan
(`docs/superpowers/plans/2026-10-16-position-file.md`, done, branch tip 75c0f7ae).

## Global Constraints

- `VISIT_GAP_MS = 10 * 60_000`; `LOOKUP_MAX_READ_PAGES = 2`; `READ_DWELL_MS = 3000`; skip test is the
  stats engine's `SKIP_CPM` (1500 chars/min).
- A visit: one device's native page views of one volume in time order, split where
  `next.t - (prev.t + (prev.dwell_ms ?? 0)) > VISIT_GAP_MS`. Legacy (converted) events are never in a
  visit.
- A look-up: ≥ 2 views; the last view's page range overlaps the first view's; at most 2 distinct pages
  outside the first view's range were read (a view read its pages when `dwell_ms ≥ 3000` and it is not
  a skip).
- "Same view": page ranges `[first_page, last_page]` overlap (spreads included).
- Restore only while the record's current stamp is one this visit set, and never a `deletedOn` record.
- Restore stamp: the snapshot's own stamp when nothing of the visit was uploaded; else
  `newestUploaded + 1` (ms).
- Completion notices for the open volume wait until the visit ends (reader closed, next volume, tab
  hidden) and fire only if the record is still `completed` then; at most one notice per completion.
- Look-up views outside the home view: time counts, characters do not, no speed sample (treated as
  skips). Home views unchanged.
- Last read = newest view end (`t + dwell_ms`) over legacy views and native views outside look-up
  visits, after the `forget` horizon; `0` when the volume has page events but none count; no events →
  `Date.parse(lastProgressUpdate)`.
- No change to any wire format (events, `volume-data.json`, `positions.json`). e2e with `E2E_PORT=<free port>`, zero failures beyond the two
  `line-grid.spec.ts` tests that fail on develop. Commit trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No pushes.

## Review Focus

1. A real read that ends back home (p.1→200, then the cover) stays reading: completed, characters
   counted, series moved. → Task 1 and Task 4 tests.
2. Another device's position landing mid-visit (volume-data merge, adoption) is never undone by the
   return. → Task 4 test.
3. A visit whose turn already went up (push or idle sync) restores with a stamp just above that upload,
   not the old one, so the visited page does not stick in the cloud. → Task 4 test.
4. A reload mid-visit (snapshot lost) changes nothing: no restore, no throw, ordinary claims. → Task 4 test.
5. Finishing on the last page and leaving gives exactly one completion notice, also when the tab was
   hidden on that page first and then closed. → Task 3 test.

---

### Task 1: The visit rule

**Files:**

- Create: `src/lib/reading-history/visits.ts`
- Test: `src/lib/reading-history/visits.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export const VISIT_GAP_MS = 10 * 60_000;
  export const LOOKUP_MAX_READ_PAGES = 2;
  export const READ_DWELL_MS = 3000;
  export type ViewLike = Pick<
    PagePayload,
    'first_page' | 'last_page' | 'page_chars' | 'dwell_ms'
  > & { t: number };
  export function eventKey(e: { device: string; seq: number }): string; // `${device}\u0000${seq}`
  export function sameView(
    a: Pick<ViewLike, 'first_page' | 'last_page'>,
    b: Pick<ViewLike, 'first_page' | 'last_page'>
  ): boolean;
  export function readsPages(v: ViewLike): boolean; // dwell ≥ READ_DWELL_MS and not a skip
  export function isLookupVisit(visit: ViewLike[]): boolean;
  export function splitVisits(events: ReadingEvent[]): PageEvent[][]; // native page views only
  export interface LookupVerdict {
    lookup: Set<string>;
    outsideHome: Set<string>;
  } // eventKeys
  export function lookupVisits(events: ReadingEvent[]): LookupVerdict;
  ```
- `SKIP_CPM` comes from `stats-engine.ts` (import it; do not copy the value).

- [ ] **Step 1: Write the failing tests** (`view(first, last, dwell, chars, t)` builds a `ViewLike`)

```ts
it('open p.40, two quick peeks, back to p.40 → look-up', () =>
  expect(
    isLookupVisit([
      v(40, 40, 5000, 300, 0),
      v(41, 41, 800, 300, 6000),
      v(42, 42, 900, 300, 7000),
      v(40, 40, 0, 300, 8000)
    ])
  ).toBe(true));
it('a single view is never a look-up', () =>
  expect(isLookupVisit([v(40, 40, 60000, 300, 0)])).toBe(false));
it('ending elsewhere is not a look-up', () =>
  expect(isLookupVisit([v(40, 40, 5000, 300, 0), v(41, 41, 900, 300, 6000)])).toBe(false));
it('two pages read outside home still a look-up; three are reading', () => {
  const read = (p: number, t: number) => v(p, p, 20_000, 300, t); // 900 cpm: reading pace
  expect(
    isLookupVisit([v(40, 40, 5000, 300, 0), read(41, 1e4), read(42, 4e4), v(40, 40, 0, 300, 7e4)])
  ).toBe(true);
  expect(
    isLookupVisit([
      v(40, 40, 5000, 300, 0),
      read(41, 1e4),
      read(42, 4e4),
      read(43, 7e4),
      v(40, 40, 0, 300, 1e5)
    ])
  ).toBe(false);
});
it('a whole read then back to the cover is reading', () => {
  const visit = [
    v(1, 1, 5000, 0, 0),
    ...Array.from({ length: 199 }, (_, i) => v(i + 2, i + 2, 20_000, 300, (i + 1) * 21_000)),
    v(1, 1, 0, 0, 5e6)
  ];
  expect(isLookupVisit(visit)).toBe(false);
});
it('spreads: [40,41] then [41,42] is the same view', () =>
  expect(sameView({ first_page: 40, last_page: 41 }, { first_page: 41, last_page: 42 })).toBe(
    true
  ));
it('a picture page (0 chars) is read by dwell alone', () => {
  expect(readsPages(v(41, 41, 5000, 0, 0))).toBe(true);
  expect(readsPages(v(41, 41, 2000, 0, 0))).toBe(false);
});
it('splitVisits: an 11-minute gap starts a new visit; devices never share one; legacy is left out', () => {});
it('lookupVisits: keys every view of a look-up, and outsideHome only the away views', () => {});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/reading-history/visits.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** per Interfaces. `isLookupVisit` counts distinct pages (from `first_page..last_page`)
      of reading views that do not overlap the first view.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(history): draw visits and tell look-ups from reading`

### Task 2: History consumers — offers, stats, last read

**Files:**

- Modify: `src/lib/reading-history/position-offer.ts:64` (`planPosition`: `views` without `lookup` keys)
- Modify: `src/lib/reading-history/stats-engine.ts:198-216` (`prepareVolume`: `skip ||= outsideHome.has(key)`)
- Create: `src/lib/reading-history/last-read.ts`
- Modify: `src/lib/components/Catalog.svelte:229-242` (smart sort through `seriesLastRead`)
- Modify: `src/lib/views/progress-tracker-helpers.ts:237-275` (`createEntriesWithSortData` takes the
  times; field `lastProgressUpdate` → `lastReadAt`, sorts at :64 and :101 follow), `ProgressTrackerView.svelte`
- Modify: `src/lib/util/reading-speed-history.ts:104` (`completedAt ?? lastProgressUpdate`)
- Test: `position-offer.test.ts`, `stats-engine.test.ts`, `last-read.test.ts`, `progress-tracker-helpers.test.ts`

**Interfaces:**

- Consumes: Task 1 `lookupVisits`, `eventKey`.
- Produces (`last-read.ts`):

  ```ts
  /** null = no page events; 0 = events, none count. */
  export function lastReadFromEvents(events: ReadingEvent[]): number | null;
  /** Volumes with page events → last read; rebuilt per changed volume on `onHistoryChanged`. */
  export const lastReadTimes: Readable<ReadonlyMap<string, number>>;
  export function lastReadTime(
    volume: string,
    record: { lastProgressUpdate?: string } | undefined,
    times: ReadonlyMap<string, number>
  ): number;
  /** Smart sort's recency: newest lastReadTime over the series' volumes with progress > 1 (as today). */
  export function seriesLastRead(
    volumeIds: string[],
    records: Record<string, { progress?: number; lastProgressUpdate?: string }>,
    times: ReadonlyMap<string, number>
  ): number;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// position-offer.test.ts
it('a look-up on the newest device makes no offer elsewhere', () => {
  // phone read 58..60 at T; laptop (newest) views 40, 41 (800 ms), 40 → planPosition on the phone: {} (no offer of p.40)
});
// stats-engine.test.ts
it('look-up away views count time but no characters', () => {
  // visit 40 (5 s), 41 (20 s, reading pace), 40 → countVolume: time includes 20 s; page 41 not read; no speed sample from it
});
// last-read.test.ts
it('a look-up never moves last read; reading does', () => {});
it('legacy views count; no events → null; only look-ups → 0', () => {});
it('lastReadTime falls back to lastProgressUpdate only without events', () => {});
it('seriesLastRead ignores volumes at progress ≤ 1, as smart sort did', () => {});
it('a re-asserted lastProgressUpdate does not move seriesLastRead when events exist', () => {});
// progress-tracker-helpers.test.ts: entries sort by lastReadAt from the times map
```

- [ ] **Step 2: Run** `npx vitest run src/lib/reading-history src/lib/views` — Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.** Compute `lookupVisits` once per call on the post-`forget` events.
      `lastReadTimes` is a `readable` whose start subscribes to `onHistoryChanged` and rebuilds only the
      announced volumes (`'all'` → every `historyVolumes()`). Catalog reads `$lastReadTimes` once into the
      sort snapshot beside `$volumes`; never call `lastReadFromEvents` inside the comparator.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(history): look-ups make no offer, read nothing, and last read leaves the merge key`

### Task 3: Completion notices wait for the visit's end

**Files:**

- Modify: `src/lib/settings/volume-data.ts` (`updateProgress` :751; new exports)
- Test: `src/lib/settings/volume-data.test.ts`

**Interfaces:**

- Produces:

  ```ts
  /** While `hold(volume)` is true, a completion is kept instead of announced. */
  export function registerCompletionHold(hold: (volume: string) => boolean): () => void;
  /** Announce a kept completion if the record is still completed; forget it either way. */
  export function releaseHeldCompletion(volume: string): void;
  /** Put a position back with the given stamp; notifies position listeners only when `announce`. */
  export function restoreVolumePosition(
    volume: string,
    snapshot: { progress: number; chars: number; completed: boolean; completedAt?: string },
    stamp: number,
    options: { announce: boolean }
  ): boolean; // false for a missing or deletedOn record
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it('a held completion is announced once at release, if still completed', () => {});
it('a held completion whose flag fell before release is never announced', () => {});
it('releasing twice announces once (hidden, then closed)', () => {});
it('restoreVolumePosition puts values and stamp back; announce controls the position notice; deletedOn → false', () => {});
it('no hold registered → completion announced at once, as today', () => {});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/settings/volume-data.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces; `restoreVolumePosition` sets `lastProgressUpdate = new Date(stamp).toISOString()` (0 → the epoch, "never").
- [ ] **Step 4: Run** `npx vitest run src/lib/settings` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(progress): completion waits for the visit to end; positions can be put back`

### Task 4: The live visit — restore on coming home

**Files:**

- Create: `src/lib/positions/escapes.ts`, `src/lib/positions/visit.ts`
- Modify: `src/lib/positions/positions-sync.ts` (after upload: `noteUploaded` per own entry; on adopting
  the open volume: `rehomeVisit`)
- Modify: `src/lib/util/sync/unified-sync-service.ts:791` (after `uploadVolumeDataFile`: `noteUploaded` for each volume)
- Modify: `src/lib/views/ReaderView.svelte` (after `positionsChecked`: `startVisit`; cleanup: `endVisit`)
- Modify: `src/routes/+layout.svelte` (positions init block: `getOrCreateDeviceId(historyDb()).then(initVisitTracking)`)
- Modify: `CLAUDE.md` (one paragraph under the `positions.json` paragraph: look-ups and last read)
- Test: `src/lib/positions/visit.test.ts`, `src/lib/positions/escapes.test.ts`

**Interfaces:**

- Consumes: Task 1 (`isLookupVisit`, `sameView`, `VISIT_GAP_MS`), Task 3, `getVolumeEvents` /
  `onHistoryChanged` (`turns-store.ts`), `registerPositionListener`, `volumesWithTrash`.
- Produces:
  ```ts
  // escapes.ts — no imports
  export function watchEscapes(volume: string): void;
  export function unwatchEscapes(volume: string): void;
  export function noteUploaded(volume: string, t: number): void; // keeps the max, only while watched
  export function newestUploaded(volume: string): number; // 0 = none
  // visit.ts
  export function initVisitTracking(device: string): () => void; // position listener, onHistoryChanged, completion hold, hidden → release
  export function startVisit(volume: string, now?: number): void; // continues the last visit of this volume when its own last view ended ≤ VISIT_GAP_MS ago
  export function rehomeVisit(volume: string): void; // re-snapshot while the visit has no own turn
  export function endVisit(volume: string): void; // releaseHeldCompletion + unwatch
  export function _resetVisitsForTests(): void;
  ```
- Check on every own position notice and every history change of the open volume: record stamp is one
  this visit set; `record.progress` (0 → 1) inside the home view (the visit's first own page event, else
  the snapshot page); `isLookupVisit(own visit events + the current view as dwell 0)` → restore with the
  Global Constraints stamp rule, `announce` when that stamp is not the snapshot's. A re-entrancy guard
  stops the restore's own notice from re-checking.

- [ ] **Step 1: Write the failing tests** (`visit.test.ts`, real `volume-data`, history events fed through
      the turns-store test hooks)

```ts
it('two quick peeks and back: the record gets its pre-visit stamp back, nothing to push', () => {});
it('an unread volume peeked at and left on p.1 stays unread (progress 0, epoch stamp)', () => {});
it('a peek whose stamp was uploaded restores with newestUploaded + 1', () => {});
it('another device's position landing mid-visit is never undone', () => {});
it('three pages read, then back home: no restore (reading)', () => {});
it('a lost snapshot (reload) restores nothing and throws nothing', () => {});
it('peek at the last page of an unread volume and back: not completed, no completion notice at endVisit', () => {});
it('finish on the last page, hide the tab, then close: one completion notice', () => {});
it('a late adoption before any turn re-homes the visit', () => {});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/positions` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test && npm run check` — Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** — `feat(positions): a look-up visit gives its position back`

### Task 5: End to end

**Files:**

- Create: `e2e/lookup-visit.spec.ts` (reuse `position-file.spec.ts`'s device/install/sync pattern)

- [ ] **Step 1: Write the spec**

```ts
test('a look-up writes no position and keeps the stamp', async ({ browser }) => {
  // A at p.40, pushed and synced. Open; ArrowLeft, ArrowLeft quickly; ArrowRight, ArrowRight back to 40;
  // wait 4 s → no new PUT of positions.json; record lastProgressUpdate equals the pre-open one.
});
test('a look-up whose peek went up ends with the file at the home page', async ({ browser }) => {
  // as above, but 4 s on p.41 (the push goes out with p.41), then back → the file ends at p.40 with t > the p.41 push.
});
test('reading then coming home is reading', async ({ browser }) => {
  // ArrowLeft ×3 with 4 s each (reading pace on 0-char pages), back to 40 → the record keeps its fresh stamp.
});
```

- [ ] **Step 2: Run** `E2E_PORT=5197 npx playwright test e2e/lookup-visit.spec.ts e2e/position-file.spec.ts` — Expected: PASS.
- [ ] **Step 3: Run** `E2E_PORT=5197 npm run test:e2e` — Expected: no failures other than `line-grid.spec.ts:658` and `:926`.
- [ ] **Step 4: Commit** — `test(e2e): a look-up visit claims nothing`
