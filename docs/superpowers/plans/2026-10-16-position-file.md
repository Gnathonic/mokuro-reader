# Position File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A device that has just been picked up opens a book where the user actually stopped, because a
small `positions.json` at a fixed path is checked before the reader chooses its page, and opening a page
never stamps it as the newest position.

**Architecture:** A pure codec/merge module for `positions.json`, a pure reconcile step that decides what
to adopt, defer and upload, and a thin IO layer that reads every listed copy through the provider cache
and writes with `unifiedCloudManager.blindUploadFile`. It runs in three places: inside every full sync,
as a debounced push after page turns, and as a check on reader open (≤ 1000 ms) that gates the first
render. bunko gets the file only when its identity endpoint says it maps it per user.

**Tech Stack:** SvelteKit 5 / TypeScript, Svelte stores, Vitest (jsdom), Playwright with
`e2e/helpers/webdav-stub.ts`; bunko side in Rust (`crates/bunko-dav`, `crates/bunko-server`).

**Spec:** `docs/superpowers/specs/2026-10-16-sync-tiers-design.md` — sections "The position file",
"The device swap", "Where history does not sync", and the `positions.json` line under "mokuro-bunko
changes". Background: "Position across devices" in
`docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md`.

## Global Constraints

- File: `positions.json` at the mokuro folder root, beside `volume-data.json`.
- Wire format: `{ "version": 1, "positions": { "<volume_uuid>": [<t epoch ms>, <page>, <chars>, "<device>"] } }`.
- Window: 30 days (`30 * 86_400_000` ms). Older entries leave the file on every write.
- Merge: per volume, newest `t` wins. Tie: the lexicographically greater `device` wins (deterministic).
- Reader-open wait: at most 1000 ms, then open on the local page.
- Toast copy: `Continued from <device label>, p.<N>`; unnamed device: `Continued from another device, p.<N>`.
- A cloud stamp more than `FUTURE_TOLERANCE_MS` (`src/lib/metadata/sanitize.ts`) ahead of `now` is bogus:
  the entry is dropped on parse and never wins.
- Writes go through `unifiedCloudManager.blindUploadFile` (it qualifies: renders nothing, self-healing,
  loses nothing — the events and `volume-data.json` still carry every position).
- Positions are never fatal: a failure is logged and the surrounding sync continues (same rule as
  `syncReadingHistory`).
- On a `serverCompilesMetadata` provider (bunko), neither read nor write `positions.json` unless the
  identity endpoint lists it in `per_user_files`: before that, the path is a SHARED library file.
- Do not change the `historySync` gate in this plan.
- Out of scope (later rollout steps of the spec): the segment push on page turns, the bunko-before-history
  turns-convert-at-next-start fix, conditional GETs (`downloadIfChanged`), the persisted listing cache.
- Work in `<worktrees>/feat/sync-tiers`. e2e with `E2E_PORT=<free port>`;
  zero failures expected.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No pushes.

## Review Focus

1. A remote entry for a volume deleted here (`deletedOn`) or forgotten after it (`forgotAt` ≥ `t`) must
   never be adopted: no resurrected progress. → Task 5 test.
2. A fast-clock device's entry (`t` beyond tolerance) must not pin every device to its page forever. →
   Task 1 test.
3. A reset on another device (page 0) must not be "adopted" as a jump to page 0, but must still beat that
   device's older entry in the file. → Tasks 1 and 5 tests.
4. A page turn that happens while a push is uploading must not be dropped from the next push. → Task 3 test.
5. bunko without the per-user mapping: zero GETs and zero PUTs of `positions.json` (the path is somebody
   else's file there). → Task 6 test.

---

### Task 1: `positions.json` codec, merge and prune

**Files:**

- Create: `src/lib/positions/positions-file.ts`
- Test: `src/lib/positions/positions-file.test.ts`
- Modify: `src/lib/util/sync/syncable-file.ts:29-34` (add `POSITIONS_FILE_NAME` to `ROOT_CONFIG_FILENAMES`)
- Test: `src/lib/util/sync/syncable-file.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export const POSITIONS_FILE_NAME = 'positions.json';
  export const POSITION_WINDOW_MS = 30 * 86_400_000;
  export interface PositionEntry {
    t: number;
    page: number;
    chars: number;
    device: string;
  }
  export type PositionsMap = Record<string, PositionEntry>;
  export interface PositionsFile {
    version: 1;
    positions: Record<string, [number, number, number, string]>;
  }
  export function parsePositionsFile(raw: unknown, now: number): PositionsMap;
  export function mergePositions(a: PositionsMap, b: PositionsMap): PositionsMap;
  export function prunePositions(map: PositionsMap, now: number): PositionsMap;
  export function composePositionsFile(map: PositionsMap): PositionsFile; // keys sorted
  export function positionsContent(raw: unknown): string; // canonical string of the RAW `positions` object, '' when absent/unparseable
  ```

- [ ] **Step 1: Write the failing tests** (`positions-file.test.ts`)

```ts
const now = Date.parse('2026-10-16T12:00:00Z');
const ok = [now - 1000, 120, 12000, 'dev-a'];

it('parses well-formed entries', () => {
  expect(parsePositionsFile({ version: 1, positions: { v1: ok } }, now)).toEqual({
    v1: { t: now - 1000, page: 120, chars: 12000, device: 'dev-a' }
  });
});
it('drops malformed entries and tolerates junk files', () => {
  expect(
    parsePositionsFile({ version: 1, positions: { a: [1, 'x', 0, 'd'], b: [1, 2], c: ok } }, now)
  ).toEqual({
    c: expect.any(Object)
  });
  expect(parsePositionsFile('not json', now)).toEqual({});
  expect(parsePositionsFile({ version: 2, positions: { c: ok } }, now)).toEqual({});
});
it('drops an entry stamped beyond FUTURE_TOLERANCE_MS', () => {
  const bogus = [now + FUTURE_TOLERANCE_MS + 1, 5, 50, 'fast'];
  expect(parsePositionsFile({ version: 1, positions: { v: bogus } }, now)).toEqual({});
});
it('newest t wins per volume; a tie goes to the greater device id', () => {
  const a = { v: { t: 10, page: 1, chars: 0, device: 'a' } };
  const b = { v: { t: 20, page: 9, chars: 0, device: 'b' } };
  expect(mergePositions(a, b).v.page).toBe(9);
  expect(mergePositions(b, a).v.page).toBe(9);
  const tie = { v: { t: 20, page: 3, chars: 0, device: 'c' } };
  expect(mergePositions(b, tie).v.device).toBe('c');
  expect(mergePositions(tie, b).v.device).toBe('c');
});
it('a page-0 reset entry is kept and beats an older entry', () => {
  const read = { v: { t: 10, page: 120, chars: 1, device: 'a' } };
  const reset = { v: { t: 20, page: 0, chars: 0, device: 'a' } };
  expect(mergePositions(read, reset).v.page).toBe(0);
});
it('prunes entries older than 30 days', () => {
  const map = {
    old: { t: now - POSITION_WINDOW_MS - 1, page: 1, chars: 0, device: 'a' },
    fresh: { t: now - POSITION_WINDOW_MS + 1, page: 1, chars: 0, device: 'a' }
  };
  expect(Object.keys(prunePositions(map, now))).toEqual(['fresh']);
});
it('compose → parse is an identity, keys sorted', () => {
  const map = {
    b: { t: 2, page: 2, chars: 2, device: 'x' },
    a: { t: 1, page: 1, chars: 1, device: 'x' }
  };
  const file = composePositionsFile(map);
  expect(Object.keys(file.positions)).toEqual(['a', 'b']);
  expect(parsePositionsFile(JSON.parse(JSON.stringify(file)), 3)).toEqual(map);
});
```

In `syncable-file.test.ts`: `expect(isSyncableFile('positions.json')).toBe(true)` and
`expect(isBestEffortMetadataPath('positions.json')).toBe(false)`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/positions/positions-file.test.ts src/lib/util/sync/syncable-file.test.ts`
Expected: FAIL — module `./positions-file` not found; `isSyncableFile('positions.json')` false.

- [ ] **Step 3: Implement** `positions-file.ts` with the Interfaces above. An entry is well-formed when
      `t`, `page`, `chars` are finite non-negative integers and `device` a non-empty string. Add
      `POSITIONS_FILE_NAME` to `ROOT_CONFIG_FILENAMES` with a one-line comment (fast position index, the user's
      own state like `goals.json`, so not best-effort).

- [ ] **Step 4: Run to verify they pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/positions/positions-file.ts src/lib/positions/positions-file.test.ts src/lib/util/sync/syncable-file.ts src/lib/util/sync/syncable-file.test.ts
git commit -m "feat(positions): positions.json codec, merge and 30-day window"
```

### Task 2: Opening never claims the position; adopting keeps the remote stamp

**Files:**

- Modify: `src/lib/settings/volume-data.ts` (`updateProgress` :701, `jumpToPosition` :788,
  `applyMissedRestart` :822, `markVolumeAsUnread` :873, `archiveAndResetVolumes` :896; new exports)
- Test: `src/lib/settings/volume-data.test.ts` (create if absent; follow the existing tests' store reset)

**Interfaces:**

- Produces:
  ```ts
  export function registerPositionListener(fn: (volume: string) => void): () => void;
  /** Take another device's position with ITS stamp. False (no change) unless strictly newer than local. */
  export function adoptPosition(
    volume: string,
    page: number,
    chars: number,
    completed: boolean | undefined,
    setAt: number
  ): boolean;
  ```
- Listener fires when the position actually changed: `updateProgress` (only when not a no-op),
  `jumpToPosition`, `applyMissedRestart`, `markVolumeAsUnread`, `archiveAndResetVolumes` (once per volume).
  `adoptPosition` never fires it (not this device's news).

- [ ] **Step 1: Write the failing tests**

```ts
it('re-reporting the current page changes nothing and stamps nothing', () => {
  updateProgress('v', 40, 4000, false);
  const before = get(volumesWithTrash).v.lastProgressUpdate;
  vi.advanceTimersByTime(60_000);
  updateProgress('v', 40, 4000, false);
  expect(get(volumesWithTrash).v.lastProgressUpdate).toBe(before);
});
it('a real page turn stamps and notifies', () => {
  const seen: string[] = [];
  registerPositionListener((v) => seen.push(v));
  updateProgress('v', 41, 4100, false);
  expect(seen).toEqual(['v']);
});
it('adoptPosition takes the remote stamp, only when newer', () => {
  updateProgress('v', 40, 4000, false); // local stamp = now
  const local = Date.parse(get(volumesWithTrash).v.lastProgressUpdate!);
  expect(adoptPosition('v', 120, 12000, false, local - 1)).toBe(false);
  expect(adoptPosition('v', 120, 12000, false, local + 1)).toBe(true);
  expect(get(volumesWithTrash).v).toMatchObject({
    progress: 120,
    chars: 12000,
    lastProgressUpdate: new Date(local + 1).toISOString()
  });
});
it('adoptPosition does not notify', () => {
  /* listener registered → adopt → seen stays [] */
});
it('adoptPosition completed: undefined keeps the flag; true dates completedAt at setAt when absent', () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/settings/volume-data.test.ts`
Expected: FAIL — `registerPositionListener`/`adoptPosition` not exported; the same-page test sees a new stamp.

- [ ] **Step 3: Implement.** In `updateProgress`, return `prev` unchanged when `progress`,
      `chars ?? current.chars` and `completed` all equal the current record's (no metadata enrichment
      skipped by this: the enrichment branch still runs). Listener registry mirrors
      `registerCompletionListener` (:657); notify after the store update. `adoptPosition` sets `progress`,
      `chars`, `lastProgressUpdate = new Date(setAt).toISOString()`, `completed` (when defined) and
      `completedAt ??= setAt` when it becomes true; it refuses a record with `deletedOn`.

- [ ] **Step 4: Run** `npx vitest run src/lib/settings` — Expected: PASS (whole folder, to catch the
      callers' tests).

- [ ] **Step 5: Commit** — `feat(progress): opening a page claims no position; adopt keeps the remote stamp`

### Task 3: This device's changed positions

**Files:**

- Create: `src/lib/positions/positions-local.ts`
- Test: `src/lib/positions/positions-local.test.ts`

**Interfaces:**

- Consumes: `registerPositionListener`, `volumesWithTrash` (Task 2); `PositionsMap` (Task 1).
- Produces:
  ```ts
  export function initPositionTracking(): () => void; // registers the listener
  export function changedVolumes(): string[];
  /** Entries for the changed volumes, from local records, under `device`. */
  export function ownChangedEntries(device: string): PositionsMap;
  /** Clear only volumes whose record stamp still equals `built[volume].t`. */
  export function clearChanged(built: PositionsMap): void;
  ```
- Persisted under localStorage key `positions:changed` (array of uuids), every access in try/catch;
  works in memory when storage throws.

- [ ] **Step 1: Write the failing tests**

```ts
it('a page turn marks the volume; its entry carries the record stamp and this device', () => {
  initPositionTracking();
  updateProgress('v', 41, 4100, false);
  const e = ownChangedEntries('me').v;
  expect(e).toEqual({
    t: Date.parse(get(volumesWithTrash).v.lastProgressUpdate!),
    page: 41,
    chars: 4100,
    device: 'me'
  });
});
it('a turn during an upload survives clearChanged', () => {
  initPositionTracking();
  updateProgress('v', 41, 4100, false);
  const built = ownChangedEntries('me');
  vi.advanceTimersByTime(1000);
  updateProgress('v', 42, 4200, false); // lands mid-upload
  clearChanged(built);
  expect(changedVolumes()).toEqual(['v']);
});
it('survives a reload via localStorage, and works when storage throws', () => {});
it('a deleted record yields no entry', () => {});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/positions/positions-local.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** per Interfaces. A record with no `lastProgressUpdate` yields no entry.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(positions): track this device's changed positions`

### Task 4: Capability — who may read and write `positions.json`

**Files:**

- Modify: `src/lib/util/sync/providers/webdav/identity.ts` (parse `per_user_files`)
- Modify: `src/lib/util/sync/provider-interface.ts:120-135` (add `positionsSync?` beside `historySync?`)
- Modify: `src/lib/util/sync/providers/webdav/webdav-provider.ts:600-620` (`getStatus`), :715-760 (store it)
- Create: `src/lib/positions/positions-capability.ts`
- Test: `src/lib/util/sync/providers/webdav/identity.test.ts`, `src/lib/positions/positions-capability.test.ts`

**Interfaces:**

- Produces:
  - `IdentityResult` `authenticated` and `anonymous` variants gain `perUserFiles?: string[]` from the body's
    `per_user_files` (array of strings; anything else → absent).
  - `ProviderStatus.positionsSync?: boolean` — doc: "Can this server keep `positions.json` per user?
    false = no (bunko not listing it in `per_user_files`): neither read nor write it. Absent = plain storage."
  - WebDAV `getStatus()`: `positionsSync: this._serverCompilesMetadata ? (this._perUserFiles?.includes('positions.json') ?? false) : undefined`.
  - `export function positionsReadAllowed(status: ProviderStatus): boolean` → `status.positionsSync ?? !status.serverCompilesMetadata`.
  - `export function positionsWriteAllowed(status: ProviderStatus): boolean` → read allowed and `!status.isReadOnly`.

- [ ] **Step 1: Write the failing tests**

```ts
// identity.test.ts — an authenticated body with per_user_files: ['volume-data.json','positions.json']
//   → result.perUserFiles equals that array; per_user_files: 'x' → perUserFiles undefined.
// positions-capability.test.ts
expect(positionsReadAllowed({ ...base })).toBe(true); // plain storage
expect(positionsReadAllowed({ ...base, serverCompilesMetadata: true })).toBe(false); // old bunko
expect(positionsReadAllowed({ ...base, serverCompilesMetadata: true, positionsSync: true })).toBe(
  true
);
expect(positionsWriteAllowed({ ...base, isReadOnly: true })).toBe(false);
```

- [ ] **Step 2: Run** `npx vitest run src/lib/util/sync/providers/webdav/identity.test.ts src/lib/positions/positions-capability.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces; reset `_perUserFiles` wherever `_serverVersion` is reset (:779, :887).
- [ ] **Step 4: Run** the same command plus `npx vitest run src/lib/util/sync/providers/webdav` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(sync): bunko says whether it keeps positions.json per user`

### Task 5: Reconcile — what to adopt, defer and upload

**Files:**

- Create: `src/lib/positions/positions-reconcile.ts`
- Test: `src/lib/positions/positions-reconcile.test.ts`

**Interfaces:**

- Consumes: Task 1 types and functions.
- Produces:
  ```ts
  export interface LocalPosition {
    stamp: number /* ms; 0 = never */;
    deleted: boolean;
    forgotAt: number /* ms; 0 = none */;
  }
  export interface ReconcileInput {
    cloud: PositionsMap; // parsed, merged across every readable copy
    cloudContent: string; // positionsContent() of the surviving raw copy ('' = no file)
    local: (volume: string) => LocalPosition | undefined;
    own: PositionsMap; // ownChangedEntries(ownDevice)
    ownDevice: string;
    open: { volume: string; openedAt: number } | null;
    now: number;
  }
  export interface ReconcileResult {
    adopt: Array<{ volume: string; entry: PositionEntry; toast: boolean }>;
    deferred: string[]; // newer elsewhere, but the open reader has turned a page
    next: PositionsMap; // prunePositions(mergePositions(cloud, own), now)
    upload: boolean; // see the upload rule below
  }
  export function reconcilePositions(input: ReconcileInput): ReconcileResult;
  ```
- Adopt rule for each `cloud` entry: `page ≥ 1`, `device !== ownDevice`, `t > local.stamp`, not
  `local.deleted`, `t > local.forgotAt` (missing local = stamp 0, not deleted, no forget). If the volume is
  `open.volume`: adopt with `toast: true` when `local.stamp < open.openedAt`, else put it in `deferred`
  (the phase 2c offer takes over). Otherwise adopt with `toast: false`.
- Upload rule: `upload = positionsContent(composePositionsFile(next)) !== cloudContent`, except that an
  empty `next` with no cloud file (`cloudContent === ''`) never uploads — no file until there is a position.

- [ ] **Step 1: Write the failing tests**

```ts
it('adopts a newer remote position for a closed volume', () => {}); // adopt[0].toast false
it('never adopts its own device, an older entry, or a page-0 reset', () => {});
it('never resurrects a deleted volume or reading before a forget', () => {
  // local: { stamp: 5, deleted: true, forgotAt: 0 }  → no adopt
  // local: { stamp: 0, deleted: false, forgotAt: 50 }, entry t 40 → no adopt; t 60 → adopt
});
it('open volume, no page turned since opening: adopt with a toast', () => {
  // local.stamp 100 (old turn), open.openedAt 500, entry.t 300 → adopt toast true
});
it('open volume, a page turned after opening: deferred, not adopted', () => {
  // local.stamp 600 ≥ openedAt 500, entry.t 300 < 600 → neither; entry.t 700 > 600 → deferred
});
it('uploads only when merged+pruned content differs from the cloud', () => {
  // own entry newer → upload true; cloud already equal → upload false;
  // cloud holding a bogus/expired entry (dropped by parse/prune) → upload true (heals)
});
it('an unparseable cloud file (cloud {}, cloudContent "") with own entries → upload true', () => {});
it('no cloud file and nothing of its own → no upload (no empty file is minted)', () => {});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/positions/positions-reconcile.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** — pure, no imports beyond Task 1.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(positions): decide adopt, defer and upload`

### Task 6: Sync — read every copy, apply, write; inside full sync and as a push

**Files:**

- Create: `src/lib/positions/positions-sync.ts`
- Create: `src/lib/positions/reader-open.ts`
- Modify: `src/lib/util/sync/unified-sync-service.ts:373-415` (`runProviderSync`: after `syncVolumeData`)
- Modify: `src/lib/util/sync/foreground-sync.ts` (export the readiness check as `syncReady(): boolean`)
- Modify: `src/routes/+layout.svelte:125-160` (`initPositionTracking()`, `initPositionPush()`)
- Modify: `CLAUDE.md` ("What syncs where" table: a `positions.json` row; root-config mentions)
- Test: `src/lib/positions/positions-sync.test.ts`

**Interfaces:**

- Consumes: Tasks 1–5; `cacheManager.getCache(type)?.getAll(POSITIONS_FILE_NAME)` (same lookup as
  `findGoalsFiles`, `unified-sync-service.ts:809`); `provider.downloadFile`;
  `unifiedCloudManager.blindUploadFile(path, blob)`; `adoptPosition` (Task 2); `ownDeviceId` /
  `getOrCreateDeviceId` (`reading-history/position-store.ts`, `record.ts`); `isVolumeComplete`
  (`util/volume-helpers.ts`) with the page count from `db.volumes.get(uuid)` (absent → `completed: undefined`);
  `showSnackbar` (`util/snackbar.ts`); `offerDeviceName` + the `devices` store
  (`reading-history/device-stats.ts`, as `PositionOfferBanner.svelte` uses).
- Produces:
  ```ts
  // reader-open.ts
  export function noteReaderOpened(volume: string, at?: number): void;
  export function noteReaderClosed(volume: string): void;
  export function openReader(): { volume: string; openedAt: number } | null;
  // positions-sync.ts
  export interface PositionsSyncOutcome {
    adopted: string[];
    deferred: string[];
    uploaded: boolean;
    skipped?: 'not-allowed' | 'not-ready';
  }
  export async function syncPositions(provider: SyncProvider): Promise<PositionsSyncOutcome>; // never throws
  export function initPositionPush(): () => void; // 3000 ms debounce after a listener fire; flush on visibilitychange → hidden
  export function flushPositionPush(): Promise<void>;
  ```
- `syncPositions`: `positionsReadAllowed(status)` false → `{ skipped: 'not-allowed' }` with no request.
  Download all listed copies with `Promise.allSettled` (not-found copies ignored, as `downloadGoalsFile`
  does); parse each, `mergePositions` them; `cloudContent` from the first readable copy. Apply each
  `adopt` through `adoptPosition`; a `toast` adoption shows the toast copy from Global Constraints. Upload
  only when `upload && positionsWriteAllowed(status)`, then `clearChanged(own)` and add the uploaded entry
  to the cache (`uploadCacheEntry`, as `uploadGoalsFile` does). Single-flight: a call while one runs
  returns that run's promise after queueing ONE follow-up.

- [ ] **Step 1: Write the failing tests** (`positions-sync.test.ts`, provider + cache stubbed through
      `cacheManager`/`unifiedCloudManager` mocks in the style of `unified-sync-service.test.ts`)

```ts
it('old bunko: no GET and no PUT of positions.json', async () => {
  // status { serverCompilesMetadata: true } → skipped 'not-allowed'; downloadFile and blindUploadFile never called
});
it('read-only plain provider: adopts, never uploads', async () => {});
it('merges two listed copies; a not-found copy does not hide the other', async () => {});
it('adopts a newer remote position with its stamp; toasts only for the open volume', async () => {});
it('uploads its own turn once, then a second run with nothing new uploads nothing', async () => {});
it('a failing download or upload resolves an outcome, never throws', async () => {});
it('push: three turns within 3 s → one syncPositions; hidden flushes at once', async () => {});
```

In `unified-sync-service.test.ts`: a full sync calls `syncPositions` after the volume-data step, and a
rejecting `syncPositions` mock does not fail the sync.

- [ ] **Step 2: Run** `npx vitest run src/lib/positions src/lib/util/sync/unified-sync-service.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. `runProviderSync`: `await syncPositions(provider)` right after
      `syncVolumeData`, inside its own try/catch. Layout: start tracking and push after the device record is
      ready (beside `initPositionOffers`). CLAUDE.md row: `| Newest reading position (30 days) | positions.json | newest t per volume |`,
      plus one sentence that bunko gets it only when it lists the file in `per_user_files`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS, whole suite.
- [ ] **Step 5: Commit** — `feat(positions): sync positions.json in every sync and push after page turns`

### Task 7: Reader open waits for the position (≤ 1000 ms)

**Files:**

- Modify: `src/lib/positions/positions-sync.ts` (add the open check)
- Modify: `src/lib/views/ReaderView.svelte:76-95` (gate render; note open/close; volume change)
- Modify: `src/lib/util/sync/foreground-sync.ts` (on visible: `requestPositionCheck()`, throttled 10 s)
- Test: `src/lib/positions/positions-sync.test.ts`

**Interfaces:**

- Consumes: Task 6.
- Produces:
  ```ts
  export const READER_OPEN_WAIT_MS = 1000;
  /** noteReaderOpened, then syncPositions when syncReady(); resolves on the answer or after the wait. */
  export function checkPositionsOnOpen(volume: string, wait?: number): Promise<void>;
  export function requestPositionCheck(now?: number): void;
  ```
- `ReaderView`: `positionsChecked` starts false; on mount and on every `volumeId` change, set false and
  `checkPositionsOnOpen(volumeId).finally(() => (positionsChecked = true))`; the existing
  `{#if cachedVolumeSettings}` also requires `positionsChecked`; on destroy `noteReaderClosed`. The
  existing `foregroundSync.request()` on mount stays.
- A late answer after the timeout still adopts through Task 5's rule, so a page not yet turned still moves.

- [ ] **Step 1: Write the failing tests**

```ts
it('resolves when the answer arrives', async () => {}); // download resolves at 200 ms → resolved by 200 ms
it('resolves at 1000 ms when the provider is slow; the late answer still adopts', async () => {
  // download resolves at 3000 ms; promise resolved at 1000; at 3000 adoptPosition called with toast
});
it('not ready (no provider / listing not loaded) → resolves at once, no request', async () => {});
it('focus check is throttled to one per 10 s', () => {});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/positions/positions-sync.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** `npm test && npm run check` — Expected: PASS, 0 errors.
- [ ] **Step 5: Commit** — `feat(reader): open where the other device stopped`

### Task 8: End-to-end device swap

**Files:**

- Create: `e2e/position-file.spec.ts`
- Modify (only if a delay hook is missing): `e2e/helpers/webdav-stub.ts`

**Interfaces:**

- Consumes: `WebDavStub` (`e2e/helpers/webdav-stub.ts`), the WebDAV connect + volume seeding helpers used
  by `e2e/position-offer.spec.ts` and `e2e/history-sync.spec.ts` (reuse them; copy nothing).

- [ ] **Step 1: Write the spec** — two browser contexts sharing one stub, as in `history-sync.spec.ts`:

```ts
test('the picked-up device opens where the other one stopped', async ({ browser }) => {
  // A and B both hold the volume at p.40 (synced). A turns to p.12x and waits for the push
  //   (stub log shows a PUT of /mokuro-reader/positions.json).
  // B opens the volume → its first rendered page is A's page; toast "Continued from … p.N" visible.
});
test('a slow check opens the local page, then moves before any page turn', async ({ browser }) => {
  // stub delays GET positions.json by 2500 ms → B renders p.40 at ~1 s, then moves to A's page
});
test('after a page turn the late answer is an offer, not a move', async ({ browser }) => {
  // delayed GET; B turns to p.41 before it lands → B stays on p.41, offer banner appears
});
test('opening and closing without turning writes no position', async ({ browser }) => {
  // B opens and leaves: no PUT of positions.json from B; A's entry unchanged
});
```

- [ ] **Step 2: Run** `E2E_PORT=5197 npx playwright test e2e/position-file.spec.ts` — Expected: PASS
      (the feature exists since Task 7; a failure here is a real defect — debug it, do not loosen the spec).
- [ ] **Step 3: Run the whole e2e suite** `E2E_PORT=5197 npm run test:e2e` — Expected: 0 failures.
- [ ] **Step 4: Commit** — `test(e2e): the device swap lands on the newest position`

### Task 9: mokuro-bunko — keep `positions.json` per user and say so

**Repo:** `<bunko-repo>`, new worktree
`../mokuro-webdav-library-worktrees/feat-positions-per-user` off `0.8/remote-storage`.

**Files:**

- Modify: `crates/bunko-dav/src/paths.rs:23` — `PER_USER_FILES` gains `"positions.json"` (array length 4)
- Modify: `crates/bunko-server/src/accounts/login.rs` — `identity_body` and the anonymous body add
  `"per_user_files": paths::PER_USER_FILES`
- Test: the crates' existing test modules for `classify`/PROPFIND and `/login/api/me`

**Interfaces:**

- Produces: `/login/api/me` → `"per_user_files": ["goals.json","profiles.json","volume-data.json","positions.json"]`
  (order as in the const); `PUT /mokuro-reader/positions.json` by user A is invisible to user B; the
  per-user PROPFIND injection (`methods/read.rs:183`) lists it like the others.

- [ ] **Step 1: Write failing tests** — `classify("mokuro-reader/positions.json")` is the per-user target;
      two users PUT different bodies and each GETs back their own; the identity body contains
      `per_user_files` including `positions.json`.
- [ ] **Step 2: Run** `cargo test -p bunko-dav -p bunko-server` — Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** the two changes.
- [ ] **Step 4: Run** `cargo test -p bunko-dav -p bunko-server` — Expected: PASS.
- [ ] **Step 5: Commit** (bunko repo) — `feat(dav): keep positions.json per user and list per-user files`
