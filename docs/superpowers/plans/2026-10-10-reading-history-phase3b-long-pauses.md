# Reading History Phase 3b — Long-Pause Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a page stays open past its idle cap, ask the user right then how to count it; every answer is a synced `resolve` event, unanswered pauses go to a review list (typical, provisional), "Still reading" widens the synced cutoff, and a standing default stops the prompts.

**Architecture:** A new `resolve` event kind (codec kind 5, format 1) targets a `page` event by `[device, seq]`; the stats engine applies the latest answer per target (`countedDwell`) and lists pauses. In the reader, `PauseWatch` arms a timer for the open view's cap and raises `LongPausePrompt`; a live answer splits the view (page + resolve written in one transaction, a continuation view opens). The review list (`LongPausesCard`) and the standing default (`tracking.pauses`, `LongPauseSetting`) live on the reading-speed page and in reader settings.

**Tech Stack:** SvelteKit 5 (runes), Dexie 4 (`mokuro_history`), Vitest + jsdom + fake-indexeddb, @testing-library/svelte, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md` (Events table; "Speed and stats" → "Long pauses: ask at the timeout"; "Decided" item 1).

## Global Constraints

- Long pauses: prompt **at the timeout itself**, staying up until answered; "Still reading" counts the time and widens the cutoff (synced) so it stops recurring; away → count all / typical / none on return; unanswered → review list, typical while provisional; "don't ask again" only after a few answers.
- Every answer is a `resolve` event, so it syncs, every device applies it, and it can be changed later from the review list.
- Legacy data converted from `recentPageTurns` is never prompted for.
- Nothing is ever edited or deleted in the event log.
- Never mention the third-party public deployment's domain anywhere (code, comments, commits, PRs).
- Modal action rows carry `relative z-10`; status UIs update in place with no layout motion.

## Rulings adopted for this plan (owner may revisit)

- O1 Legacy views over their cap keep the 3a rule (count 0, not typical) — counting typical could lift pre-history above the frozen `legacyStats` snapshot. The spec line saying "typical" is corrected in Task 8.
- O2 The `resolve` payload also carries `volume` (every consumer keys events by volume).
- O3 The standing default applies only to views that reach their cap after it is set (written when the view ends); pauses already listed stay provisional.
- O4 The floor is fixed; `widenedK` returns null when widening cannot lengthen this view's cap.
- O5 A live answer splits the view: the paused view and its resolve are written in one rw transaction, and a continuation view of the same pages opens at the answer time.
- O6 `k` shares the `idle` entry's stamp in `tracking`.
- O7 `WIDEN_HEADROOM` 1.5, `AWAY_AFTER_MS` 2 min, `DONT_ASK_AFTER` 3 (derived: answered pauses across all volumes and devices), `k` in half steps, `K_MAX` 20.
- O8 `resolve` is kind 5 inside segment format 1 (the codec has not been released).

## Corrections (binding — apply over the task text below)

These came from the cross-task review of the drafts; where a task's text disagrees, this section wins.

1. **Task 5** depends on Task 4: its test helper returns `{ view: view(first, extra), since, answer: null }`; run after Task 4.
2. **Task 6 Step 5** (`pause-answer.test.ts`): `const open: OpenView = { since: 0, answer: null, view: {...} }`.
3. **Task 6 PauseWatch wiring** uses Task 5's signature `constructor(onCap, onClear?, timers?, now?)`: construct `new PauseWatch(onCap, () => { livePause.set(null); viewTracker.setAnswer(null); })`. Drop `pauseOutgrown` everywhere (Step 5 describe + import, Step 7 code); the `$effect` body is only `pauseWatch.update($liveView, $readingStats.pace, $readingStats.idle);`. Step 8 expects 7 tests.
4. **Task 6: one source of truth for the live answer** — `OpenView.answer` (Task 4). Drop the `liveAnswer` store and its test (Steps 1/3); Step 13 uses `liveMinutes(counted, open, now, cap, typical, open?.answer ?? null)` and `now - open.since > cap && open.answer !== 'full'`; Step 14's `onChange` is `(open) => { liveView.set(open); if (!open || open.since !== get(livePause)?.since) livePause.set(null); }` and `onCap` does not set `liveAnswer`; drop `liveAnswer.set(null)` from cleanup. Step 4 expects 4 tests.
5. **Task 2 Step 7 `widenedK`** keeps half steps at the ceiling: `const reach = Math.ceil((CEILING_MS / expected) * 2) / 2; const next = Math.min(K_MAX, reach, fit);`.
6. **Task 6 Notes:** drop the note that Task 2 must implement O4 beyond the formula (it already returns null unless the widened cap is longer).
7. **Task 8 Notes:** drop the "timer defaults will crash" conflict note (Task 5 already late-binds timers); keep its test 4 as a regression guard.
8. **Task 4 `setAnswer` accepts null:** `setAnswer(count: PauseCount | null, now = Date.now())`; body `if (!this.open) return; if (count === null && this.open.answer === null) return; this.open.answer = count === null ? null : { count, t: now }; this.onChange?.({ view: this.open.view, since: this.open.since, answer: count });`. Add test "setAnswer(null) withdraws a preset; the view ends unanswered": `setView(v1,0)`, `setAnswer('none',100)`, `setAnswer(null,200)`, `setView(v2,900)` → `emitted[0].answer` is `null`.
9. **Task 2 Notes:** Timer passes `open.answer` (Task 4) as the answer argument of `countedDwell`.

## Review Focus

1. **Split pair in the engine** — a paused view answered, then a short continuation of the same pages in the same pass: chars credited once, the continuation a harmless skip with `skippedChars` 0, only the paused view in `pauses`. Owner: Task 2 (add the test).
2. **Prompt taken down when the view ends without a page turn** — hidden tab, Timer pause click, leaving the reader then opening another volume (module-level `livePause` must not leak); each leaves a provisional pause. Owner: Task 8 (e2e steps) + Task 6 (clear on unmount).
3. **Standing default set at the cap, then the cap grows past the time so far** — the preset is withdrawn (`onClear` → `setAnswer(null)`) and re-applied if the cap is reached again. Owner: Task 4 (unit) + Task 6 (wiring).
4. **Timer under a preset answer** — with a standing `'full'` default it keeps counting and stays Active past the cap; unanswered it shows Idle and never steps back. Owner: Task 6 (Timer component test).
5. **Resolve aimed at an earlier pass (after `restart`), or newer than a `forget` whose target was forgotten** — the first changes time only, page credit unchanged; the second matches nothing. Owner: Task 2.

## Task order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 (Task 3 needs 1–2; Tasks 4–5 need 1, 5 also needs 4; Task 6 needs 1–5; Task 7 needs 1–3; Task 8 needs all).

---

### Task 1: `resolve` event type, codec kind 5, and atomic view recording

**Files:**

- Modify: `src/lib/reading-history/types.ts:66-71` (add `PauseCount` and `ResolvePayload`, extend `EventPayload`)
- Modify: `src/lib/reading-history/segment-codec.ts`. Touch points: `:2` import, `:10-21` header comment, `:54` tables, `:69-79` volume dictionary, `:118-120` encoder switch, `:132` JSON body, `:165-166` header check, `:218-223` decoder switch, `:249` helpers
- Modify: `src/lib/reading-history/record.ts`. Touch points: `:3` import, `:22-45` `appendEvent`, `:79-87` `recordEvent`
- Test: `src/lib/reading-history/segment-codec.test.ts` (after `:49`, inside the malformed-cells block after `:150`, before the final `});` at `:231`)
- Test: `src/lib/reading-history/record.test.ts` (`:4-5` imports, append after `:96`)
- No change needed in `src/lib/reading-history/history-sync.ts`. `importOne` (`:171-257`) never switches on event kind. It delegates to `decodeSegment` and compares events with `canonical()` (`:414`), which already recurses into arrays, so `target` tuples compare correctly.

**Interfaces:**

- Consumes: `HistoryDexie` (`history-db.ts`: `history_meta`, `reading_events: Table<ReadingEvent,[string,number]>`); `getOrCreateDeviceId`, `notifyEventsRecorded`, `warnOnce`, `NEXT_SEQ_KEY` (`record.ts`); `legacyDeviceFor` (`paths.ts`).
- Produces (`types.ts`):
  ```ts
  export type PauseCount = 'full' | 'typical' | 'none';
  export interface ResolvePayload {
    kind: 'resolve';
    volume: string;
    target: [device: string, seq: number];
    count: PauseCount;
  }
  export type EventPayload =
    | PagePayload
    | AdjustPayload
    | RestartPayload
    | ForgetPayload
    | PositionPayload
    | ResolvePayload;
  ```
- Produces (`record.ts`), exactly as in the design:
  ```ts
  export async function appendView(
    db: HistoryDexie,
    page: PagePayload,
    t: number,
    answer: { count: PauseCount; t: number } | null
  ): Promise<ReadingEvent[]>;
  export function recordView(
    page: PagePayload,
    t: number,
    answer: { count: PauseCount; t: number } | null,
    db?: HistoryDexie
  ): Promise<ReadingEvent[] | null>;
  export function recordResolve(
    volume: string,
    target: [device: string, seq: number],
    count: PauseCount,
    t?: number /* = Date.now() */,
    db?: HistoryDexie
  ): Promise<ReadingEvent | null>;
  ```
  The seq allocator the design calls `nextSeq()` is named `takeSeqs(db, count)` here. It is private, and it reserves `count` consecutive seqs because `appendView` needs two.
- Produces (codec wire format, format stays 1):
  - New row: `[5, dSeq, dT, vol, targetDeviceIdx, targetSeq, countIdx]`.
  - Optional header dictionary `targets: string[]`, written only when the segment holds a resolve. The key order is `…count, volumes, targets, rows`.
  - `COUNTS = ['full','typical','none']`.
  - New decode errors: `'unknown target device'`, `'target seq must be positive'`, `'unknown pause answer'`, `'resolve in a legacy segment'`, and `'malformed segment header'` when `targets` is not a list of strings.

- [ ] **Step 1: Write the failing codec tests**

In `src/lib/reading-history/segment-codec.test.ts`, insert this directly after the shared `events` array (after line 49, `];`):

```ts
/** The JSON inside a segment, to check what the encoder wrote. */
async function inflate(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const stream = new Blob([new Uint8Array(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(stream).text());
}
```

Inside `describe('rejects decodable files with malformed cells', …)`, directly after the existing `it.each([...])('%s', …)` (after line 150, before that describe's closing `});`), add:

```ts
it.each([
  [
    'a resolve without a target dictionary',
    { rows: [[5, 1, T, 0, 0, 7, 0]] },
    /unknown target device/
  ],
  [
    'an unknown target device index',
    { targets: ['dev-b'], rows: [[5, 1, T, 0, 1, 7, 0]] },
    /unknown target device/
  ],
  [
    'an empty target device',
    { targets: [''], rows: [[5, 1, T, 0, 0, 7, 0]] },
    /unknown target device/
  ],
  [
    'a string target device index',
    { targets: ['dev-b'], rows: [[5, 1, T, 0, '0', 7, 0]] },
    /malformed integer cell/
  ],
  [
    'a target dictionary that is not a list of strings',
    { targets: [7], rows: [[5, 1, T, 0, 0, 7, 0]] },
    /malformed segment header/
  ],
  ['a target seq of 0', { targets: ['dev-b'], rows: [[5, 1, T, 0, 0, 0, 0]] }, /target seq/],
  ['pause answer 3', { targets: ['dev-b'], rows: [[5, 1, T, 0, 0, 7, 3]] }, /unknown pause answer/],
  [
    'a resolve in a legacy segment',
    { legacy: true, targets: ['dev-b'], rows: [[5, 1, T, 0, 0, 7, 0]] },
    /resolve in a legacy segment/
  ]
])('%s', async (_label, body, message) => {
  const error = await decodeSegment(await raw(body)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SegmentFormatError);
  expect(String((error as Error).message)).toMatch(message);
});
```

At the end of the file, inside `describe('segment codec', …)` and after the `'round-trips position answers (jump, stay, reset)'` test (before the final `});`), add:

```ts
describe('resolve (kind 5)', () => {
  const resolves: ReadingEvent[] = [
    {
      device: DEV,
      seq: 7,
      t: T,
      kind: 'resolve',
      volume: 'vol-1',
      target: [DEV, 6],
      count: 'full'
    },
    {
      device: DEV,
      seq: 8,
      t: T + 1,
      kind: 'resolve',
      volume: 'vol-2',
      target: ['dev-b', 41],
      count: 'typical'
    },
    {
      device: DEV,
      seq: 9,
      t: T + 2,
      kind: 'resolve',
      volume: 'vol-1',
      target: ['dev-b', 3],
      count: 'none'
    }
  ];

  it('round-trips answers aimed at this device and at another (full, typical, none)', async () => {
    const bytes = await encodeSegment(DEV, '2026-10', resolves);
    const { header, events: out } = await decodeSegment(bytes);
    expect(header).toEqual({
      format: 1,
      device: DEV,
      month: '2026-10',
      first_seq: 7,
      last_seq: 9,
      count: 3
    });
    expect(out).toEqual(resolves);
  });

  it('round-trips a resolve beside the page it answers', async () => {
    const both = [...events, { ...resolves[0], seq: 11, target: [DEV, 5] as [string, number] }];
    const { events: out } = await decodeSegment(await encodeSegment(DEV, '2026-10', both));
    expect(out).toEqual(both);
  });

  it('writes a target dictionary only when the segment holds a resolve', async () => {
    const plain = await inflate(await encodeSegment(DEV, '2026-10', events));
    expect(plain).not.toHaveProperty('targets');
    expect(Object.keys(plain)).toEqual([
      'format',
      'device',
      'month',
      'first_seq',
      'last_seq',
      'count',
      'volumes',
      'rows'
    ]);
    const answered = await inflate(await encodeSegment(DEV, '2026-10', resolves));
    expect(answered.targets).toEqual([DEV, 'dev-b']);
    expect(answered.rows).toEqual([
      [5, 7, T, 0, 0, 6, 0],
      [5, 1, 1, 1, 1, 41, 1],
      [5, 1, 1, 0, 1, 3, 2]
    ]);
  });

  it('refuses a resolve in a legacy segment', async () => {
    await expect(encodeSegment(DEV, 'legacy', [resolves[0]], { legacy: true })).rejects.toThrow(
      SegmentFormatError
    );
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/reading-history/segment-codec.test.ts`

Expected: FAIL, with 11 tests failing and 18 passing.

- The 8 new malformed-cell rows fail with `expected 'unknown event kind 5' to match /…/`.
- The two round-trips fail with `malformed row`, because the encoder's switch returns `undefined` for `resolve` and JSON writes `null`.
- The dictionary test fails with `expected undefined to deeply equal [ 'dev-a', 'dev-b' ]`.
- `refuses a resolve in a legacy segment` already passes, because the owner check at `:85-90` throws. It is kept as a guard.

- [ ] **Step 3: Implement the type and the codec**

In `src/lib/reading-history/types.ts`, replace lines 66-71:

```ts
export type EventPayload =
  | PagePayload
  | AdjustPayload
  | RestartPayload
  | ForgetPayload
  | PositionPayload;
```

with:

```ts
/** How a long pause counts: all of it, the typical time for its pages, or none. */
export type PauseCount = 'full' | 'typical' | 'none';

/**
 * The user's answer about a long pause on one `page` event (phase 3b). The
 * latest answer per target wins (stats engine). `volume` is the target's
 * volume, denormalised so that every per-volume path (stores, the codec's
 * volume dictionary, the `volume` index) carries this kind unchanged.
 */
export interface ResolvePayload {
  kind: 'resolve';
  volume: string;
  target: [device: string, seq: number];
  count: PauseCount;
}

export type EventPayload =
  | PagePayload
  | AdjustPayload
  | RestartPayload
  | ForgetPayload
  | PositionPayload
  | ResolvePayload;
```

In `src/lib/reading-history/segment-codec.ts`, make the following edits.

Line 2. Before:

```ts
import type { EventPayload, Layout, Orientation, PositionPayload, ReadingEvent } from './types';
```

After:

```ts
import type {
  EventPayload,
  Layout,
  Orientation,
  PauseCount,
  PositionPayload,
  ReadingEvent
} from './types';
```

Lines 15-21. Before:

```ts
 *   4 position [4, dSeq, dT, vol, answer (0 jump, 1 stay, 2 reset), through, page]
 *
 * A new event kind or field AFTER a release is a new `format`; a reader refuses
 * formats it does not know (the importer keeps the old stamp, so an updated app
 * retries). Format 1 was settled before any release read segments, `position`
 * (kind 4) included.
 */
```

After:

```ts
 *   4 position [4, dSeq, dT, vol, answer (0 jump, 1 stay, 2 reset), through, page]
 *   5 resolve [5, dSeq, dT, vol, target device, target seq, count (0 full, 1 typical, 2 none)]
 *
 * `target device` indexes a second dictionary, `targets`, written only when
 * the segment holds a resolve (so a segment without one keeps its bytes).
 * Resolves live in month segments only: a legacy device never answers.
 *
 * A new event kind or field AFTER a release is a new `format`; a reader refuses
 * formats it does not know (the importer keeps the old stamp, so an updated app
 * retries). Format 1 was settled before any release read segments, `position`
 * (kind 4) and `resolve` (kind 5) included.
 */
```

After line 54 (`const ANSWERS …`), add:

```ts
const COUNTS: PauseCount[] = ['full', 'typical', 'none'];
```

Lines 69-79. Before:

```ts
const volumes: string[] = [];
const volIndex = new Map<string, number>();
const vol = (v: string) => {
  let i = volIndex.get(v);
  if (i === undefined) {
    i = volumes.length;
    volumes.push(v);
    volIndex.set(v, i);
  }
  return i;
};
```

After:

```ts
const volumes = dictionary();
const targets = dictionary();
const vol = volumes.index;
```

Encoder switch, lines 118-120. Before:

```ts
      case 'position':
        return [4, ...head, vol(e.volume), ANSWERS.indexOf(e.answer), e.through, e.page];
    }
```

After:

```ts
      case 'position':
        return [4, ...head, vol(e.volume), ANSWERS.indexOf(e.answer), e.through, e.page];
      case 'resolve':
        return [
          5,
          ...head,
          vol(e.volume),
          targets.index(e.target[0]),
          e.target[1],
          COUNTS.indexOf(e.count)
        ];
    }
```

Line 132. Before:

```ts
const json = JSON.stringify({ ...header, volumes, rows });
```

After:

```ts
const json = JSON.stringify({
  ...header,
  volumes: volumes.values,
  ...(targets.values.length > 0 && { targets: targets.values }),
  rows
});
```

After the header check (after line 166, the `}` closing `throw new SegmentFormatError('malformed segment header');`), before `const legacy = parsed.legacy === true;`, add:

```ts
const targets: string[] = parsed.targets === undefined ? [] : parsed.targets;
if (!Array.isArray(targets) || targets.some((d) => typeof d !== 'string')) {
  throw new SegmentFormatError('malformed segment header');
}
```

Decoder switch, after the `case 4: { … }` block (line 223) and before `default:`, add:

```ts
      case 5: {
        if (legacy) throw new SegmentFormatError('resolve in a legacy segment');
        const targetDevice = targets[int(row[4])];
        if (!targetDevice) throw new SegmentFormatError('unknown target device');
        const targetSeq = int(row[5]);
        if (targetSeq <= 0) throw new SegmentFormatError('target seq must be positive');
        const count = COUNTS[int(row[6])];
        if (!count) throw new SegmentFormatError('unknown pause answer');
        payload = { kind: 'resolve', volume, target: [targetDevice, targetSeq], count };
        break;
      }
```

Directly before `function num(value: unknown): number {` (line 249), add:

```ts
/** A string table for a segment's header: each distinct value once, rows hold its index. */
function dictionary(): { values: string[]; index: (value: string) => number } {
  const values: string[] = [];
  const indices = new Map<string, number>();
  return {
    values,
    index(value) {
      let i = indices.get(value);
      if (i === undefined) {
        i = values.length;
        values.push(value);
        indices.set(value, i);
      }
      return i;
    }
  };
}
```

`Row` (`:56`) stays `Array<number | number[]>`, because the target device is a dictionary index and not a string cell.

- [ ] **Step 4: Run it**

Run: `npx vitest run src/lib/reading-history/segment-codec.test.ts`

Expected: PASS (29 tests). The existing `'round-trips every event kind exactly, in seq order'` header assertion is unchanged, because the decoded `SegmentHeader` never carries `targets`.

- [ ] **Step 5: Write the failing recording tests**

In `src/lib/reading-history/record.test.ts`, replace lines 4-5:

```ts
import { _resetRecordWarning, appendEvent, getOrCreateDeviceId, recordEvent } from './record';
import type { PagePayload } from './types';
```

with:

```ts
import {
  _resetRecordWarning,
  appendEvent,
  appendView,
  getOrCreateDeviceId,
  onEventsRecorded,
  recordEvent,
  recordResolve,
  recordView
} from './record';
import type { PagePayload, ReadingEvent } from './types';
```

Append at the end of the file:

```ts
describe('appendView', () => {
  it('stores the page and the answer aimed at it under consecutive seqs, heard once', async () => {
    const db = freshDb();
    await appendEvent(db, page(1), 50);
    const heard: ReadingEvent[][] = [];
    const off = onEventsRecorded((events) => heard.push(events));
    const out = await appendView(db, page(2), 100, { count: 'typical', t: 400 });
    off();
    const device = await getOrCreateDeviceId(db);
    expect(out).toEqual([
      { ...page(2), device, seq: 2, t: 100 },
      {
        kind: 'resolve',
        volume: 'vol-1',
        target: [device, 2],
        count: 'typical',
        device,
        seq: 3,
        t: 400
      }
    ]);
    expect(heard).toEqual([out]);
    expect(
      await db.reading_events.bulkGet([
        [device, 2],
        [device, 3]
      ])
    ).toEqual(out);
    expect((await appendEvent(db, page(3), 500)).seq).toBe(4);
  });

  it('stores only the page when the view was not answered', async () => {
    const db = freshDb();
    const out = await appendView(db, page(1), 100, null);
    expect(out.map((e) => [e.kind, e.seq])).toEqual([['page', 1]]);
    expect(await db.reading_events.count()).toBe(1);
    expect((await appendEvent(db, page(2), 200)).seq).toBe(2);
  });

  it('stores neither event when the answer cannot be stored', async () => {
    const db = freshDb();
    const device = await getOrCreateDeviceId(db);
    // A row already sits where the answer would go, so the transaction aborts.
    await db.reading_events.add({ ...page(9), device, seq: 2, t: 1 });
    await expect(appendView(db, page(1), 100, { count: 'none', t: 200 })).rejects.toThrow();
    expect(await db.reading_events.get([device, 1])).toBeUndefined();
    expect((await appendEvent(db, page(3), 300)).seq).toBe(1);
  });

  it('never shares a seq with concurrent appends on another connection', async () => {
    const name = `history_test_${n++}`;
    const a = freshDb(name);
    const b = freshDb(name);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 2
          ? appendView(a, page(i + 1), i, { count: 'full', t: i + 1 })
          : appendEvent(b, page(i + 1), i).then((e) => [e])
      )
    );
    const seqs = results
      .flat()
      .map((e) => e.seq)
      .sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    for (const [view, answer] of results.filter((r) => r.length === 2)) {
      expect(answer).toMatchObject({ kind: 'resolve', seq: view.seq + 1 });
      expect(answer).toMatchObject({ target: [view.device, view.seq] });
    }
  });
});

describe('recordView', () => {
  it('writes the view and its answer through to the given database', async () => {
    const db = freshDb();
    const out = await recordView(page(1), 100, { count: 'full', t: 300 }, db);
    expect(out?.map((e) => [e.kind, e.seq])).toEqual([
      ['page', 1],
      ['resolve', 2]
    ]);
  });

  it('writes only the page for an unanswered view', async () => {
    const db = freshDb();
    const out = await recordView(page(1), 100, null, db);
    expect(out?.map((e) => e.kind)).toEqual(['page']);
    expect(await db.reading_events.count()).toBe(1);
  });

  it('swallows a failing database, sharing the once-per-session warning', async () => {
    _resetRecordWarning();
    const db = freshDb();
    vi.spyOn(db, 'transaction').mockImplementation((() =>
      Promise.reject(new Error('QuotaExceededError'))) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordView(page(1), 1, { count: 'none', t: 2 }, db)).resolves.toBeNull();
    await expect(recordEvent(page(2), 3, db)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('recordResolve', () => {
  it('records an answer aimed at a page of any device (the review list)', async () => {
    const db = freshDb();
    const e = await recordResolve('vol-1', ['dev-b', 41], 'none', 700, db);
    expect(e).toMatchObject({
      kind: 'resolve',
      volume: 'vol-1',
      target: ['dev-b', 41],
      count: 'none',
      seq: 1,
      t: 700
    });
    expect(await db.reading_events.get([e!.device, 1])).toEqual(e);
  });
});
```

- [ ] **Step 6: Run it**

Run: `npx vitest run src/lib/reading-history/record.test.ts`

Expected: FAIL. The 8 new tests fail with `TypeError: (0 , appendView) is not a function` (and the same for `recordView` and `recordResolve`). The 6 existing tests pass.

- [ ] **Step 7: Implement atomic recording**

In `src/lib/reading-history/record.ts`, replace line 3:

```ts
import type { EventPayload, ReadingEvent } from './types';
```

with:

```ts
import type { EventPayload, PagePayload, PauseCount, ReadingEvent } from './types';
```

Replace lines 22-45, the whole `appendEvent` with its doc comment, with:

```ts
/**
 * This device and the first of `count` consecutive fresh seqs. Call it inside
 * the caller's rw transaction over `history_meta` and `reading_events`: the
 * counter is read and advanced in the same transaction as the writes, and
 * IndexedDB serialises rw transactions on a store across every connection, so
 * two tabs of one device can never hand out the same `seq`.
 */
async function takeSeqs(db: HistoryDexie, count: number): Promise<{ device: string; seq: number }> {
  const device = await getOrCreateDeviceId(db);
  const next = await db.history_meta.get(NEXT_SEQ_KEY);
  const seq = typeof next?.value === 'number' ? next.value : 1;
  await db.history_meta.put({ key: NEXT_SEQ_KEY, value: seq + count });
  return { device, seq };
}

/** Store one event under this device's next `seq`. */
export async function appendEvent(
  db: HistoryDexie,
  payload: EventPayload,
  t: number
): Promise<ReadingEvent> {
  const event = await db.transaction('rw', db.history_meta, db.reading_events, async () => {
    const { device, seq } = await takeSeqs(db, 1);
    const stored = { ...payload, device, seq, t } as ReadingEvent;
    await db.reading_events.add(stored);
    return stored;
  });
  // After the commit: listeners only ever hear about durable events.
  notifyEventsRecorded([event]);
  return event;
}

/**
 * Store a finished view: its `page` event under seq n and, when the user
 * answered its long pause, a `resolve` under n+1 aimed at it. One rw
 * transaction, so a page is never stored without the answer given for it.
 */
export async function appendView(
  db: HistoryDexie,
  page: PagePayload,
  t: number,
  answer: { count: PauseCount; t: number } | null
): Promise<ReadingEvent[]> {
  const events = await db.transaction('rw', db.history_meta, db.reading_events, async () => {
    const { device, seq } = await takeSeqs(db, answer ? 2 : 1);
    const stored: ReadingEvent[] = [{ ...page, device, seq, t }];
    if (answer) {
      stored.push({
        kind: 'resolve',
        volume: page.volume,
        target: [device, seq],
        count: answer.count,
        device,
        seq: seq + 1,
        t: answer.t
      });
    }
    await db.reading_events.bulkAdd(stored);
    return stored;
  });
  notifyEventsRecorded(events);
  return events;
}
```

In `recordEvent`, replace its last two body lines (`:85-86`):

```ts
  const target = db ? Promise.resolve(db) : import('./history-db').then((m) => m.historyDb());
  return target.then((resolved) => appendEvent(resolved, payload, t)).catch(warnOnce);
}
```

with:

```ts
  return historyFor(db)
    .then((resolved) => appendEvent(resolved, payload, t))
    .catch(warnOnce);
}

/** `recordEvent` for a finished view and its answer (`appendView`): never throws. */
export function recordView(
  page: PagePayload,
  t: number,
  answer: { count: PauseCount; t: number } | null,
  db?: HistoryDexie
): Promise<ReadingEvent[] | null> {
  if (!db && typeof indexedDB === 'undefined') return Promise.resolve(null);
  return historyFor(db)
    .then((resolved) => appendView(resolved, page, t, answer))
    .catch(warnOnce);
}

/** An answer given after the view ended (the review list): never throws. */
export function recordResolve(
  volume: string,
  target: [device: string, seq: number],
  count: PauseCount,
  t: number = Date.now(),
  db?: HistoryDexie
): Promise<ReadingEvent | null> {
  return recordEvent({ kind: 'resolve', volume, target, count }, t, db);
}

function historyFor(db?: HistoryDexie): Promise<HistoryDexie> {
  return db ? Promise.resolve(db) : import('./history-db').then((m) => m.historyDb());
}
```

The `history-db` import stays lazy and type-only at the top, so `record.import.test.ts` (`vi.mock('dexie', () => ({}))`) still loads the module.

- [ ] **Step 8: Run it**

Run: `npx vitest run src/lib/reading-history/record.test.ts src/lib/reading-history/record.import.test.ts`

Expected: PASS (14 + 1 tests).

- [ ] **Step 9: Regression and type check**

Run: `npx vitest run src/lib/reading-history/ && npx prettier --check src/lib/reading-history/{types,segment-codec,record}.ts src/lib/reading-history/{segment-codec,record}.test.ts && npm run check`

Expected:

- PASS: 20 files and 217 tests in `src/lib/reading-history/`.
- prettier: "All matched files use Prettier code style!"
- svelte-check: `0 errors`.

Engine consumers (`stats-engine.ts`, `project-turns.ts`, `position-offer.ts`, `turns-store.ts`) filter by `kind` and ignore `resolve` until Task 2.

- [ ] **Step 10: Commit**

```bash
git add src/lib/reading-history/types.ts src/lib/reading-history/segment-codec.ts src/lib/reading-history/segment-codec.test.ts src/lib/reading-history/record.ts src/lib/reading-history/record.test.ts
git commit -m "$(cat <<'EOF'
feat(history): resolve events — codec kind 5, view and answer in one transaction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Notes for the plan author

- **Verified, not just drafted.** I applied every edit above to a scratch copy of the worktree, not to the repo: `/tmp/claude-1000/-home-nathan-Projects-mokuro-reader/6f65961f-f765-436a-a0b9-aa680120300c/scratchpad/t1copy`.
  - RED counts were as stated: codec 11 failing, record 8 failing.
  - GREEN: all 217 tests in `reading-history/` passed, `svelte-check` reported 0 errors, and prettier had been applied.
  - eslint shows only the 2 existing `no-explicit-any` warnings in `segment-codec.ts` (`parsed: any`, `row: any[]`).
- **Name change from the design.** The design's private `nextSeq()` became `takeSeqs(db, count)`, because `appendView` reserves two seqs in one counter write. It is private, so no other task sees it.
- **Added beyond the design.** The decoder also rejects a resolve row inside a `legacy` segment (`'resolve in a legacy segment'`). The design only says the encoder refuses them. The decoder check is what keeps a crafted legacy file from minting `legacy:*`-device resolves.
- **No change to `history-sync.ts`.** It has no per-kind validation. The `targets` header key needs no sync change because the decoder strips it from the returned `SegmentHeader`.
- **`resolve.t` is the answer time, not the page's `t`.** For a split (O5), the page is written at `t = since` and the resolve at `t = now`, so the two can land in different month segments. That is harmless, since each segment holds events by their own `t`. Task 2's latest-wins rule (by `byTime`) relies on this `t`.
- **Assumptions about other tasks.**
  - Task 4/6 wire `ViewTracker.emit` to `(p, t, a) => void recordView(p, t, a)` using the inline answer type `{ count: PauseCount; t: number } | null`. No named alias was introduced, to match the design. If Task 4 wants one, export `ViewAnswer` from `types.ts` and use it in `record.ts`.
  - Task 7's review card calls `recordResolve(volume, [device, seq], count)`, which defaults to `t = Date.now()`.
  - `PauseCount` is imported from `$lib/reading-history/types` by Tasks 2, 3, 4 and 6. `tracking-data.ts` (Task 3) should import that same type rather than redeclare it.
- **`recordView` returns `ReadingEvent[] | null`.** Callers fire and forget it, as with `recordEvent`. `notifyEventsRecorded` fires once with both events, so `turns-store` re-prepares the volume once per answered view.

---

### Task 2: Engine applies pause answers, lists pauses, computes `widenedK`

**Files:**

- Modify: `src/lib/reading-history/stats-engine.ts`
  - line 3: the type import
  - lines 11-15: the header comment
  - after line 34: new constants `K_MAX` and `WIDEN_HEADROOM`
  - lines 49-61: `PreparedView`
  - lines 71-95: new `Pause` interface and `VolumeTotals.pauses`
  - lines 108-111 and 143-159: `prepareVolume` gets an answers map and the view's id and answer
  - after line 211: new `countedDwell` and `widenedK`
  - lines 218-235 and 286: `countVolume`
- Test: `src/lib/reading-history/stats-engine.test.ts`
  - lines 1-17: imports
  - after line 89: new `resolve` builder
  - before line 242 (`describe('speedFromSamples'`): new describe blocks

**Interfaces:**

- **Consumes (from Task 1, `src/lib/reading-history/types.ts`):**
  - `export type PauseCount = 'full' | 'typical' | 'none';`
  - `export interface ResolvePayload { kind: 'resolve'; volume: string; target: [device: string, seq: number]; count: PauseCount }`
  - `ResolvePayload` is a member of `EventPayload`, so `ReadingEvent` includes `{ kind: 'resolve', ... }`.
- **Produces (`stats-engine.ts`):**

```ts
export const K_MAX = 20;
export const WIDEN_HEADROOM = 1.5;
export interface PreparedView {
  /* existing fields */ device: string;
  seq: number;
  answer: PauseCount | null;
}
export interface Pause {
  device: string;
  seq: number;
  t: number;
  page: number;
  dwell: number;
  cap: number;
  typical: number;
  counted: number;
  answer: PauseCount | null;
}
export interface VolumeTotals {
  /* existing fields */ pauses: Pause[];
}
export function countedDwell(
  dwell: number,
  cap: number,
  typical: number,
  answer: PauseCount | null
): number;
export function widenedK(
  elapsed: number,
  chars: number,
  pace: number | null,
  idle: IdleSettings
): number | null;
```

- [ ] **Step 1: Write the failing test (answers and pauses)**

In `src/lib/reading-history/stats-engine.test.ts`, replace the import block (lines 1-17):

```ts
import { describe, expect, it } from 'vitest';
import {
  CEILING_MS,
  DEFAULT_K,
  FLOOR_MS,
  NO_DATA_CAP_MS,
  countVolume,
  countedDwell,
  estimatePace,
  prepareVolume,
  recentSpeed,
  speedFromSamples,
  totalsBefore,
  viewCap,
  type IdleSettings,
  type Pause,
  type PreparedVolume
} from './stats-engine';
import type { PauseCount, ReadingEvent } from './types';
```

Directly after the `adjust` builder (which ends at line 89, `});`), insert:

```ts
/** The user's answer about the view `target` (`[device, seq]`). */
const resolve = (
  t: number,
  target: [string, number],
  count: PauseCount,
  device = 'dev-a'
): ReadingEvent => ({
  device,
  seq: ++seq,
  t,
  kind: 'resolve',
  volume: 'vol',
  target,
  count
});
const id = (e: ReadingEvent): [string, number] => [e.device, e.seq];
```

Directly before `describe('speedFromSamples', () => {` (line 242), insert:

```ts
describe('countedDwell', () => {
  it('counts all, typical or nothing as answered, and typical while unanswered over the cap', () => {
    expect(countedDwell(10 * MIN, 4 * MIN, 80_000, 'full')).toBe(10 * MIN);
    expect(countedDwell(10 * MIN, 4 * MIN, 80_000, 'typical')).toBe(80_000);
    expect(countedDwell(10 * MIN, 4 * MIN, 80_000, 'none')).toBe(0);
    expect(countedDwell(10 * MIN, 4 * MIN, 80_000, null)).toBe(80_000);
  });

  it('counts an unanswered view within its cap in full, and typical never above the dwell', () => {
    expect(countedDwell(3 * MIN, 4 * MIN, 80_000, null)).toBe(3 * MIN);
    expect(countedDwell(60_000, 4 * MIN, 80_000, 'typical')).toBe(60_000);
  });
});

describe('long-pause answers (resolve events)', () => {
  // 400 chars at 200 ms/char: expected 80 s, cap 240 s.
  const pace = 200;
  const long = () => view(0, 1, [400], 8 * 60 * MIN);

  it('counts a long pause in full, typical or not at all as answered', () => {
    const cases = [
      ['full', 8 * 60 * MIN],
      ['typical', 80_000],
      ['none', 0]
    ] as const;
    for (const [count, ms] of cases) {
      const v = long();
      const totals = countVolume(
        prepareVolume([v, resolve(8 * 60 * MIN, id(v), count)]),
        pace,
        AUTO
      );
      expect(totals.timeMs).toBe(ms);
    }
  });

  it("keeps the pages of a 'none' pause read, but takes no speed sample from it", () => {
    const v = long();
    const totals = countVolume(
      prepareVolume([v, resolve(8 * 60 * MIN, id(v), 'none')]),
      pace,
      AUTO
    );
    expect(totals.timeMs).toBe(0);
    expect(totals.readChars).toBe(400);
    expect(totals.samples).toEqual([]);
  });

  it('takes the latest answer by time, whatever order the events arrive in', () => {
    const v = long();
    const events = [resolve(9 * 60 * MIN, id(v), 'none'), v, resolve(8 * 60 * MIN, id(v), 'full')];
    expect(countVolume(prepareVolume(events), pace, AUTO).timeMs).toBe(0);
  });

  it('breaks a tie in time by device, the same on every device', () => {
    const v = long();
    const a = resolve(8 * 60 * MIN, id(v), 'full', 'dev-a');
    const b = resolve(8 * 60 * MIN, id(v), 'none', 'dev-b');
    expect(countVolume(prepareVolume([v, b, a]), pace, AUTO).timeMs).toBe(0);
    expect(countVolume(prepareVolume([a, v, b]), pace, AUTO).timeMs).toBe(0);
  });

  it('applies an answer under the cap, and keeps it when the pace moves', () => {
    const v = view(0, 1, [400], 3 * MIN);
    const none = [v, resolve(3 * MIN, id(v), 'none')];
    expect(countVolume(prepareVolume(none), 200, AUTO).timeMs).toBe(0);
    expect(countVolume(prepareVolume(none), 400, AUTO).timeMs).toBe(0);
    const typical = [v, resolve(3 * MIN, id(v), 'typical')];
    expect(countVolume(prepareVolume(typical), 200, AUTO).timeMs).toBe(80_000);
  });

  it('never applies an answer to a legacy view, and never lists one', () => {
    const events = [
      legacy(0, 1, 0, 10 * 60 * MIN),
      legacy(10 * 60 * MIN, 9, 5000, null),
      resolve(11 * 60 * MIN, ['legacy:vol', 0], 'full')
    ];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    expect(totals.timeMs).toBe(0);
    expect(totals.readChars).toBe(0);
    expect(totals.pauses).toEqual([]);
  });

  it('ignores an answer aimed at no view', () => {
    const v = long();
    const stray = resolve(8 * 60 * MIN, ['dev-z', 99], 'none');
    expect(countVolume(prepareVolume([v, stray]), pace, AUTO).timeMs).toBe(80_000);
  });

  it('drops answers a forget hides, even one whose view is after the horizon', () => {
    const v = long();
    const w = view(10 * 60 * MIN, 2, [400], 8 * 60 * MIN);
    // dev-b's slow clock stamps its answer about w before the forget's horizon.
    const skewed = resolve(8 * 60 * MIN + 30 * MIN, id(w), 'full', 'dev-b');
    const events = [
      v,
      resolve(8 * 60 * MIN, id(v), 'full'),
      forget(9 * 60 * MIN, 9 * 60 * MIN),
      w,
      skewed
    ];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    expect(totals.timeMs).toBe(80_000);
    expect(totals.pauses.map((p) => [p.seq, p.answer])).toEqual([[w.seq, null]]);
  });

  it('lists long pauses and answered views in time order, with what each counted', () => {
    const a = view(0, 1, [400], MIN); // within its cap, unanswered: not listed
    const b = view(10 * MIN, 5, [400, 100], 8 * 60 * MIN); // provisional
    const c = view(9 * 60 * MIN, 7, [400], 20 * MIN); // answered: all
    const d = view(10 * 60 * MIN, 8, [400], 2 * MIN); // under its cap, answered: typical
    const events = [
      a,
      b,
      c,
      resolve(9 * 60 * MIN + 20 * MIN, id(c), 'full'),
      d,
      resolve(11 * 60 * MIN, id(d), 'typical')
    ];
    const totals = countVolume(prepareVolume(events), pace, AUTO);
    const expected: Pause[] = [
      {
        device: 'dev-a',
        seq: b.seq,
        t: 10 * MIN,
        page: 5,
        dwell: 8 * 60 * MIN,
        cap: 300_000,
        typical: 100_000,
        counted: 100_000,
        answer: null
      },
      {
        device: 'dev-a',
        seq: c.seq,
        t: 9 * 60 * MIN,
        page: 7,
        dwell: 20 * MIN,
        cap: 240_000,
        typical: 80_000,
        counted: 20 * MIN,
        answer: 'full'
      },
      {
        device: 'dev-a',
        seq: d.seq,
        t: 10 * 60 * MIN,
        page: 8,
        dwell: 2 * MIN,
        cap: 240_000,
        typical: 80_000,
        counted: 80_000,
        answer: 'typical'
      }
    ];
    expect(totals.pauses).toEqual(expected);
    expect(totals.timeMs).toBe(60_000 + 100_000 + 20 * MIN + 80_000);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/reading-history/stats-engine.test.ts`

Expected: FAIL, for these reasons:

- The `countedDwell` tests throw `TypeError: countedDwell is not a function`, because the engine does not export it yet.
- In the resolve tests, `prepareVolume` still skips `resolve` events, so:
  - `'full'` gives `expected 28800000, received 80000`;
  - `'none'` gives `expected 0, received 80000`;
  - `totals.pauses` is `undefined`, so the `toEqual` checks and `.map` fail.
- The existing tests pass.

- [ ] **Step 3: Implement answers, `countedDwell` and `pauses`**

In `src/lib/reading-history/stats-engine.ts`, make these edits.

**Line 3.** Before:

```ts
import type { ReadingEvent } from './types';
```

After:

```ts
import type { PauseCount, ReadingEvent } from './types';
```

**Lines 11-15, the header bullet.** Before:

```ts
 *   one global pace (the median ms per character of recent views); its cap is
 *   `clamp(k × expected, FLOOR, CEILING)`, or the manual override. A view over
 *   its cap counts TYPICAL time (`expected`, at least the floor) — the spec's
 *   "unanswered" rule until phase 3b asks the user.
```

After:

```ts
 *   one global pace (the median ms per character of recent views); its cap is
 *   `clamp(k × expected, FLOOR, CEILING)`, or the manual override. A view over
 *   its cap is a long pause: it counts TYPICAL time (`expected`, at least the
 *   floor) until the user answers, then what the latest `resolve` targeting
 *   it says (`countedDwell`) — an answer applies whatever the cap is now.
```

**Constants, after line 34** (`export const SKIP_CPM = 1500;`), insert:

```ts
/** The widest "Still reading" may make `k` (tracking-data's range ends here too). */
export const K_MAX = 20;
/** "Still reading" fits `k` to the view's time so far × this. */
export const WIDEN_HEADROOM = 1.5;
```

**`PreparedView`, lines 57-60.** Before:

```ts
  legacy: boolean;
  pass: number;
  /** Pages on screen and their characters. */
  pages: Array<[page: number, chars: number]>;
}
```

After:

```ts
  legacy: boolean;
  pass: number;
  /** Pages on screen and their characters. */
  pages: Array<[page: number, chars: number]>;
  /** The recording event's id — what a `resolve` targets. */
  device: string;
  seq: number;
  /** The latest answer about this view; always `null` for legacy (never prompted). */
  answer: PauseCount | null;
}
```

**`Pause` and `VolumeTotals`, lines 77-95.** Before:

```ts
/** Running totals after each counted entry, by time — for `totalsBefore`. */
export type TimelinePoint = [t: number, timeMs: number, readChars: number, skippedChars: number];
```

After:

```ts
/** Running totals after each counted entry, by time — for `totalsBefore`. */
export type TimelinePoint = [t: number, timeMs: number, readChars: number, skippedChars: number];

/** A native view over its cap, or one the user answered about (review list, answer count). */
export interface Pause {
  device: string;
  seq: number;
  t: number;
  /** First page on screen. */
  page: number;
  dwell: number;
  cap: number;
  typical: number;
  /** What it counts now (`countedDwell`). */
  counted: number;
  /** `null` = provisional: unanswered, counts typical. */
  answer: PauseCount | null;
}
```

Also before:

```ts
  /** Non-skip views that counted time, oldest first. */
  samples: SpeedSample[];
}
```

After:

```ts
  /** Non-skip views that counted time, oldest first. */
  samples: SpeedSample[];
  /** Native views over their cap or answered, oldest first. Legacy never. */
  pauses: Pause[];
}
```

**`prepareVolume`, line 111.** Before:

```ts
const live = events.filter((e) => e.t >= horizon).sort(byTime);
```

After:

```ts
const live = events.filter((e) => e.t >= horizon).sort(byTime);
// `live` is in time order (ties by device, then seq), so the last answer
// set for a view is the latest — the same on every device.
const answers = new Map<string, PauseCount>();
for (const e of live) {
  if (e.kind === 'resolve') answers.set(`${e.target[0]}\u0000${e.target[1]}`, e.count);
}
```

**`prepareVolume`, the view push (lines 150-159).** Before:

```ts
views.push({
  t: e.t,
  end: e.t + (dwell ?? 0),
  dwell,
  chars,
  skip: chars > 0 && dwell !== null && (dwell <= 0 || (chars / dwell) * 60_000 > SKIP_CPM),
  legacy,
  pass,
  pages
});
```

After:

```ts
views.push({
  t: e.t,
  end: e.t + (dwell ?? 0),
  dwell,
  chars,
  skip: chars > 0 && dwell !== null && (dwell <= 0 || (chars / dwell) * 60_000 > SKIP_CPM),
  legacy,
  pass,
  pages,
  device: e.device,
  seq: e.seq,
  answer: legacy || answers.size === 0 ? null : (answers.get(`${e.device}\u0000${e.seq}`) ?? null)
});
```

**After `typicalDwell` (which ends at line 211), insert:**

```ts
/**
 * What a view's dwell counts, given the user's answer (`null` = none yet):
 * `full` all of it, `none` nothing, `typical` at most its typical time. An
 * unanswered view counts in full within its cap and typical over it
 * (provisional). An answer holds whatever the cap is now, so a pace change
 * never undoes a "don't count".
 */
export function countedDwell(
  dwell: number,
  cap: number,
  typical: number,
  answer: PauseCount | null
): number {
  if (answer === 'full') return dwell;
  if (answer === 'none') return 0;
  if (answer === 'typical' || dwell > cap) return Math.min(dwell, typical);
  return dwell;
}
```

**`countVolume`, first loop (lines 218-235).** Before:

```ts
let timeMs = 0;
let lastReadAt: number | null = null;
const counted: Array<{ view: PreparedView; ms: number; reads: boolean }> = [];
for (const view of prepared.views) {
  const cap = viewCap(view.chars, pace, idle);
  let ms: number;
  let reads = !view.skip;
  if (view.dwell === null) ms = 0;
  else if (view.dwell <= cap) ms = view.dwell;
  else if (view.legacy) {
    // The old idle rule: a gap over the timeout was neither time nor reading.
    ms = 0;
    reads = false;
  } else ms = Math.min(view.dwell, typicalDwell(view.chars, pace, cap));
  timeMs += ms;
  lastReadAt = Math.max(lastReadAt ?? view.end, view.end);
  counted.push({ view, ms, reads });
}
```

After:

```ts
let timeMs = 0;
let lastReadAt: number | null = null;
const counted: Array<{ view: PreparedView; ms: number; reads: boolean }> = [];
const pauses: Pause[] = [];
for (const view of prepared.views) {
  const cap = viewCap(view.chars, pace, idle);
  let ms: number;
  let reads = !view.skip;
  if (view.dwell === null) ms = 0;
  else if (view.dwell <= cap && view.answer === null) ms = view.dwell;
  else if (view.legacy) {
    // The old idle rule: a gap over the timeout was neither time nor reading.
    ms = 0;
    reads = false;
  } else {
    // A long pause or an answered view. An answer moves time only: whether
    // its pages were read stays as the view's own speed says.
    const typical = typicalDwell(view.chars, pace, cap);
    ms = countedDwell(view.dwell, cap, typical, view.answer);
    pauses.push({
      device: view.device,
      seq: view.seq,
      t: view.t,
      page: view.pages[0]?.[0] ?? 0,
      dwell: view.dwell,
      cap,
      typical,
      counted: ms,
      answer: view.answer
    });
  }
  timeMs += ms;
  lastReadAt = Math.max(lastReadAt ?? view.end, view.end);
  counted.push({ view, ms, reads });
}
```

**`countVolume`, the return (line 286).** Before:

```ts
return { timeMs, readChars, skippedChars, lastReadAt, newestSampleEnd, timeline, samples };
```

After:

```ts
return {
  timeMs,
  readChars,
  skippedChars,
  lastReadAt,
  newestSampleEnd,
  timeline,
  samples,
  pauses
};
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/lib/reading-history/stats-engine.test.ts`

Expected: PASS. This covers every test, including the existing countVolume, raw totals and brute-force describes.

- [ ] **Step 5: Write the failing test (`widenedK`)**

In the import block of `src/lib/reading-history/stats-engine.test.ts`, change two spots.

First, before:

```ts
  FLOOR_MS,
  NO_DATA_CAP_MS,
```

After:

```ts
  FLOOR_MS,
  K_MAX,
  NO_DATA_CAP_MS,
```

Second, before:

```ts
  viewCap,
  type IdleSettings,
```

After:

```ts
  viewCap,
  widenedK,
  type IdleSettings,
```

Directly before `describe('speedFromSamples', () => {`, insert:

```ts
describe('widenedK', () => {
  // 400 chars at 200 ms/char: expected 80 s; k = 3 caps it at 240 s.
  it('fits the time so far with 1.5× headroom, rounded up to a half step', () => {
    expect(widenedK(6 * MIN, 400, 200, AUTO)).toBe(7);
    expect(viewCap(400, 200, { k: 7, overrideMs: null })).toBe(560_000);
    expect(widenedK(270_000, 400, 200, AUTO)).toBe(5.5);
  });

  it('stops where the cap of this view reaches the ceiling', () => {
    // 2000 chars: expected 400 s; the ceiling is reached at k = 4.5.
    const k = widenedK(25 * MIN, 2000, 200, AUTO);
    expect(k).toBe(4.5);
    expect(viewCap(2000, 200, { k: k!, overrideMs: null })).toBe(CEILING_MS);
    // 4000 chars: already at the ceiling with k = 3.
    expect(widenedK(40 * MIN, 4000, 200, AUTO)).toBeNull();
  });

  it(`never goes past K_MAX (${K_MAX})`, () => {
    // 30 chars: expected 6 s; the fit (30) is bounded, and the cap still grows past the floor.
    expect(widenedK(2 * MIN, 30, 200, AUTO)).toBe(K_MAX);
  });

  it('is null when widening cannot lengthen this view’s cap', () => {
    expect(widenedK(10 * MIN, 400, 200, { k: DEFAULT_K, overrideMs: 5 * MIN })).toBeNull();
    expect(widenedK(10 * MIN, 400, null, AUTO)).toBeNull();
    expect(widenedK(10 * MIN, 0, 200, AUTO)).toBeNull();
    // 1 char: even k = K_MAX leaves the cap at the floor.
    expect(widenedK(2 * MIN, 1, 200, AUTO)).toBeNull();
    expect(viewCap(1, 200, AUTO)).toBe(FLOOR_MS);
  });

  it('never shrinks k', () => {
    expect(widenedK(4 * MIN, 400, 200, { k: 10, overrideMs: null })).toBeNull();
  });
});
```

- [ ] **Step 6: Run it**

Run: `npx vitest run src/lib/reading-history/stats-engine.test.ts`

Expected: FAIL in the `widenedK` describe:

- The calls throw `TypeError: widenedK is not a function`, because the engine does not export it yet.
- The K_MAX test title renders as `never goes past K_MAX (undefined)`.
- Every other test passes.

- [ ] **Step 7: Implement `widenedK`**

In `src/lib/reading-history/stats-engine.ts`, directly after `countedDwell`, insert:

```ts
/**
 * `k` after "Still reading" on a view of `chars` characters open for
 * `elapsed`: fits that time with `WIDEN_HEADROOM`, rounded up to a half step,
 * never past `K_MAX` nor the k at which this view's cap meets the ceiling.
 * `null` when widening cannot lengthen THIS view's cap — a manual override,
 * no pace yet, an art-only page, a cap held at the floor or already at the
 * ceiling — since `k` is global and would only move other views' caps.
 */
export function widenedK(
  elapsed: number,
  chars: number,
  pace: number | null,
  idle: IdleSettings
): number | null {
  if (idle.overrideMs !== null || pace === null || chars * pace <= 0) return null;
  const expected = chars * pace;
  const fit = Math.ceil(((elapsed * WIDEN_HEADROOM) / expected) * 2) / 2;
  const next = Math.min(K_MAX, CEILING_MS / expected, fit);
  if (next <= idle.k) return null;
  const widened = viewCap(chars, pace, { k: next, overrideMs: null });
  return widened > viewCap(chars, pace, idle) ? next : null;
}
```

- [ ] **Step 8: Run the engine and its consumers**

Run: `npx vitest run src/lib/reading-history`

Expected: PASS for every file. `stats-store.test.ts` and `total-stats.test.ts` read `VolumeTotals` only through `countVolume`, so the new `pauses` field changes nothing for them.

Run: `npm run check 2>&1 | grep -E "stats-engine"`

Expected: no output, meaning no type errors in `stats-engine.ts` or its test. This needs Task 1's `PauseCount` and `ResolvePayload` in `types.ts`.

- [ ] **Step 9: Commit**

```bash
git -C /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-pauses add \
  src/lib/reading-history/stats-engine.ts \
  src/lib/reading-history/stats-engine.test.ts
git -C /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-pauses commit -m "$(cat <<'EOF'
feat(history): engine applies pause answers, lists pauses, widens k

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Notes for the plan author

- **`widenedK` differs from the design's formula.** The design's version only checks `next > idle.k`. For a page held at the floor (for example 1 char at 200 ms/char) it returns 20, which raises the global `k` while this view's cap stays at 60 s. That contradicts O4 ("null when it can't help"). The task therefore returns `next` only when `viewCap(…, {k: next})` is longer than the current cap. This also covers the ceiling case, so the separate `reachCeiling` variable is folded into `Math.min(K_MAX, CEILING_MS / expected, fit)`.
- **`pauses` includes answered views within their cap** (design: "dwell > cap OR answer !== null"). Task 6/7's `DONT_ASK_AFTER` count is `pauses.filter(p => p.answer !== null).length` summed over `byVolume`. It counts each answered view once, however many times its answer changed.
- **A live split never shows a continuation view in the review list unless it passes its own cap.** The continuation (Task 4) is unanswered unless the standing default was preset on it. If its dwell stays under its cap, it is not listed.
- **`Pause.page` is `view.pages[0]?.[0] ?? 0`.** That is `first_page` for every well-formed native event.
- **Task 3 must import `K_MAX` from `stats-engine.ts`.** `tracking-data.ts` keeps its own private `K_RANGE = [1, 20]` at line 32, so Task 3 should replace `K_RANGE[1]` with `K_MAX`. This task does not touch `tracking-data.ts`.
- **Answers never affect the pace.** `paceTail` is unchanged, so a view between its cap and the ceiling feeds the pace with its raw dwell, even when answered 'none'. This follows the design.
- **Engine cost.** The answers map is built only from `resolve` events. A view's key string is built only when the map is not empty, and `typicalDwell` runs only on the long-pause/answered branch. A page with no resolves therefore costs the same as in 3a, consistent with the "~1 ms per page" commit.
- **Task 1 is assumed to be in place.** These tests rely on Task 1's `ResolvePayload` being `{ kind: 'resolve'; volume: string; target: [string, number]; count: PauseCount }` inside `ReadingEvent`. Vitest does not type-check, so the runtime RED/GREEN works either way, but Step 8's `npm run check` needs Task 1 committed first.
- **Task 6 consumes `countedDwell`.** Timer's live part should call `countedDwell(now - since, cap, typicalDwell(chars, pace, cap), presetAnswer)`, with `presetAnswer` being `null` when no standing default is set. With no answer this keeps 3a's behaviour: full time within the cap, clamped to typical past it.

---

### Task 3: tracking: standing default + k setters

**Files:**

- Modify: `src/lib/settings/tracking-data.ts` (whole file, lines 1–134, rewritten in Step 3)
- Modify: `src/lib/util/sync/unified-sync-service.ts`
  - :18–26: add the `copyTrackingEntry` import
  - :580: replace the fold assignment
- Test: `src/lib/settings/tracking-data.test.ts`
  - imports :6–16
  - insert before :47
  - insert after :70
  - append after :95
- Test: `src/lib/util/sync/unified-sync-service.test.ts` (insert after :1724, inside `describe('the tracking section of volume-data.json (idle cutoff)')`)

**Interfaces:**

- Consumes:
  - `PauseCount` from `$lib/reading-history/types` (Task 1): `type PauseCount = 'full' | 'typical' | 'none'`
  - `K_MAX` from `$lib/reading-history/stats-engine` (Task 2): `export const K_MAX = 20`
  - `DEFAULT_K` and `IdleSettings` (already exported)
- Produces (all from `src/lib/settings/tracking-data.ts`):

  ```ts
  export interface PausesEntry {
    default: PauseCount | null;
    lastUpdated: string;
  } // null = ask
  export interface TrackingState {
    idle?: IdleEntry;
    pauses?: PausesEntry;
  }
  export function isPauseCount(value: unknown): value is PauseCount;
  export function copyTrackingEntry<K extends keyof TrackingState>(
    to: TrackingState,
    from: TrackingState,
    key: K
  ): void;
  export function widenIdleK(k: number): void; // idle.k = clamp(k, 1..K_MAX), keeps override_minutes, restamps idle
  export function resetIdleK(): void; // idle.k = DEFAULT_K, written explicitly, restamps idle
  export function setPauseDefault(count: PauseCount | null): void;
  export const pauseDefault: Readable<PauseCount | null>;
  ```

  - `copyTrackingEntry` is not in the design. The real code needs it: once `TrackingState` has two entry types, a write through a union key (`merged[key] = cloudEntry` in `mergeTrackingSections`, and `foldable[key] = own[key]` at `unified-sync-service.ts:580`) fails type-checking with TS2322 (`'IdleEntry | PausesEntry' is not assignable to '(IdleEntry & PausesEntry) | undefined'`). I reproduced this with `svelte-check`. A generic key fixes it, so the design's statement that merge and sync need no change holds at runtime but not for types.
  - `isPauseCount` is exported so the settings select in Task 7 can validate its value.

- [ ] **Step 1: Write the failing tests**

`src/lib/settings/tracking-data.test.ts`: replace the import block at :6–16 with:

```ts
import { get } from 'svelte/store';
import {
  TRACKING_SECTION_KEY,
  detectBogusTrackingKeys,
  idleSettings,
  mergeTrackingSections,
  parseTrackingSection,
  pauseDefault,
  resetIdleK,
  setIdleOverride,
  setPauseDefault,
  setTrackingStates,
  trackingState,
  widenIdleK
} from './tracking-data';
import { DEFAULT_K, K_MAX } from '$lib/reading-history/stats-engine';
```

In `describe('parseTrackingSection')`, insert directly before `it('uses the reserved key name', …)` (:47):

```ts
it('keeps a pauses entry without an idle one', () => {
  expect(parseTrackingSection({ pauses: { default: 'typical', lastUpdated: T1 } })).toEqual({
    pauses: { default: 'typical', lastUpdated: T1 }
  });
});

it('parses each key on its own: a junk one never takes the other with it', () => {
  expect(parseTrackingSection({ idle: 3, pauses: { default: 'none', lastUpdated: T1 } })).toEqual({
    pauses: { default: 'none', lastUpdated: T1 }
  });
  expect(parseTrackingSection({ idle: { k: 2, lastUpdated: T1 }, pauses: 'full' })).toEqual({
    idle: { k: 2, lastUpdated: T1 }
  });
});

it('reads a junk or missing standing default as "ask"', () => {
  expect(parseTrackingSection({ pauses: { default: 'sometimes', lastUpdated: T1 } })).toEqual({
    pauses: { default: null, lastUpdated: T1 }
  });
  expect(parseTrackingSection({ pauses: { lastUpdated: T1 } }).pauses?.default).toBeNull();
  expect(parseTrackingSection({ pauses: { default: 'full' } }).pauses?.lastUpdated).toBe(
    new Date(0).toISOString()
  );
});
```

In `describe('mergeTrackingSections')`, insert after the `it('a bogus (future) cloud entry forfeits…')` block, before its closing `});` (:70):

```ts
it('merges pauses and idle apart: each key keeps its own newest stamp', () => {
  const merged = mergeTrackingSections(
    {
      idle: { override_minutes: 8, lastUpdated: T2 },
      pauses: { default: 'full', lastUpdated: T1 }
    },
    {
      idle: { override_minutes: 15, lastUpdated: T1 },
      pauses: { default: 'none', lastUpdated: T2 }
    }
  );
  expect(merged).toEqual({
    idle: { override_minutes: 8, lastUpdated: T2 },
    pauses: { default: 'none', lastUpdated: T2 }
  });
});

it('a bogus pauses stamp forfeits only that key', () => {
  const raw = {
    idle: { override_minutes: 15, lastUpdated: T2 },
    pauses: { default: 'none', lastUpdated: '2999-01-01T00:00:00.000Z' }
  };
  const bogus = detectBogusTrackingKeys(raw);
  expect([...bogus]).toEqual(['pauses']);
  const merged = mergeTrackingSections(
    {
      idle: { override_minutes: 8, lastUpdated: T1 },
      pauses: { default: 'full', lastUpdated: T1 }
    },
    parseTrackingSection(raw),
    bogus
  );
  expect(merged.idle?.override_minutes).toBe(15);
  expect(merged.pauses?.default).toBe('full');
});
```

Append at the end of the file, after :95:

```ts
describe('widening k', () => {
  it('sets k and keeps the manual override (they share one entry and one stamp)', () => {
    setTrackingStates({ idle: { override_minutes: 7, lastUpdated: T1 } });
    widenIdleK(6.5);
    const idle = get(trackingState).idle!;
    expect(idle).toMatchObject({ k: 6.5, override_minutes: 7 });
    expect(idle.lastUpdated > T1).toBe(true);
    expect(get(idleSettings)).toEqual({ k: 6.5, overrideMs: 7 * 60_000 });
  });

  it('clamps k into 1–K_MAX and ignores a non-number', () => {
    widenIdleK(99);
    expect(get(trackingState).idle?.k).toBe(K_MAX);
    widenIdleK(0.2);
    expect(get(trackingState).idle?.k).toBe(1);
    widenIdleK(Number.NaN);
    expect(get(trackingState).idle?.k).toBe(1);
  });

  it('reset writes the default explicitly, so it beats the older widen in a merge', () => {
    const widened = { idle: { k: 9, override_minutes: 4, lastUpdated: T1 } };
    setTrackingStates(widened);
    resetIdleK();
    expect(get(trackingState).idle).toMatchObject({ k: DEFAULT_K, override_minutes: 4 });
    expect(mergeTrackingSections(get(trackingState), widened).idle?.k).toBe(DEFAULT_K);
    expect(get(idleSettings).k).toBe(DEFAULT_K);
  });
});

describe('the standing pause default', () => {
  it('is "ask" until set, then follows the setting back to "ask"', () => {
    expect(get(pauseDefault)).toBeNull();
    setPauseDefault('typical');
    expect(get(pauseDefault)).toBe('typical');
    setPauseDefault(null);
    expect(get(pauseDefault)).toBeNull();
    // "Ask" is an explicit choice, so it beats an older default from another device.
    expect(get(trackingState).pauses?.default).toBeNull();
  });

  it('never touches the idle entry', () => {
    setTrackingStates({ idle: { k: 4, lastUpdated: T1 } });
    setPauseDefault('none');
    expect(get(trackingState).idle).toEqual({ k: 4, lastUpdated: T1 });
  });

  it('stamps past a future stamp already stored', () => {
    setTrackingStates({ pauses: { default: 'full', lastUpdated: '2026-12-31T00:00:00.000Z' } });
    setPauseDefault(null);
    expect(get(trackingState).pauses!.lastUpdated > '2026-12-31T00:00:00.000Z').toBe(true);
  });

  it('survives its own wire format and persists locally', () => {
    setPauseDefault('full');
    widenIdleK(5);
    const stored = JSON.parse(window.localStorage.getItem('tracking-data')!);
    expect(stored.pauses.default).toBe('full');
    expect(parseTrackingSection(stored)).toEqual(get(trackingState));
  });
});
```

`src/lib/util/sync/unified-sync-service.test.ts`: inside `describe('the tracking section of volume-data.json (idle cutoff)')`, after `it('folds duplicate copies, newest wins', …)` (its closing `});` is :1724), and before the describe's closing `});` at :1725, insert:

```ts
it('round-trips the standing pause default through the file', async () => {
  const pauses = { default: 'typical', lastUpdated: T2 };
  setTrackingStates({ pauses: { default: 'typical', lastUpdated: T2 } });
  stubCache([fileMeta('only')]);
  const first = provider(file(undefined));
  await svc.syncVolumeData(first.provider);
  expect(first.uploads).toHaveLength(1);
  expect(first.uploads[0].tracking).toEqual({ pauses });

  // Another device reads that upload back: adopted, and nothing to upload.
  setTrackingStates({});
  stubCache([fileMeta('only')]);
  const second = provider(first.uploads[0]);
  await svc.syncVolumeData(second.provider);
  expect(get(trackingState)).toEqual({ pauses });
  expect(second.uploads).toHaveLength(0);
});

it('merges the pause default and the idle cutoff apart', async () => {
  setTrackingStates({
    idle: { override_minutes: 12, lastUpdated: T2 },
    pauses: { default: 'full', lastUpdated: T1 }
  });
  stubCache([fileMeta('only')]);
  const { uploads, provider: p } = provider(
    file({
      idle: { override_minutes: 20, lastUpdated: T1 },
      pauses: { default: 'none', lastUpdated: T2 }
    })
  );
  await svc.syncVolumeData(p);
  const expected = {
    idle: { override_minutes: 12, lastUpdated: T2 },
    pauses: { default: 'none', lastUpdated: T2 }
  };
  expect(get(trackingState)).toEqual(expected);
  expect(uploads).toHaveLength(1);
  expect(uploads[0].tracking).toEqual(expected);
});

it('folds duplicate copies per key', async () => {
  const [first, second] = [fileMeta('first'), fileMeta('second')];
  stubCache([first, second]);
  const p = makeProvider(async (f) =>
    jsonBlob(
      file(
        f.fileId === 'first'
          ? {
              idle: { override_minutes: 4, lastUpdated: T2 },
              pauses: { default: 'full', lastUpdated: T1 }
            }
          : {
              idle: { override_minutes: 8, lastUpdated: T1 },
              pauses: { default: 'none', lastUpdated: T2 }
            }
      )
    )
  );
  const result = await svc.downloadVolumeDataFile(p);
  expect(result.tracking).toEqual({
    idle: { override_minutes: 4, lastUpdated: T2 },
    pauses: { default: 'none', lastUpdated: T2 }
  });
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run src/lib/settings/tracking-data.test.ts src/lib/util/sync/unified-sync-service.test.ts`

Expected: FAIL, `13 failed | 76 passed (89)`.

- The three new parse tests fail with `expected {} to deeply equal { Object (pauses) }`, because `parseTrackingSection` returns `{}` without `raw.idle` and drops `pauses`.
- `widening k` fails with `widenIdleK is not a function` and `resetIdleK is not a function`.
- `the standing pause default` fails with `expected undefined to be null` and `setPauseDefault is not a function`.
- The three new sync tests fail because the parse drops `pauses`. For example, the fold test reports `expected { idle: {…} } to deeply equal { idle: {…}, pauses: {…} }`.
- The two new `mergeTrackingSections` tests already PASS: the merge is generic over keys at runtime, and only its types change (Step 3). They are kept as guards.

- [ ] **Step 3: Implement**

Replace `src/lib/settings/tracking-data.ts` entirely with:

```ts
import { browser } from '$app/environment';
import { derived, get, writable, type Readable } from 'svelte/store';
import { FUTURE_TOLERANCE_MS, isRecord, normalizeUpdatedAt } from '$lib/metadata/sanitize';
import { DEFAULT_K, K_MAX, type IdleSettings } from '$lib/reading-history/stats-engine';
import type { PauseCount } from '$lib/reading-history/types';

/**
 * Reading-tracking SETTINGS that belong to the user, not to a device or a
 * profile: they travel in `volume-data.json` under the reserved `tracking`
 * key, beside the `series` section, with the same rules — per key, newest
 * `lastUpdated` wins, a stamp too far in the future is clamped on read and
 * forfeits to a local entry (spec: "Speed and stats", manual override).
 *
 * - `idle`: the idle cutoff every stat uses. `override_minutes` replaces the
 *   adaptive cap everywhere when set; `k` widens it ("Still reading" on a
 *   long-pause prompt raises it, `widenIdleK`). The two share one stamp, so
 *   a widen and an override edit made on two devices between syncs keep only
 *   the newer of the two.
 * - `pauses`: the standing answer to long-pause prompts. `default: null` =
 *   ask. When set, prompts stop and each view that reaches its cap while open
 *   is written with that answer — from then on, never backwards. Its own key,
 *   so it merges apart from `idle`.
 */

export const TRACKING_SECTION_KEY = 'tracking';
export const TRACKING_STORAGE_KEY = 'tracking-data';

export interface IdleEntry {
  k?: number;
  /** `null` = automatic (explicitly chosen, so it beats an older override). */
  override_minutes?: number | null;
  lastUpdated: string;
}

export interface PausesEntry {
  /** `null` = ask (explicitly chosen, so it beats an older default). */
  default: PauseCount | null;
  lastUpdated: string;
}

export interface TrackingState {
  idle?: IdleEntry;
  pauses?: PausesEntry;
}

const K_RANGE = [1, K_MAX] as const;
const OVERRIDE_RANGE = [1, 60] as const;
const PAUSE_COUNTS: readonly PauseCount[] = ['full', 'typical', 'none'];
const EPOCH = new Date(0).toISOString();

const clampK = (k: number): number => Math.min(K_RANGE[1], Math.max(K_RANGE[0], k));

export function isPauseCount(value: unknown): value is PauseCount {
  return (PAUSE_COUNTS as readonly unknown[]).includes(value);
}

function parseIdle(value: Record<string, unknown>): IdleEntry {
  const idle: IdleEntry = { lastUpdated: normalizeUpdatedAt(value.lastUpdated) ?? EPOCH };
  if (typeof value.k === 'number' && Number.isFinite(value.k)) idle.k = clampK(value.k);
  if ('override_minutes' in value) {
    const minutes = value.override_minutes;
    idle.override_minutes =
      typeof minutes === 'number' && minutes >= OVERRIDE_RANGE[0] && minutes <= OVERRIDE_RANGE[1]
        ? minutes
        : null;
  }
  return idle;
}

function parsePauses(value: Record<string, unknown>): PausesEntry {
  return {
    default: isPauseCount(value.default) ? value.default : null,
    lastUpdated: normalizeUpdatedAt(value.lastUpdated) ?? EPOCH
  };
}

/** Validate an untrusted `tracking` section, key by key. Unknown keys are dropped. */
export function parseTrackingSection(raw: unknown): TrackingState {
  const state: TrackingState = {};
  if (!isRecord(raw)) return state;
  if (isRecord(raw.idle)) state.idle = parseIdle(raw.idle);
  if (isRecord(raw.pauses)) state.pauses = parsePauses(raw.pauses);
  return state;
}

/** Keys whose RAW stamp is too far in the future (before the parse clamps it). */
export function detectBogusTrackingKeys(raw: unknown, now: number = Date.now()): Set<string> {
  const bogus = new Set<string>();
  if (!isRecord(raw)) return bogus;
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.lastUpdated !== 'string') continue;
    const stamp = Date.parse(value.lastUpdated);
    if (!Number.isNaN(stamp) && stamp > now + FUTURE_TOLERANCE_MS) bogus.add(key);
  }
  return bogus;
}

/**
 * `to[key] = from[key]`. Generic over the key because a write through a
 * UNION of keys must satisfy every entry type at once (`IdleEntry &
 * PausesEntry`) and does not type-check.
 */
export function copyTrackingEntry<K extends keyof TrackingState>(
  to: TrackingState,
  from: TrackingState,
  key: K
): void {
  to[key] = from[key];
}

/** Newest `lastUpdated` per key; a tie keeps local; a bogus cloud key never beats a local one. */
export function mergeTrackingSections(
  local: TrackingState,
  cloud: TrackingState,
  bogusKeys: ReadonlySet<string> = new Set()
): TrackingState {
  const merged: TrackingState = { ...local };
  for (const key of Object.keys(cloud) as Array<keyof TrackingState>) {
    const cloudEntry = cloud[key];
    const localEntry = merged[key];
    if (!cloudEntry) continue;
    if (!localEntry || (!bogusKeys.has(key) && cloudEntry.lastUpdated > localEntry.lastUpdated)) {
      copyTrackingEntry(merged, cloud, key);
    }
  }
  return merged;
}

function load(): TrackingState {
  if (!browser) return {};
  try {
    return parseTrackingSection(
      JSON.parse(window.localStorage.getItem(TRACKING_STORAGE_KEY) || '{}')
    );
  } catch {
    return {};
  }
}

export const trackingState = writable<TrackingState>(load());

trackingState.subscribe((state) => {
  if (!browser) return;
  try {
    window.localStorage.setItem(TRACKING_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the setting still syncs through the cloud file.
  }
});

export function setTrackingStates(state: TrackingState): void {
  trackingState.set(state);
}

/** A local edit always supersedes what is stored, even a future stamp. */
function nextStamp(existing: string | undefined, now: number = Date.now()): string {
  const previous = existing ? Date.parse(existing) : NaN;
  return new Date(Number.isNaN(previous) ? now : Math.max(now, previous + 1)).toISOString();
}

/** Change fields of `idle`, keeping the others, under one new stamp. */
function editIdle(fields: Omit<IdleEntry, 'lastUpdated'>): void {
  const state = get(trackingState);
  trackingState.set({
    ...state,
    idle: { ...state.idle, ...fields, lastUpdated: nextStamp(state.idle?.lastUpdated) }
  });
}

/** Set the manual idle cutoff in minutes, or `null` for automatic. */
export function setIdleOverride(minutes: number | null): void {
  editIdle({ override_minutes: minutes });
}

/**
 * Set the cap multiplier `k` (clamped into 1–`K_MAX`), keeping the manual
 * override. "Still reading" calls it with `widenedK(…)`, which never shrinks
 * `k`; this setter writes whatever it is given.
 */
export function widenIdleK(k: number): void {
  if (!Number.isFinite(k)) return;
  editIdle({ k: clampK(k) });
}

/** Back to `DEFAULT_K`, written explicitly so it beats an older widen under newest-wins. */
export function resetIdleK(): void {
  editIdle({ k: DEFAULT_K });
}

/** The standing answer to long-pause prompts, or `null` to be asked. */
export function setPauseDefault(count: PauseCount | null): void {
  const state = get(trackingState);
  trackingState.set({
    ...state,
    pauses: { default: count, lastUpdated: nextStamp(state.pauses?.lastUpdated) }
  });
}

/** The idle cutoff every stat uses. */
export const idleSettings: Readable<IdleSettings> = derived(trackingState, ($state) => ({
  k: $state.idle?.k ?? DEFAULT_K,
  overrideMs: $state.idle?.override_minutes ? $state.idle.override_minutes * 60_000 : null
}));

/** The standing long-pause answer; `null` = ask. */
export const pauseDefault: Readable<PauseCount | null> = derived(
  trackingState,
  ($state) => $state.pauses?.default ?? null
);
```

In `src/lib/util/sync/unified-sync-service.ts`, make two edits.

Import (:18–26). Before:

```ts
import {
  TRACKING_SECTION_KEY,
  detectBogusTrackingKeys,
```

After:

```ts
import {
  TRACKING_SECTION_KEY,
  copyTrackingEntry,
  detectBogusTrackingKeys,
```

Duplicate-copy fold (:580, in `downloadVolumeDataFile`). Before:

```ts
if (!honestElsewhere) foldable[key] = own[key];
```

After:

```ts
if (!honestElsewhere) copyTrackingEntry(foldable, own, key);
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/lib/settings/tracking-data.test.ts src/lib/util/sync/unified-sync-service.test.ts`

Expected: PASS, `89 passed (89)`.

- [ ] **Step 5: Type-check and the neighbouring tests**

Run: `npm run check`

Expected: `0 ERRORS`. Without the two `copyTrackingEntry` edits, svelte-check reports `unified-sync-service.ts 581:35 Type 'IdleEntry | PausesEntry | undefined' is not assignable to type '(IdleEntry & PausesEntry) | undefined'`, and the same error at the merge assignment in `tracking-data.ts`.

Run: `npx vitest run src/lib/components/Settings/Reader/__tests__/IdleCutoffSetting.test.ts src/lib/reading-history`

Expected: PASS. `setIdleOverride` now goes through `editIdle` and behaves the same.

Run: `npx prettier --check src/lib/settings/tracking-data.ts src/lib/settings/tracking-data.test.ts src/lib/util/sync/unified-sync-service.ts src/lib/util/sync/unified-sync-service.test.ts`

Expected: `All matched files use Prettier code style!`

- [ ] **Step 6: Commit**

```bash
git add src/lib/settings/tracking-data.ts src/lib/settings/tracking-data.test.ts src/lib/util/sync/unified-sync-service.ts src/lib/util/sync/unified-sync-service.test.ts
git commit -m "$(cat <<'EOF'
feat(history): standing long-pause default and k setters in tracking

`tracking.pauses` holds the standing answer to long-pause prompts (null =
ask) under its own stamp, so it merges apart from `idle`. widenIdleK /
resetIdleK set `k` beside the manual override. The section now parses key
by key, and per-key writes go through a generic copyTrackingEntry: a write
through the union of keys no longer type-checks.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Notes for the plan author

- **Verified, not just drafted.** I applied this task to a scratch copy of the worktree at HEAD `f582f030`, with Task 1's `PauseCount` and Task 2's `K_MAX` stubbed in. Before the implementation, the tests failed 13 / passed 76, as Step 2 says. After it, 89/89 passed. svelte-check over 2594 files reported 0 errors; reverting line 580 brought back the TS2322 error. The `src/lib/reading-history` tests and the IdleCutoffSetting test passed (200 tests), and prettier was clean.
- **Conflict with the design.** The design says "`mergeTrackingSections` … compose and sync … need no change". At runtime that is true. For types it is not: adding `pauses` to `TrackingState` breaks two union-key writes, so this task must touch `unified-sync-service.ts:580` and the merge, through the new exported `copyTrackingEntry`.
- **Depends on Task 1** (`PauseCount` exported from `types.ts`) **and Task 2** (`export const K_MAX = 20` in `stats-engine.ts`). Run Task 3 after both, or vitest will import `K_MAX` as `undefined`, and `K_RANGE` will clamp to `NaN`.
- **`widenIdleK` writes whatever it is given** (clamped to 1–20, `NaN` ignored). The "never shrinks" and "null when it can't help" rules stay in `widenedK` (Task 2). The Reader (Task 6) must call `widenIdleK` only when `widenedK` returns non-null.
- **`setPauseDefault(null)` writes an explicit `{default: null}` entry**, so "Ask me" beats an older default from another device. Task 7's select should call `setPauseDefault(null)` for "Ask me", not delete the key.
- **A local `PAUSE_COUNTS` list and the exported `isPauseCount` live in tracking-data.** Task 1's `COUNTS` in `segment-codec.ts` is private and is index-ordered for the wire format. Keep both lists in the same order, `['full','typical','none']`, or have Task 1 export one shared constant from `types.ts`.
- **The existing describe title still says "(idle cutoff)".** I left it unchanged to keep the diff small, though it now also covers `pauses`.

---

### Task 4: ViewTracker answers and split

**Files:**

- Modify: `src/lib/reading-history/view-tracker.ts` (whole file, lines 1-64, is replaced. `ViewDescriptor` and `viewKey` stay byte-identical. `OpenView` gains `answer`. `ViewTracker` gains `setAnswer`, `split`, a private `start`, and an answer on `end`.)
- Test: `src/lib/reading-history/view-tracker.test.ts` (import at :3, `setup()` at :19-23, assertion at :30, new `describe` appended after :92)
- Not modified: `src/lib/reading-history/live-view.ts`. `liveView` is `writable<OpenView | null>` (:10), so it carries the new `OpenView.answer` with no edit. `liveMinutes` (:18-26) takes `{ since }` only. Moving the live part to `countedDwell` belongs to Task 6 (Timer).
- Not modified: `Reader.svelte:631-634`. The current emit `(payload, t) => void recordEvent(payload, t)` still type-checks against the 3-parameter emit, because TS accepts a callback with fewer parameters. Task 6 switches it to `recordView(p, t, a)`.

**Interfaces:**

- Consumes:
  - `PauseCount` from `./types`, which is Task 1: `export type PauseCount = 'full' | 'typical' | 'none';`
  - `PagePayload`, `Layout`, `Orientation` from `./types`, which already exist.
- Produces:
  ```ts
  export interface OpenView {
    view: ViewDescriptor;
    since: number;
    answer: PauseCount | null; // the preset (standing-default) answer for the open view; null = none
  }
  export class ViewTracker {
    constructor(
      emit: (
        payload: PagePayload,
        t: number,
        answer: { count: PauseCount; t: number } | null
      ) => void,
      onChange?: (open: OpenView | null) => void
    );
    setView(view: ViewDescriptor | null, now: number): void; // unchanged behaviour
    close(now: number): void; // unchanged behaviour
    setAnswer(count: PauseCount, now = Date.now()): void; // preset; emitted when the view ends
    split(now: number, count: PauseCount): void; // end open view with this answer, reopen SAME view at `now`
  }
  ```
- Behaviour contract that Tasks 5 and 6 rely on:
  - `split` emits the paused view as `emit(page, since, { count, t: now })` and then calls `onChange({ view, since: now, answer: null })`.
  - `setAnswer` calls `onChange({ view, since, answer: count })` with the SAME `since`, so a watch keyed on `since` must not re-fire or clear.
  - Every emit carries `answer`. It is `null` unless the view was split or preset.
  - A preset never carries over into a continuation or into the next view.
  - Both `split` and `setAnswer` are no-ops when nothing is open.

- [ ] **Step 1: Write the failing test**

Edit `src/lib/reading-history/view-tracker.test.ts`.

Line 3, before:

```ts
import type { PagePayload } from './types';
```

After:

```ts
import type { PagePayload, PauseCount } from './types';
```

Lines 19-23, before:

```ts
function setup() {
  const emitted: { payload: PagePayload; t: number }[] = [];
  const tracker = new ViewTracker((payload, t) => emitted.push({ payload, t }));
  return { tracker, emitted };
}
```

After:

```ts
type Answer = { count: PauseCount; t: number } | null;

function setup() {
  const emitted: { payload: PagePayload; t: number; answer: Answer }[] = [];
  const changes: Array<{ first: number; since: number; answer: PauseCount | null } | null> = [];
  const tracker = new ViewTracker(
    (payload, t, answer) => emitted.push({ payload, t, answer }),
    (open) =>
      changes.push(open && { first: open.view.first_page, since: open.since, answer: open.answer })
  );
  return { tracker, emitted, changes };
}
```

Line 30 (in "emits the previous view with its dwell when the view changes"), before:

```ts
expect(emitted).toEqual([{ payload: { kind: 'page', ...view(1), dwell_ms: 30000 }, t: 1000 }]);
```

After:

```ts
expect(emitted).toEqual([
  { payload: { kind: 'page', ...view(1), dwell_ms: 30000 }, t: 1000, answer: null }
]);
```

Append after the last line (the closing `});` of `describe('ViewTracker onChange'`):

```ts
describe('ViewTracker answers', () => {
  it('split writes the paused view with the answer and reopens the same view at the answer', () => {
    const { tracker, emitted, changes } = setup();
    tracker.setView(view(1), 1000);
    tracker.split(400_000, 'typical');
    expect(emitted).toEqual([
      {
        payload: { kind: 'page', ...view(1), dwell_ms: 399_000 },
        t: 1000,
        answer: { count: 'typical', t: 400_000 }
      }
    ]);
    expect(changes).toEqual([
      { first: 1, since: 1000, answer: null },
      { first: 1, since: 400_000, answer: null }
    ]);
    // The continuation is the same view: re-setting it is no change, and it
    // ends unanswered with the time since the answer.
    tracker.setView(view(1), 450_000);
    tracker.setView(view(2), 500_000);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual({
      payload: { kind: 'page', ...view(1), dwell_ms: 100_000 },
      t: 400_000,
      answer: null
    });
  });

  it('setAnswer presets the open view: written with its stamp when the view ends', () => {
    const { tracker, emitted, changes } = setup();
    tracker.setView(view(1), 0);
    tracker.setAnswer('full', 300_000);
    expect(emitted).toHaveLength(0);
    expect(changes).toEqual([
      { first: 1, since: 0, answer: null },
      { first: 1, since: 0, answer: 'full' }
    ]);
    tracker.setView(view(2), 900_000);
    expect(emitted[0]).toEqual({
      payload: { kind: 'page', ...view(1), dwell_ms: 900_000 },
      t: 0,
      answer: { count: 'full', t: 300_000 }
    });
  });

  it('clears the answer on the next view', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 0);
    tracker.setAnswer('none', 100_000);
    tracker.setView(view(2), 200_000);
    tracker.close(250_000);
    tracker.setView(view(2), 300_000);
    tracker.setView(null, 310_000);
    expect(emitted.map((e) => e.answer)).toEqual([{ count: 'none', t: 100_000 }, null, null]);
  });

  it('a live answer replaces the preset, and the continuation starts unanswered', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 0);
    tracker.setAnswer('none', 100_000);
    tracker.split(200_000, 'full');
    tracker.close(260_000);
    expect(emitted.map((e) => [e.t, e.payload.dwell_ms, e.answer])).toEqual([
      [0, 200_000, { count: 'full', t: 200_000 }],
      [200_000, 60_000, null]
    ]);
  });

  it('split and setAnswer with no open view do nothing', () => {
    const { tracker, emitted, changes } = setup();
    tracker.split(5, 'none');
    tracker.setAnswer('full', 6);
    expect(emitted).toEqual([]);
    expect(changes).toEqual([]);
    tracker.setView(view(1), 10);
    tracker.close(20);
    tracker.split(30, 'typical');
    tracker.setAnswer('typical', 40);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].answer).toBeNull();
    expect(changes).toEqual([{ first: 1, since: 10, answer: null }, null]);
  });

  it('never emits a negative dwell when splitting on a clock that stepped back', () => {
    const { tracker, emitted } = setup();
    tracker.setView(view(1), 5000);
    tracker.split(4000, 'full');
    expect(emitted[0].payload.dwell_ms).toBe(0);
  });
});
```

- [ ] **Step 2: Run it**

`npx vitest run src/lib/reading-history/view-tracker.test.ts`

Expected: FAIL. 7 failed and 6 passed, out of 13:

- "emits the previous view with its dwell…" fails with `AssertionError: expected [...] to deeply equal [...]`. The current emit passes no third argument, so `answer` is `undefined`, not `null`.
- The six "ViewTracker answers" tests fail with `TypeError: tracker.split is not a function` or `TypeError: tracker.setAnswer is not a function`.

- [ ] **Step 3: Implement**

Replace the whole of `src/lib/reading-history/view-tracker.ts` with:

```ts
import type { Layout, Orientation, PagePayload, PauseCount } from './types';

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
 * The view on screen now and when it opened (the live timer's clock).
 * `answer` is the long-pause answer preset for it (the standing default,
 * `setAnswer`): the live timer counts the open view by it. `null` = none.
 */
export interface OpenView {
  view: ViewDescriptor;
  since: number;
  answer: PauseCount | null;
}

/**
 * Turns a stream of "what's on screen" into `page` events. An event is emitted
 * when its view ENDS (another view, hidden, closed), so its dwell is known.
 *
 * A long-pause answer rides out with its view's event (`emit`'s third
 * argument), stamped with the time it was given, so the recorder can write the
 * page and its `resolve` in one transaction:
 * - `setAnswer` presets the open view (the standing default) — written when the
 *   view ends however it ends, one event however long the pause;
 * - `split` is a live answer: the paused view ends NOW with it, and the same
 *   view reopens at the answer time, so the time after it counts normally and
 *   a later pause on the same pages is prompted afresh.
 */
export class ViewTracker {
  private open: {
    view: ViewDescriptor;
    key: string;
    since: number;
    answer: { count: PauseCount; t: number } | null;
  } | null = null;

  constructor(
    private readonly emit: (
      payload: PagePayload,
      t: number,
      answer: { count: PauseCount; t: number } | null
    ) => void,
    private readonly onChange?: (open: OpenView | null) => void
  ) {}

  setView(view: ViewDescriptor | null, now: number): void {
    const key = view ? viewKey(view) : null;
    if (this.open && key === this.open.key) return;
    const wasOpen = this.open !== null;
    this.end(now);
    if (view && key) this.start(view, key, now);
    else if (wasOpen) this.onChange?.(null);
  }

  close(now: number): void {
    if (this.end(now)) this.onChange?.(null);
  }

  /** Preset the open view's answer (the standing default); no-op with nothing open. */
  setAnswer(count: PauseCount, now = Date.now()): void {
    if (!this.open) return;
    this.open.answer = { count, t: now };
    this.onChange?.({ view: this.open.view, since: this.open.since, answer: count });
  }

  /** End the open view with this live answer and reopen the same view at `now`. */
  split(now: number, count: PauseCount): void {
    if (!this.open) return;
    const { view, key } = this.open;
    this.end(now, { count, t: now });
    this.start(view, key, now);
  }

  private start(view: ViewDescriptor, key: string, now: number): void {
    this.open = { view, key, since: now, answer: null };
    this.onChange?.({ view, since: now, answer: null });
  }

  /** `live` (a split's answer) wins over the preset. */
  private end(now: number, live: { count: PauseCount; t: number } | null = null): boolean {
    if (!this.open) return false;
    const { view, since, answer } = this.open;
    this.open = null;
    this.emit({ kind: 'page', ...view, dwell_ms: Math.max(0, now - since) }, since, live ?? answer);
    return true;
  }
}
```

The old file had a stray doc comment ("Turns a stream of 'what's on screen' into `page` events…") sitting above `OpenView` at :24-27. The new file moves it onto `ViewTracker`.

- [ ] **Step 4: Run**

`npx vitest run src/lib/reading-history/view-tracker.test.ts src/lib/reading-history/live-view.test.ts`

Expected: PASS. That is 13 passed in view-tracker and 2 in live-view.

- [ ] **Step 5: Type-check the consumers of `OpenView` and the emit**

`npm run check`

Expected: no errors in `src/lib/reading-history/view-tracker.ts`, `live-view.ts`, `components/Reader/Reader.svelte` or `components/Reader/Timer.svelte`.

- `Reader.svelte:631-634` passes a 2-parameter emit, which is allowed.
- `liveView.set(open)` takes the widened `OpenView`.
- `Timer.svelte:33` reads only `.view` and `.since`.

This step needs Task 1's `PauseCount` in `types.ts`. If Task 1 has not landed, check reports `Module './types' has no exported member 'PauseCount'`.

Then run `npx prettier --check src/lib/reading-history/view-tracker.ts src/lib/reading-history/view-tracker.test.ts`. Expected: "All matched files use Prettier code style!"

- [ ] **Step 6: Commit**

```bash
git add src/lib/reading-history/view-tracker.ts src/lib/reading-history/view-tracker.test.ts
git commit -m "$(cat <<'EOF'
feat(history): view tracker carries long-pause answers; a live answer splits the view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Notes for the plan author

- **Verified out of tree.** I copied the current `view-tracker.ts` and its test to a scratch dir and added a `PauseCount` stub to a copy of `types.ts`.
  - The Step 1 tests against the unchanged tracker gave exactly the RED above: 7 failed, 6 passed.
  - The Step 3 file made all 13 pass.
  - `tsc --strict` was clean on both files.
  - Prettier with the repo settings (singleQuote, trailingComma none, width 100) reported no diff.
  - No repo file was edited.
- **Design gap filled: `OpenView.answer`.** The design has Timer compute `countedDwell(now - since, cap, typical, presetAnswer)` but never says where `presetAnswer` comes from. I put it on `OpenView`, mirrored through `onChange`, so it reaches `liveView` with no edit to `live-view.ts`.
  - As a result `setAnswer` fires `onChange` with the same `since`.
  - Task 5's `PauseWatch.update` must treat "same since and same cap" as no change, which the design already says.
  - Task 6's "clear `livePause` when `since` changes or becomes null" stays correct.
  - Task 6 Timer should read `open.answer` as `presetAnswer`, not `get(pauseDefault)`. That keeps O3: a default set mid-view doesn't apply until it is preset at the cap.
- **No new type name.** The answer type is written inline as `{ count: PauseCount; t: number } | null`, exactly as the design's `appendView`/`recordView` signatures (Task 1) write it, so the emit is structurally compatible with `recordView(p, t, a)`.
- **Timestamps of an answer.**
  - For a split, the resolve's `t` is the answer time, and the continuation's `since` is the same `now`.
  - For a preset, the resolve's `t` is the `setAnswer` time, which is when the cap was hit (Task 6's `onCap`). It is not the view's end time.
  - Either way the resolve's `t` is at or after the page's `t` unless the clock stepped back. The engine orders resolves by `byTime` among themselves only, so this does not matter for correctness.
- **Parameter order follows the design but is inconsistent.** `split(now, count)` and `setAnswer(count, now = Date.now())` take their arguments in opposite orders. Every other `ViewTracker` method takes an explicit `now`. Task 6 should pass `Date.now()` explicitly to both.
- **Clock stepping backwards.** A split with `now < since` emits `dwell_ms: 0`, which is the existing clamp, and reopens at `now`. No extra guard is needed.
- **Assumption about Task 1:** `PauseCount` is exported from `src/lib/reading-history/types.ts`. If Task 4 runs before Task 1, the vitest run still passes because the import is type-only and erased, but `npm run check` fails until Task 1 lands.

---

### Task 5: Pause watch (live cap detection)

**Files:**

- Create: `src/lib/reading-history/pause-watch.ts`
- Test: `src/lib/reading-history/pause-watch.test.ts` (uses fake timers)
- No existing file is modified. The module only consumes exports that already exist at `f582f030`, so it has no dependency on Tasks 1–4 and can run in parallel with them.

**Interfaces:**

- Consumes (all exist today):
  - `viewCap(chars: number, pace: number | null, idle: IdleSettings): number`, `typicalDwell(chars: number, pace: number | null, cap: number): number`, `type IdleSettings`, `NO_DATA_CAP_MS` (test only), all from `./stats-engine` (`stats-engine.ts:42-47, 201-211`).
  - `type OpenView`, `type ViewDescriptor` (test only), from `./view-tracker` (`view-tracker.ts:4-13, 29-32`).
  - `writable` from `svelte/store`.
- Produces:

```ts
export const AWAY_AFTER_MS = 2 * 60_000;
export interface LivePause {
  volume: string;
  since: number;
  chars: number;
  cap: number;
  typical: number;
}
export const livePause: Writable<LivePause | null>;
export function livePauseFor(open: OpenView, pace: number | null, idle: IdleSettings): LivePause;
export interface WatchTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}
export class PauseWatch {
  constructor(
    onCap: (p: LivePause) => void,
    onClear?: () => void, // default () => {}
    timers?: WatchTimers, // default: late-bound setTimeout/clearTimeout
    now?: () => number // default () => Date.now()
  );
  update(open: OpenView | null, pace: number | null, idle: IdleSettings): void;
  dispose(): void;
}
```

- Departures from the design, each forced by something:
  - **`onClear` is added.** The design's edge-case table says that when pace or `k` changes while the prompt is up and the new cap is longer than the time so far, the prompt clears. Only the watch knows when that happens.
  - **`now` is `() => Date.now()` and `timers` is late-bound.** This way fake timers apply however the watch was constructed.
  - **`livePauseFor` is exported.** Timer in Task 6 can then use the same cap and typical rule, so the `page_chars` sum is not computed a second time.

- [ ] **Step 1: Write the failing test**

Create `src/lib/reading-history/pause-watch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { NO_DATA_CAP_MS, type IdleSettings } from './stats-engine';
import type { OpenView, ViewDescriptor } from './view-tracker';
import { AWAY_AFTER_MS, PauseWatch, livePause, livePauseFor, type LivePause } from './pause-watch';

const T0 = Date.UTC(2026, 9, 10, 12, 0);
const MIN = 60_000;
/** 1000 characters at 100 ms/char: expected 100 s, cap 3 × 100 s = 5 min. */
const PACE = 100;
const IDLE: IdleSettings = { k: 3, overrideMs: null };

function view(first: number, extra: Partial<ViewDescriptor> = {}): ViewDescriptor {
  return {
    volume: 'vol-1',
    first_page: first,
    last_page: first,
    page_chars: [1000],
    chars_before: (first - 1) * 1000,
    layout: 'single',
    orientation: 'portrait',
    viewport: { w: 400, h: 800 },
    ...extra
  };
}

function open(since: number, first = 1, extra: Partial<ViewDescriptor> = {}): OpenView {
  return { view: view(first, extra), since };
}

function setup() {
  const onCap = vi.fn<(p: LivePause) => void>();
  const onClear = vi.fn<() => void>();
  const watch = new PauseWatch(onCap, onClear);
  return { watch, onCap, onClear };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('livePauseFor', () => {
  it('describes the open view with the cap and typical time the engine uses', () => {
    expect(livePauseFor(open(T0), PACE, IDLE)).toEqual({
      volume: 'vol-1',
      since: T0,
      chars: 1000,
      cap: 5 * MIN,
      typical: 100_000
    });
  });

  it('sums every page on screen (a spread)', () => {
    const spread = open(T0, 1, { last_page: 2, page_chars: [400, 600], layout: 'double' });
    expect(livePauseFor(spread, PACE, IDLE).chars).toBe(1000);
  });

  it('takes the override, or the no-data cap before there is a pace', () => {
    expect(livePauseFor(open(T0), PACE, { k: 3, overrideMs: MIN }).cap).toBe(MIN);
    expect(livePauseFor(open(T0), null, IDLE).cap).toBe(NO_DATA_CAP_MS);
  });
});

describe('PauseWatch', () => {
  it('starts with no live pause and a two-minute away threshold', () => {
    expect(get(livePause)).toBeNull();
    expect(AWAY_AFTER_MS).toBe(2 * MIN);
  });

  it('fires at since + cap, not before', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(5 * MIN - 1);
    expect(onCap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap).toHaveBeenCalledWith({
      volume: 'vol-1',
      since: T0,
      chars: 1000,
      cap: 5 * MIN,
      typical: 100_000
    });
  });

  it('fires on the next tick, never inside update, when the cap is already behind', () => {
    const { watch, onCap } = setup();
    vi.setSystemTime(T0 + 7 * MIN);
    watch.update(open(T0), PACE, IDLE);
    expect(onCap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(onCap).toHaveBeenCalledTimes(1);
  });

  it('keeps its deadline when the same view and cap are reported again', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(4 * MIN);
    watch.update(open(T0, 1, { viewport: { w: 800, h: 400 } }), PACE, IDLE);
    vi.advanceTimersByTime(MIN);
    expect(onCap).toHaveBeenCalledTimes(1);
  });

  it('re-arms when the cap grows before it is reached', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(4 * MIN);
    watch.update(open(T0), PACE, { k: 6, overrideMs: null });
    vi.advanceTimersByTime(5 * MIN);
    expect(onCap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap.mock.calls[0][0].cap).toBe(10 * MIN);
  });

  it('re-arms when the cap shrinks, firing at once if the new cap is already behind', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(2 * MIN);
    watch.update(open(T0), PACE, { k: 3, overrideMs: MIN });
    vi.advanceTimersByTime(0);
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap.mock.calls[0][0].cap).toBe(MIN);
  });

  it('never fires after the view ends', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(MIN);
    watch.update(null, PACE, IDLE);
    vi.advanceTimersByTime(60 * MIN);
    expect(onCap).not.toHaveBeenCalled();
  });

  it('times a new view from its own since', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(4 * MIN);
    watch.update(open(T0 + 4 * MIN, 2), PACE, IDLE);
    vi.advanceTimersByTime(4 * MIN);
    expect(onCap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap.mock.calls[0][0].since).toBe(T0 + 4 * MIN);
  });

  it('fires once per since, even when a smaller change to the cap arrives after', () => {
    const { watch, onCap, onClear } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(7 * MIN);
    watch.update(open(T0), PACE, IDLE);
    watch.update(open(T0), PACE, { k: 4, overrideMs: null });
    vi.advanceTimersByTime(60 * MIN);
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('fires again for the continuation view a split opens', () => {
    const { watch, onCap } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(6 * MIN);
    // "Still reading": the same pages reopen at the answer time with a wider cap.
    watch.update(open(T0 + 6 * MIN), PACE, { k: 6, overrideMs: null });
    vi.advanceTimersByTime(10 * MIN);
    expect(onCap).toHaveBeenCalledTimes(2);
    expect(onCap.mock.calls[1][0]).toMatchObject({ since: T0 + 6 * MIN, cap: 10 * MIN });
  });

  it('withdraws a fired pause when its view ends or another opens', () => {
    const { watch, onClear } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(6 * MIN);
    watch.update(open(T0 + 6 * MIN, 2), PACE, IDLE);
    expect(onClear).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * MIN);
    watch.update(null, PACE, IDLE);
    expect(onClear).toHaveBeenCalledTimes(2);
  });

  it('does not withdraw what never fired', () => {
    const { watch, onClear } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(MIN);
    watch.update(open(T0 + MIN, 2), PACE, IDLE);
    watch.update(null, PACE, IDLE);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('withdraws a fired pause when the cap grows past the time so far, then waits again', () => {
    const { watch, onCap, onClear } = setup();
    watch.update(open(T0), PACE, IDLE);
    vi.advanceTimersByTime(6 * MIN);
    expect(onCap).toHaveBeenCalledTimes(1);
    watch.update(open(T0), PACE, { k: 9, overrideMs: null });
    expect(onClear).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9 * MIN - 1);
    expect(onCap).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onCap).toHaveBeenCalledTimes(2);
    expect(onCap.mock.calls[1][0].cap).toBe(15 * MIN);
  });

  it('stops for good on dispose', () => {
    const { watch, onCap, onClear } = setup();
    watch.update(open(T0), PACE, IDLE);
    watch.dispose();
    vi.advanceTimersByTime(60 * MIN);
    expect(onCap).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/reading-history/pause-watch.test.ts`
Expected: FAIL with `Failed to load url ./pause-watch (resolved id: ./pause-watch) ... Does the file exist?`. The suite reports "no tests" because the module does not exist yet.

- [ ] **Step 3: Implement**

Create `src/lib/reading-history/pause-watch.ts`:

```ts
import { writable } from 'svelte/store';
import { typicalDwell, viewCap, type IdleSettings } from './stats-engine';
import type { OpenView } from './view-tracker';

/**
 * Live long-pause detection (phase 3b; spec: "Long pauses"). The open view
 * reaches its cap at `since + cap` — the same cap the engine applies once the
 * view ends — and the reader asks then, to the millisecond, not on the
 * timer's 15 s tick. A view is asked about once; a split's continuation is a
 * new view (new `since`) and is asked about again.
 */

/** The prompt has been up this long past the cap → its "away" copy. */
export const AWAY_AFTER_MS = 2 * 60_000;

/** The open view that has reached its cap: what the prompt shows and answers. */
export interface LivePause {
  volume: string;
  since: number;
  /** Characters on screen. */
  chars: number;
  cap: number;
  /** What "Count typical" counts: `typicalDwell(chars, pace, cap)`. */
  typical: number;
}

/** The pause the reader is asking about now; `null` = no prompt. */
export const livePause = writable<LivePause | null>(null);

/** The open view's cap and typical time, as the engine will count them. */
export function livePauseFor(open: OpenView, pace: number | null, idle: IdleSettings): LivePause {
  const chars = open.view.page_chars.reduce((sum, c) => sum + c, 0);
  const cap = viewCap(chars, pace, idle);
  return {
    volume: open.view.volume,
    since: open.since,
    chars,
    cap,
    typical: typicalDwell(chars, pace, cap)
  };
}

export interface WatchTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

// Late-bound, so fake timers installed after construction still apply.
const globalTimers: WatchTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>)
};

export class PauseWatch {
  private current: LivePause | null = null;
  private timer: unknown = null;
  private fired = false;

  /**
   * @param onCap the open view reached its cap (once per view).
   * @param onClear a pause that fired no longer stands: its view ended,
   *   another opened, or the cap grew past the time so far.
   */
  constructor(
    private readonly onCap: (p: LivePause) => void,
    private readonly onClear: () => void = () => {},
    private readonly timers: WatchTimers = globalTimers,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Re-arm for the open view; call on any liveView / pace / idle change. Never
   * calls `onCap` synchronously (it runs inside store subscriptions).
   */
  update(open: OpenView | null, pace: number | null, idle: IdleSettings): void {
    const next = open ? livePauseFor(open, pace, idle) : null;
    const prev = this.current;
    const sameView =
      prev !== null && next !== null && prev.volume === next.volume && prev.since === next.since;
    if (sameView && prev.cap === next.cap) return;
    this.current = next;

    if (sameView && this.fired) {
      // Asked once per view: a new cap still behind us changes nothing; one
      // that moved past the time so far withdraws the prompt and waits again.
      if (next.since + next.cap <= this.now()) return;
      this.fired = false;
      this.onClear();
      this.arm(next);
      return;
    }

    this.disarm();
    if (this.fired) {
      this.fired = false;
      this.onClear();
    }
    if (next) this.arm(next);
  }

  dispose(): void {
    this.disarm();
    this.current = null;
    this.fired = false;
  }

  private arm(p: LivePause): void {
    const delay = Math.max(0, p.since + p.cap - this.now());
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (this.current !== p) return;
      this.fired = true;
      this.onCap(p);
    }, delay);
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }
}
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/lib/reading-history/pause-watch.test.ts`
Expected: PASS, 17 tests (3 for `livePauseFor`, 14 for `PauseWatch`).

- [ ] **Step 5: Lint and type-check the new files**

Run: `npx prettier --check src/lib/reading-history/pause-watch.ts src/lib/reading-history/pause-watch.test.ts && npm run check`
Expected: Prettier prints "All matched files use Prettier code style!", and svelte-check reports no new errors in `pause-watch*.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reading-history/pause-watch.ts src/lib/reading-history/pause-watch.test.ts
git commit -m "$(cat <<'EOF'
feat(history): pause watch — the open view's cap, live to the millisecond

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Notes for the plan author

- **Verified.** I copied the exact code above into a scratch sandbox (`.../scratchpad/t5/`) alongside the worktree's real `stats-engine.ts`, `view-tracker.ts`, `types.ts`, `paths.ts` and `project-turns.ts`, and ran it with the worktree's `node_modules`:
  - RED: "Failed to load url ./pause-watch".
  - GREEN: 17/17 passed.
  - Prettier check: clean against `.prettierrc`.
  - `tsc --strict`: clean. The only error was the expected `$lib` alias in `project-turns.ts`, which the sandbox cannot resolve.
  - I did not run it inside the worktree itself, because this step was read-only.
- **`onClear` (design conflict, resolved).** The design's constructor has only `onCap`, but its edge-case table needs the prompt cleared when the cap grows past the time so far, and only the watch knows that. Task 6 should wire `new PauseWatch(onCap, () => livePause.set(null))`. `onClear` also fires when the view ends or a new view opens, so the Reader's separate "set `livePause` to null on a `liveView` change" rule becomes redundant. Keeping it is harmless.
- **"Fires immediately" means the next macrotask (`setTimeout` with 0 ms), never synchronously inside `update()`.** `update` runs inside the `liveView` and `readingStats` subscriptions, and `onCap` sets stores or calls `viewTracker.setAnswer`.
- **Once per `since`.**
  - After firing, a cap change whose deadline is still past does not re-fire. The `LivePause` the prompt shows is also not refreshed, so its cap and typical figures can lag a pace recount while it is up. That is acceptable, or Task 6 can recompute them with `livePauseFor`.
  - "Still reading" gets its re-prompt because `split` opens a new `since`.
- **Gap for Tasks 4 and 6: the standing default after the cap grows.**
  - The sequence: `onCap` presets the answer with `viewTracker.setAnswer(default)`. Pace or `k` then grows past the time so far, so `onClear` fires. The preset answer stays on the tracker, and if the view ends under the new cap the default is still written.
  - Recommendation: Task 4 makes it `setAnswer(count: PauseCount | null)`, and Task 6's `onClear` also calls `viewTracker.setAnswer(null)`. The alternative is to accept it as rare.
- **`dispose()` is deliberately silent.** In Task 6's `onMount` cleanup, `viewTracker.close()` must come before `watch.dispose()`. Then `liveView` goes to null and `update(null)` fires `onClear`. Otherwise the module-level `livePause` survives into the next reader session. The alternative is to call `livePause.set(null)` explicitly on unmount.
- **Calling cost.** `update` returns early when both `since` and cap are unchanged; it does one reduce over `page_chars`. It is therefore safe to call on every `readingStats` emission. It must not run inside a `$derived`; use a `$effect` or subscriptions.
- **`livePauseFor` for Timer.** Task 6's Timer should use `livePauseFor($liveView, pace, idle)` to get `cap` and `typical` for `countedDwell`, rather than repeating `viewCap(page_chars.reduce…)` as it does now (`Timer.svelte:34-42`).

---

### Task 6: "Still reading?" prompt, answer handling, and Reader/Timer wiring

**Files:**

- Create: `src/lib/components/Reader/LongPausePrompt.svelte`
- Create: `src/lib/components/Reader/__tests__/LongPausePrompt.test.ts`
- Create: `src/lib/reading-history/pause-answer.ts`. This holds the pure answer handler and the stale-prompt check, so the Reader wiring can be tested. `Reader.svelte` has no unit tests and is 1873 lines long.
- Create: `src/lib/reading-history/pause-answer.test.ts`
- Modify: `src/lib/reading-history/live-view.ts` (all 26 lines). It gains the `liveAnswer` store, and `liveMinutes` now counts through `countedDwell`.
- Modify: `src/lib/reading-history/live-view.test.ts` (tests are added)
- Modify: `src/lib/components/Reader/Timer.svelte`, lines 1-56 (script and status)
- Modify: `src/lib/components/Reader/Reader.svelte` at these places:
  - line 33: import the component
  - lines 95-102: history imports
  - lines 509-514: unmount cleanup
  - lines 629-634: ViewTracker construction, plus the new PauseWatch and answer handler
  - lines 1187-1189: a watch effect added after the `setView` effect
  - lines 1678-1684: mount the prompt beside `PositionOfferBanner`
- Test: `npx vitest run src/lib/reading-history/live-view.test.ts src/lib/reading-history/pause-answer.test.ts src/lib/components/Reader/__tests__/LongPausePrompt.test.ts`

**Interfaces:**

Consumes (from earlier tasks):

- Task 1, `record.ts`:
  `recordView(page: PagePayload, t: number, answer: { count: PauseCount; t: number } | null, db?: HistoryDexie): Promise<ReadingEvent[] | null>`
- Task 1, `types.ts`:
  `type PauseCount = 'full' | 'typical' | 'none'`
- Task 2, `stats-engine.ts`:
  - `countedDwell(dwell, cap, typical, answer: PauseCount | null): number`
  - `widenedK(elapsed, chars, pace: number | null, idle: IdleSettings): number | null`
  - the existing `viewCap` and `typicalDwell`
  - `VolumeTotals.pauses: Pause[]`, where `Pause.answer: PauseCount | null`
- Task 3, `tracking-data.ts`:
  - `pauseDefault: Readable<PauseCount | null>`
  - `setPauseDefault(count: PauseCount | null): void`
  - `widenIdleK(k: number): void`
  - the existing `idleSettings`
- Task 4, `view-tracker.ts`:
  - `emit: (payload: PagePayload, t: number, answer: { count: PauseCount; t: number } | null) => void`
  - `setAnswer(count: PauseCount, now?: number): void`
  - `split(now: number, count: PauseCount): void`
- Task 5, `pause-watch.ts`:
  - `AWAY_AFTER_MS`
  - `interface LivePause { volume; since; chars; cap; typical }`
  - `livePause: Writable<LivePause | null>`
  - `class PauseWatch { constructor(onCap: (p: LivePause) => void, timers?, now?); update(open: OpenView | null, pace: number | null, idle: IdleSettings): void; dispose(): void }`

Produces:

- `LongPausePrompt.svelte`:
  - props `{ onAnswer: (count: PauseCount, opts: { stillReading: boolean; always: boolean }) => void }`, as in the design
  - module exports `DONT_ASK_AFTER = 3` and `REFRESH_MS = 10_000`
- `live-view.ts`:
  - `liveAnswer: Writable<PauseCount | null>`
  - `liveMinutes(countedMs: number, open: { since: number } | null, now: number, cap: number, typical?: number, answer?: PauseCount | null): number`. The defaults (`typical = cap`, `answer = null`) give exactly the 3a result. The design names a "presetAnswer" for Timer but gives it no source; `liveAnswer` is that source.
- `pause-answer.ts`:
  - `interface PauseAnswerEffects { split(now: number, count: PauseCount): void; widenIdleK(k: number): void; setPauseDefault(count: PauseCount): void; notify(message: string): void }`
  - `answerPause(pause: LivePause, count: PauseCount, opts: { stillReading: boolean; always: boolean }, pace: number | null, idle: IdleSettings, effects: PauseAnswerEffects, now?: number): void`
  - `pauseOutgrown(shown: LivePause | null, open: OpenView | null, pace: number | null, idle: IdleSettings, now: number): boolean`

---

- [ ] **Step 1: Write the failing test: live minutes follow the answer**

Append to `src/lib/reading-history/live-view.test.ts`, keeping the existing two tests, and replace its import line.

```ts
import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { liveAnswer, liveMinutes } from './live-view';
```

```ts
describe('liveMinutes past the cap (phase 3b)', () => {
  it('counts what the answer says: full, typical, none; unanswered = typical', () => {
    const open = { since: 0 };
    expect(liveMinutes(0, open, 20 * MIN, 5 * MIN, 2 * MIN, 'full')).toBe(20);
    expect(liveMinutes(0, open, 20 * MIN, 5 * MIN, 2 * MIN, 'typical')).toBe(2);
    expect(liveMinutes(0, open, 20 * MIN, 5 * MIN, 2 * MIN, 'none')).toBe(0);
    expect(liveMinutes(0, open, 20 * MIN, 5 * MIN, 2 * MIN, null)).toBe(2);
  });

  it('under the cap an unanswered view counts its whole dwell', () => {
    expect(liveMinutes(0, { since: 0 }, 3 * MIN, 5 * MIN, 2 * MIN, null)).toBe(3);
  });

  it('starts with no standing answer on the open view', () => {
    expect(get(liveAnswer)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/reading-history/live-view.test.ts`
Expected: FAIL. `liveAnswer` is not exported (`get(undefined)` throws), and `'full'` gives `expected 5 to be 20` because the old `liveMinutes` clamps at the cap and ignores the extra arguments.

- [ ] **Step 3: Implement `live-view.ts`**

Replace the whole of `src/lib/reading-history/live-view.ts`:

```ts
import { writable } from 'svelte/store';
import { countedDwell } from './stats-engine';
import type { PauseCount } from './types';
import type { OpenView } from './view-tracker';

/**
 * The reader's open view, for the live timer (phase 3a, one clock): the time
 * read shown while reading is the counted history plus how long this view has
 * been on screen, counted by the same rule the stats apply once it ends.
 */
export const liveView = writable<OpenView | null>(null);

/**
 * The standing default already attached to the open view (phase 3b): it
 * reached its cap while "When a page stays open past the cutoff" was set, so
 * it will be written with that answer when it ends. The live timer counts by
 * it (a `full` default keeps counting). Cleared with every new view.
 */
export const liveAnswer = writable<PauseCount | null>(null);

/**
 * "Pause" on the reader timer: the view ends (as a hidden tab does) and no
 * time counts until the next page turn or a second click.
 */
export const readingPaused = writable(false);

/**
 * Counted history plus the open view under `countedDwell`: its dwell up to
 * the cap, past it the typical time unless an answer says otherwise. Without
 * `typical`, a view past its cap counts the cap (the 3a rule).
 */
export function liveMinutes(
  countedMs: number,
  open: { since: number } | null,
  now: number,
  cap: number,
  typical: number = cap,
  answer: PauseCount | null = null
): number {
  const live = open ? countedDwell(Math.max(0, now - open.since), cap, typical, answer) : 0;
  return Math.floor((countedMs + live) / 60_000);
}
```

- [ ] **Step 4: Run it**

Run: `npx vitest run src/lib/reading-history/live-view.test.ts`
Expected: PASS, 5 tests. The two 3a tests still pass: with `typical = cap`, `countedDwell(60 min, 5 min, 5 min, null)` gives 5 min.

- [ ] **Step 5: Write the failing test for the answer handler and stale-prompt check**

Create `src/lib/reading-history/pause-answer.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { answerPause, pauseOutgrown } from './pause-answer';
import type { LivePause } from './pause-watch';
import type { OpenView } from './view-tracker';

const MIN = 60_000;
/** ms per character. */
const PACE = 300;
const AUTO = { k: 3, overrideMs: null };

function effects() {
  return { split: vi.fn(), widenIdleK: vi.fn(), setPauseDefault: vi.fn(), notify: vi.fn() };
}

/** 400 chars at 300 ms/char: 2 min expected, so a 6 min cap at k = 3. */
const pause: LivePause = { volume: 'v1', since: 0, chars: 400, cap: 6 * MIN, typical: 2 * MIN };

describe('answerPause', () => {
  it('splits the view at the answer, with the answer, and nothing else', () => {
    const fx = effects();
    answerPause(pause, 'typical', { stillReading: false, always: false }, PACE, AUTO, fx, 7 * MIN);
    expect(fx.split).toHaveBeenCalledWith(7 * MIN, 'typical');
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.setPauseDefault).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it('"Still reading" widens k to fit this view and says the new cutoff', () => {
    const fx = effects();
    // 8 min × 1.5 headroom / 2 min expected = 6 → k 6 → cap 6 × 2 min = 12 min.
    answerPause(pause, 'full', { stillReading: true, always: false }, PACE, AUTO, fx, 8 * MIN);
    expect(fx.split).toHaveBeenCalledWith(8 * MIN, 'full');
    expect(fx.widenIdleK).toHaveBeenCalledWith(6);
    expect(fx.notify).toHaveBeenCalledWith('Cutoff widened to ~12 min for pages like this');
  });

  it('"Count all" from the away copy never widens', () => {
    const fx = effects();
    answerPause(pause, 'full', { stillReading: false, always: false }, PACE, AUTO, fx, 30 * MIN);
    expect(fx.split).toHaveBeenCalledWith(30 * MIN, 'full');
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it('"Still reading" under a manual cutoff leaves it and points at Settings', () => {
    const fx = effects();
    const manual = { k: 3, overrideMs: 5 * MIN };
    answerPause(pause, 'full', { stillReading: true, always: false }, PACE, manual, fx, 8 * MIN);
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.notify).toHaveBeenCalledWith('Manual cutoff is 5 min — change it in Settings');
  });

  it('"Still reading" before there is a pace changes nothing (the cap is fixed)', () => {
    const fx = effects();
    answerPause(pause, 'full', { stillReading: true, always: false }, null, AUTO, fx, 8 * MIN);
    expect(fx.split).toHaveBeenCalledWith(8 * MIN, 'full');
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it('"Still reading" on a page held at the floor leaves k alone (O4)', () => {
    const fx = effects();
    // 10 chars: 3 s expected; k = 20 would still be 60 s, the floor.
    const art: LivePause = { volume: 'v1', since: 0, chars: 10, cap: MIN, typical: MIN };
    answerPause(art, 'full', { stillReading: true, always: false }, PACE, AUTO, fx, 90_000);
    expect(fx.widenIdleK).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it('"Always do this" makes the answer the standing default', () => {
    const fx = effects();
    answerPause(pause, 'none', { stillReading: false, always: true }, PACE, AUTO, fx, 7 * MIN);
    expect(fx.setPauseDefault).toHaveBeenCalledWith('none');
  });
});

describe('pauseOutgrown', () => {
  const open: OpenView = {
    since: 0,
    view: {
      volume: 'v1',
      first_page: 3,
      last_page: 3,
      page_chars: [400],
      chars_before: 800,
      layout: 'single',
      orientation: 'portrait',
      viewport: { w: 400, h: 800 }
    }
  };

  it('is false with no prompt up', () => {
    expect(pauseOutgrown(null, open, PACE, AUTO, 7 * MIN)).toBe(false);
  });

  it('is false while the open view is still past its cap', () => {
    expect(pauseOutgrown(pause, open, PACE, AUTO, 7 * MIN)).toBe(false);
  });

  it('is true once the cap has outgrown the time so far (k widened, pace moved)', () => {
    expect(pauseOutgrown(pause, open, PACE, { k: 6, overrideMs: null }, 7 * MIN)).toBe(true);
  });

  it('is true when the prompt belongs to another view, or none is open', () => {
    expect(pauseOutgrown(pause, { ...open, since: 1 }, PACE, AUTO, 7 * MIN)).toBe(true);
    expect(pauseOutgrown(pause, null, PACE, AUTO, 7 * MIN)).toBe(true);
  });
});
```

- [ ] **Step 6: Run it**

Run: `npx vitest run src/lib/reading-history/pause-answer.test.ts`
Expected: FAIL with `Failed to resolve import "./pause-answer"`. The module does not exist yet.

- [ ] **Step 7: Implement `pause-answer.ts`**

Create `src/lib/reading-history/pause-answer.ts`:

```ts
import { viewCap, widenedK, type IdleSettings } from './stats-engine';
import type { LivePause } from './pause-watch';
import type { PauseCount } from './types';
import type { OpenView } from './view-tracker';

/**
 * What an answer to the "Still reading?" prompt does (phase 3b), apart from
 * the DOM: the reader passes the real effects, tests pass spies.
 */
export interface PauseAnswerEffects {
  /** End the paused view with this answer and reopen it at `now` (`ViewTracker.split`). */
  split(now: number, count: PauseCount): void;
  widenIdleK(k: number): void;
  setPauseDefault(count: PauseCount): void;
  notify(message: string): void;
}

const MIN = 60_000;

/**
 * Every live answer SPLITS the view: the paused view is written now with its
 * `resolve` (one transaction), and the same pages reopen at `now`, so time
 * after the reader came back counts normally. "Still reading" also widens the
 * global `k` far enough for this view, when that can help; under a manual
 * cutoff it only says where to change it. `idle` must be the CURRENT setting
 * (`idleSettings`, not the stats' debounced copy), so a widen never writes a
 * smaller `k` than one already stored.
 */
export function answerPause(
  pause: LivePause,
  count: PauseCount,
  opts: { stillReading: boolean; always: boolean },
  pace: number | null,
  idle: IdleSettings,
  effects: PauseAnswerEffects,
  now: number = Date.now()
): void {
  effects.split(now, count);
  if (opts.stillReading) {
    const k = widenedK(now - pause.since, pause.chars, pace, idle);
    if (k !== null) {
      effects.widenIdleK(k);
      const cap = viewCap(pause.chars, pace, { ...idle, k });
      effects.notify(`Cutoff widened to ~${Math.round(cap / MIN)} min for pages like this`);
    } else if (idle.overrideMs !== null) {
      effects.notify(
        `Manual cutoff is ${Math.round(idle.overrideMs / MIN)} min — change it in Settings`
      );
    }
  }
  if (opts.always) effects.setPauseDefault(count);
}

/**
 * A shown prompt that no longer applies: its view is gone, or the open view's
 * cap (pace or cutoff moved) now ends after `now`. The watch asks again when
 * the new cap is reached.
 */
export function pauseOutgrown(
  shown: LivePause | null,
  open: OpenView | null,
  pace: number | null,
  idle: IdleSettings,
  now: number
): boolean {
  if (!shown) return false;
  if (!open || open.since !== shown.since) return true;
  const chars = open.view.page_chars.reduce((sum, c) => sum + c, 0);
  return now < open.since + viewCap(chars, pace, idle);
}
```

- [ ] **Step 8: Run it**

Run: `npx vitest run src/lib/reading-history/pause-answer.test.ts`
Expected: PASS, 11 tests. The floor case passes only if Task 2's `widenedK` returns `null` when the widened cap would not exceed the current one (ruling O4; see the notes).

- [ ] **Step 9: Write the failing component test**

Create `src/lib/components/Reader/__tests__/LongPausePrompt.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Writable } from 'svelte/store';

vi.mock('$lib/reading-history/stats-store', async () => {
  const { writable } = await import('svelte/store');
  return { readingStats: writable({ byVolume: new Map() }) };
});

import { readingStats } from '$lib/reading-history/stats-store';
import { AWAY_AFTER_MS, livePause } from '$lib/reading-history/pause-watch';
import LongPausePrompt, { DONT_ASK_AFTER, REFRESH_MS } from '../LongPausePrompt.svelte';

type Answer = 'full' | 'typical' | 'none' | null;
const stats = readingStats as unknown as Writable<{
  byVolume: Map<string, { pauses: Array<{ answer: Answer }> }>;
}>;

const MIN = 60_000;
const CAP = 4 * MIN;
const onAnswer = vi.fn();

/** `n` answered pauses (plus one provisional, which must not count). */
function answeredPauses(n: number) {
  const pauses: Array<{ answer: Answer }> = Array.from({ length: n }, () => ({
    answer: 'typical'
  }));
  stats.set({ byVolume: new Map([['v1', { pauses: [...pauses, { answer: null }] }]]) });
}
/** The open view's `since` when its 4 min cap passed `ago` ms before `now`. */
const sinceFor = (ago: number, now = Date.now()) => now - CAP - ago;
function show(since: number) {
  livePause.set({ volume: 'v1', since, chars: 400, cap: CAP, typical: 90_000 });
}

beforeEach(() => {
  livePause.set(null);
  answeredPauses(0);
  onAnswer.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LongPausePrompt', () => {
  it('is hidden with no pause', () => {
    const { queryByTestId } = render(LongPausePrompt, { props: { onAnswer } });
    expect(queryByTestId('long-pause')).toBeNull();
  });

  it('fresh: "Still reading?" with the cap and the typical time', async () => {
    show(sinceFor(0));
    const { findByText, getByRole } = render(LongPausePrompt, { props: { onAnswer } });
    expect(
      await findByText(/still reading\? the timer stopped at 4 min on this page\./i)
    ).toBeTruthy();
    expect(getByRole('status')).toBeTruthy();
    expect(getByRole('button', { name: 'Still reading' })).toBeTruthy();
    expect(getByRole('button', { name: 'Count ~2 min' })).toBeTruthy();
    expect(getByRole('button', { name: "Don't count" })).toBeTruthy();
  });

  it('away: how long the page has been open, with all / typical / none', async () => {
    expect(AWAY_AFTER_MS).toBe(2 * MIN); // O7
    show(sinceFor(AWAY_AFTER_MS + 6 * MIN)); // open 4 + 2 + 6 = 12 min
    const { findByText, getByRole, queryByRole } = render(LongPausePrompt, {
      props: { onAnswer }
    });
    expect(await findByText(/this page has been open 12 min\. count it\?/i)).toBeTruthy();
    expect(getByRole('button', { name: 'Count all (12 min)' })).toBeTruthy();
    expect(getByRole('button', { name: 'Count typical (~2 min)' })).toBeTruthy();
    expect(getByRole('button', { name: "Don't count" })).toBeTruthy();
    expect(queryByRole('button', { name: 'Still reading' })).toBeNull();
  });

  it('turns into the away copy once the cap is AWAY_AFTER_MS behind', async () => {
    const NOW = Date.UTC(2026, 9, 10, 12);
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    show(sinceFor(0, NOW));
    const { getByText, queryByText } = render(LongPausePrompt, { props: { onAnswer } });
    await tick();
    expect(getByText(/still reading\?/i)).toBeTruthy();
    vi.advanceTimersByTime(AWAY_AFTER_MS + REFRESH_MS); // open 4 min + 2 min + 10 s
    await tick();
    expect(queryByText(/still reading\?/i)).toBeNull();
    expect(getByText(/this page has been open 6 min/i)).toBeTruthy();
  });

  it(`offers "Always do this" only after ${DONT_ASK_AFTER} answered pauses`, async () => {
    expect(DONT_ASK_AFTER).toBe(3); // O7
    answeredPauses(2);
    show(sinceFor(0));
    const { findByTestId, queryByLabelText, findByLabelText } = render(LongPausePrompt, {
      props: { onAnswer }
    });
    await findByTestId('long-pause');
    expect(queryByLabelText('Always do this')).toBeNull();
    answeredPauses(3);
    expect(await findByLabelText('Always do this')).toBeTruthy();
  });

  it.each([
    ['Still reading', 'full', true],
    ['Count ~2 min', 'typical', false],
    ["Don't count", 'none', false]
  ] as const)('fresh "%s" answers %s', async (name, count, stillReading) => {
    show(sinceFor(0));
    const { findByRole, queryByTestId } = render(LongPausePrompt, { props: { onAnswer } });
    await fireEvent.click(await findByRole('button', { name }));
    expect(onAnswer).toHaveBeenCalledWith(count, { stillReading, always: false });
    expect(queryByTestId('long-pause')).toBeNull();
  });

  it.each([
    ['Count all (12 min)', 'full'],
    ['Count typical (~2 min)', 'typical'],
    ["Don't count", 'none']
  ] as const)('away "%s" answers %s, never as Still reading', async (name, count) => {
    show(sinceFor(AWAY_AFTER_MS + 6 * MIN));
    const { findByRole } = render(LongPausePrompt, { props: { onAnswer } });
    await fireEvent.click(await findByRole('button', { name }));
    expect(onAnswer).toHaveBeenCalledWith(count, { stillReading: false, always: false });
  });

  it('"Always do this" rides along with the answer; Still reading stays full', async () => {
    answeredPauses(3);
    show(sinceFor(0));
    const { findByLabelText, getByRole } = render(LongPausePrompt, { props: { onAnswer } });
    await fireEvent.click(await findByLabelText('Always do this'));
    await fireEvent.click(getByRole('button', { name: 'Still reading' }));
    expect(onAnswer).toHaveBeenCalledWith('full', { stillReading: true, always: true });
  });

  it('goes with its view, stays gone once answered, and asks again for the next view', async () => {
    const first = sinceFor(0);
    show(first);
    const { findByTestId, queryByTestId, getByRole } = render(LongPausePrompt, {
      props: { onAnswer }
    });
    await findByTestId('long-pause');
    livePause.set(null);
    await tick();
    expect(queryByTestId('long-pause')).toBeNull();

    show(first);
    await findByTestId('long-pause');
    await fireEvent.click(getByRole('button', { name: "Don't count" }));
    show(first); // the same view again (a re-fire before the reader cleared it)
    await tick();
    expect(queryByTestId('long-pause')).toBeNull();

    show(first + 1); // the continuation view
    expect(await findByTestId('long-pause')).toBeTruthy();
  });
});
```

- [ ] **Step 10: Run it**

Run: `npx vitest run src/lib/components/Reader/__tests__/LongPausePrompt.test.ts`
Expected: FAIL with `Failed to resolve import "../LongPausePrompt.svelte"`.

- [ ] **Step 11: Implement `LongPausePrompt.svelte`**

Create `src/lib/components/Reader/LongPausePrompt.svelte`:

```svelte
<script lang="ts" module>
  /** "Always do this" is offered once this many pauses are answered (any volume, any device). */
  export const DONT_ASK_AFTER = 3;
  /** How often the open-for time refreshes while the prompt is up. */
  export const REFRESH_MS = 10_000;
</script>

<script lang="ts">
  import { AWAY_AFTER_MS, livePause, type LivePause } from '$lib/reading-history/pause-watch';
  import { readingStats } from '$lib/reading-history/stats-store';
  import type { PauseCount } from '$lib/reading-history/types';

  /**
   * "Still reading?" (phase 3b): the open view reached its idle cap. It is
   * non-modal and keyboard-neutral, like the position banner, so reading goes
   * on underneath. A page turn, a hidden tab or a pause ends the view
   * unanswered; the pause then waits in the review list, counted as typical.
   * If the reader comes back a while later, the copy changes to "open N min —
   * count it?". The box keeps one width, so changing copy and the refreshing
   * time never move anything around it.
   */
  let {
    onAnswer
  }: {
    onAnswer: (count: PauseCount, opts: { stillReading: boolean; always: boolean }) => void;
  } = $props();

  /** The view (by `since`) answered here: hidden even before the reader clears the store. */
  let settled = $state<number | null>(null);
  let pause = $derived<LivePause | null>(
    $livePause && $livePause.since !== settled ? $livePause : null
  );

  let now = $state(Date.now());
  let always = $state(false);
  // Before the DOM updates, so the first paint already shows the right copy.
  $effect.pre(() => {
    if (!pause) return;
    now = Date.now();
    always = false;
    const id = setInterval(() => (now = Date.now()), REFRESH_MS);
    return () => clearInterval(id);
  });

  // Counted only while a prompt is up: one pass over the listed pauses.
  let answered = $derived.by(() => {
    if (!pause) return 0;
    let n = 0;
    for (const totals of $readingStats.byVolume.values()) {
      for (const p of totals.pauses) if (p.answer !== null) n++;
    }
    return n;
  });

  let away = $derived(pause !== null && now - (pause.since + pause.cap) > AWAY_AFTER_MS);
  let elapsed = $derived(pause ? minutes(now - pause.since) : '');
  let typical = $derived(pause ? minutes(pause.typical) : '');

  function minutes(ms: number): string {
    const total = Math.max(1, Math.round(ms / 60_000));
    if (total < 60) return `${total} min`;
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  function answer(count: PauseCount, stillReading = false) {
    if (!pause) return;
    settled = pause.since;
    onAnswer(count, { stillReading, always });
  }
</script>

{#if pause}
  <div
    class="fixed bottom-16 left-1/2 z-20 flex w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg px-4 py-2 text-sm text-white shadow-lg"
    style="backdrop-filter: blur(8px); background-color: rgba(17, 24, 39, 0.9);"
    role="status"
    data-testid="long-pause"
  >
    {#if away}
      <span class="w-full">This page has been open {elapsed}. Count it?</span>
      <span class="relative z-10 flex flex-wrap gap-2">
        <button
          class="rounded bg-primary-700 px-2 py-1 font-medium hover:bg-primary-600"
          onclick={() => answer('full')}>Count all ({elapsed})</button
        >
        <button
          class="rounded bg-gray-700 px-2 py-1 hover:bg-gray-600"
          onclick={() => answer('typical')}>Count typical (~{typical})</button
        >
        <button
          class="rounded px-2 py-1 text-gray-400 hover:text-white"
          onclick={() => answer('none')}>Don't count</button
        >
      </span>
    {:else}
      <span class="w-full"
        >Still reading? The timer stopped at {minutes(pause.cap)} on this page.</span
      >
      <span class="relative z-10 flex flex-wrap gap-2">
        <button
          class="rounded bg-primary-700 px-2 py-1 font-medium hover:bg-primary-600"
          onclick={() => answer('full', true)}>Still reading</button
        >
        <button
          class="rounded bg-gray-700 px-2 py-1 hover:bg-gray-600"
          onclick={() => answer('typical')}>Count ~{typical}</button
        >
        <button
          class="rounded px-2 py-1 text-gray-400 hover:text-white"
          onclick={() => answer('none')}>Don't count</button
        >
      </span>
    {/if}
    {#if answered >= DONT_ASK_AFTER}
      <label class="relative z-10 flex items-center gap-1 text-gray-300">
        <input type="checkbox" class="rounded" bind:checked={always} />
        Always do this
      </label>
    {/if}
  </div>
{/if}
```

- [ ] **Step 12: Run it**

Run: `npx vitest run src/lib/components/Reader/__tests__/LongPausePrompt.test.ts`
Expected: PASS, 13 tests (5 single tests, two `it.each` tables of 3, and the lifecycle test).

- [ ] **Step 13: Wire Timer to count by the answer**

Edit `src/lib/components/Reader/Timer.svelte` in three places.

Imports, lines 9-10. Before:

```ts
import { liveMinutes, liveView, readingPaused } from '$lib/reading-history/live-view';
import { viewCap } from '$lib/reading-history/stats-engine';
```

After:

```ts
import { liveAnswer, liveMinutes, liveView, readingPaused } from '$lib/reading-history/live-view';
import { typicalDwell, viewCap } from '$lib/reading-history/stats-engine';
```

Doc comment, lines 12-18. Before:

```ts
/**
 * Time read in this volume, live (phase 3a, one clock): the counted reading
 * history plus the view on screen now, up to its idle cap — the same rule
 * the stats apply once the view ends. Past the cap it shows "Idle" and stops
 * counting. Clicking pauses: the view ends and nothing counts until the next
 * page or a second click.
 */
```

After:

```ts
/**
 * Time read in this volume, live (phase 3a, one clock): the counted reading
 * history plus the view on screen now, counted by the rule the stats apply
 * once the view ends (`countedDwell`): its dwell up to the idle cap, then the
 * typical time, or everything when a standing "Count all" default answered
 * it (phase 3b). Past the cap it shows "Idle" unless that default keeps it
 * counting. Clicking pauses: the view ends and nothing counts until the next
 * page or a second click.
 */
```

Cap, computed time and status, lines 33-56. Before:

```ts
let open = $derived($liveView?.view.volume === volumeId ? $liveView : null);
let cap = $derived(
  open
    ? viewCap(
        open.view.page_chars.reduce((sum, c) => sum + c, 0),
        $readingStats.pace,
        $readingStats.idle
      )
    : 0
);
let counted = $derived(figuresFor($readingStats, volumeId, $volumes[volumeId]).timeMs);
let computed = $derived(liveMinutes(counted, open, now, cap));
```

After:

```ts
let open = $derived($liveView?.view.volume === volumeId ? $liveView : null);
let chars = $derived(open ? open.view.page_chars.reduce((sum, c) => sum + c, 0) : 0);
let cap = $derived(open ? viewCap(chars, $readingStats.pace, $readingStats.idle) : 0);
let typical = $derived(open ? typicalDwell(chars, $readingStats.pace, cap) : 0);
let counted = $derived(figuresFor($readingStats, volumeId, $volumes[volumeId]).timeMs);
let computed = $derived(liveMinutes(counted, open, now, cap, typical, $liveAnswer));
```

Before:

```ts
let status = $derived(
  $readingPaused || !open ? 'Paused' : now - open.since > cap ? 'Idle' : 'Active'
);
```

After:

```ts
let status = $derived(
  $readingPaused || !open
    ? 'Paused'
    : now - open.since > cap && $liveAnswer !== 'full'
      ? 'Idle'
      : 'Active'
);
```

- [ ] **Step 14: Wire Reader (watch, prompt, answers, emit)**

Edit `src/lib/components/Reader/Reader.svelte` in six places.

Line 33. Before:

```ts
import PositionOfferBanner from './PositionOfferBanner.svelte';
```

After:

```ts
import PositionOfferBanner from './PositionOfferBanner.svelte';
import LongPausePrompt from './LongPausePrompt.svelte';
```

Lines 95-102. Before:

```ts
import { ViewTracker, viewKey } from '$lib/reading-history/view-tracker';
import { liveView, readingPaused } from '$lib/reading-history/live-view';
import {
  describeView,
  rangeScopeKey,
  type ContinuousRange
} from '$lib/reading-history/describe-view';
import { recordEvent } from '$lib/reading-history/record';
```

After:

```ts
import { ViewTracker, viewKey } from '$lib/reading-history/view-tracker';
import { liveAnswer, liveView, readingPaused } from '$lib/reading-history/live-view';
import {
  describeView,
  rangeScopeKey,
  type ContinuousRange
} from '$lib/reading-history/describe-view';
import { recordView } from '$lib/reading-history/record';
import { PauseWatch, livePause } from '$lib/reading-history/pause-watch';
import { answerPause, pauseOutgrown } from '$lib/reading-history/pause-answer';
import { readingStats } from '$lib/reading-history/stats-store';
import type { PauseCount } from '$lib/reading-history/types';
import {
  idleSettings,
  pauseDefault,
  setPauseDefault,
  widenIdleK
} from '$lib/settings/tracking-data';
```

Unmount cleanup, lines 512-513. Before:

```ts
viewTracker.close(Date.now());
readingPaused.set(false);
```

After:

```ts
viewTracker.close(Date.now());
pauseWatch.dispose();
livePause.set(null);
liveAnswer.set(null);
readingPaused.set(false);
```

Lines 629-634. Before:

```ts
// Reading history: one `page` event per view, emitted when the view ends.
// Hidden tab = no view, so a backgrounded reader never accrues dwell.
const viewTracker = new ViewTracker(
  (payload, t) => void recordEvent(payload, t),
  (open) => liveView.set(open)
);
```

After:

```ts
// Reading history: one `page` event per view, emitted when the view ends,
// with its long-pause answer (if any) in the same transaction.
// Hidden tab = no view, so a backgrounded reader never accrues dwell.
const viewTracker = new ViewTracker(
  (payload, t, answer) => void recordView(payload, t, answer),
  (open) => {
    // A new view (or none): anything asked about the last one is moot.
    liveView.set(open);
    livePause.set(null);
    liveAnswer.set(null);
  }
);
// At the open view's cap, a standing default answers silently (written
// when the view ends). Otherwise the "Still reading?" prompt asks.
const pauseWatch = new PauseWatch((pause) => {
  const preset = get(pauseDefault);
  if (preset) {
    viewTracker.setAnswer(preset);
    liveAnswer.set(preset);
  } else livePause.set(pause);
});

function onPauseAnswer(count: PauseCount, opts: { stillReading: boolean; always: boolean }) {
  const pause = get(livePause);
  const open = get(liveView);
  if (!pause || !open || open.since !== pause.since) return;
  answerPause(pause, count, opts, get(readingStats).pace, get(idleSettings), {
    split: (now, answer) => viewTracker.split(now, answer),
    widenIdleK,
    setPauseDefault,
    notify: (message) => showSnackbar(message)
  });
}
```

Lines 1187-1189: keep the existing effect and add a new one after it. Before:

```ts
$effect(() => {
  viewTracker.setView(pageHidden || $readingPaused ? null : currentView, Date.now());
});
```

After:

```ts
$effect(() => {
  viewTracker.setView(pageHidden || $readingPaused ? null : currentView, Date.now());
});

// Re-arm the cap watch on every view, pace or cutoff change. This is an
// effect, not a $derived, because it sets a timer. If the cap has grown past
// the time so far, a shown prompt is taken down; the watch asks again when
// the new cap is reached.
$effect(() => {
  const open = $liveView;
  const { pace, idle } = $readingStats;
  pauseWatch.update(open, pace, idle);
  if (pauseOutgrown(get(livePause), open, pace, idle, Date.now())) livePause.set(null);
});
```

Lines 1678-1684. Before:

```svelte
{#if volume && pages?.length}
  <PositionOfferBanner volumeId={volume.volume_uuid} pageCount={pages.length} currentPage={page} />
{/if}
```

After:

```svelte
{#if volume && pages?.length}
  <PositionOfferBanner volumeId={volume.volume_uuid} pageCount={pages.length} currentPage={page} />
  <LongPausePrompt onAnswer={onPauseAnswer} />
{/if}
```

- [ ] **Step 15: Type-check, format, and run the neighbouring suites**

Run: `npx prettier --write src/lib/components/Reader/LongPausePrompt.svelte src/lib/components/Reader/__tests__/LongPausePrompt.test.ts src/lib/components/Reader/Reader.svelte src/lib/components/Reader/Timer.svelte src/lib/reading-history/live-view.ts src/lib/reading-history/live-view.test.ts src/lib/reading-history/pause-answer.ts src/lib/reading-history/pause-answer.test.ts`
Expected: the files are rewritten. Only class ordering and line wrapping change.

Run: `npm run check 2>&1 | tail -3`
Expected: `svelte-check found 0 errors`. Warnings are allowed only if the same warnings appear on f582f030.

Run: `npx vitest run src/lib/reading-history src/lib/components/Reader`
Expected: PASS for every suite, including the new ones and the unchanged `view-tracker.test.ts`, `PositionOfferBanner.test.ts` and `stats-store.test.ts`.

The behaviour in the real app is checked by Task 8 (`E2E_PORT=5199 npx playwright test e2e/long-pauses.spec.ts`), which drives this exact wiring.

- [ ] **Step 16: Commit**

```bash
git add src/lib/components/Reader/LongPausePrompt.svelte \
  src/lib/components/Reader/__tests__/LongPausePrompt.test.ts \
  src/lib/components/Reader/Reader.svelte \
  src/lib/components/Reader/Timer.svelte \
  src/lib/reading-history/live-view.ts \
  src/lib/reading-history/live-view.test.ts \
  src/lib/reading-history/pause-answer.ts \
  src/lib/reading-history/pause-answer.test.ts
git commit -m "$(cat <<'EOF'
feat(history): "Still reading?" at a view's cap, answers split the view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Notes for the plan author

- **Task 2 must implement O4 beyond the formula as written.** The design's `widenedK` returns 20 for a page held at the floor. For example, with 10 chars at 300 ms/char, the `fit` is 45 and `min(K_MAX, reachCeiling, …)` = 20 > 3, yet k=20 still gives the 60 s floor. Ruling O4 says it must return `null` when it cannot help. Task 2 needs an explicit check: return null when `viewCap(chars, pace, {...idle, k: next}) <= viewCap(chars, pace, idle)`. The floor test in `pause-answer.test.ts` (Step 5) fails until it has one. Without the check, "Still reading" on an art page would also raise the global `k` to 20 for every view.
- **Files beyond the three the task names.**
  - `live-view.ts` gains `liveAnswer`, and `liveMinutes` gains the `typical`/`answer` parameters. The design asks Timer for a "presetAnswer" but gives it no source, and Timer is mounted by `ReaderView`, so it cannot see the `ViewTracker`.
  - `pause-answer.ts` holds the answer steps (split, then widen plus snackbar, then default) and the stale-prompt check, so they are unit-tested. `Reader.svelte` has no unit tests.
- **The prompt takes no pace/idle props.** The design's component "reads `readingStats.pace`/`idle`", but this version does not need them. The widen maths and the snackbar live in the Reader handler. `LivePause` already carries `cap`/`typical`.
- **Assumed `PauseWatch` behaviour (Task 5).**
  - The Reader calls `update()` on every `readingStats` emission. That only means re-arming when `since` or `cap` changed, and never re-firing the same `since`/`cap`, as the design says.
  - Taking a shown prompt down when the cap grows past the time so far is done in the Reader (`pauseOutgrown`), not inside the watch. The design's edge-case table requires it, but `PauseWatch` only has `onCap`.
- **Assumed `ViewTracker.split` behaviour (Task 4).** `split` calls `onChange` synchronously with the new `since`. The Reader clears `livePause` and `liveAnswer` in `onChange`, which is how the prompt goes away after an answer. The component also hides itself by `since` (`settled`), so it never depends on that order.
- **`answerPause` reads `idle` from `idleSettings`, not from `readingStats.idle`.** The stats copy is debounced by 500 ms. A second "Still reading" inside that window could otherwise write a smaller `k` than the one stored, because `widenIdleK` has no max guard in the design. The watch and Timer keep using `readingStats` (pace and idle), which matches the 3a Timer.
- **The Timer figure stays high after an unanswered pause.** With `countedDwell`, an unanswered view's live part drops from `cap` to `typical` when it crosses the cap. Timer's never-step-back `shown` guard holds the higher figure until the volume remounts. The same overstatement exists in 3a, where the live part clamps at the cap and the engine counts typical. This task does not change it; Task 8 should assert "counts past 1 min" only after an answer.
- **Placement.** The prompt sits at `bottom-16`, centred, with a fixed width `w-[min(34rem,calc(100vw-2rem))]`.
  - That width means neither the away-copy switch nor the 10 s refresh resizes the box (the no-layout-motion rule).
  - QuickActions sits at `end-3 bottom-3 z-50` and does not reach 64 px, so the two do not overlap.
  - It is not a dialog, so the modal `relative z-10` rule does not apply; the button row and the checkbox carry it anyway, as the banner's do.
- **Task 8 (e2e) copy, as rendered here.**
  - Fresh: `Still reading? The timer stopped at N min on this page.`
  - Away: `This page has been open N min. Count it?`
  - Buttons: `Still reading`, `Count ~N min`, `Don't count`, `Count all (N min)`, `Count typical (~N min)`
  - Checkbox label: `Always do this`
  - With the 1-minute override in step 3 of the e2e, "Still reading" shows the snackbar `Manual cutoff is 1 min — change it in Settings`, not a widen message.

---

### Task 7: The long-pause review list, its store and the standing-default setting

**Files:**

- Create: `src/lib/reading-history/pause-review.ts`
- Create: `src/lib/reading-history/pause-review.test.ts`
- Create: `src/lib/components/Stats/LongPausesCard.svelte` (new directory `components/Stats/`)
- Create: `src/lib/components/Stats/__tests__/LongPausesCard.test.ts`
- Create: `src/lib/components/Settings/Reader/LongPauseSetting.svelte`
- Create: `src/lib/components/Settings/Reader/__tests__/LongPauseSetting.test.ts`
- Create: `src/lib/views/__tests__/ReadingSpeedView.pauses.test.ts`
- Modify: `src/lib/views/ReadingSpeedView.svelte`
  - :13: one import line after `import { figuresFor, readingStats } from '$lib/reading-history/stats-store';`
  - :1210–1214: insert the card between the stats-cards grid's closing `</div>` (:1210) and `<!-- Achievement Badges -->` (:1214)
- Modify: `src/lib/components/Settings/Reader/ReaderToggles.svelte`
  - :13: one import after `import IdleCutoffSetting from './IdleCutoffSetting.svelte';`
  - :129: mount the setting after `<IdleCutoffSetting />`
- Modify (test only): `src/lib/components/Settings/Reader/__tests__/ReaderToggles.editmode.test.ts` (append a describe block at the end of the file)

**Interfaces:**

Consumes, from earlier tasks:

- Task 1 (`types.ts`): `export type PauseCount = 'full' | 'typical' | 'none';`
- Task 1 (`record.ts`): `export function recordResolve(volume: string, target: [string, number], count: PauseCount, t?: number, db?: HistoryDexie): Promise<ReadingEvent | null>`
- Task 2 (`stats-engine.ts`): `export interface Pause { device: string; seq: number; t: number; page: number; dwell: number; cap: number; typical: number; counted: number; answer: PauseCount | null }`, and `VolumeTotals.pauses: Pause[]`
- Task 3 (`tracking-data.ts`):
  - `TrackingState.pauses?: PausesEntry`, where `PausesEntry = { default: PauseCount | null; lastUpdated: string }`
  - `export function setPauseDefault(count: PauseCount | null): void`
  - `export const pauseDefault: Readable<PauseCount | null>`
  - `export function resetIdleK(): void`, which writes `idle.k = DEFAULT_K` and keeps `override_minutes`
- Existing code:
  - `readingStats: Readable<ReadingStatsState>` (`stats-store.ts`), with `byVolume: Map<string, VolumeTotals>`
  - `idleSettings: Readable<IdleSettings>` (`tracking-data.ts`)
  - `DEFAULT_K` (`stats-engine.ts`)
  - `formatDuration(minutes: number)` and `formatRelativeDate(date: Date)` (`$lib/util/reading-speed-history`)

Produces, in `pause-review.ts`. The design's names are kept. Three additions are explained in the notes: the `PauseReview` type name, `reviewPauses`/`pauseKey`, and `pauseVolumeTitle`.

```ts
export interface ReviewPause extends Pause {
  volume: string;
}
export interface PauseReview {
  pauses: ReviewPause[];
  unanswered: number;
  answered: number;
}
export function pauseKey(p: Pick<Pause, 'device' | 'seq'>): string;
export function reviewPauses(
  byVolume: ReadonlyMap<string, Pick<VolumeTotals, 'pauses'>>
): PauseReview;
export function pauseVolumeTitle(
  volume: string,
  catalog: Record<string, TitleSource> | undefined,
  records: Record<string, TitleSource>
): string;
export const pauseReview: Readable<PauseReview>; // derived(readingStats), newest first
```

The components:

- `LongPausesCard.svelte` has props `{ titleOf: (volume: string) => string }`.
- `LongPauseSetting.svelte` takes no props.

---

- [ ] **Step 1: Write the failing test for the review store**

`src/lib/reading-history/pause-review.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { get: vi.fn(async () => undefined), bulkGet: vi.fn(async () => []) },
    volume_ocr: { get: vi.fn(async () => undefined) }
  }
}));

import { get } from 'svelte/store';
import { clearVolumes } from '$lib/settings/volume-data';
import { setTrackingStates } from '$lib/settings/tracking-data';
import { HistoryDexie } from './history-db';
import { appendEvent, recordResolve } from './record';
import { _resetHistoryTurns, loadHistoryTurns } from './turns-store';
import { _resetReadingStatsForTests, flushReadingStats, initReadingStats } from './stats-store';
import { pauseKey, pauseReview, pauseVolumeTitle, reviewPauses } from './pause-review';
import type { Pause, VolumeTotals } from './stats-engine';
import type { PagePayload, ReadingEvent } from './types';

const MIN = 60_000;
let db: HistoryDexie;

const page = (volume: string, p: number, chars: number, dwell: number): PagePayload => ({
  kind: 'page',
  volume,
  first_page: p,
  last_page: p,
  page_chars: [chars],
  chars_before: 0,
  dwell_ms: dwell,
  layout: 'single',
  orientation: 'portrait',
  viewport: null
});

/** Let turns-store hand the stored events on (a microtask), then count now. */
async function settle(): Promise<void> {
  await Promise.resolve();
  flushReadingStats();
}

async function view(
  volume: string,
  t: number,
  p: number,
  chars: number,
  dwell: number
): Promise<ReadingEvent> {
  const event = await appendEvent(db, page(volume, p, chars, dwell), t);
  await settle();
  return event;
}

beforeEach(async () => {
  clearVolumes();
  window.localStorage.clear();
  setTrackingStates({});
  _resetHistoryTurns();
  _resetReadingStatsForTests();
  db = new HistoryDexie(`pauses-${Math.random()}`);
  await loadHistoryTurns(db);
  initReadingStats();
  flushReadingStats();
});

describe('pauseReview', () => {
  // No pace yet (fewer than 30 views): every cap is the fixed 5 minutes, and
  // a view over it counts the cap itself as its typical time.
  it('lists a view left open past its cap as provisional, counting typical time', async () => {
    const e = await view('v1', 0, 4, 300, 10 * MIN);
    const review = get(pauseReview);
    expect(review).toMatchObject({ unanswered: 1, answered: 0 });
    expect(review.pauses).toEqual([
      {
        volume: 'v1',
        device: e.device,
        seq: e.seq,
        t: 0,
        page: 4,
        dwell: 10 * MIN,
        cap: 5 * MIN,
        typical: 5 * MIN,
        counted: 5 * MIN,
        answer: null
      }
    ]);
  });

  it('does not list a view within its cap', async () => {
    await view('v1', 0, 1, 300, 4 * MIN);
    expect(get(pauseReview)).toEqual({ pauses: [], unanswered: 0, answered: 0 });
  });

  it("takes an answer from the list: the pause counts it and moves to 'answered'", async () => {
    const e = await view('v1', 0, 1, 300, 10 * MIN);
    await recordResolve('v1', [e.device, e.seq], 'full', 20 * MIN, db);
    await settle();
    const review = get(pauseReview);
    expect(review).toMatchObject({ unanswered: 0, answered: 1 });
    expect(review.pauses[0]).toMatchObject({ answer: 'full', counted: 10 * MIN });
  });

  it('flattens every volume, newest first', async () => {
    await view('v1', 0, 1, 300, 10 * MIN);
    await view('v2', 60 * MIN, 1, 300, 10 * MIN);
    expect(get(pauseReview).pauses.map((p) => p.volume)).toEqual(['v2', 'v1']);
  });
});

describe('reviewPauses', () => {
  const pause = (seq: number, t: number, answer: Pause['answer'] = null): Pause => ({
    device: 'd',
    seq,
    t,
    page: 1,
    dwell: 10 * MIN,
    cap: 5 * MIN,
    typical: 5 * MIN,
    counted: 5 * MIN,
    answer
  });
  const totals = (pauses: Pause[]): Pick<VolumeTotals, 'pauses'> => ({ pauses });

  it('sorts newest first and counts answered and unanswered', () => {
    const review = reviewPauses(
      new Map([
        ['a', totals([pause(1, 100), pause(3, 300, 'none')])],
        ['b', totals([pause(2, 200)])]
      ])
    );
    expect(review.pauses.map((p) => [p.volume, p.seq])).toEqual([
      ['a', 3],
      ['b', 2],
      ['a', 1]
    ]);
    expect(review).toMatchObject({ unanswered: 2, answered: 1 });
  });

  it("reuses a volume's rows while its totals are unchanged (a page turn recounts one volume)", () => {
    const a = totals([pause(1, 100)]);
    const first = reviewPauses(
      new Map([
        ['a', a],
        ['b', totals([pause(2, 200)])]
      ])
    );
    const second = reviewPauses(
      new Map([
        ['a', a],
        ['b', totals([pause(2, 200)])]
      ])
    );
    const rowOf = (r: typeof first, volume: string) => r.pauses.find((p) => p.volume === volume);
    expect(rowOf(second, 'a')).toBe(rowOf(first, 'a'));
    expect(rowOf(second, 'b')).not.toBe(rowOf(first, 'b'));
  });

  it('keys a pause by its page event', () => {
    expect(pauseKey({ device: 'dev-a', seq: 7 })).toBe('dev-a\u00007');
  });
});

describe('pauseVolumeTitle', () => {
  it('names the volume from its catalog row', () => {
    expect(
      pauseVolumeTitle('v1', { v1: { series_title: 'Dr Stone', volume_title: 'Dr Stone 01' } }, {})
    ).toBe('Dr Stone — Dr Stone 01');
  });

  it('falls back to the reading record, then to a placeholder name', () => {
    expect(
      pauseVolumeTitle('v1', undefined, {
        v1: { series_title: 'Frieren', volume_title: 'Frieren 02' }
      })
    ).toBe('Frieren — Frieren 02');
    expect(pauseVolumeTitle('v1', {}, {})).toBe('Unknown volume');
  });

  it('does not repeat a volume title equal to its series', () => {
    expect(
      pauseVolumeTitle('v1', { v1: { series_title: 'Oneshot', volume_title: 'Oneshot' } }, {})
    ).toBe('Oneshot');
  });
});
```

- [ ] **Step 2: Run it**

`npx vitest run src/lib/reading-history/pause-review.test.ts`

Expected: FAIL, because `./pause-review` does not exist yet (`Failed to resolve import "./pause-review"`).

- [ ] **Step 3: Implement the store**

`src/lib/reading-history/pause-review.ts`:

```ts
import { derived, type Readable } from 'svelte/store';
import type { Pause, VolumeTotals } from './stats-engine';
import { readingStats } from './stats-store';

/**
 * The "long pauses to review" list (phase 3b; spec: "Long pauses"): every
 * volume's pauses, flattened, newest first. A pause is a view left open past
 * its cap, plus any view that has been answered. Derived from
 * `readingStats`, so an answer recorded anywhere (the reader's prompt, this
 * list, another device) appears here once the stats recount.
 *
 * Unanswered pauses count typical time and are PROVISIONAL. `answered` is
 * also the "answered a few prompts" count that unlocks "Always do this". It
 * is derived rather than stored, so it syncs with the events themselves.
 */

export interface ReviewPause extends Pause {
  volume: string;
}

export interface PauseReview {
  pauses: ReviewPause[];
  unanswered: number;
  answered: number;
}

type TitleSource = { series_title?: string; volume_title?: string };

/**
 * One volume's rows, built once per `VolumeTotals` object. A page turn
 * recounts only its own volume and keeps every other volume's totals object
 * (`flushReadingStats`), so the other volumes' rows are reused.
 */
const rowsOf = new WeakMap<Pick<VolumeTotals, 'pauses'>, ReviewPause[]>();

/** A pause's identity: its page event's `[device, seq]`. */
export function pauseKey(p: Pick<Pause, 'device' | 'seq'>): string {
  return `${p.device}\u0000${p.seq}`;
}

export function reviewPauses(
  byVolume: ReadonlyMap<string, Pick<VolumeTotals, 'pauses'>>
): PauseReview {
  const pauses: ReviewPause[] = [];
  for (const [volume, totals] of byVolume) {
    if (totals.pauses.length === 0) continue;
    let rows = rowsOf.get(totals);
    if (!rows) {
      rows = totals.pauses.map((p) => ({ ...p, volume }));
      rowsOf.set(totals, rows);
    }
    for (const row of rows) pauses.push(row);
  }
  pauses.sort((a, b) => b.t - a.t || a.device.localeCompare(b.device) || b.seq - a.seq);
  let answered = 0;
  for (const p of pauses) if (p.answer !== null) answered++;
  return { pauses, unanswered: pauses.length - answered, answered };
}

/** "Series — Volume" from the catalog row, else the reading record. */
export function pauseVolumeTitle(
  volume: string,
  catalog: Record<string, TitleSource> | undefined,
  records: Record<string, TitleSource>
): string {
  const row = catalog?.[volume];
  const record = records[volume];
  const series = row?.series_title || record?.series_title;
  const title = row?.volume_title || record?.volume_title;
  const parts = [series, title && title !== series ? title : undefined].filter(
    (part): part is string => !!part
  );
  return parts.length > 0 ? parts.join(' — ') : 'Unknown volume';
}

export const pauseReview: Readable<PauseReview> = derived(readingStats, ($stats) =>
  reviewPauses($stats.byVolume)
);
```

- [ ] **Step 4: Run it**

`npx vitest run src/lib/reading-history/pause-review.test.ts`

Expected: PASS (10 tests).

- [ ] **Step 5: Write the failing test for the review card**

`src/lib/components/Stats/__tests__/LongPausesCard.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { writable, type Writable } from 'svelte/store';
import type { PauseReview, ReviewPause } from '$lib/reading-history/pause-review';

const state = vi.hoisted(() => ({
  review: null as unknown as Writable<PauseReview>
}));
const recordResolve = vi.hoisted(() => vi.fn(async () => null));

vi.mock('$lib/reading-history/pause-review', () => ({
  pauseReview: {
    subscribe: (run: (value: PauseReview) => void) => state.review.subscribe(run)
  },
  pauseKey: (p: { device: string; seq: number }) => `${p.device}\u0000${p.seq}`
}));
vi.mock('$lib/reading-history/record', () => ({ recordResolve }));

import LongPausesCard from '../LongPausesCard.svelte';

const MIN = 60_000;
const titleOf = (volume: string) => `Title ${volume}`;

const pause = (seq: number, over: Partial<ReviewPause> = {}): ReviewPause => ({
  volume: 'v1',
  device: 'dev-a',
  seq,
  t: Date.now() - 2 * MIN,
  page: 3,
  dwell: 12 * MIN,
  cap: 5 * MIN,
  typical: 4 * MIN,
  counted: 4 * MIN,
  answer: null,
  ...over
});

function listOf(pauses: ReviewPause[]): PauseReview {
  const answered = pauses.filter((p) => p.answer !== null).length;
  return { pauses, unanswered: pauses.length - answered, answered };
}

beforeEach(() => {
  state.review = writable(listOf([]));
  recordResolve.mockClear();
});
afterEach(cleanup);

describe('LongPausesCard', () => {
  it('renders nothing without pauses', () => {
    const { queryByText } = render(LongPausesCard, { props: { titleOf } });
    expect(queryByText(/Long pauses to review/)).toBeNull();
  });

  it('lists an unanswered pause as provisional, with its title, page and times', () => {
    state.review.set(listOf([pause(1)]));
    const { getByText, getAllByTestId } = render(LongPausesCard, { props: { titleOf } });
    expect(getByText('Long pauses to review (1)')).toBeTruthy();
    const row = getAllByTestId('long-pause-row')[0];
    expect(within(row).getByText('Title v1')).toBeTruthy();
    expect(within(row).getByText(/page 3 · open 12 min · counted 4 min/)).toBeTruthy();
    expect(within(row).getByText('provisional')).toBeTruthy();
    for (const name of ['All', 'Typical', 'None']) {
      expect(within(row).getByRole('button', { name }).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('answering records a resolve for that page event and keeps the row in place', async () => {
    state.review.set(listOf([pause(7)]));
    const { getByText, getAllByTestId } = render(LongPausesCard, { props: { titleOf } });
    const row = getAllByTestId('long-pause-row')[0];
    await fireEvent.click(within(row).getByRole('button', { name: 'Typical' }));
    expect(recordResolve).toHaveBeenCalledWith('v1', ['dev-a', 7], 'typical');
    // Shown at once, before the stats recount lands.
    expect(within(row).getByRole('button', { name: 'Typical' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(within(row).queryByText('provisional')).toBeNull();
    // The recount lands: the row stays put (no vanishing rows on this visit).
    state.review.set(listOf([pause(7, { answer: 'typical' })]));
    await tick();
    expect(getAllByTestId('long-pause-row')).toEqual([row]);
    expect(getByText('Long pauses to review (0)')).toBeTruthy();
  });

  it('keeps answered pauses behind "Show answered", and an answer there can be changed', async () => {
    state.review.set(listOf([pause(1), pause(2, { answer: 'full', counted: 12 * MIN })]));
    const { getByRole, getAllByTestId } = render(LongPausesCard, { props: { titleOf } });
    expect(getAllByTestId('long-pause-row')).toHaveLength(1);
    await fireEvent.click(getByRole('button', { name: 'Show answered (1)' }));
    const rows = getAllByTestId('long-pause-row');
    expect(rows).toHaveLength(2);
    const answered = rows[1];
    expect(within(answered).queryByText('provisional')).toBeNull();
    expect(within(answered).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    await fireEvent.click(within(answered).getByRole('button', { name: 'None' }));
    expect(recordResolve).toHaveBeenCalledWith('v1', ['dev-a', 2], 'none');
    expect(
      within(answered).getByRole('button', { name: 'None' }).getAttribute('aria-pressed')
    ).toBe('true');
    expect(getAllByTestId('long-pause-row')).toHaveLength(2);
  });

  it('shows 50 rows at a time', async () => {
    state.review.set(listOf(Array.from({ length: 60 }, (_, i) => pause(i + 1))));
    const { getByRole, queryByRole, getAllByTestId } = render(LongPausesCard, {
      props: { titleOf }
    });
    expect(getAllByTestId('long-pause-row')).toHaveLength(50);
    await fireEvent.click(getByRole('button', { name: 'Show more' }));
    expect(getAllByTestId('long-pause-row')).toHaveLength(60);
    expect(queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});
```

- [ ] **Step 6: Run it**

`npx vitest run src/lib/components/Stats/__tests__/LongPausesCard.test.ts`

Expected: FAIL, because `../LongPausesCard.svelte` does not exist (`Failed to resolve import "../LongPausesCard.svelte"`).

- [ ] **Step 7: Implement the card**

`src/lib/components/Stats/LongPausesCard.svelte`:

```svelte
<script lang="ts">
  import { Badge, Button, Card } from 'flowbite-svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { pauseKey, pauseReview, type ReviewPause } from '$lib/reading-history/pause-review';
  import { recordResolve } from '$lib/reading-history/record';
  import type { PauseCount } from '$lib/reading-history/types';
  import { formatDuration, formatRelativeDate } from '$lib/util/reading-speed-history';

  /**
   * "Long pauses to review" (phase 3b; spec: "Long pauses"): pages left open
   * past the idle cutoff. An unanswered pause counts typical time and is
   * marked provisional. Any answer can be changed later; each change is a new
   * `resolve` event, and the latest wins on every device.
   *
   * No layout motion. A pause answered on this visit keeps its place, so the
   * list does not shrink under the pointer. The provisional badge sits in a
   * fixed-width slot, so answering never re-flows the row.
   */
  let { titleOf }: { titleOf: (volume: string) => string } = $props();

  const PAGE_SIZE = 50;
  const CHOICES: ReadonlyArray<{ count: PauseCount; label: string }> = [
    { count: 'full', label: 'All' },
    { count: 'typical', label: 'Typical' },
    { count: 'none', label: 'None' }
  ];

  /** Pauses answered on this visit from the unanswered list: they stay there. */
  const kept = new SvelteSet<string>();
  /**
   * Answers given here, shown at once. The stats recount lands ~0.5 s later.
   * Each one is shown only while the stored answer is still the one it
   * replaced, so a newer answer from another device takes over.
   */
  const picked = new SvelteMap<string, { count: PauseCount; over: PauseCount | null }>();
  let showAnswered = $state(false);
  let limit = $state(PAGE_SIZE);

  let open = $derived(
    $pauseReview.pauses.filter((p) => p.answer === null || kept.has(pauseKey(p)))
  );
  let done = $derived(
    $pauseReview.pauses.filter((p) => p.answer !== null && !kept.has(pauseKey(p)))
  );
  let rows = $derived(showAnswered ? [...open, ...done] : open);
  let shown = $derived(rows.slice(0, limit));

  function answerOf(p: ReviewPause): PauseCount | null {
    const mine = picked.get(pauseKey(p));
    return mine && mine.over === p.answer ? mine.count : p.answer;
  }

  function choose(p: ReviewPause, count: PauseCount): void {
    const key = pauseKey(p);
    if (p.answer === null) kept.add(key);
    picked.set(key, { count, over: p.answer });
    void recordResolve(p.volume, [p.device, p.seq], count);
  }

  const minutes = (ms: number) => formatDuration(ms / 60_000);
</script>

{#if $pauseReview.pauses.length > 0}
  <Card class="mb-6 w-full max-w-none p-6" data-testid="long-pauses">
    <h2 class="mb-1 text-xl font-semibold">Long pauses to review ({$pauseReview.unanswered})</h2>
    <p class="mb-4 text-sm text-gray-400">
      Pages left open past the idle cutoff. Until you answer, each one counts a typical time for its
      page.
    </p>
    {#if shown.length > 0}
      <ul class="divide-y divide-gray-200 dark:divide-gray-700">
        {#each shown as p (pauseKey(p))}
          {@const answer = answerOf(p)}
          <li
            class="flex flex-wrap items-center justify-between gap-3 py-3"
            data-testid="long-pause-row"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium">{titleOf(p.volume)}</p>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                {formatRelativeDate(new Date(p.t))} · page {p.page} · open {minutes(p.dwell)} · counted
                {minutes(p.counted)}
              </p>
            </div>
            <div class="flex items-center gap-3">
              <span class="inline-flex w-24 justify-end">
                {#if answer === null}
                  <Badge color="yellow">provisional</Badge>
                {/if}
              </span>
              <div
                role="group"
                aria-label="Count this pause"
                class="inline-flex overflow-hidden rounded-lg border border-gray-300 dark:border-gray-600"
              >
                {#each CHOICES as choice (choice.count)}
                  <button
                    type="button"
                    aria-pressed={answer === choice.count}
                    class="px-3 py-1 text-sm {answer === choice.count
                      ? 'bg-primary-700 text-white'
                      : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'}"
                    onclick={() => choose(p, choice.count)}>{choice.label}</button
                  >
                {/each}
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="mt-3 flex gap-2">
      {#if rows.length > limit}
        <Button size="xs" color="alternative" onclick={() => (limit += PAGE_SIZE)}>Show more</Button
        >
      {/if}
      {#if done.length > 0}
        <Button size="xs" color="alternative" onclick={() => (showAnswered = !showAnswered)}>
          {showAnswered ? 'Hide answered' : `Show answered (${done.length})`}
        </Button>
      {/if}
    </div>
  </Card>
{/if}
```

- [ ] **Step 8: Run it**

`npx vitest run src/lib/components/Stats/__tests__/LongPausesCard.test.ts`

Expected: PASS (5 tests).

- [ ] **Step 9: Write the failing test for the setting**

`src/lib/components/Settings/Reader/__tests__/LongPauseSetting.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { get } from 'svelte/store';
import LongPauseSetting from '../LongPauseSetting.svelte';
import { setTrackingStates, trackingState } from '$lib/settings/tracking-data';

const T1 = '2026-10-01T00:00:00.000Z';
const LABEL = 'When a page stays open past the cutoff';

beforeEach(() => setTrackingStates({}));

describe('LongPauseSetting', () => {
  it('asks by default, offering the three standing answers', () => {
    const { getByLabelText } = render(LongPauseSetting);
    const select = getByLabelText(LABEL) as HTMLSelectElement;
    expect(select.value).toBe('ask');
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'ask',
      'full',
      'typical',
      'none'
    ]);
  });

  it('choosing an answer stores a synced standing default; "Ask me" clears it', async () => {
    const { getByLabelText } = render(LongPauseSetting);
    const select = getByLabelText(LABEL) as HTMLSelectElement;
    select.value = 'typical';
    await fireEvent.change(select);
    expect(get(trackingState).pauses?.default).toBe('typical');
    select.value = 'ask';
    await fireEvent.change(select);
    expect(get(trackingState).pauses?.default).toBeNull();
  });

  it('shows the stored default', () => {
    setTrackingStates({ pauses: { default: 'none', lastUpdated: T1 } });
    const { getByLabelText } = render(LongPauseSetting);
    expect((getByLabelText(LABEL) as HTMLSelectElement).value).toBe('none');
  });

  it('has no reset while the cutoff is at its default width', () => {
    const { queryByText, queryByRole } = render(LongPauseSetting);
    expect(queryByText(/Cutoff widened/)).toBeNull();
    expect(queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('shows a widened cutoff, and Reset puts k back to 3 keeping the manual cutoff', async () => {
    setTrackingStates({ idle: { k: 4.5, override_minutes: 7, lastUpdated: T1 } });
    const { getByText, getByRole, queryByText } = render(LongPauseSetting);
    expect(getByText('Cutoff widened ×4.5')).toBeTruthy();
    await fireEvent.click(getByRole('button', { name: 'Reset' }));
    expect(get(trackingState).idle).toMatchObject({ k: 3, override_minutes: 7 });
    expect(get(trackingState).idle!.lastUpdated > T1).toBe(true);
    await tick();
    expect(queryByText(/Cutoff widened/)).toBeNull();
  });
});
```

- [ ] **Step 10: Run it**

`npx vitest run src/lib/components/Settings/Reader/__tests__/LongPauseSetting.test.ts`

Expected: FAIL, because `../LongPauseSetting.svelte` does not exist (`Failed to resolve import "../LongPauseSetting.svelte"`).

- [ ] **Step 11: Implement the setting**

`src/lib/components/Settings/Reader/LongPauseSetting.svelte`:

```svelte
<script lang="ts">
  import { Button, Label, Select } from 'flowbite-svelte';
  import { DEFAULT_K } from '$lib/reading-history/stats-engine';
  import type { PauseCount } from '$lib/reading-history/types';
  import {
    idleSettings,
    pauseDefault,
    resetIdleK,
    setPauseDefault
  } from '$lib/settings/tracking-data';

  /**
   * What a page left open past the idle cutoff counts (phase 3b). The choices
   * are to ask each time, or a standing answer that stops the prompt. The
   * standing answer is written for views that reach the cutoff from now on,
   * never for pauses already recorded, which are answered in the review list
   * on the stats page. Synced in `volume-data.json` like the cutoff itself.
   *
   * "Still reading" answers widen the automatic cutoff (`k`); Reset puts it
   * back.
   */
  const ASK = 'ask';
  const options = [
    { value: ASK, name: 'Ask me' },
    { value: 'full', name: 'Count all' },
    { value: 'typical', name: 'Count typical' },
    { value: 'none', name: "Don't count" }
  ];

  let value = $derived($pauseDefault ?? ASK);
  let k = $derived($idleSettings.k);

  function onchange(e: Event) {
    const next = (e.target as HTMLSelectElement).value;
    setPauseDefault(next === ASK ? null : (next as PauseCount));
  }
</script>

<div class="mt-4">
  <Label for="long-pause-default" class="mb-2 text-gray-900 dark:text-white">
    When a page stays open past the cutoff
  </Label>
  <Select id="long-pause-default" size="sm" placeholder="" items={options} {value} {onchange} />
  <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
    {#if value === ASK}
      The reader asks whether you were still reading. Pauses you leave unanswered count a typical
      time until you answer them on the stats page.
    {:else}
      No prompt: long pauses from now on are counted this way.
    {/if}
  </p>
  {#if k > DEFAULT_K}
    <div
      class="mt-2 flex items-center justify-between gap-2 text-sm text-gray-700 dark:text-gray-300"
    >
      <span>Cutoff widened ×{Math.round(k * 10) / 10}</span>
      <Button size="xs" color="alternative" onclick={resetIdleK}>Reset</Button>
    </div>
  {/if}
</div>
```

- [ ] **Step 12: Run it**

`npx vitest run src/lib/components/Settings/Reader/__tests__/LongPauseSetting.test.ts`

Expected: PASS (5 tests).

- [ ] **Step 13: Write the failing wiring tests**

(a) Append this to the end of `src/lib/components/Settings/Reader/__tests__/ReaderToggles.editmode.test.ts`:

```ts
describe('ReaderToggles — long pauses', () => {
  it('carries the long-pause setting right after the idle cutoff', () => {
    const { getByLabelText } = render(ReaderToggles);
    const cutoff = getByLabelText('Automatic idle cutoff');
    const pauses = getByLabelText('When a page stays open past the cutoff');
    expect(cutoff.compareDocumentPosition(pauses) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
```

(b) `src/lib/views/__tests__/ReadingSpeedView.pauses.test.ts`. It uses the same edge doubles as `ReadingSpeedView.orphans.test.ts` and replaces only the `pauseReview` store:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/svelte';
import { readable, type Writable } from 'svelte/store';
import type { PauseReview } from '$lib/reading-history/pause-review';

const { catalogVolumes } = vi.hoisted(() => {
  function createStore<T>(initial: T) {
    const subs = new Set<(v: T) => void>();
    let current = initial;
    return {
      subscribe(fn: (v: T) => void) {
        subs.add(fn);
        fn(current);
        return () => subs.delete(fn);
      },
      set(v: T) {
        current = v;
        subs.forEach((fn) => fn(current));
      }
    };
  }
  return { catalogVolumes: createStore<Record<string, unknown>>({}) };
});
vi.mock('$lib/catalog', () => ({ volumes: catalogVolumes }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: async () => undefined,
      bulkGet: async (uuids: string[]) => uuids.map(() => undefined),
      orderBy: () => ({ uniqueKeys: async () => [] })
    }
  }
}));
vi.mock('$lib/metadata/history-rows', () => ({ materializeHistoryRows: async () => 0 }));
vi.mock('$lib/metadata/series-index', () => ({ listSeriesIndexes: async () => [] }));
vi.mock('$lib/metadata/series-open', () => ({ openSeries: vi.fn(async () => {}) }));
vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    getActiveProvider: () => ({ type: 'google-drive' }),
    cloudFiles: readable(new Map()),
    whenSeriesIndexesSettled: () => Promise.resolve()
  }
}));
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: { getCache: () => ({ isLoaded: () => true }) }
}));
vi.mock('chart.js/auto', () => ({
  default: class {
    destroy() {}
    update() {}
  }
}));

const review = vi.hoisted(() => ({ store: null as unknown as Writable<PauseReview> }));
vi.mock('$lib/reading-history/pause-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/reading-history/pause-review')>();
  const { writable } = await import('svelte/store');
  review.store = writable<PauseReview>({ pauses: [], unanswered: 0, answered: 0 });
  return { ...actual, pauseReview: review.store };
});

import ReadingSpeedView from '$lib/views/ReadingSpeedView.svelte';
import { volumesWithTrash } from '$lib/settings/volume-data';

const MIN = 60_000;

beforeEach(() => {
  volumesWithTrash.set({});
  catalogVolumes.set({});
  review.store.set({ pauses: [], unanswered: 0, answered: 0 });
});
afterEach(cleanup);

describe('ReadingSpeedView long pauses', () => {
  it('shows no review card without pauses', () => {
    render(ReadingSpeedView);
    expect(screen.queryByText(/Long pauses to review/)).toBeNull();
  });

  it('lists long pauses on the stats page, titled from the catalog', async () => {
    catalogVolumes.set({
      v1: { volume_uuid: 'v1', series_title: 'Dr Stone', volume_title: 'Dr Stone 01' }
    });
    review.store.set({
      pauses: [
        {
          volume: 'v1',
          device: 'dev-a',
          seq: 1,
          t: Date.now() - MIN,
          page: 4,
          dwell: 12 * MIN,
          cap: 5 * MIN,
          typical: 4 * MIN,
          counted: 4 * MIN,
          answer: null
        }
      ],
      unanswered: 1,
      answered: 0
    });
    render(ReadingSpeedView);
    expect(await screen.findByText('Long pauses to review (1)')).toBeTruthy();
    expect(screen.getByText('Dr Stone — Dr Stone 01')).toBeTruthy();
  });
});
```

- [ ] **Step 14: Run them**

`npx vitest run src/lib/components/Settings/Reader/__tests__/ReaderToggles.editmode.test.ts src/lib/views/__tests__/ReadingSpeedView.pauses.test.ts`

Expected: FAIL. Two tests fail and the rest pass:

- In ReaderToggles: `Unable to find a label with the text of: When a page stays open past the cutoff`.
- In the stats page: `findByText('Long pauses to review (1)')` times out.

- [ ] **Step 15: Wire both into their parents**

`src/lib/components/Settings/Reader/ReaderToggles.svelte`. First the import (:13).

Before:

```svelte
import IdleCutoffSetting from './IdleCutoffSetting.svelte'; import {(editModeActive,
requestEditMode)} from '$lib/reader/edit/edit-mode';
```

After:

```svelte
import IdleCutoffSetting from './IdleCutoffSetting.svelte'; import LongPauseSetting from
'./LongPauseSetting.svelte'; import {(editModeActive, requestEditMode)} from '$lib/reader/edit/edit-mode';
```

Then the mount (:129, end of file).

Before:

```svelte
<IdleCutoffSetting />
```

After:

```svelte
<IdleCutoffSetting />

<LongPauseSetting />
```

`src/lib/views/ReadingSpeedView.svelte`. First the imports (:13).

Before:

```svelte
import {(figuresFor, readingStats)} from '$lib/reading-history/stats-store';
```

After:

```svelte
import {(figuresFor, readingStats)} from '$lib/reading-history/stats-store'; import {pauseVolumeTitle}
from '$lib/reading-history/pause-review'; import LongPausesCard from '$lib/components/Stats/LongPausesCard.svelte';
```

Then the card, after the stats-cards grid. Anchor on the end of the Total Time card and the achievements comment (:1206–1214).

Before:

```svelte
          <ClockSolid size="lg" class="text-purple-500" />
        </div>
      </Card>
    </div>

    <!-- Achievement Badges -->
```

After:

```svelte
          <ClockSolid size="lg" class="text-purple-500" />
        </div>
      </Card>
    </div>

    <!-- Long pauses to review (phase 3b); renders nothing when there are none -->
    <LongPausesCard titleOf={(volume) => pauseVolumeTitle(volume, $catalogStore, $volumes)} />

    <!-- Achievement Badges -->
```

`$catalogStore` is the `$lib/catalog` `volumes` alias and `$volumes` is the volume-data store, both already imported at :15 and :20. The card calls `titleOf` from its own template, so it re-runs when either store changes.

- [ ] **Step 16: Run them**

`npx vitest run src/lib/components/Settings/Reader/__tests__/ReaderToggles.editmode.test.ts src/lib/views/__tests__/ReadingSpeedView.pauses.test.ts`

Expected: PASS (4 tests in ReaderToggles, 2 on the stats page).

- [ ] **Step 17: Verify the neighbours, types and lint**

Run:

```
npx vitest run src/lib/reading-history src/lib/components/Stats src/lib/components/Settings/Reader src/lib/views/__tests__ src/lib/settings/tracking-data.test.ts
npm run check
npx prettier --check src/lib/reading-history/pause-review.ts src/lib/reading-history/pause-review.test.ts src/lib/components/Stats src/lib/components/Settings/Reader/LongPauseSetting.svelte src/lib/components/Settings/Reader/__tests__/LongPauseSetting.test.ts src/lib/components/Settings/Reader/ReaderToggles.svelte src/lib/components/Settings/Reader/__tests__/ReaderToggles.editmode.test.ts src/lib/views/ReadingSpeedView.svelte src/lib/views/__tests__/ReadingSpeedView.pauses.test.ts
npx eslint src/lib/reading-history/pause-review.ts src/lib/components/Stats src/lib/components/Settings/Reader/LongPauseSetting.svelte src/lib/views/ReadingSpeedView.svelte
```

Expected:

- Every suite passes, including `ReadingSpeedView.orphans.test.ts` (unchanged) and `stats-store.test.ts`.
- `svelte-check` reports 0 errors.
- Prettier and ESLint are clean. If Prettier only re-wraps the meta line, run `npx prettier --write` on those files and re-run the card test.

- [ ] **Step 18: Commit**

```
git add src/lib/reading-history/pause-review.ts src/lib/reading-history/pause-review.test.ts \
  src/lib/components/Stats/LongPausesCard.svelte src/lib/components/Stats/__tests__/LongPausesCard.test.ts \
  src/lib/components/Settings/Reader/LongPauseSetting.svelte src/lib/components/Settings/Reader/__tests__/LongPauseSetting.test.ts \
  src/lib/components/Settings/Reader/ReaderToggles.svelte src/lib/components/Settings/Reader/__tests__/ReaderToggles.editmode.test.ts \
  src/lib/views/ReadingSpeedView.svelte src/lib/views/__tests__/ReadingSpeedView.pauses.test.ts
git commit -m "feat(history): long-pause review list on the stats page, standing default in settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Notes for the plan author

- **Ordering conflict with Task 6.**
  - The design's "Always do this" gate (`answeredPauses >= DONT_ASK_AFTER`) needs the derived answered count. Task 6's prompt is the first consumer, but `pause-review.ts` is only created here in Task 7.
  - Option 1: move Steps 1–4 (the store) into Task 6 or before it. The prompt then reads `$pauseReview.answered`.
  - Option 2: Task 6 computes `sum(byVolume.pauses.filter(p => p.answer).length)` inline, and the two counts must then be kept identical.
  - I recommend option 1. `pauseReview.answered` is exactly that sum.
- **Additions beyond the design's names.** None of these renames anything:
  - `PauseReview` names the store's value type.
  - `reviewPauses()` is the pure function the store derives from. It is memoised per `VolumeTotals` object, because a page turn recounts one volume and keeps every other volume's totals object (`stats-store.ts` `flushReadingStats`), so the derived store stays O(changed volume) per turn.
  - `pauseKey()` is the `[device, seq]` identity shared by the card and its test mock.
  - `pauseVolumeTitle()` exists so the card takes a `titleOf` prop and never imports the `$lib/catalog` liveQuery. That keeps the card test free of Dexie. The view passes `$catalogStore` and `$volumes`.
- **No layout motion.** These choices go beyond the design:
  - A pause answered on this visit stays in the unanswered section (`kept`) until the page is left.
  - The "provisional" badge sits in a fixed `w-24` slot.
  - The pressed answer is shown optimistically (`picked`), because the stats recount is debounced 500 ms. It yields to a newer stored answer.
- **Design wording that diverged from the design.**
  - A provisional row highlights none of All/Typical/None. Its effective count is typical, but nothing has been answered.
  - "Show answered (N)" counts only the answered rows not already kept in place.
- **Assumed from Task 3.**
  - `setPauseDefault(null)` stores `{ default: null, lastUpdated }`. The setting test asserts `pauses?.default` is `null`.
  - `resetIdleK()` keeps `override_minutes` and moves `lastUpdated` past the stored stamp.
  - `pauseDefault` maps an absent entry to `null`.
- **Assumed from Task 1.** `recordResolve(volume, target, count, t?, db?)` notifies through `appendEvent`, which is how the store test sees a resolve. Page events and resolves share one device ID because both go through `getOrCreateDeviceId(db)`.
- **Assumed from Task 2.** `Pause` has exactly `device, seq, t, page, dwell, cap, typical, counted, answer`. With no pace, a view over its cap reports `cap = typical = counted = NO_DATA_CAP_MS` (5 min), and `'full'` counts the whole dwell. The store test depends on both.
- **Selectors for Task 8 (e2e).**
  - The card is `[data-testid=long-pauses]`, with rows `[data-testid=long-pause-row]`.
  - The header text is exactly `Long pauses to review (N)`.
  - Each row has buttons named `All`, `Typical` and `None` with `aria-pressed`, and the badge text is `provisional`.
  - The setting's select is labelled `When a page stays open past the cutoff`.
- **Assumed: no conflicts in shared test files.** `ReaderToggles.editmode.test.ts` is the only existing test file edited (an appended describe block). The new `ReadingSpeedView.pauses.test.ts` copies the orphans suite's edge doubles rather than editing that suite.

---

### Task 8: Long-pauses e2e spec and the as-built docs

**Files:**

- Create: `e2e/long-pauses.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md`. Change three places: the `resolve` row of the Events table (line 121), the legacy bullet (line 234), and a new paragraph inserted after line 253, just before `## Migration and compatibility` (line 255).
- Modify: `CLAUDE.md`. Change four places: the "What syncs where" row (line 688), the kinds sentence (lines 793-797), two bullets under "Stats on events (phase 3a)" (lines 829-831 and 852-853), and a new **Long pauses (phase 3b)** block inserted after line 860, before `**Position across devices (phase 2c).**` (line 862).
- Test: `E2E_PORT=5199 npx playwright test e2e/long-pauses.spec.ts`. Run it again as a regression next to `e2e/reading-stats.spec.ts`.

**Interfaces:**

Consumes. These names come from the design and Tasks 1–7. The spec reaches them through Vite module URLs, the same way `reading-stats.spec.ts` does.

- `src/lib/reading-history/record.ts`
  - Existing: `recordEvent(payload: EventPayload, t?: number, db?: HistoryDexie): Promise<ReadingEvent | null>`
  - Task 1: `recordResolve(volume: string, target: [string, number], count: PauseCount, t?: number, db?: HistoryDexie): Promise<ReadingEvent | null>`
- `src/lib/reading-history/stats-store.ts` (existing): `readingStats: Readable<ReadingStatsState>`, `flushReadingStats(): void`, `figuresFor(stats, volumeId, record?): VolumeFigures`
- `src/lib/reading-history/pause-review.ts` (Task 7): `pauseReview: Readable<{ pauses: ReviewPause[]; unanswered: number; answered: number }>`. Pauses are newest first, and `ReviewPause` has `answer: PauseCount | null`.
- `src/lib/reading-history/pause-watch.ts` (Task 5): `livePause: Writable<LivePause | null>`
- `src/lib/settings/tracking-data.ts`
  - Existing: `setIdleOverride(minutes: number | null): void`
  - Task 3: `setPauseDefault(count: PauseCount | null): void`, `pauseDefault: Readable<PauseCount | null>`
- DOM contract from Task 6, `LongPausePrompt.svelte`:
  - Root is `[data-testid="long-pause"]`.
  - Fresh copy contains `Still reading?`. Away copy contains `has been open {elapsed}`, with elapsed in minutes, e.g. `10 min`.
  - Button names start with `Still reading` and `Don't count`.
  - A checkbox labelled `Always do this` appears only when `answered >= 3`.
  - Snackbars: `Cutoff widened to ~N min for pages like this` and `Manual cutoff is N min — change it in Settings`.
- DOM contract from Task 7, `LongPausesCard.svelte`:
  - Root is `[data-testid="long-pauses"]` and contains the text `Long pauses to review ({unanswered})`.
  - Each row is `[data-testid="long-pause-row"]` and contains `provisional` when unanswered.
  - Segment buttons have the exact accessible names `All`, `Typical` and `None`, with `aria-pressed` set on the current answer.
  - A toggle button is named `Show answered`.
- `Timer.svelte` (existing, unchanged): `button.reader-hud` with text `{status} | Minutes read: {n}`.
- Helpers (existing): `gotoApp(page)` from `e2e/helpers/app.ts`, and `WebDavStub` with `.handle` from `e2e/helpers/webdav-stub.ts`.

Produces: no runtime interface. The outputs are the e2e spec and the documentation.

- [ ] **Step 1: Write the test**

Create `e2e/long-pauses.spec.ts`:

```ts
import { test, expect, type Browser, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { WebDavStub } from './helpers/webdav-stub';

/**
 * Long pauses (phase 3b) through the REAL reader, stats page and sync. The
 * page clock is Playwright's: time flows normally, and `fastForward` carries a
 * view past its cap the way a reader who walked away would.
 *
 * - At the cap a prompt asks; "Still reading" counts the time in full and the
 *   timer runs on; away, it says how long the page has been open. An answer
 *   splits the view, so a later page turn loses nothing.
 * - Unanswered (a page turn), the pause counts typical time and waits on the
 *   reading-speed page, provisional, where it can be answered later.
 * - "Always do this" appears once three pauses are answered; the default then
 *   answers views that reach the cap, with no prompt.
 * - Without an override, "Still reading" widens `k`, and the rest of the view
 *   runs on the wider cap.
 * - Answers and the default sync; the latest answer wins on every device.
 */

const STUB = 'http://stub.test';
const SERIES = 'Pause Series';
const SERIES_UUID = 'e2e-pause-series';
const VOL = 'e2e-pause-volume';
const PAGES = 6;

async function device(
  browser: Browser,
  opts: { stub?: WebDavStub; clock?: boolean } = {}
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Before the app loads, so every timer it arms runs on the page clock.
  if (opts.clock) await page.clock.install();
  if (opts.stub) await page.route(`${STUB}/**`, opts.stub.handle);
  await gotoApp(page);
  if (opts.stub) {
    await page.evaluate(async (serverUrl) => {
      const { providerManager } = await import('/src/lib/util/sync/provider-manager.ts');
      const provider = await providerManager.getOrLoadProvider('webdav');
      await provider.login({ serverUrl, username: '', password: '' });
      await providerManager.setCurrentProvider(provider);
    }, STUB);
  }
  return page;
}

async function sync(page: Page) {
  const result = await page.evaluate(async () => {
    const { unifiedCloudManager } = await import('/src/lib/util/sync/unified-cloud-manager.ts');
    await unifiedCloudManager.fetchAllCloudVolumes();
    return unifiedCloudManager.syncProgress({ silent: false });
  });
  expect(result.succeeded).toBe(1);
}

/** Install a volume whose every page holds `charsPerPage` characters of OCR text. */
async function installVolume(page: Page, charsPerPage: number) {
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOL, PAGES, charsPerPage }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 300;
      canvas.getContext('2d')!.fillRect(0, 0, 200, 300);
      const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
      const pages = Array.from({ length: PAGES }, (_, i) => ({
        version: '0.2.1',
        img_width: 200,
        img_height: 300,
        img_path: `${String(i + 1).padStart(3, '0')}.png`,
        blocks: [
          {
            box: [20, 20, 60, 280],
            vertical: true,
            font_size: 12,
            lines: ['あ'.repeat(charsPerPage)],
            lines_coords: [
              [
                [40, 20],
                [60, 20],
                [60, 280],
                [40, 280]
              ]
            ]
          }
        ]
      }));
      const files: Record<string, File> = {};
      for (const p of pages)
        files[p.img_path] = new File([blob], p.img_path, { type: 'image/png' });
      await db.volumes.put({
        volume_uuid: VOL,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.2.1',
        page_count: PAGES,
        character_count: PAGES * charsPerPage,
        page_char_counts: pages.map((_, i) => (i + 1) * charsPerPage),
        thumbnail: new File([blob], 'thumb.webp', { type: 'image/webp' })
      });
      await db.volume_ocr.put({ volume_uuid: VOL, pages });
      await db.volume_files.put({ volume_uuid: VOL, files });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('singlePageView', 'single');
      updateSetting('showTimer', true);
    },
    { SERIES, SERIES_UUID, VOL, PAGES, charsPerPage }
  );
}

function timerOf(page: Page) {
  return page.locator('button.reader-hud', { hasText: 'Minutes read' });
}

/** Open the volume in the reader and wait until its first view is open. */
async function openReader(page: Page) {
  await page.evaluate(
    ({ SERIES_UUID, VOL }) => {
      window.location.hash = `#/reader/${SERIES_UUID}/${VOL}`;
    },
    { SERIES_UUID, VOL }
  );
  await expect(timerOf(page)).toContainText('Active', { timeout: 45000 });
}

/** The counted state the reader's pause timer is armed from (forces the pending count). */
async function statsState(page: Page) {
  return page.evaluate(async () => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    stats.flushReadingStats();
    let state: { pace: number | null; idle: { k: number; overrideMs: number | null } } | undefined;
    stats.readingStats.subscribe((s) => (state = s))();
    return { pace: state!.pace, k: state!.idle.k, overrideMs: state!.idle.overrideMs };
  });
}

/** This volume's figures, once the stats have counted. */
async function figures(page: Page) {
  return page.evaluate(async (VOL) => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    const { volumesWithTrash } = await import('/src/lib/settings/volume-data.ts');
    stats.flushReadingStats();
    let state: Parameters<typeof stats.figuresFor>[0] | undefined;
    stats.readingStats.subscribe((s) => (state = s))();
    let records: Record<string, never> = {};
    volumesWithTrash.subscribe((v) => (records = v as never))();
    return stats.figuresFor(state!, VOL, records[VOL]);
  }, VOL);
}

/** The review list as the stats page sees it: every pause's answer, newest first. */
async function review(page: Page) {
  return page.evaluate(async () => {
    const stats = await import('/src/lib/reading-history/stats-store.ts');
    const { pauseReview } = await import('/src/lib/reading-history/pause-review.ts');
    stats.flushReadingStats();
    let state:
      | { pauses: Array<{ answer: string | null }>; unanswered: number; answered: number }
      | undefined;
    pauseReview.subscribe((s) => (state = s))();
    return {
      unanswered: state!.unanswered,
      answered: state!.answered,
      answers: state!.pauses.map((p) => p.answer)
    };
  });
}

async function pauseDefaultOf(page: Page) {
  return page.evaluate(async () => {
    const { pauseDefault } = await import('/src/lib/settings/tracking-data.ts');
    let value: string | null = null;
    pauseDefault.subscribe((v) => (value = v))();
    return value;
  });
}

async function livePauseOf(page: Page) {
  return page.evaluate(async () => {
    const { livePause } = await import('/src/lib/reading-history/pause-watch.ts');
    let value: unknown = null;
    livePause.subscribe((v) => (value = v))();
    return value;
  });
}

test('a long pause is asked about at its cap; unanswered it waits on the stats page', async ({
  browser
}) => {
  const page = await device(browser, { clock: true });
  await installVolume(page, 20);
  // A 1-minute manual cutoff: every view's cap, with or without a pace.
  await page.evaluate(async () => {
    const { setIdleOverride } = await import('/src/lib/settings/tracking-data.ts');
    setIdleOverride(1);
  });
  await expect.poll(async () => (await statsState(page)).overrideMs).toBe(60_000);
  await openReader(page);
  const timer = timerOf(page);
  const prompt = page.getByTestId('long-pause');
  await expect(prompt).toBeHidden();

  // Page 1 stays open past its cap: the prompt asks right then.
  await page.clock.fastForward('01:05');
  await expect(prompt).toContainText('Still reading?');
  // "Always do this" is not offered before three answers.
  await expect(prompt.getByRole('checkbox')).toHaveCount(0);
  await prompt.getByRole('button', { name: /^Still reading/ }).click();
  await expect(prompt).toBeHidden();
  // The override is the cap, so nothing widens; the reader says where it is set.
  await expect(page.getByText(/Manual cutoff is 1 min/)).toBeVisible();
  // The view was split at the answer: the 65 s counted, the timer runs on.
  await expect(timer).toContainText('Active');
  await expect(timer).toContainText('Minutes read: 1', { timeout: 15000 });

  // Away: the same page sits 10 more minutes. The prompt says how long.
  await page.clock.fastForward('10:00');
  await expect(prompt).toContainText('has been open');
  await expect(prompt).toContainText(/\b10\s?m/);
  await prompt.getByRole('button', { name: /^Don.t count/ }).click();
  await expect(prompt).toBeHidden();

  // Page 2 runs past its cap, and the reader turns on without answering.
  await page.keyboard.press('ArrowLeft');
  await page.clock.fastForward('01:30');
  await expect(prompt).toContainText('Still reading?');
  await page.keyboard.press('ArrowLeft');
  await expect(prompt).toBeHidden();

  // The unanswered pause waits on the reading-speed page, provisional.
  await page.evaluate(() => (window.location.hash = '#/reading-speed'));
  const card = page.getByTestId('long-pauses');
  await expect(card).toContainText('Long pauses to review (1)', { timeout: 15000 });
  await expect(card.getByTestId('long-pause-row')).toHaveCount(1);
  await expect(card.getByTestId('long-pause-row')).toContainText('provisional');
  await expect
    .poll(async () => (await review(page)).answers, { timeout: 15000 })
    .toEqual([null, 'none', 'full']);
  // 65 s in full + 10 min not counted + page 2's 90 s as typical (the 1-min cap).
  const before = (await figures(page)).timeMs;
  expect(before).toBeGreaterThanOrEqual(125_000);
  expect(before).toBeLessThan(150_000);

  // Answered later: page 2 counts all of its 90 s.
  await card
    .getByTestId('long-pause-row')
    .getByRole('button', { name: 'All', exact: true })
    .click();
  await expect(card).toContainText('Long pauses to review (0)');
  await expect
    .poll(async () => (await figures(page)).timeMs - before, { timeout: 15000 })
    .toBeGreaterThanOrEqual(30_000);
  expect((await figures(page)).timeMs - before).toBeLessThan(45_000);
  await card.getByRole('button', { name: /Show answered/ }).click();
  await expect(card.getByTestId('long-pause-row')).toHaveCount(3);
  await expect(card.getByRole('button', { name: 'All', exact: true, pressed: true })).toHaveCount(
    2
  );
  await expect(card.getByRole('button', { name: 'None', exact: true, pressed: true })).toHaveCount(
    1
  );

  // Answers are history: a reload keeps all three.
  await page.reload();
  await expect(page.getByTestId('long-pauses')).toContainText('Long pauses to review (0)', {
    timeout: 30000
  });
  await expect.poll(async () => (await review(page)).answered, { timeout: 15000 }).toBe(3);

  // Three answers in: the next prompt offers to stop asking.
  await openReader(page);
  await page.clock.fastForward('01:05');
  await expect(prompt).toContainText('Still reading?');
  await prompt.getByRole('checkbox', { name: /Always do this/i }).check();
  await prompt.getByRole('button', { name: /^Don.t count/ }).click();
  await expect(prompt).toBeHidden();
  expect(await pauseDefaultOf(page)).toBe('none');

  // With a standing default, a view past its cap is not asked about…
  await page.clock.fastForward('01:05');
  expect(await livePauseOf(page)).toBeNull();
  await expect(prompt).toBeHidden();

  // …and the default is its answer once the view ends.
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await expect
    .poll(async () => (await review(page)).answers, { timeout: 15000 })
    .toEqual(['none', 'none', 'full', 'none', 'full']);
  expect((await review(page)).unanswered).toBe(0);
});

test('"Still reading" widens the cutoff, and the rest of the view runs on it', async ({
  browser
}) => {
  const page = await device(browser, { clock: true });
  await installVolume(page, 200);
  // A pace: 30 views of another volume at 200 ms per character.
  await page.evaluate(async () => {
    const { recordEvent } = await import('/src/lib/reading-history/record.ts');
    for (let i = 0; i < 30; i++) {
      await recordEvent({
        kind: 'page',
        volume: 'e2e-pause-pace',
        first_page: i + 1,
        last_page: i + 1,
        page_chars: [300],
        chars_before: i * 300,
        dwell_ms: 60_000,
        layout: 'single',
        orientation: 'portrait',
        viewport: { w: 400, h: 800 }
      });
    }
  });
  await expect.poll(async () => (await statsState(page)).pace, { timeout: 15000 }).toBe(200);
  await openReader(page);
  const prompt = page.getByTestId('long-pause');

  // 200 characters × 200 ms = 40 s expected; × k = 3 → a 2-minute cap.
  await page.clock.fastForward('02:01');
  await expect(prompt).toContainText('Still reading?');
  await prompt.getByRole('button', { name: /^Still reading/ }).click();
  await expect(page.getByText(/Cutoff widened to ~\d+ min/)).toBeVisible();
  // k fits this view with headroom: 121 s × 1.5 / 40 s = 4.5, up to a half step = 5.
  await expect.poll(async () => (await statsState(page)).k, { timeout: 15000 }).toBe(5);

  // The rest of the view runs on the wider cap (5 × 40 s = 200 s): no prompt at 125 s…
  await page.clock.fastForward('02:05');
  expect(await livePauseOf(page)).toBeNull();
  await expect(prompt).toBeHidden();
  await expect(timerOf(page)).toContainText('Active');
  // …and past it, the prompt asks again.
  await page.clock.fastForward('01:20');
  await expect(prompt).toContainText('Still reading?');

  // Leaving with the prompt up leaves that pause to review.
  await page.evaluate(() => (window.location.hash = '#/catalog'));
  await expect
    .poll(async () => (await review(page)).answers, { timeout: 15000 })
    .toEqual([null, 'full']);
  const volume = await figures(page);
  // Page 1 credited once though the view was split; ~121 s in full + 60 s typical.
  expect(volume.chars).toBe(200);
  expect(volume.timeMs).toBeGreaterThanOrEqual(181_000);
  expect(volume.timeMs).toBeLessThan(200_000);
});

test('answers and the standing default sync; the latest answer wins', async ({ browser }) => {
  const stub = new WebDavStub();
  const laptop = await device(browser, { stub });
  const phone = await device(browser, { stub });

  // The laptop left a page open 10 minutes (no pace: a 5-minute cap), answered
  // "don't count", and made "typical" its standing default.
  const target = await laptop.evaluate(async (VOL) => {
    const { recordEvent, recordResolve } = await import('/src/lib/reading-history/record.ts');
    const { updateProgress } = await import('/src/lib/settings/volume-data.ts');
    const { setPauseDefault } = await import('/src/lib/settings/tracking-data.ts');
    const event = await recordEvent({
      kind: 'page',
      volume: VOL,
      first_page: 1,
      last_page: 1,
      page_chars: [300],
      chars_before: 0,
      dwell_ms: 600_000,
      layout: 'single',
      orientation: 'portrait',
      viewport: { w: 400, h: 800 }
    });
    updateProgress(VOL, 1, 300);
    const target: [string, number] = [event!.device, event!.seq];
    await recordResolve(VOL, target, 'none');
    setPauseDefault('typical');
    return target;
  }, VOL);
  await sync(laptop);
  await sync(phone);

  await expect
    .poll(async () => (await figures(phone)).timeMs, { timeout: 15000 })
    .toBe((await figures(laptop)).timeMs);
  expect(await figures(phone)).toMatchObject({ timeMs: 0, chars: 300 });
  expect((await review(phone)).answers).toEqual(['none']);
  expect(await pauseDefaultOf(phone)).toBe('typical');

  // Changed later on the laptop: every device takes the newer answer.
  await laptop.evaluate(
    async ({ VOL, target }) => {
      const { recordResolve } = await import('/src/lib/reading-history/record.ts');
      await recordResolve(VOL, target, 'full');
    },
    { VOL, target }
  );
  await sync(laptop);
  await sync(phone);
  await expect
    .poll(async () => (await review(phone)).answers, { timeout: 15000 })
    .toEqual(['full']);
  expect((await figures(phone)).timeMs).toBe(600_000);
});

test('the reader arms its pause timer on the real clock without error', async ({ browser }) => {
  // The other reader tests run on Playwright's clock, whose timers are plain
  // functions; the native ones throw when called off `window`.
  const page = await device(browser);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await installVolume(page, 20);
  await openReader(page);
  await page.keyboard.press('ArrowLeft');
  await expect(timerOf(page)).toContainText('Active');
  expect(errors.filter((e) => /Illegal invocation|setTimeout|clearTimeout/i.test(e))).toEqual([]);
});
```

- [ ] **Step 2: Run it**

First check that port 5199 is free, because the config silently reuses any server already on that port: `ss -ltn | grep -q ':5199 ' && echo TAKEN`. If it prints `TAKEN`, pick another port.

Then run:

```bash
cd /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-pauses
E2E_PORT=5199 npx playwright test e2e/long-pauses.spec.ts
```

Add `E2E_CHROMIUM=<path>` if Playwright's own browser isn't installed.

Expected: PASS, `4 passed`. This spec checks Tasks 1–7 end to end, so the usual RED step doesn't apply: by the time it is written, the code it exercises already exists. To confirm the run is not passing vacuously, check the first run's log for these four test titles:

- "a long pause is asked about at its cap…"
- "\"Still reading\" widens the cutoff…"
- "answers and the standing default sync…"
- "the reader arms its pause timer…"

A failure points at a specific earlier task:

- No `[data-testid=long-pause]` after `fastForward`: the Task 5 or Task 6 watch wiring.
- Wrong `answers`: the Task 2 engine or the Task 7 review ordering.
- `timeMs` out of bounds: `countedDwell` or the split (Tasks 2 and 4).
- `Illegal invocation`: Task 5's timer defaults (see Notes).

In each case, fix that task; never loosen an assertion here.

- [ ] **Step 3: Run the neighbouring specs and lint**

```bash
cd /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-pauses
E2E_PORT=5199 npx playwright test e2e/long-pauses.spec.ts e2e/reading-stats.spec.ts e2e/history-sync.spec.ts e2e/position-offer.spec.ts
npx prettier --check e2e/long-pauses.spec.ts && npx eslint e2e/long-pauses.spec.ts
```

Expected: every test passes; count them across the whole log, not the tail. Prettier reports `All matched files use Prettier code style!` and ESLint prints nothing. If prettier complains, run `npx prettier --write e2e/long-pauses.spec.ts` and re-check.

- [ ] **Step 4: Commit the spec**

```bash
cd /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-pauses
git add e2e/long-pauses.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): long pauses — prompt at the cap, split answers, review list, default, widening, sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Update the spec doc**

All three edits are in `docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md`.

(a) The Events table, line 121. Before:

```
| `resolve` | `target` (`[device, seq]` of a `page` event), `count`: `'full'` \| `'typical'` \| `'none'`                                                                                                | — (the user's answer about a long pause)                                                                   |
```

After (prettier re-pads the table in Step 7):

```
| `resolve` | `volume` (the target's), `target` (`[device, seq]` of a `page` event), `count`: `'full'` \| `'typical'` \| `'none'` | — (the user's answer about a long pause) |
```

(b) The legacy bullet, line 234. Before:

```
  - Legacy data converted from `recentPageTurns` is never prompted for; it counts as typical.
```

After:

```
  - Legacy data converted from `recentPageTurns` is never prompted for; over its cap it counts nothing
    (the old idle rule, kept in phase 3b: counting typical could lift history from before the freeze above
    the frozen `legacyStats` snapshot).
```

(c) Insert after line 253, which ends `… The manual override lives in \`volume-data.json\` → \`tracking.idle\`.`, leaving one blank line before `## Migration and compatibility`:

```

**As built (phase 3b, `pause-watch.ts` / `LongPausePrompt.svelte` / `pause-review.ts`).** The reader arms one
timer for the open view at `since + cap`, re-armed when the pace, `k` or the override moves, and asks in a
non-modal prompt above the page. A `resolve` also carries its target's `volume`, so everything keyed by
volume handles it unchanged; it is kind 5 inside segment format 1 (the codec had not shipped). A live answer
**splits the view**: the view so far and its `resolve` are written in one transaction, and a continuation
view of the same pages opens at the answer time. No answer waits on a later event, and the continuation
earns no new characters. "Still reading" counts the time in full and widens `k` to fit this view × 1.5,
rounded up to a half step, at most 20 and never past where the ceiling caps it anyway. It changes nothing
under a manual override, without a pace yet, or on a page held at the floor (the floor stays fixed). `k`
keeps sharing `tracking.idle`'s stamp with the override. Two minutes past the cap the prompt shows how long
the page has been open: count all, typical, or none. An answer applies under whatever cap holds later, and
only to time: pages stay read and skips stay skips, and `'none'` gives no speed sample. The latest answer per
target wins in event order (t, device, seq), the same on every device. Unanswered pauses count typical and are
listed as provisional on the reading-speed page, where any answer can be changed. "Always do this" appears once
3 pauses are answered, counted from the answers themselves across devices (nothing is stored). The standing
default (`tracking.pauses`, its own key and stamp) is written as a view's answer when the view ends, and only
for views that reached the cap while it was set, never backwards over the review list.
```

- [ ] **Step 6: Update CLAUDE.md**

(a) "What syncs where", line 688. Before:

```
| Idle cutoff (automatic / manual override, `k`)              | `volume-data.json` → `tracking` section   | `lastUpdated` per key                  |
```

After (re-padded in Step 7):

```
| Idle cutoff (automatic / manual override, `k`), long-pause default | `volume-data.json` → `tracking` section | `lastUpdated` per key |
```

(b) The kinds sentence, lines 794-797. Before:

```
("restart series"), `forget` (delete stats), `position` (an answer to a
cross-device position offer — see below). Record through `recordEvent`,
which never throws and loads the DB module lazily (`volume-data.ts` imports
it; many suites mock `dexie` bare).
```

After:

```
("restart series"), `forget` (delete stats), `position` (an answer to a
cross-device position offer — see below), `resolve` (an answer about a long
pause — see below). Record through `recordEvent` (`recordView` for a view and
its answer in one transaction, `recordResolve` for a later answer), which
never throw and load the DB module lazily (`volume-data.ts` imports it; many
suites mock `dexie` bare).
```

(c) The cap bullet, lines 830-831. Before:

```
  else 5 min), or the synced manual override. Over the cap it counts TYPICAL
  time (`expected`, at least the floor) — phase 3b will ask instead.
```

After:

```
  else 5 min), or the synced manual override. Over the cap the reader ASKS
  (phase 3b, below); unanswered, it counts TYPICAL time (`expected`, at least
  the floor), provisionally.
```

(d) The timer bullet, lines 852-853. Before:

```
  record stamp). The reader timer is that figure plus the open view up to its
  cap (`live-view.ts`); clicking it ends the view until the next page.
```

After:

```
  record stamp). The reader timer is that figure plus the open view counted by
  the same rule (`countedDwell`: up to its cap, or as a standing long-pause
  default counts it); clicking it ends the view until the next page.
```

(e) Insert after line 860, `  series section's clamp + forfeit-on-bogus and raw upload comparison.`, and before the blank line that precedes `**Position across devices (phase 2c).**`:

```

**Long pauses (phase 3b).** A view that reaches its cap is ASKED about, never
guessed: `pause-watch.ts` arms one timer at `since + cap` (re-armed when the
pace, `k` or the override moves) and `LongPausePrompt.svelte` asks, non-modal,
above the page — never inside `Timer.svelte`, whose markup hides with the HUD.
Rules that must hold:

- An answer is a `resolve` event (`volume`, `target: [device, seq]`, `count`
  = `full` | `typical` | `none`), kind 5 inside segment format 1. `volume` is
  the target's, so everything keyed by volume (turns store, codec, index)
  handles it unchanged. The latest answer per target wins in event order
  (t, device, seq) on every device; nothing is ever edited.
- A live answer SPLITS the view: the view so far and its `resolve` go in ONE
  rw transaction (`recordView` → `appendView`), and a continuation view of the
  same pages opens at the answer (`ViewTracker.split`). Nothing waits for a
  later event, so a page turn or close loses no answer; the continuation earns
  no new characters (a page counts once per pass).
- `countedDwell` is the one rule for engine and live timer: `full` = the raw
  dwell, `none` = 0, `typical` or unanswered-over-cap = typical. An answer
  applies under any later cap, and only to TIME — reads and skips are
  unchanged (`none` keeps the pages read and gives no speed sample).
- "Still reading" = `full` plus `widenedK`: `k` fits this view × 1.5, up to a
  half step, at most 20 and never past where the ceiling caps it; it never
  shrinks. `null` (nothing changes) under a manual override, without a pace,
  or on a page held at the floor — the floor is fixed. `k` shares
  `tracking.idle`'s stamp with the override; Settings shows the widening with
  a Reset.
- Two minutes past the cap the prompt shows how long the page has been open:
  count all / typical / none. Unanswered (turn, hide, pause click, close) the
  pause counts typical and is listed PROVISIONAL on the reading-speed page
  (`pause-review.ts`, `LongPausesCard.svelte`), where any answer can change.
- "Always do this" appears once 3 pauses are answered — DERIVED from the
  answers across every volume and device, never stored. The standing default
  is `tracking.pauses` (its own key and stamp), written as a view's answer
  when the view ENDS, only for views that reached the cap while it was set —
  never backwards over the review list.
- Converted `legacy:` views are never prompted; over the cap they still count
  nothing, and a `resolve` aimed at one is ignored.
- `e2e/long-pauses.spec.ts` drives all of it on Playwright's page clock
  (`clock.install()` before the app loads, then `fastForward`).
```

- [ ] **Step 7: Format and check the docs**

```bash
cd /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-pauses
npx prettier --write CLAUDE.md docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md
npx prettier --check CLAUDE.md docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md
git diff --stat
```

Expected: the check reports `All matched files use Prettier code style!`. The diff shows exactly those two files, and the only lines prettier changes beyond these edits are the re-padded rows of the two tables. Read `git diff` once to confirm no other paragraph moved.

- [ ] **Step 8: Commit the docs**

```bash
cd /home/nathan/Projects/mokuro-reader-worktrees/feat/reading-history-pauses
git add CLAUDE.md docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md
git commit -m "$(cat <<'EOF'
docs(history): phase 3b long pauses as built — split answers, derived N, default at view end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Notes for the plan author

- **Design conflict: Task 5's timer defaults will crash in production.** `constructor(..., private timers = { set: setTimeout, clear: clearTimeout })` followed by `this.timers.set(fn, ms)` calls the native `setTimeout` with `this` set to the `timers` object. Chrome throws `TypeError: Illegal invocation`, and Firefox throws a similar error.
  - Neither vitest fake timers nor Playwright's clock catches this, because their timers are plain JS functions. Tests 1–2 of this spec would pass while production crashes.
  - Task 5 must use `{ set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) }`.
  - Test 4 of this spec is the guard for it.
- **DOM contract Tasks 6 and 7 must ship:** `data-testid="long-pauses"` on the card root, `data-testid="long-pause-row"` per row, segment buttons with the exact accessible names `All` / `Typical` / `None` carrying `aria-pressed`, a `Show answered` toggle button, and the row text `provisional`. The design names neither test id nor `aria-pressed`; add them to Task 7's component and test.
- **Copy the e2e relies on, all taken from the design:**
  - Prompt text `Still reading?`. Away copy `has been open {elapsed}`, with elapsed in minutes so it matches `/\b10\s?m/`; `formatDuration` gives `10 min`, which matches.
  - Button labels starting `Still reading` and `Don't count` (either apostrophe matches).
  - Checkbox label `Always do this`.
  - Snackbars `Cutoff widened to ~N min…` and `Manual cutoff is N min…`.
  - The Timer's `{status} | Minutes read: {n}` stays unchanged.
- **The watch must re-arm from `readingStats`, not only `idleSettings`.** `readingStats.idle` only updates after the store's 500 ms debounce. The spec forces that recount with `flushReadingStats()` before each `fastForward`, so a watch that reads `readingStats` re-arms synchronously. A watch fed only by `idleSettings` also works.
- **`pauseReview.pauses` is assumed newest first** (design §4). The `answers` array assertions depend on that order.
- **Design scenario step 8 (two devices)** is covered by seeding events with `recordEvent` and `recordResolve` instead of driving the laptop's UI. It adds two checks the design only implied: the standing default syncs, and a later answer wins after sync.
- **Settings UI is left out of the e2e.** No existing e2e opens the settings panel. The `LongPauseSetting` select and the Reset button stay covered by Task 7's component test.
- **`installVolume` is duplicated** from `reading-stats.spec.ts`, with `charsPerPage` as a parameter. Moving it into `e2e/helpers/` would mean modifying `reading-stats.spec.ts`, which is outside this task.
- **Step 2 expects PASS, not FAIL.** This task runs after Tasks 1–7 by construction, so there is nothing for a RED step to show.
- **O1 is applied in the docs**: the spec's "counts as typical" legacy bullet is corrected to "counts nothing", per the binding ruling.

---
