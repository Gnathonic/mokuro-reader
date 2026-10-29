# Reading History Phase 1 — Local Event Store and Recording — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every reading view, and every manual stat edit, as permanent per-device events in a new local IndexedDB, without changing what any existing screen, sync or stat does.

**Architecture:** A separate Dexie database `mokuro_history` holds `reading_events` keyed `[device+seq]`, device facts, and a meta table that allocates this device's ID and `seq` inside IndexedDB transactions (so two tabs can never collide). A small pure `ViewTracker` turns "what is on screen" into `page` events with real dwell. Reader feeds it a pure `describeView(...)` descriptor, and the scroll readers report their visible page range. The existing stat mutators emit `adjust`/`restart`/`forget` events. Nothing reads the events yet.

**Tech Stack:** Svelte 5 (runes), Dexie 4, Vitest + jsdom + `fake-indexeddb`, Playwright via the `verify` skill.

**Spec:** `docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md` (phase 1 of its Rollout section).

## Global Constraints

- Database name `mokuro_history`, Dexie version 1, stores exactly: `reading_events: '[device+seq], volume, t'`, `devices: 'device'`, `history_meta: 'key'`.
- Do NOT add tables or versions to `mokuro_v3` / `MOKURO_DB_SCHEMA`.
- No new npm dependencies.
- No change to `recentPageTurns`, `timeReadInMinutes`, `volume-data.json`, any sync code, or any speed/stat calculation. Phase 1 only writes events.
- No legacy conversion of `recentPageTurns` in this phase (it moves to phase 2's cut-over; see spec "Migration").
- Recording must never throw into the reader or a store update: every write is fire-and-forget, failures log one `console.warn` per session.
- `page` events: `dwell_ms` is raw and uncapped. Pages are whole pages, 1-based, inclusive, at least one page. Any page with any part on screen counts.
- IDs come from `generateUUID()` (`src/lib/util/uuid.ts`), never `crypto.randomUUID()` directly (iOS fallback).
- Code style: match the surrounding files (Prettier config of the repo, JSDoc comments explaining _why_). Never mention the third-party public deployment's domain anywhere.
- Harness rule: run the `verify` skill right before each code commit (not for docs/test-only commits).
- Branch `feat/reading-history-event-log`, worktree `/home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-event-log`. Local commits only, no push.

## Review Focus

1. **Two tabs on one device recording at once** → every event gets a unique `seq`. Pinned in Task 1 (two connections, interleaved appends).
2. **IndexedDB unavailable or failing** (private mode, quota, blocked) → reading works normally and the failure is logged once, never thrown. Pinned in Task 1 (`recordEvent` swallow test).
3. **Mobile app switch / tab hidden mid-page** → the open view is closed with dwell up to the moment it was hidden, and a new view opens on return. Pinned in Task 3 (null-then-same-view test); wired in Task 5.
4. **Reader before pages load, image-only volumes, last page of a double spread, cover page shown single** → no event without pages; zero-char pages still recorded; the range never runs past the last page. Pinned in Task 4 (`describeView` tests).
5. **A stale continuous range after switching modes or volumes** (the range no longer contains the current page) → falls back to the current page alone. Pinned in Task 4 (`describeView` stale-range test).

---

## File Structure

| File                                                                                     | Responsibility                                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/lib/reading-history/types.ts`                                                       | Event, payload and device-fact types                                             |
| `src/lib/reading-history/history-db.ts`                                                  | `HistoryDexie` class and the lazily created default instance                     |
| `src/lib/reading-history/record.ts`                                                      | Device ID, atomic `seq` allocation, `appendEvent`, fire-and-forget `recordEvent` |
| `src/lib/reading-history/device-facts.ts`                                                | Pure device class / OS / browser detection, `touchDeviceRecord`                  |
| `src/lib/reading-history/view-tracker.ts`                                                | Pure `ViewTracker` (open view → `page` event with dwell)                         |
| `src/lib/reading-history/describe-view.ts`                                               | Pure Reader-state → `ViewDescriptor`                                             |
| `src/lib/reader/page-detection.ts`                                                       | + `visiblePageRange`                                                             |
| `src/lib/components/Reader/VerticalScrollReader.svelte`, `HorizontalScrollReader.svelte` | + `onVisibleRangeChange` prop                                                    |
| `src/lib/components/Reader/Reader.svelte`                                                | Feeds the tracker, visibility/pagehide/destroy handling                          |
| `src/routes/+layout.svelte`                                                              | Touch this device's record on app start                                          |
| `src/lib/util/volume-editor.ts`, `src/lib/settings/volume-data.ts`                       | Emit `adjust` / `forget` / `restart`                                             |
| `CLAUDE.md`                                                                              | Document the history DB                                                          |

---

### Task 1: History database, device ID and atomic event append

**Files:**

- Create: `src/lib/reading-history/types.ts`
- Create: `src/lib/reading-history/history-db.ts`
- Create: `src/lib/reading-history/record.ts`
- Test: `src/lib/reading-history/record.test.ts`

**Interfaces:**

- Consumes: `generateUUID()` from `src/lib/util/uuid.ts`.
- Produces:
  - Types `Layout`, `Orientation`, `PagePayload`, `AdjustPayload`, `RestartPayload`, `ForgetPayload`, `EventPayload`, `ReadingEvent`, `DeviceClass`, `DeviceFacts` (exact shapes below).
  - `class HistoryDexie` (`reading_events`, `devices`, `history_meta` tables), `HISTORY_DB_NAME = 'mokuro_history'`, `historyDb(): HistoryDexie`.
  - `getOrCreateDeviceId(db: HistoryDexie): Promise<string>`
  - `appendEvent(db: HistoryDexie, payload: EventPayload, t: number): Promise<ReadingEvent>`
  - `recordEvent(payload: EventPayload, t?: number, db?: HistoryDexie): Promise<ReadingEvent | null>`

- [ ] **Step 1: Set up the worktree's dependencies and check the baseline**

```bash
cd /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-event-log
npm ci
npx vitest run src/lib/settings src/lib/util/volume-editor 2>&1 | tail -5
```

Expected: install succeeds; the listed tests pass. If anything fails here, stop and report it — it's pre-existing.

- [ ] **Step 2: Write the types**

`src/lib/reading-history/types.ts`:

```ts
/**
 * Reading history events — see
 * docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md.
 *
 * Every event is permanent and identified by `[device, seq]`: `device` is the
 * recording install's random ID, `seq` counts up per device. Nothing is ever
 * edited or deleted; `forget`/`restart` are applied when stats are computed.
 */

export type Layout = 'single' | 'double' | 'continuous-v' | 'continuous-h';
export type Orientation = 'portrait' | 'landscape';

/** One view (whatever was on screen together) and how long it stayed. */
export interface PagePayload {
  kind: 'page';
  volume: string;
  /** 1-based, inclusive. Whole pages: any page with any part on screen. */
  first_page: number;
  last_page: number;
  /** Characters of each page first_page..last_page, in order. */
  page_chars: number[];
  /** Characters of every page before first_page (position, not reading). */
  chars_before: number;
  /** Raw time on screen, uncapped. `null` = unknown (legacy conversion only). */
  dwell_ms: number | null;
  layout: Layout | 'unknown';
  orientation: Orientation | 'unknown';
  viewport: { w: number; h: number } | null;
}

/** A manual stat edit (volume editor): totals moved by these deltas. */
export interface AdjustPayload {
  kind: 'adjust';
  volume: string;
  time_delta_ms: number;
  chars_delta: number;
}

/** "Restart series": a new read pass of this volume starts here. */
export interface RestartPayload {
  kind: 'restart';
  volume: string;
}

/** "Forget this volume's stats": ignore its events recorded before `before`. */
export interface ForgetPayload {
  kind: 'forget';
  volume: string;
  before: number;
}

export type EventPayload = PagePayload | AdjustPayload | RestartPayload | ForgetPayload;

/** `t` = epoch ms on the recording device (for `page`: when the view opened). */
export type ReadingEvent = { device: string; seq: number; t: number } & EventPayload;

export type DeviceClass = 'phone' | 'tablet' | 'laptop' | 'desktop' | 'unknown';

/** Facts a device records about itself. User labels live elsewhere (phase 4). */
export interface DeviceFacts {
  device: string;
  class: DeviceClass;
  os?: string;
  browser?: string;
  first_seen: string;
  last_seen: string;
}
```

- [ ] **Step 3: Write the failing tests**

`src/lib/reading-history/record.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { HistoryDexie } from './history-db';
import { appendEvent, getOrCreateDeviceId, recordEvent } from './record';
import type { PagePayload } from './types';

let n = 0;
const dbs: HistoryDexie[] = [];
function freshDb(name = `history_test_${n++}`): HistoryDexie {
  const db = new HistoryDexie(name);
  dbs.push(db);
  return db;
}

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    db.close();
    await HistoryDexie.delete(db.name);
  }
  vi.restoreAllMocks();
});

const page = (p: number): PagePayload => ({
  kind: 'page',
  volume: 'vol-1',
  first_page: p,
  last_page: p,
  page_chars: [10],
  chars_before: 0,
  dwell_ms: 1000,
  layout: 'single',
  orientation: 'portrait',
  viewport: { w: 400, h: 800 }
});

describe('getOrCreateDeviceId', () => {
  it('creates one ID and returns the same one afterwards', async () => {
    const db = freshDb();
    const a = await getOrCreateDeviceId(db);
    const b = await getOrCreateDeviceId(db);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toBe(a);
  });

  it('agrees across two connections to the same database (two tabs)', async () => {
    const name = `history_test_${n++}`;
    const [a, b] = await Promise.all([
      getOrCreateDeviceId(freshDb(name)),
      getOrCreateDeviceId(freshDb(name))
    ]);
    expect(b).toBe(a);
  });
});

describe('appendEvent', () => {
  it('numbers events 1, 2, 3 under this device and stores them', async () => {
    const db = freshDb();
    const e1 = await appendEvent(db, page(1), 100);
    const e2 = await appendEvent(db, page(2), 200);
    const device = await getOrCreateDeviceId(db);
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    expect(e1.device).toBe(device);
    expect(await db.reading_events.get([device, 2])).toMatchObject({ t: 200, first_page: 2 });
  });

  it('never reuses a seq when two connections append concurrently', async () => {
    const name = `history_test_${n++}`;
    const a = freshDb(name);
    const b = freshDb(name);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => appendEvent(i % 2 ? a : b, page(i + 1), i))
    );
    const seqs = results.map((e) => e.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await a.reading_events.count()).toBe(20);
  });
});

describe('recordEvent', () => {
  it('writes through to the given database', async () => {
    const db = freshDb();
    const e = await recordEvent(page(3), 300, db);
    expect(e?.seq).toBe(1);
  });

  it('swallows a failing database, warns once, and returns null', async () => {
    const db = freshDb();
    vi.spyOn(db, 'transaction').mockImplementation((() =>
      Promise.reject(new Error('QuotaExceededError'))) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordEvent(page(1), 1, db)).resolves.toBeNull();
    await expect(recordEvent(page(2), 2, db)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/lib/reading-history/record.test.ts`
Expected: FAIL — cannot resolve `./history-db` / `./record`.

- [ ] **Step 5: Write the database class**

`src/lib/reading-history/history-db.ts`:

```ts
import Dexie, { type Table } from 'dexie';
import type { DeviceFacts, ReadingEvent } from './types';

/**
 * Reading history lives in its OWN database, not in `mokuro_v3`: it outlives
 * every catalog row, the export Worker never needs it, it stays off the
 * `MOKURO_DB_SCHEMA` ladder, and its small writes never queue behind the
 * catalog's long blob transactions.
 */
export const HISTORY_DB_NAME = 'mokuro_history';

export interface HistoryMeta {
  key: string;
  value: unknown;
}

export class HistoryDexie extends Dexie {
  reading_events!: Table<ReadingEvent, [string, number]>;
  devices!: Table<DeviceFacts, string>;
  history_meta!: Table<HistoryMeta, string>;

  constructor(name: string = HISTORY_DB_NAME) {
    super(name);
    this.version(1).stores({
      reading_events: '[device+seq], volume, t',
      devices: 'device',
      history_meta: 'key'
    });
  }
}

let defaultDb: HistoryDexie | null = null;

/** The app's history database, created on first use. */
export function historyDb(): HistoryDexie {
  return (defaultDb ??= new HistoryDexie());
}
```

- [ ] **Step 6: Write the recorder**

`src/lib/reading-history/record.ts`:

```ts
import { generateUUID } from '$lib/util/uuid';
import { historyDb, type HistoryDexie } from './history-db';
import type { EventPayload, ReadingEvent } from './types';

const DEVICE_ID_KEY = 'device_id';
const NEXT_SEQ_KEY = 'next_seq';

/**
 * This install's device ID, created on first call. Read-or-create runs in one
 * rw transaction, so two tabs racing on first run still agree on one ID.
 */
export async function getOrCreateDeviceId(db: HistoryDexie): Promise<string> {
  return db.transaction('rw', db.history_meta, async () => {
    const row = await db.history_meta.get(DEVICE_ID_KEY);
    if (typeof row?.value === 'string') return row.value;
    const id = generateUUID();
    await db.history_meta.put({ key: DEVICE_ID_KEY, value: id });
    return id;
  });
}

/**
 * Store one event under this device's next `seq`. The counter is read and
 * advanced in the same rw transaction as the write: IndexedDB serialises rw
 * transactions on a store across every connection, so two tabs of one device
 * can never hand out the same `seq`.
 */
export async function appendEvent(
  db: HistoryDexie,
  payload: EventPayload,
  t: number
): Promise<ReadingEvent> {
  return db.transaction('rw', db.history_meta, db.reading_events, async () => {
    const device = await getOrCreateDeviceId(db);
    const next = await db.history_meta.get(NEXT_SEQ_KEY);
    const seq = typeof next?.value === 'number' ? next.value : 1;
    await db.history_meta.put({ key: NEXT_SEQ_KEY, value: seq + 1 });
    const event = { ...payload, device, seq, t } as ReadingEvent;
    await db.reading_events.add(event);
    return event;
  });
}

let warned = false;

/**
 * Fire-and-forget recording for UI and store code. Never throws: history is
 * worth less than the reading it describes, so a failing database (private
 * mode, quota, blocked upgrade) logs once per session and is otherwise ignored.
 */
export function recordEvent(
  payload: EventPayload,
  t: number = Date.now(),
  db?: HistoryDexie
): Promise<ReadingEvent | null> {
  if (!db && typeof indexedDB === 'undefined') return Promise.resolve(null);
  let target: HistoryDexie;
  try {
    target = db ?? historyDb();
  } catch (error) {
    return Promise.resolve(warnOnce(error));
  }
  return appendEvent(target, payload, t).catch(warnOnce);
}

function warnOnce(error: unknown): null {
  if (!warned) {
    warned = true;
    console.warn('[reading-history] could not record event:', error);
  }
  return null;
}

/** Test hook: re-arm the once-per-session warning. */
export function _resetRecordWarning(): void {
  warned = false;
}
```

Then make the swallow test independent of test order: add `import { _resetRecordWarning } from './record';` to the test's existing import from `./record`, and call `_resetRecordWarning();` as the first line of the `'swallows a failing database…'` test.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/lib/reading-history/record.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Type-check**

Run: `npm run check 2>&1 | tail -5`
Expected: no new errors in `src/lib/reading-history/`.

- [ ] **Step 9: Commit** (run the `verify` skill first: harness rule)

```bash
git add src/lib/reading-history/types.ts src/lib/reading-history/history-db.ts src/lib/reading-history/record.ts src/lib/reading-history/record.test.ts
git commit -m "feat(history): local mokuro_history DB with per-device atomic event seq

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Device facts

**Files:**

- Create: `src/lib/reading-history/device-facts.ts`
- Test: `src/lib/reading-history/device-facts.test.ts`

**Interfaces:**

- Consumes: `HistoryDexie`, `getOrCreateDeviceId` (Task 1); `DeviceClass`, `DeviceFacts` (Task 1).
- Produces:
  - `interface DeviceEnv { userAgent: string; uaDataPlatform?: string; uaDataBrands?: string[]; uaDataMobile?: boolean; coarsePointer: boolean; maxTouchPoints: number; screenShortSide: number }`
  - `readDeviceEnv(): DeviceEnv`
  - `detectDeviceFacts(env: DeviceEnv): { class: DeviceClass; os?: string; browser?: string }`
  - `touchDeviceRecord(db: HistoryDexie, facts: ReturnType<typeof detectDeviceFacts>, nowIso: string): Promise<DeviceFacts>`

- [ ] **Step 1: Write the failing tests**

`src/lib/reading-history/device-facts.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { HistoryDexie } from './history-db';
import { detectDeviceFacts, touchDeviceRecord, type DeviceEnv } from './device-facts';

const base: DeviceEnv = {
  userAgent: '',
  coarsePointer: false,
  maxTouchPoints: 0,
  screenShortSide: 1080
};

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipadDesktopSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
  winEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  linuxChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
};

describe('detectDeviceFacts', () => {
  it.each([
    [
      'Android phone',
      { userAgent: UA.androidChrome, coarsePointer: true, maxTouchPoints: 5, screenShortSide: 412 },
      { class: 'phone', os: 'Android', browser: 'Chrome' }
    ],
    [
      'iPhone',
      { userAgent: UA.iphoneSafari, coarsePointer: true, maxTouchPoints: 5, screenShortSide: 390 },
      { class: 'phone', os: 'iOS', browser: 'Safari' }
    ],
    [
      'iPad reporting a desktop UA',
      {
        userAgent: UA.ipadDesktopSafari,
        coarsePointer: true,
        maxTouchPoints: 5,
        screenShortSide: 820
      },
      { class: 'tablet', os: 'iOS', browser: 'Safari' }
    ],
    [
      'iPad desktop UA with a trackpad (fine pointer)',
      {
        userAgent: UA.ipadDesktopSafari,
        coarsePointer: false,
        maxTouchPoints: 5,
        screenShortSide: 820
      },
      { class: 'tablet', os: 'iOS', browser: 'Safari' }
    ],
    [
      'Windows Firefox',
      { userAgent: UA.winFirefox },
      { class: 'desktop', os: 'Windows', browser: 'Firefox' }
    ],
    [
      'Windows Edge',
      { userAgent: UA.winEdge },
      { class: 'desktop', os: 'Windows', browser: 'Edge' }
    ],
    [
      'Linux Chrome',
      { userAgent: UA.linuxChrome },
      { class: 'desktop', os: 'Linux', browser: 'Chrome' }
    ],
    [
      'ChromeOS',
      { userAgent: UA.chromebook },
      { class: 'desktop', os: 'ChromeOS', browser: 'Chrome' }
    ],
    [
      'Client hints win over the UA string',
      {
        userAgent: UA.linuxChrome,
        uaDataPlatform: 'Android',
        uaDataBrands: ['Not=A?Brand', 'Chromium', 'Google Chrome'],
        uaDataMobile: true,
        coarsePointer: true,
        maxTouchPoints: 5,
        screenShortSide: 400
      },
      { class: 'phone', os: 'Android', browser: 'Chrome' }
    ],
    ['Nothing recognisable', { userAgent: 'curl/8' }, { class: 'desktop' }]
  ])('%s', (_name, env, expected) => {
    expect(detectDeviceFacts({ ...base, ...env } as DeviceEnv)).toEqual(expected);
  });
});

describe('touchDeviceRecord', () => {
  const db = new HistoryDexie('history_device_test');
  afterEach(async () => {
    await db.devices.clear();
  });

  it('keeps first_seen and moves last_seen', async () => {
    const facts = { class: 'phone' as const, os: 'Android', browser: 'Chrome' };
    const first = await touchDeviceRecord(db, facts, '2026-10-01T00:00:00.000Z');
    const second = await touchDeviceRecord(db, facts, '2026-10-02T00:00:00.000Z');
    expect(second.device).toBe(first.device);
    expect(second.first_seen).toBe('2026-10-01T00:00:00.000Z');
    expect(second.last_seen).toBe('2026-10-02T00:00:00.000Z');
    expect(await db.devices.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/reading-history/device-facts.test.ts`
Expected: FAIL — cannot resolve `./device-facts`.

- [ ] **Step 3: Implement**

`src/lib/reading-history/device-facts.ts`:

```ts
import type { HistoryDexie } from './history-db';
import { getOrCreateDeviceId } from './record';
import type { DeviceClass, DeviceFacts } from './types';

/**
 * Coarse signals only: class, OS family, browser family. Never a device model
 * or the full user agent. Laptop vs desktop can't be told apart reliably from
 * a browser, so fine-pointer devices report 'desktop' and the user corrects it
 * (phase 4 labels).
 */
export interface DeviceEnv {
  userAgent: string;
  uaDataPlatform?: string;
  uaDataBrands?: string[];
  uaDataMobile?: boolean;
  coarsePointer: boolean;
  maxTouchPoints: number;
  /** min(screen.width, screen.height) in CSS px. */
  screenShortSide: number;
}

interface UADataLike {
  platform?: string;
  brands?: { brand: string }[];
  mobile?: boolean;
}

export function readDeviceEnv(): DeviceEnv {
  const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
  return {
    userAgent: navigator.userAgent,
    uaDataPlatform: uaData?.platform || undefined,
    uaDataBrands: uaData?.brands?.map((b) => b.brand),
    uaDataMobile: uaData?.mobile,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    screenShortSide: Math.min(screen.width, screen.height)
  };
}

const PHONE_MAX_SHORT_SIDE = 600;

export function detectDeviceFacts(env: DeviceEnv): {
  class: DeviceClass;
  os?: string;
  browser?: string;
} {
  const os = detectOs(env);
  const browser = detectBrowser(env);
  return { class: detectClass(env, os), ...(os && { os }), ...(browser && { browser }) };
}

function isIpadDesktopUa(env: DeviceEnv): boolean {
  // iPadOS Safari sends a macOS UA; touch points give it away.
  return /Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1;
}

function detectClass(env: DeviceEnv, os: string | undefined): DeviceClass {
  if (env.uaDataMobile === true) return 'phone';
  if (isIpadDesktopUa(env)) return 'tablet';
  if (env.coarsePointer) {
    return env.screenShortSide < PHONE_MAX_SHORT_SIDE ? 'phone' : 'tablet';
  }
  if (os === 'Android' || os === 'iOS') {
    return env.screenShortSide < PHONE_MAX_SHORT_SIDE ? 'phone' : 'tablet';
  }
  return 'desktop';
}

const PLATFORM_NAMES: Record<string, string> = {
  Android: 'Android',
  iOS: 'iOS',
  Windows: 'Windows',
  macOS: 'macOS',
  Linux: 'Linux',
  'Chrome OS': 'ChromeOS',
  ChromeOS: 'ChromeOS'
};

function detectOs(env: DeviceEnv): string | undefined {
  if (env.uaDataPlatform && PLATFORM_NAMES[env.uaDataPlatform]) {
    return PLATFORM_NAMES[env.uaDataPlatform];
  }
  const ua = env.userAgent;
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua) || isIpadDesktopUa(env)) return 'iOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return undefined;
}

const BRANDS: [string, string][] = [
  ['Microsoft Edge', 'Edge'],
  ['Opera', 'Opera'],
  ['Brave', 'Brave'],
  ['Google Chrome', 'Chrome'],
  ['Chromium', 'Chromium']
];

function detectBrowser(env: DeviceEnv): string | undefined {
  for (const [brand, name] of BRANDS) {
    if (env.uaDataBrands?.includes(brand)) return name;
  }
  const ua = env.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS/.test(ua)) return 'Firefox';
  if (/CriOS|Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return undefined;
}

/** Create or refresh this device's facts row. `first_seen` never moves. */
export async function touchDeviceRecord(
  db: HistoryDexie,
  facts: ReturnType<typeof detectDeviceFacts>,
  nowIso: string
): Promise<DeviceFacts> {
  const device = await getOrCreateDeviceId(db);
  return db.transaction('rw', db.devices, async () => {
    const existing = await db.devices.get(device);
    const record: DeviceFacts = {
      device,
      ...facts,
      first_seen: existing?.first_seen ?? nowIso,
      last_seen: nowIso
    };
    await db.devices.put(record);
    return record;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/reading-history/device-facts.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit** (run the `verify` skill first)

```bash
git add src/lib/reading-history/device-facts.ts src/lib/reading-history/device-facts.test.ts
git commit -m "feat(history): coarse device facts (class, OS, browser)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: ViewTracker

**Files:**

- Create: `src/lib/reading-history/view-tracker.ts`
- Test: `src/lib/reading-history/view-tracker.test.ts`

**Interfaces:**

- Consumes: `PagePayload`, `Layout`, `Orientation` (Task 1).
- Produces:
  - `interface ViewDescriptor { volume: string; first_page: number; last_page: number; page_chars: number[]; chars_before: number; layout: Layout; orientation: Orientation; viewport: { w: number; h: number } }`
  - `viewKey(view: ViewDescriptor): string`
  - `class ViewTracker { constructor(emit: (payload: PagePayload, t: number) => void); setView(view: ViewDescriptor | null, now: number): void; close(now: number): void }`

- [ ] **Step 1: Write the failing tests**

`src/lib/reading-history/view-tracker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ViewTracker, type ViewDescriptor } from './view-tracker';
import type { PagePayload } from './types';

function view(first: number, last = first, extra: Partial<ViewDescriptor> = {}): ViewDescriptor {
  return {
    volume: 'vol-1',
    first_page: first,
    last_page: last,
    page_chars: Array.from({ length: last - first + 1 }, () => 50),
    chars_before: (first - 1) * 50,
    layout: first === last ? 'single' : 'double',
    orientation: 'portrait',
    viewport: { w: 400, h: 800 },
    ...extra
  };
}

function setup() {
  const emitted: { payload: PagePayload; t: number }[] = [];
  const tracker = new ViewTracker((payload, t) => emitted.push({ payload, t }));
  return { tracker, emitted };
}

describe('ViewTracker', () => {
  it('emits the previous view with its dwell when the view changes', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 1000);
    tracker.setView(view(2), 31000);
    expect(emitted).toEqual([{ payload: { kind: 'page', ...view(1), dwell_ms: 30000 }, t: 1000 }]);
  });

  it('ignores a re-set of the same view (same volume, pages, layout)', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 1000);
    tracker.setView(view(1, 1, { viewport: { w: 500, h: 900 } }), 2000);
    tracker.setView(view(2), 5000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.dwell_ms).toBe(4000);
  });

  it('closes on null (tab hidden) and reopens the same view as a new event', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(3), 0);
    tracker.setView(null, 10000);
    tracker.setView(view(3), 60000);
    tracker.close(65000);
    expect(emitted.map((e) => [e.t, e.payload.dwell_ms])).toEqual([
      [0, 10000],
      [60000, 5000]
    ]);
  });

  it('treats a layout change on the same pages as a new view', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(4, 4, { layout: 'single' }), 0);
    tracker.setView(view(4, 4, { layout: 'continuous-v' }), 2000);
    expect(emitted).toHaveLength(1);
  });

  it('close with nothing open emits nothing, and close is idempotent', () => {
    const { tracker, emitted } = setup();
    tracker.close(5);
    tracker.setView(view(1), 10);
    tracker.close(20);
    tracker.close(30);
    expect(emitted).toHaveLength(1);
  });

  it('never emits a negative dwell if the clock steps backwards', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 5000);
    tracker.close(4000);
    expect(emitted[0].payload.dwell_ms).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/reading-history/view-tracker.test.ts`
Expected: FAIL — cannot resolve `./view-tracker`.

- [ ] **Step 3: Implement**

`src/lib/reading-history/view-tracker.ts`:

```ts
import type { Layout, Orientation, PagePayload } from './types';

/** What is on screen right now (see `describeView`). */
export interface ViewDescriptor {
  volume: string;
  first_page: number;
  last_page: number;
  page_chars: number[];
  chars_before: number;
  layout: Layout;
  orientation: Orientation;
  viewport: { w: number; h: number };
}

/**
 * Two descriptors are the same view when the same pages of the same volume are
 * shown in the same layout. A resize or rotation alone doesn't start a new view;
 * the event keeps the orientation/viewport it opened with.
 */
export function viewKey(view: ViewDescriptor): string {
  return `${view.volume}|${view.first_page}|${view.last_page}|${view.layout}`;
}

/**
 * Turns a stream of "what's on screen" into `page` events. An event is emitted
 * when its view ENDS (another view, hidden, closed), so its dwell is known.
 */
export class ViewTracker {
  private open: { view: ViewDescriptor; key: string; since: number } | null = null;

  constructor(private readonly emit: (payload: PagePayload, t: number) => void) {}

  setView(view: ViewDescriptor | null, now: number): void {
    const key = view ? viewKey(view) : null;
    if (this.open && key === this.open.key) return;
    this.close(now);
    if (view && key) this.open = { view, key, since: now };
  }

  close(now: number): void {
    if (!this.open) return;
    const { view, since } = this.open;
    this.open = null;
    this.emit({ kind: 'page', ...view, dwell_ms: Math.max(0, now - since) }, since);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/reading-history/view-tracker.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit** (run the `verify` skill first)

```bash
git add src/lib/reading-history/view-tracker.ts src/lib/reading-history/view-tracker.test.ts
git commit -m "feat(history): ViewTracker emits page events with dwell when a view ends

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: describeView and visible page ranges

**Files:**

- Create: `src/lib/reading-history/describe-view.ts`
- Test: `src/lib/reading-history/describe-view.test.ts`
- Modify: `src/lib/reader/page-detection.ts` (append `visiblePageRange`)
- Test: `src/lib/reader/page-detection.test.ts` (append a `describe` block)

**Interfaces:**

- Consumes: `ViewDescriptor` (Task 3); `RectLike` from `src/lib/reader/zoom-math.ts`.
- Produces:
  - `interface ViewInputs { volume: string | undefined; pageCharCumulative: number[]; page: number; continuous: boolean; scrollMode: 'vertical' | 'horizontal'; showSecondPage: boolean; continuousRange: [number, number] | null; viewport: { w: number; h: number } }`
  - `describeView(inputs: ViewInputs): ViewDescriptor | null`
  - `visiblePageRange(containerRect: RectLike, rects: (RectLike | undefined)[], axis: 'x' | 'y'): [number, number] | null` (1-based, inclusive)

- [ ] **Step 1: Write the failing `describeView` tests**

`src/lib/reading-history/describe-view.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { describeView, type ViewInputs } from './describe-view';

// Five pages with 10, 0, 30, 40, 50 characters.
const cumulative = [10, 10, 40, 80, 130];

function inputs(extra: Partial<ViewInputs>): ViewInputs {
  return {
    volume: 'vol-1',
    pageCharCumulative: cumulative,
    page: 1,
    continuous: false,
    scrollMode: 'vertical',
    showSecondPage: false,
    continuousRange: null,
    viewport: { w: 400, h: 800 },
    ...extra
  };
}

describe('describeView', () => {
  it('returns null before the volume or its pages are loaded', () => {
    expect(describeView(inputs({ volume: undefined }))).toBeNull();
    expect(describeView(inputs({ pageCharCumulative: [] }))).toBeNull();
  });

  it('describes a single page with its own chars and the chars before it', () => {
    expect(describeView(inputs({ page: 3 }))).toEqual({
      volume: 'vol-1',
      first_page: 3,
      last_page: 3,
      page_chars: [30],
      chars_before: 10,
      layout: 'single',
      orientation: 'portrait',
      viewport: { w: 400, h: 800 }
    });
  });

  it('describes a double spread as both pages, including a zero-char page', () => {
    const v = describeView(inputs({ page: 2, showSecondPage: true }));
    expect(v).toMatchObject({ first_page: 2, last_page: 3, page_chars: [0, 30], layout: 'double' });
  });

  it('never runs past the last page', () => {
    const v = describeView(inputs({ page: 5, showSecondPage: true }));
    expect(v).toMatchObject({ first_page: 5, last_page: 5, page_chars: [50] });
    expect(describeView(inputs({ page: 9 }))).toMatchObject({ first_page: 5, last_page: 5 });
  });

  it('uses the continuous range when it contains the current page', () => {
    const v = describeView(
      inputs({ continuous: true, scrollMode: 'horizontal', page: 3, continuousRange: [2, 4] })
    );
    expect(v).toMatchObject({
      first_page: 2,
      last_page: 4,
      page_chars: [0, 30, 40],
      chars_before: 10,
      layout: 'continuous-h'
    });
  });

  it('falls back to the current page when the continuous range is stale or missing', () => {
    expect(
      describeView(inputs({ continuous: true, page: 5, continuousRange: [1, 2] }))
    ).toMatchObject({ first_page: 5, last_page: 5, layout: 'continuous-v' });
    expect(describeView(inputs({ continuous: true, page: 2 }))).toMatchObject({
      first_page: 2,
      last_page: 2
    });
  });

  it('reports landscape and rounds the viewport', () => {
    expect(describeView(inputs({ viewport: { w: 1280.4, h: 719.6 } }))).toMatchObject({
      orientation: 'landscape',
      viewport: { w: 1280, h: 720 }
    });
  });
});
```

- [ ] **Step 2: Write the failing `visiblePageRange` tests**

Append to `src/lib/reader/page-detection.test.ts` (it already defines `verticalStrip` and `container` at the top; add `visiblePageRange` to the existing import from `./page-detection`):

```ts
describe('visiblePageRange', () => {
  it('returns every page with any part inside the viewport, 1-based', () => {
    // 1000px pages, scrolled to 3100: page 4 (3000–4000) fills the 800px viewport.
    expect(visiblePageRange(container, verticalStrip(10, 1000, 3100), 'y')).toEqual([4, 4]);
    // Scrolled to 3500: pages 4 and 5 both show.
    expect(visiblePageRange(container, verticalStrip(10, 1000, 3500), 'y')).toEqual([4, 5]);
  });

  it('counts a 1px sliver as a whole page', () => {
    // Viewport 0–800 at scroll 2201: page 3 (2000–3000) shows, page 4 starts at 799.
    expect(visiblePageRange(container, verticalStrip(10, 1000, 2201), 'y')).toEqual([3, 4]);
  });

  it('skips missing and zero-size rects, and returns null when nothing shows', () => {
    // Scrolled to 500: page 1 (-500–500) and page 2 (500–1500) both show; page 1's rect is missing.
    const rects = verticalStrip(3, 1000, 500);
    expect(visiblePageRange(container, [undefined, ...rects.slice(1)], 'y')).toEqual([2, 2]);
    expect(visiblePageRange(container, [], 'y')).toBeNull();
    expect(
      visiblePageRange(container, [{ left: 0, top: 0, width: 1000, height: 0 }], 'y')
    ).toBeNull();
  });

  it('works horizontally', () => {
    const rects = [0, 1, 2].map((i) => ({ left: i * 600 - 300, top: 0, width: 600, height: 800 }));
    expect(visiblePageRange(container, rects, 'x')).toEqual([1, 3]);
  });
});
```

The horizontal case: pages at −300..300, 300..900, 900..1500 against a 0..1000 viewport → all three overlap → `[1, 3]`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/reading-history/describe-view.test.ts src/lib/reader/page-detection.test.ts`
Expected: FAIL — `./describe-view` not found; `visiblePageRange` is not exported.

- [ ] **Step 4: Implement `describeView`**

`src/lib/reading-history/describe-view.ts`:

```ts
import type { ViewDescriptor } from './view-tracker';

export interface ViewInputs {
  volume: string | undefined;
  /** Cumulative chars per page (`buildPageCharCounts(pages).cumulative`). */
  pageCharCumulative: number[];
  /** 1-based current page from progress. */
  page: number;
  continuous: boolean;
  scrollMode: 'vertical' | 'horizontal';
  /** Paged mode: a second page is shown beside `page`. */
  showSecondPage: boolean;
  /** Continuous mode: 1-based inclusive range of pages with any part on screen. */
  continuousRange: [number, number] | null;
  viewport: { w: number; h: number };
}

/**
 * What the reader is showing, as whole pages. Returns null until there are
 * pages to show. A continuous range that no longer contains the current page
 * is stale (mode or volume switched) and is ignored.
 */
export function describeView(inputs: ViewInputs): ViewDescriptor | null {
  const cum = inputs.pageCharCumulative;
  const count = cum.length;
  if (!inputs.volume || count === 0) return null;

  const page = clamp(inputs.page, 1, count);
  let first = page;
  let last = page;
  let layout: ViewDescriptor['layout'];

  if (inputs.continuous) {
    layout = inputs.scrollMode === 'vertical' ? 'continuous-v' : 'continuous-h';
    const range = inputs.continuousRange;
    if (range && range[0] <= page && page <= range[1]) [first, last] = range;
  } else {
    layout = inputs.showSecondPage ? 'double' : 'single';
    if (inputs.showSecondPage) last = page + 1;
  }

  first = clamp(first, 1, count);
  last = clamp(last, first, count);

  const before = (p: number) => (p > 1 ? cum[p - 2] : 0);
  const page_chars: number[] = [];
  for (let p = first; p <= last; p++) page_chars.push(cum[p - 1] - before(p));

  return {
    volume: inputs.volume,
    first_page: first,
    last_page: last,
    page_chars,
    chars_before: before(first),
    layout,
    orientation: inputs.viewport.w > inputs.viewport.h ? 'landscape' : 'portrait',
    viewport: { w: Math.round(inputs.viewport.w), h: Math.round(inputs.viewport.h) }
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
```

- [ ] **Step 5: Implement `visiblePageRange`**

Append to `src/lib/reader/page-detection.ts`:

```ts
/**
 * 1-based inclusive range of pages with ANY part inside the container along
 * `axis` — reading history counts whole pages, so a sliver counts. Null when
 * no page is on screen.
 */
export function visiblePageRange(
  containerRect: RectLike,
  rects: (RectLike | undefined)[],
  axis: 'x' | 'y'
): [number, number] | null {
  const cStart = axis === 'x' ? containerRect.left : containerRect.top;
  const cEnd = cStart + (axis === 'x' ? containerRect.width : containerRect.height);
  let first = -1;
  let last = -1;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    if (!rect) continue;
    const start = axis === 'x' ? rect.left : rect.top;
    const size = axis === 'x' ? rect.width : rect.height;
    if (size <= 0) continue;
    if (Math.min(start + size, cEnd) - Math.max(start, cStart) > 0) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : [first + 1, last + 1];
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/reading-history/describe-view.test.ts src/lib/reader/page-detection.test.ts`
Expected: PASS (all new tests and the existing page-detection tests).

- [ ] **Step 7: Commit** (run the `verify` skill first)

```bash
git add src/lib/reading-history/describe-view.ts src/lib/reading-history/describe-view.test.ts src/lib/reader/page-detection.ts src/lib/reader/page-detection.test.ts
git commit -m "feat(history): describe the on-screen view as whole pages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Record views from the reader, touch the device on start

**Files:**

- Modify: `src/lib/components/Reader/VerticalScrollReader.svelte` (Props ~line 36-57, `reportProgress` ~line 253)
- Modify: `src/lib/components/Reader/HorizontalScrollReader.svelte` (Props ~line 38-58, `reportProgress` ~line 235)
- Modify: `src/lib/components/Reader/Reader.svelte` (imports, state near `pages`/`page` ~line 600-612, `onMount` ~line 464-498, scroll reader props ~line 1613-1640)
- Modify: `src/routes/+layout.svelte` (`onMount` ~line 81-130)

**Interfaces:**

- Consumes: `ViewTracker` (Task 3); `describeView` (Task 4); `visiblePageRange` (Task 4); `recordEvent` (Task 1); `historyDb` (Task 1); `readDeviceEnv`, `detectDeviceFacts`, `touchDeviceRecord` (Task 2); `buildPageCharCounts` from `src/lib/catalog/page-char-counts.ts`.
- Produces: scroll reader prop `onVisibleRangeChange?: (first: number, last: number) => void`.

- [ ] **Step 1: Report the visible range from the vertical reader**

In `VerticalScrollReader.svelte`, add to the `Props` interface (after `onContextMenu?: (data: any) => void;`):

```ts
    /** Pages with any part on screen, 1-based inclusive (reading history). */
    onVisibleRangeChange?: (first: number, last: number) => void;
```

add `onVisibleRangeChange` to the destructuring after `onContextMenu`, add `visiblePageRange` to its import from `$lib/reader/page-detection` (the file already imports `closestPageToCenter` from there), and replace `reportProgress` with:

```ts
let lastReportedRange = '';

function reportProgress() {
  const pageIdx = detectCurrentPage();
  const pageNum = pageIdx + 1;
  if (pageNum !== lastReportedPage) {
    lastReportedPage = pageNum;
    const { charCount } = getCharCount(pages, pageNum);
    onPageChange(pageNum, charCount, pageNum >= pages.length);
  }

  if (onVisibleRangeChange && scrollContainer) {
    const range = visiblePageRange(
      scrollContainer.getBoundingClientRect(),
      pageElements.map((el) => el?.getBoundingClientRect()),
      'y'
    );
    const key = range ? range.join('-') : '';
    if (range && key !== lastReportedRange) {
      lastReportedRange = key;
      onVisibleRangeChange(range[0], range[1]);
    }
  }
}
```

If the existing import line differs, check with `grep -n "page-detection" src/lib/components/Reader/VerticalScrollReader.svelte` and extend that line.

- [ ] **Step 2: Report the visible range from the horizontal reader**

In `HorizontalScrollReader.svelte`, add the same prop declaration and destructuring entry, add `visiblePageRange` to its `$lib/reader/page-detection` import, declare `let lastReportedRange = '';` above `reportProgress`, and append this inside `reportProgress` after the existing `onVisibleCountChange` block:

```ts
if (onVisibleRangeChange && scrollContainer) {
  const range = visiblePageRange(
    scrollContainer.getBoundingClientRect(),
    pageElements.map((el) => el?.getBoundingClientRect()),
    'x'
  );
  const key = range ? range.join('-') : '';
  if (range && key !== lastReportedRange) {
    lastReportedRange = key;
    onVisibleRangeChange(range[0], range[1]);
  }
}
```

- [ ] **Step 3: Feed the tracker from Reader**

In `Reader.svelte` add imports beside the other `$lib` imports:

```ts
import { ViewTracker } from '$lib/reading-history/view-tracker';
import { describeView } from '$lib/reading-history/describe-view';
import { recordEvent } from '$lib/reading-history/record';
import { buildPageCharCounts } from '$lib/catalog/page-char-counts';
```

Directly after `let index = $derived(page - 1);` (~line 609) add:

```ts
// Reading history: one `page` event per view, emitted when the view ends.
// Hidden tab = no view, so a backgrounded reader never accrues dwell.
const viewTracker = new ViewTracker((payload, t) => void recordEvent(payload, t));
let pageHidden = $state(typeof document !== 'undefined' && document.visibilityState === 'hidden');
let continuousRange = $state<[number, number] | null>(null);
let pageCharCumulative = $derived(buildPageCharCounts(pages).cumulative);
```

After the `showSecondPage` and `effectiveScrollMode` declarations exist (place this block right after `let charDisplay = ...` ~line 1112, where both are in scope):

```ts
let currentView = $derived(
  describeView({
    volume: volume?.volume_uuid,
    pageCharCumulative,
    page,
    continuous: !!$settings.continuousScroll,
    scrollMode: effectiveScrollMode === 'horizontal' ? 'horizontal' : 'vertical',
    showSecondPage: showSecondPage(),
    continuousRange,
    viewport: { w: windowWidth, h: windowHeight }
  })
);

$effect(() => {
  viewTracker.setView(pageHidden ? null : currentView, Date.now());
});

// A range from the other scroll mode, or the previous volume, is stale.
$effect(() => {
  void $settings.continuousScroll;
  void effectiveScrollMode;
  void volume?.volume_uuid;
  continuousRange = null;
});
```

`windowWidth`/`windowHeight` already exist in Reader (used by `useSinglePage`); confirm with `grep -n "let windowWidth\|let windowHeight" src/lib/components/Reader/Reader.svelte`. If `effectiveScrollMode` can be values other than `'vertical' | 'horizontal'`, the ternary above maps them to vertical.

In the `onMount` body (the one that sets the timeout duration, ~line 464), before `return () => {`:

```ts
const onVisibility = () => {
  pageHidden = document.visibilityState === 'hidden';
};
const onPageHide = () => viewTracker.close(Date.now());
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('pagehide', onPageHide);
```

and inside its returned cleanup, first lines:

```ts
document.removeEventListener('visibilitychange', onVisibility);
window.removeEventListener('pagehide', onPageHide);
viewTracker.close(Date.now());
```

Pass the range handler to BOTH scroll readers (beside `onPageChange={handleContinuousPageChange}`):

```svelte
onVisibleRangeChange={(first, last) => (continuousRange = [first, last])}
```

- [ ] **Step 4: Touch the device record on app start**

In `src/routes/+layout.svelte`, add imports:

```ts
import { historyDb } from '$lib/reading-history/history-db';
import {
  detectDeviceFacts,
  readDeviceEnv,
  touchDeviceRecord
} from '$lib/reading-history/device-facts';
```

and inside the main `onMount(async () => { ... })`, right after `startThumbnailProcessing();`:

```ts
// Reading history: create/refresh this device's facts. Never blocks start-up.
touchDeviceRecord(historyDb(), detectDeviceFacts(readDeviceEnv()), new Date().toISOString()).catch(
  (error) => console.warn('[reading-history] device record failed:', error)
);
```

- [ ] **Step 5: Type-check and run the reader-adjacent tests**

```bash
npm run check 2>&1 | tail -5
npx vitest run src/lib/components/Reader src/lib/reader src/lib/reading-history 2>&1 | tail -8
```

Expected: no new type errors; all tests pass.

- [ ] **Step 6: Verify in the real app with the `verify` skill**

Invoke the `verify` skill with these checks (use `E2E_PORT` for a free port so another worktree's server isn't reused):

1. Import a synthetic volume, open it in paged single-page mode. Wait ~2 s, turn forward twice (≈2 s apart), then navigate back to the series page.
2. In the page, read the history DB:

```js
await page.evaluate(
  () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open('mokuro_history');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('reading_events', 'readonly');
        const all = tx.objectStore('reading_events').getAll();
        all.onsuccess = () => resolve(all.result);
      };
    })
);
```

Expected: 3 `page` events for the volume with `first_page` 1, 2, 3 in `seq` order, `layout: 'single'`, `dwell_ms` ≈ 2000 for the first two, every `page_chars` entry equal to that page's character count, and the same `device` on all. 3. Switch the volume to double-page mode, turn once: the new event has `last_page = first_page + 1` and `layout: 'double'`. 4. Enable continuous scroll (vertical), scroll by about one page and wait 1 s: events with `layout: 'continuous-v'` and ranges that cover the pages actually on screen. 5. Emulate hiding the tab (`page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); })`): an event is emitted immediately for the open view. 6. `devices` store has exactly one row whose `device` equals the events' `device`.

Record the actual output in the commit message body or the task notes. If any expectation fails, fix and re-run before committing.

- [ ] **Step 7: Commit** (the `verify` run in Step 6 satisfies the harness rule)

```bash
git add src/lib/components/Reader/Reader.svelte src/lib/components/Reader/VerticalScrollReader.svelte src/lib/components/Reader/HorizontalScrollReader.svelte src/routes/+layout.svelte
git commit -m "feat(history): record a page event per reader view; device facts on start

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: adjust / restart / forget events from existing stat edits

**Files:**

- Modify: `src/lib/util/volume-editor.ts` (`updateVolumeStats`, ~line 189)
- Modify: `src/lib/settings/volume-data.ts` (`deleteVolume` ~line 485, `archiveAndResetVolumes` ~line 723)
- Test: `src/lib/reading-history/stat-edit-events.test.ts`

**Interfaces:**

- Consumes: `recordEvent` (Task 1).
- Produces: nothing new; existing functions gain event emission.

- [ ] **Step 1: Write the failing tests**

`src/lib/reading-history/stat-edit-events.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/reading-history/record', () => ({ recordEvent: vi.fn(() => Promise.resolve(null)) }));

import { recordEvent } from '$lib/reading-history/record';
import { updateVolumeStats } from '$lib/util/volume-editor';
import {
  archiveAndResetVolumes,
  deleteVolume,
  updateProgress,
  volumesWithTrash
} from '$lib/settings/volume-data';

const recorded = vi.mocked(recordEvent);

beforeEach(() => {
  volumesWithTrash.set({});
  recorded.mockClear();
});

describe('stat edits record history events', () => {
  it('volume editor: records the time and chars deltas', () => {
    updateVolumeStats('vol-a', { timeReadInMinutes: 30, chars: 1000 });
    updateVolumeStats('vol-a', { timeReadInMinutes: 45, chars: 900 });
    expect(recorded.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'adjust', volume: 'vol-a', time_delta_ms: 30 * 60000, chars_delta: 1000 },
      { kind: 'adjust', volume: 'vol-a', time_delta_ms: 15 * 60000, chars_delta: -100 }
    ]);
  });

  it('volume editor: records nothing when time and chars are unchanged', () => {
    updateVolumeStats('vol-a', { timeReadInMinutes: 10 });
    recorded.mockClear();
    updateVolumeStats('vol-a', { timeReadInMinutes: 10, volume_title: 'Renamed' });
    expect(recorded).not.toHaveBeenCalled();
  });

  it('restart series: one restart per volume actually archived', () => {
    updateProgress('vol-a', 10, 500);
    updateProgress('vol-b', 0, 0);
    recorded.mockClear();
    archiveAndResetVolumes(['vol-a', 'vol-b', 'vol-missing']);
    expect(recorded.mock.calls.map((c) => c[0])).toEqual([{ kind: 'restart', volume: 'vol-a' }]);
  });

  it('forget stats: records forget with the deletion time', () => {
    updateProgress('vol-a', 3, 100);
    recorded.mockClear();
    const before = Date.now();
    deleteVolume('vol-a');
    expect(recorded).toHaveBeenCalledTimes(1);
    const [payload] = recorded.mock.calls[0];
    expect(payload).toMatchObject({ kind: 'forget', volume: 'vol-a' });
    expect((payload as { before: number }).before).toBeGreaterThanOrEqual(before);
  });

  it('forget stats on an unknown volume records nothing', () => {
    deleteVolume('nope');
    expect(recorded).not.toHaveBeenCalled();
  });
});
```

Before running, confirm `volumesWithTrash` is exported from `volume-data.ts` (`grep -n "export const volumesWithTrash" src/lib/settings/volume-data.ts`). If `updateProgress` triggers listeners that need extra mocks in this environment, copy the `vi.mock` lines from an existing test that imports `volume-data` (`grep -rln "settings/volume-data" src --include=*.test.ts | head -3`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/reading-history/stat-edit-events.test.ts`
Expected: FAIL — `recordEvent` never called.

- [ ] **Step 3: Emit `adjust` from the volume editor**

In `src/lib/util/volume-editor.ts` add `import { recordEvent } from '$lib/reading-history/record';` and change `updateVolumeStats` to capture deltas inside the update and record after it:

```ts
export function updateVolumeStats(
  volumeUuid: string,
  updates: {
    progress?: number;
    chars?: number;
    timeReadInMinutes?: number;
    completed?: boolean;
    series_uuid?: string;
    series_title?: string;
    volume_title?: string;
  }
): void {
  let timeDeltaMs = 0;
  let charsDelta = 0;

  volumesWithTrash.update((prev: Volumes) => {
    const currentVolume = prev[volumeUuid] || new VolumeData();
    if (updates.timeReadInMinutes !== undefined) {
      timeDeltaMs = (updates.timeReadInMinutes - currentVolume.timeReadInMinutes) * 60000;
    }
    if (updates.chars !== undefined) {
      charsDelta = updates.chars - currentVolume.chars;
    }

    return {
      // ... the existing returned object, unchanged ...
    };
  });

  // Reading history: the edit is an event, so every device's stats can apply it.
  if (timeDeltaMs !== 0 || charsDelta !== 0) {
    void recordEvent({
      kind: 'adjust',
      volume: volumeUuid,
      time_delta_ms: timeDeltaMs,
      chars_delta: charsDelta
    });
  }
}
```

Keep the existing `return { ...prev, [volumeUuid]: new VolumeData({...}) }` body exactly as it is; only the two `if` blocks before it and the trailing `recordEvent` block are new.

- [ ] **Step 4: Emit `forget` and `restart` in volume-data**

In `src/lib/settings/volume-data.ts` add `import { recordEvent } from '$lib/reading-history/record';`.

In `deleteVolume`, track whether a tombstone was written and record after the update:

```ts
export function deleteVolume(volume: string) {
  let forgotten = false;
  _volumesInternal.update((prev) => {
    const existing = prev[volume];
    if (!existing) return prev; // Already gone or never existed
    forgotten = true;
    // ... existing tombstone code, unchanged ...
  });
  if (forgotten) void recordEvent({ kind: 'forget', volume, before: Date.now() });
}
```

In `archiveAndResetVolumes`, collect archived UUIDs and record after the update:

```ts
export function archiveAndResetVolumes(volumeUuids: string[]) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const archived: string[] = [];
  _volumesInternal.update((prev) => {
    const updated = { ...prev };
    for (const uuid of volumeUuids) {
      const existing = updated[uuid];
      if (!existing || existing.deletedOn) continue;
      if (existing.progress <= 0 && !existing.completed) continue;
      archived.push(uuid);
      updated[uuid] = new VolumeData({
        // ... existing body, unchanged ...
      });
    }
    return updated;
  });
  for (const uuid of archived) void recordEvent({ kind: 'restart', volume: uuid }, now);
}
```

Match the actual body of each function when editing (read it first); only the `forgotten` / `archived` bookkeeping and the trailing `recordEvent` lines are new.

- [ ] **Step 5: Run the new and existing tests**

```bash
npx vitest run src/lib/reading-history/stat-edit-events.test.ts
npx vitest run src/lib/settings src/lib/util 2>&1 | tail -6
```

Expected: the new tests pass; no existing test regresses.

- [ ] **Step 6: Commit** (run the `verify` skill first)

```bash
git add src/lib/util/volume-editor.ts src/lib/settings/volume-data.ts src/lib/reading-history/stat-edit-events.test.ts
git commit -m "feat(history): record adjust/restart/forget events from stat edits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Full suite and docs

**Files:**

- Modify: `CLAUDE.md` (add a subsection after the "Database Schema (V3)" section's table/notes)

- [ ] **Step 1: Run everything**

```bash
npm test -- --run 2>&1 | tail -8
npm run check 2>&1 | tail -5
npm run lint 2>&1 | tail -8
```

Expected: all pass. Read the whole test output for failures before summarising (count them, don't trust the tail alone). Any failure that also fails on `origin/develop` is pre-existing: note it, don't fix it here.

- [ ] **Step 2: Document the history DB in `CLAUDE.md`**

Add this subsection directly before `### Settings Architecture`:

```markdown
### Reading history (`mokuro_history`)

A SEPARATE Dexie database (`src/lib/reading-history/`, spec
`docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md`), never
tables in `mokuro_v3`. Every event is permanent and keyed `[device+seq]`:
`device` is this install's random ID and `seq` is allocated inside the same
IndexedDB rw transaction as the write (`appendEvent`), so two tabs never
collide. Kinds: `page` (one per reader VIEW — whole pages on screen, raw
uncapped `dwell_ms`, emitted when the view ends via `ViewTracker`; a hidden
tab has no view), `adjust` (volume editor time/chars edits), `restart`
("restart series"), `forget` (delete stats). Record through `recordEvent`,
which never throws. Phase 1 only writes: nothing reads the events yet, and
`recentPageTurns`/`timeReadInMinutes` still drive every stat.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: reading history DB in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
