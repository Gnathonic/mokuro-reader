# Series Metadata — Plan C: AniList Tracking + Re-reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push read progress and re-read counts to AniList (one-way, per-series opt-in), and add an explicit "restart series" re-read flow that archives the previous read and offers itself when a re-read is detected.

**Architecture:** Pure decision functions (`planProgressPush`, `computeLocalPassState`, `shouldOfferReread`, `extractVolumeNumber`) sit under a thin side-effecting tracker (`progress-tracker.ts`) that talks to AniList through Plan A's `anilistRequest`. Auth is the OAuth2 implicit grant handled as a hash callback in `initRouter`. Re-read history lives on `VolumeData.archivedReads` (synced with the existing newest-wins merge) and `SeriesMetadata.read_count` (synced via `series-metadata.json`).

**Tech Stack:** SvelteKit 5 (runes), Svelte stores, Dexie (via Plan A's `store.ts`), Flowbite Svelte, Vitest + jsdom, AniList GraphQL.

**Spec:** `docs/superpowers/specs/2026-08-16-series-metadata-linking-design.md` (sections "AniList auth", "Progress push", "Re-reads", "UI", "Testing").

**Prerequisites:** Plans A and B are merged. This plan consumes, exactly as named in the shared contract:
`src/lib/metadata/types.ts` (`SeriesMetadata`, `TrackingUnit`, `SeriesTracking`), `src/lib/metadata/series-key.ts` (`normalizeSeriesKey`), `src/lib/metadata/store.ts` (`getSeriesMetadata`, `getSeriesMetadataForTitle`, `updateSeriesMetadata`, `seriesMetadataMap`), `src/lib/metadata/providers/anilist.ts` (`anilistRequest<T>(query, variables?, token?, signal?)`, `AniListError { code: 'RATE_LIMITED'|'UNAUTHORIZED'|'NETWORK'|'GRAPHQL'; retryAfterMs? }`), `src/lib/metadata/display-title.ts` (`resolveDisplayTitle`), `src/lib/components/Series/SeriesMetadataBar.svelte` (props `seriesTitle`, `volumes`), `src/lib/components/Settings/MetadataSettings.svelte` (Plan B left a `<!-- Plan C: AniList account section mounts here -->` comment), and `catalogSettings.preferredTitleLanguage` (Plan B).

## Global Constraints

- The folder name / stored `series_title` is never modified by anything in this plan.
- Progress pushed to AniList never decreases within a read; a **restart** is the only explicit decrease (`REPEATING`, progress 0).
- AniList: `https://graphql.anilist.co`, 30 requests/minute; honor `Retry-After` on 429; token lifetime 1 year; implicit grant `https://anilist.co/api/v2/oauth/authorize?client_id=…&response_type=token`; callback lands at `{origin}/#access_token=…&token_type=Bearer&expires_in=…`.
- Env var name: `VITE_ANILIST_CLIENT_ID` (only needed for progress push; search/link work without it).
- localStorage keys: `anilist_token`, `anilist_token_expires_at`, `anilist_user`, `anilist_pending_pushes`; sessionStorage keys: `anilist_return`, `reread_dismissed:<seriesKey>`.
- `read_count` = archived completed passes; `timesRead = read_count + (all volumes completed now ? 1 : 0)`; AniList `repeat = timesRead - 1`.
- Modal action-button containers get `relative z-10` (night-mode filter stacking-context rule in CLAUDE.md).
- Tests: `npx vitest run <path>` (the `npm test` script is watch-mode `vitest`). Type-check: `npm run check`.
- Work in the worktree `/home/nathan/Projects/mokuro-reader-worktrees/feat/series-metadata` on branch `feat/series-metadata`.

---

### Task 1: `archivedReads` on VolumeData + `archiveAndResetVolumes` + completion listener + lifetime totals

**Files:**

- Modify: `src/lib/settings/volume-data.ts` (VolumeDataJSON/VolumeData ~lines 44-187, `updateProgress` ~432-483, `totalStats` ~600-625)
- Test: `src/lib/settings/volume-data.test.ts` (new)

**Interfaces:**

- Consumes: nothing new.
- Produces:

  ```ts
  export type ArchivedRead = { at: number; pages: number; chars: number; completed: boolean };
  // VolumeData.archivedReads: ArchivedRead[]  (empty array default; omitted from toJSON when empty)
  export function archiveAndResetVolumes(volumeUuids: string[]): void;
  export function registerCompletionListener(fn: (volumeUuid: string) => void): () => void;
  ```

  `updateProgress` calls every registered listener exactly when a volume's `completed` flips false→true (`markVolumeAsComplete` goes through `updateProgress`, so it fires too). `totalStats.charsRead/pagesRead` include archived sums.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/settings/volume-data.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      get: vi.fn().mockResolvedValue(undefined),
      toArray: vi.fn().mockResolvedValue([])
    }
  }
}));

import {
  VolumeData,
  archiveAndResetVolumes,
  clearVolumes,
  registerCompletionListener,
  totalStats,
  updateProgress,
  volumes
} from './volume-data';

describe('VolumeData.archivedReads', () => {
  it('round-trips through toJSON/fromJSON and is omitted when empty', () => {
    const empty = new VolumeData({ progress: 3 });
    expect(empty.archivedReads).toEqual([]);
    expect('archivedReads' in empty.toJSON()).toBe(false);

    const withReads = new VolumeData({
      archivedReads: [{ at: 1000, pages: 200, chars: 5000, completed: true }]
    });
    const json = withReads.toJSON();
    expect(json.archivedReads).toEqual([{ at: 1000, pages: 200, chars: 5000, completed: true }]);
    expect(VolumeData.fromJSON(JSON.stringify(json)).archivedReads).toEqual(
      withReads.archivedReads
    );
  });

  it('drops malformed archived entries', () => {
    const v = new VolumeData({
      archivedReads: [
        { at: 1, pages: 2, chars: 3, completed: false },
        { at: 'x' } as any,
        null as any
      ]
    });
    expect(v.archivedReads).toEqual([{ at: 1, pages: 2, chars: 3, completed: false }]);
  });
});

describe('archiveAndResetVolumes', () => {
  beforeEach(() => clearVolumes());

  it('archives progress/chars/completed and resets to the start, keeping stats', () => {
    updateProgress('vol-1', 200, 5000, true);
    updateProgress('vol-2', 40, 900, false);
    // simulate accumulated time + sessions on vol-1
    const before = get(volumes)['vol-1'];
    expect(before.completed).toBe(true);

    archiveAndResetVolumes(['vol-1', 'vol-2', 'vol-untouched']);

    const v1 = get(volumes)['vol-1'];
    expect(v1.progress).toBe(0);
    expect(v1.chars).toBe(0);
    expect(v1.completed).toBe(false);
    expect(v1.archivedReads).toHaveLength(1);
    expect(v1.archivedReads[0]).toMatchObject({ pages: 200, chars: 5000, completed: true });
    expect(v1.recentPageTurns.length).toBe(before.recentPageTurns.length); // history kept

    const v2 = get(volumes)['vol-2'];
    expect(v2.archivedReads[0]).toMatchObject({ pages: 40, chars: 900, completed: false });
    expect(v2.progress).toBe(0);

    expect(get(volumes)['vol-untouched']).toBeUndefined(); // never created
  });

  it('is a no-op for volumes with no progress', () => {
    updateProgress('vol-3', 0, 0, false);
    archiveAndResetVolumes(['vol-3']);
    expect(get(volumes)['vol-3'].archivedReads).toEqual([]);
  });
});

describe('registerCompletionListener', () => {
  beforeEach(() => clearVolumes());

  it('fires once on the false→true transition only', () => {
    const listener = vi.fn();
    const unregister = registerCompletionListener(listener);

    updateProgress('vol-1', 10, 100, false);
    expect(listener).not.toHaveBeenCalled();

    updateProgress('vol-1', 200, 5000, true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('vol-1');

    updateProgress('vol-1', 199, 4900, true); // still completed → no new event
    expect(listener).toHaveBeenCalledTimes(1);

    unregister();
    updateProgress('vol-1', 1, 0, false);
    updateProgress('vol-1', 200, 5000, true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('totalStats with archived reads', () => {
  beforeEach(() => clearVolumes());

  it('keeps lifetime chars/pages after a restart', () => {
    updateProgress('vol-1', 200, 5000, true);
    const before = get(totalStats)!;
    expect(before.charsRead).toBe(5000);
    expect(before.pagesRead).toBe(200);

    archiveAndResetVolumes(['vol-1']);
    const after = get(totalStats)!;
    expect(after.charsRead).toBe(5000);
    expect(after.pagesRead).toBe(200);
    expect(after.completed).toBe(0);

    updateProgress('vol-1', 50, 1000, false); // re-reading
    expect(get(totalStats)!.charsRead).toBe(6000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/settings/volume-data.test.ts`
Expected: FAIL — `archiveAndResetVolumes`/`registerCompletionListener` are not exported; `archivedReads` undefined.

- [ ] **Step 3: Implement in `src/lib/settings/volume-data.ts`**

Add the type next to `AggregateSession` (~line 40):

```ts
// One archived read pass, appended by "restart series". `pages`/`chars` are the
// values at the moment of the restart; `completed` says whether that pass finished.
export type ArchivedRead = { at: number; pages: number; chars: number; completed: boolean };

function isArchivedRead(value: unknown): value is ArchivedRead {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.at === 'number' &&
    typeof v.pages === 'number' &&
    typeof v.chars === 'number' &&
    typeof v.completed === 'boolean'
  );
}
```

In `VolumeDataJSON` add `archivedReads?: ArchivedRead[];` (after `sessions?`). In the class add the field `archivedReads: ArchivedRead[];` and in the constructor after `this.sessions = data.sessions || [];`:

```ts
this.archivedReads = Array.isArray(data.archivedReads)
  ? data.archivedReads.filter(isArchivedRead)
  : [];
```

In `toJSON()` after the `sessions` block:

```ts
// Archived read passes (restart series) — sync with the volume
if (this.archivedReads.length > 0) {
  result.archivedReads = this.archivedReads;
}
```

Add the listener registry above `updateProgress`:

```ts
type CompletionListener = (volumeUuid: string) => void;
const completionListeners = new Set<CompletionListener>();

/**
 * Called when a volume's `completed` flips false → true (via updateProgress or
 * markVolumeAsComplete). Returns an unregister function.
 */
export function registerCompletionListener(fn: CompletionListener): () => void {
  completionListeners.add(fn);
  return () => {
    completionListeners.delete(fn);
  };
}

function notifyCompletion(volumeUuid: string) {
  for (const fn of completionListeners) {
    try {
      fn(volumeUuid);
    } catch (error) {
      console.warn('[volume-data] completion listener failed:', error);
    }
  }
}
```

Modify `updateProgress`: declare `let becameCompleted = false;` before `_volumesInternal.update(...)`; inside the callback right after `const currentVolume = prev[volume] || new VolumeData();` add `becameCompleted = completed && !currentVolume.completed;`; after the `_volumesInternal.update(...)` call ends add:

```ts
if (becameCompleted) {
  notifyCompletion(volume);
}
```

Add `archiveAndResetVolumes` after `markVolumeAsUnread`:

```ts
/**
 * "Restart series": archive each volume's current read (progress/chars/completed)
 * onto `archivedReads`, then reset it to the start. Reading history
 * (recentPageTurns, sessions, timeReadInMinutes) is untouched. Volumes with no
 * progress are skipped; unknown UUIDs are not created.
 */
export function archiveAndResetVolumes(volumeUuids: string[]) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  _volumesInternal.update((prev) => {
    const updated = { ...prev };
    for (const uuid of volumeUuids) {
      const existing = updated[uuid];
      if (!existing || existing.deletedOn) continue;
      if (existing.progress <= 0 && !existing.completed) continue;
      updated[uuid] = new VolumeData({
        ...existing,
        archivedReads: [
          ...existing.archivedReads,
          {
            at: now,
            pages: existing.progress,
            chars: existing.chars,
            completed: existing.completed
          }
        ],
        progress: 0,
        chars: 0,
        completed: false,
        lastProgressUpdate: nowIso
      });
    }
    return updated;
  });
}
```

In `totalStats` replace the two accumulation lines with:

```ts
stats.pagesRead += volumeData.progress;
stats.minutesRead += getEffectiveReadingTime(volumeData, idleTimeoutMs);
stats.charsRead += volumeData.chars;
// Lifetime totals keep every archived pass (restart series never lowers them)
for (const read of volumeData.archivedReads) {
  stats.pagesRead += read.pages;
  stats.charsRead += read.chars;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/settings/volume-data.test.ts src/lib/util/sync/unified-sync-service.test.ts`
Expected: PASS (the sync merge parses whole `VolumeData` objects via `parseVolumesFromJson`, so `archivedReads` travels through `mergeVolumeData` unchanged — no sync change needed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings/volume-data.ts src/lib/settings/volume-data.test.ts
git commit -m "feat(progress): archived reads, restart reset, completion listener"
```

---

### Task 2: `extractVolumeNumber`

**Files:**

- Create: `src/lib/metadata/volume-number.ts`
- Test: `src/lib/metadata/volume-number.test.ts`

**Interfaces:**

- Consumes: `TrackingUnit` from `src/lib/metadata/types.ts` (Plan A).
- Produces: `export function extractVolumeNumber(volumeTitle: string, unit: TrackingUnit): number | undefined`.

Note: `src/lib/util/series-extraction.ts` keeps its patterns private and every one of them requires a series prefix (`^(.+?)\s+…`), which fails for bare volume titles like `Vol 01`. This module therefore carries its own small pattern lists (mirroring the same forms) rather than exporting internals from the folder parser.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/metadata/volume-number.test.ts
import { describe, expect, it } from 'vitest';
import { extractVolumeNumber } from './volume-number';

describe('extractVolumeNumber — volumes', () => {
  it.each([
    ['Vol 01', 1],
    ['Volume 12', 12],
    ['vol.3', 3],
    ['One Piece Vol.03', 3],
    ['第01巻', 1],
    ['ワンピース 第5巻', 5],
    ['3巻', 3],
    ['v07', 7],
    ['One Piece_v02', 2],
    ['One Piece #4', 4],
    ['One Piece 12', 12],
    ['One Piece_04', 4],
    ['One Piece-09', 9],
    ['01', 1]
  ])('%s → %i', (title, expected) => {
    expect(extractVolumeNumber(title, 'volumes')).toBe(expected);
  });

  it.each([['One Piece'], ['Extra'], ['One Piece (2020)'], ['第12話'], ['']])(
    '%s → undefined',
    (title) => {
      expect(extractVolumeNumber(title, 'volumes')).toBeUndefined();
    }
  );
});

describe('extractVolumeNumber — chapters', () => {
  it.each([
    ['第12話', 12],
    ['Chapter 105', 105],
    ['ch.7', 7],
    ['Ch 1050', 1050],
    ['One Piece 1050', 1050],
    ['#12', 12],
    ['012', 12]
  ])('%s → %i', (title, expected) => {
    expect(extractVolumeNumber(title, 'chapters')).toBe(expected);
  });

  it('does not treat 巻 as a chapter number', () => {
    expect(extractVolumeNumber('第3巻', 'chapters')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/metadata/volume-number.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/metadata/volume-number.ts
import type { TrackingUnit } from './types';

// Ordered: explicit markers first, bare trailing numbers last.
const VOLUME_PATTERNS: RegExp[] = [
  /第\s*(\d+)\s*巻/, // 第01巻
  /(?:^|[\s_\-–—(\[])(\d+)\s*巻/, // 3巻
  /(?:^|[^a-z])(?:vol(?:ume)?\.?)\s*(\d+)/i, // Vol 1, Volume 01, vol.3
  /(?:^|[\s_\-–—(\[])v\.?\s*(\d+)(?!\d)/i, // v07, _v02
  /(?:^|\s)#\s*(\d+)/, // #4
  /(?:^|[\s_\-–—])(\d{1,3})\s*$/, // "One Piece 12", "series_04" (1–3 digits: not years)
  /^(\d+)$/ // "01"
];

const CHAPTER_PATTERNS: RegExp[] = [
  /第\s*(\d+)\s*話/, // 第12話
  /(?:^|[\s_\-–—(\[])(\d+)\s*話/, // 12話
  /(?:^|[^a-z])(?:ch(?:apter)?\.?)\s*(\d+)/i, // Chapter 105, ch.7
  /(?:^|\s)#\s*(\d+)/, // #12
  /(?:^|[\s_\-–—])(\d{1,4})\s*$/, // "One Piece 1050"
  /^(\d+)$/ // "012"
];

/**
 * Best-effort volume/chapter number from a stored volume title. Returns
 * undefined when nothing looks like a number for the requested unit; the
 * tracker then falls back to the volume's position in sort order.
 */
export function extractVolumeNumber(volumeTitle: string, unit: TrackingUnit): number | undefined {
  const title = (volumeTitle ?? '').trim();
  if (!title) return undefined;
  const patterns = unit === 'chapters' ? CHAPTER_PATTERNS : VOLUME_PATTERNS;
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/metadata/volume-number.test.ts`
Expected: PASS. If `'One Piece (2020)'` matches, the trailing-number pattern is wrong — it must require 1–3 digits and no `)` before end; keep it as written.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metadata/volume-number.ts src/lib/metadata/volume-number.test.ts
git commit -m "feat(metadata): extract volume/chapter numbers from titles"
```

---

### Task 3: `planProgressPush` (pure)

**Files:**

- Create: `src/lib/metadata/progress-plan.ts`
- Test: `src/lib/metadata/progress-plan.test.ts`

**Interfaces:**

- Consumes: `TrackingUnit`.
- Produces:

  ```ts
  export interface LocalPassState {
    passProgress: number;
    allCompleted: boolean;
    passComplete: boolean;
    timesRead: number;
    rereading: boolean;
  }
  export interface RemoteEntry {
    status: string | null;
    progress: number;
    progressVolumes: number;
    repeat: number;
  }
  export type ProgressPushEvent = 'completion' | 'restart' | 'sync';
  export interface ProgressPushPlan {
    status?: 'CURRENT' | 'COMPLETED' | 'REPEATING';
    progress?: number;
    progressVolumes?: number;
    repeat?: number;
  }
  export function planProgressPush(
    local: LocalPassState,
    remote: RemoteEntry | null,
    unit: TrackingUnit,
    event: ProgressPushEvent
  ): ProgressPushPlan | null;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/metadata/progress-plan.test.ts
import { describe, expect, it } from 'vitest';
import { planProgressPush, type LocalPassState, type RemoteEntry } from './progress-plan';

const local = (over: Partial<LocalPassState> = {}): LocalPassState => ({
  passProgress: 0,
  allCompleted: false,
  passComplete: false,
  timesRead: 0,
  rereading: false,
  ...over
});
const remote = (over: Partial<RemoteEntry> = {}): RemoteEntry => ({
  status: null,
  progress: 0,
  progressVolumes: 0,
  repeat: 0,
  ...over
});

describe('planProgressPush', () => {
  it('first read: pushes CURRENT with progressVolumes when local is ahead', () => {
    expect(planProgressPush(local({ passProgress: 3 }), remote(), 'volumes', 'completion')).toEqual(
      {
        status: 'CURRENT',
        progressVolumes: 3
      }
    );
  });

  it('uses the chapter field for the chapters unit', () => {
    expect(
      planProgressPush(
        local({ passProgress: 12 }),
        remote({ progress: 5 }),
        'chapters',
        'completion'
      )
    ).toEqual({ status: 'CURRENT', progress: 12 });
  });

  it('remote null behaves like an empty entry', () => {
    expect(planProgressPush(local({ passProgress: 1 }), null, 'volumes', 'completion')).toEqual({
      status: 'CURRENT',
      progressVolumes: 1
    });
  });

  it('is a no-op when remote is ahead or equal', () => {
    expect(
      planProgressPush(
        local({ passProgress: 3 }),
        remote({ progressVolumes: 5 }),
        'volumes',
        'completion'
      )
    ).toBeNull();
    expect(
      planProgressPush(
        local({ passProgress: 5 }),
        remote({ progressVolumes: 5 }),
        'volumes',
        'sync'
      )
    ).toBeNull();
  });

  it('pass complete: COMPLETED and repeat = timesRead - 1', () => {
    // second full read finished: read_count 1 + allCompleted → timesRead 2
    expect(
      planProgressPush(
        local({
          passProgress: 20,
          allCompleted: true,
          passComplete: true,
          timesRead: 2,
          rereading: false
        }),
        remote({ status: 'REPEATING', progressVolumes: 19, repeat: 0 }),
        'volumes',
        'completion'
      )
    ).toEqual({ status: 'COMPLETED', progressVolumes: 20, repeat: 1 });
  });

  it('first completion pushes COMPLETED without a repeat bump', () => {
    expect(
      planProgressPush(
        local({ passProgress: 20, allCompleted: true, passComplete: true, timesRead: 1 }),
        remote({ status: 'CURRENT', progressVolumes: 19 }),
        'volumes',
        'completion'
      )
    ).toEqual({ status: 'COMPLETED', progressVolumes: 20 });
  });

  it('restart: REPEATING with an explicit 0 even though remote is ahead', () => {
    // after restart of a once-read series: read_count 1, nothing completed → timesRead 1
    expect(
      planProgressPush(
        local({ passProgress: 0, timesRead: 1, rereading: true }),
        remote({ status: 'COMPLETED', progressVolumes: 20, repeat: 0 }),
        'volumes',
        'restart'
      )
    ).toEqual({ status: 'REPEATING', progressVolumes: 0 });
  });

  it('re-read completions push REPEATING while the pass is in flight', () => {
    expect(
      planProgressPush(
        local({ passProgress: 2, timesRead: 1, rereading: true }),
        remote({ status: 'REPEATING', progressVolumes: 0 }),
        'volumes',
        'completion'
      )
    ).toEqual({ status: 'REPEATING', progressVolumes: 2 });
  });

  it('bumps repeat only when it would increase', () => {
    // manual +1 on read count while remote already at repeat 3
    expect(
      planProgressPush(
        local({ passProgress: 20, allCompleted: true, passComplete: true, timesRead: 3 }),
        remote({ status: 'COMPLETED', progressVolumes: 20, repeat: 3 }),
        'volumes',
        'sync'
      )
    ).toBeNull();
    expect(
      planProgressPush(
        local({ passProgress: 20, allCompleted: true, passComplete: true, timesRead: 5 }),
        remote({ status: 'COMPLETED', progressVolumes: 20, repeat: 3 }),
        'volumes',
        'sync'
      )
    ).toEqual({ repeat: 4 });
  });

  it('never returns an empty plan object', () => {
    expect(planProgressPush(local(), remote(), 'volumes', 'sync')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/metadata/progress-plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/metadata/progress-plan.ts
import type { TrackingUnit } from './types';

export interface LocalPassState {
  /** Highest volume/chapter number among volumes completed in the current pass. */
  passProgress: number;
  /** Every local volume of the series is completed. */
  allCompleted: boolean;
  /** Series total is known and passProgress reaches it. */
  passComplete: boolean;
  /** read_count + (allCompleted ? 1 : 0). */
  timesRead: number;
  /** read_count >= 1 && !allCompleted — a later pass is in flight. */
  rereading: boolean;
}

export interface RemoteEntry {
  status: string | null;
  progress: number;
  progressVolumes: number;
  repeat: number;
}

export type ProgressPushEvent = 'completion' | 'restart' | 'sync';

export interface ProgressPushPlan {
  status?: 'CURRENT' | 'COMPLETED' | 'REPEATING';
  progress?: number;
  progressVolumes?: number;
  repeat?: number;
}

/**
 * Decide what (if anything) to send to AniList. Pure.
 * - restart: the one explicit decrease → REPEATING with progress 0.
 * - otherwise progress only ever moves forward; status COMPLETED when the pass
 *   reaches the known total, REPEATING while re-reading, CURRENT otherwise.
 * - repeat = timesRead - 1, sent only when it would increase.
 * Returns null when nothing would change.
 */
export function planProgressPush(
  local: LocalPassState,
  remote: RemoteEntry | null,
  unit: TrackingUnit,
  event: ProgressPushEvent
): ProgressPushPlan | null {
  const field: 'progress' | 'progressVolumes' =
    unit === 'chapters' ? 'progress' : 'progressVolumes';
  const remoteProgress = remote ? remote[field] : 0;
  const remoteRepeat = remote?.repeat ?? 0;
  const desiredRepeat = Math.max(0, local.timesRead - 1);
  const plan: ProgressPushPlan = {};

  if (event === 'restart') {
    plan.status = 'REPEATING';
    plan[field] = 0;
    if (desiredRepeat > remoteRepeat) plan.repeat = desiredRepeat;
    return plan;
  }

  if (local.passProgress > remoteProgress) {
    plan[field] = local.passProgress;
    plan.status = local.passComplete ? 'COMPLETED' : local.rereading ? 'REPEATING' : 'CURRENT';
  }
  if (desiredRepeat > remoteRepeat) {
    plan.repeat = desiredRepeat;
  }

  return Object.keys(plan).length > 0 ? plan : null;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/metadata/progress-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metadata/progress-plan.ts src/lib/metadata/progress-plan.test.ts
git commit -m "feat(metadata): pure AniList progress push planner"
```

---

### Task 4: Global master switch `catalogSettings.pushProgressToAniList`

**Files:**

- Modify: `src/lib/settings/settings.ts` (`CatalogSettings` type ~line 116-127, `defaultSettings.catalogSettings` ~line 340-350)
- Test: `src/lib/settings/settings.test.ts`

**Interfaces:**

- Produces: `catalogSettings.pushProgressToAniList: boolean` (default `true`); read via `get(settings).catalogSettings.pushProgressToAniList` and written with the existing `updateCatalogSetting('pushProgressToAniList', value)`.

- [ ] **Step 1: Write the failing test** — append to `src/lib/settings/settings.test.ts`:

```ts
describe('pushProgressToAniList migration', () => {
  it('defaults to true for profiles saved before the setting existed', () => {
    const migrated = migrateProfiles({
      Default: { catalogSettings: { stackingPreset: 'default' } }
    } as any);
    expect(migrated.Default.catalogSettings.pushProgressToAniList).toBe(true);
    expect(migrated.Default.catalogSettings.stackingPreset).toBe('default');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/settings/settings.test.ts`
Expected: FAIL — `pushProgressToAniList` is `undefined`.

- [ ] **Step 3: Implement**

In the `CatalogSettings` type add, after Plan B's `preferredTitleLanguage: DisplayTitleLanguage;` line:

```ts
/** Master switch for pushing completions to AniList (per-series tracking must also be on). */
pushProgressToAniList: boolean;
```

In `defaultSettings.catalogSettings` add, after `preferredTitleLanguage: 'imported',`:

```ts
pushProgressToAniList: true;
```

(`migrateProfiles` already spreads `defaultSettings.catalogSettings` under the stored object — no further change.)

- [ ] **Step 4: Run tests + type-check**

Run: `npx vitest run src/lib/settings/settings.test.ts && npm run check`
Expected: PASS; svelte-check reports 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings/settings.ts src/lib/settings/settings.test.ts
git commit -m "feat(settings): pushProgressToAniList master switch"
```

---

### Task 5: AniList auth (`anilist-auth.ts`), router callback, env docs

**Files:**

- Create: `src/lib/metadata/anilist-auth.ts`
- Modify: `src/lib/util/hash-router.ts` (`initRouter`, ~line 229), `.env.example`, `README.md` (env block ~line 186-196), `CLAUDE.md` ("Environment Variables" section)
- Test: `src/lib/metadata/anilist-auth.test.ts` (new), `src/lib/util/hash-router.test.ts` (append)

**Interfaces:**

- Consumes: `anilistRequest` from `./providers/anilist` (Plan A); `showSnackbar` from `$lib/util/snackbar`.
- Produces:

  ```ts
  export interface AniListUser {
    id: number;
    name: string;
  }
  export const ANILIST_CALLBACK_PREFIX = '#access_token=';
  export function getAniListClientId(): string | undefined;
  export function buildAniListAuthorizeUrl(clientId: string): string;
  export function startAniListLogin(): void;
  export function parseAniListCallbackHash(
    hash: string
  ): { accessToken: string; expiresInSec: number } | null;
  export function handleAniListCallbackHash(hash: string): Promise<boolean>;
  export function consumeAniListReturnHash(): string | null;
  export function getAniListToken(): string | null;
  export const anilistUser: Readable<AniListUser | null>;
  export function disconnectAniList(): void;
  export function handleAniListUnauthorized(): void; // clears session + snackbar
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/metadata/anilist-auth.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
vi.mock('./providers/anilist', () => ({
  anilistRequest: vi.fn()
}));

import { anilistRequest } from './providers/anilist';
import {
  anilistUser,
  buildAniListAuthorizeUrl,
  consumeAniListReturnHash,
  disconnectAniList,
  getAniListToken,
  handleAniListCallbackHash,
  parseAniListCallbackHash
} from './anilist-auth';

describe('parseAniListCallbackHash', () => {
  it('parses the implicit-grant fragment', () => {
    expect(
      parseAniListCallbackHash('#access_token=abc.def&token_type=Bearer&expires_in=31536000')
    ).toEqual({ accessToken: 'abc.def', expiresInSec: 31536000 });
  });
  it('rejects unrelated hashes', () => {
    expect(parseAniListCallbackHash('#/catalog')).toBeNull();
    expect(parseAniListCallbackHash('#access_token=')).toBeNull();
  });
});

describe('handleAniListCallbackHash', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(anilistRequest).mockReset();
  });

  it('stores token + expiry synchronously and the viewer once fetched', async () => {
    vi.mocked(anilistRequest).mockResolvedValue({ Viewer: { id: 42, name: 'nathan' } });
    const promise = handleAniListCallbackHash(
      '#access_token=tok&token_type=Bearer&expires_in=3600'
    );
    // token must be readable before the Viewer round-trip resolves
    expect(localStorage.getItem('anilist_token')).toBe('tok');
    expect(Number(localStorage.getItem('anilist_token_expires_at'))).toBeGreaterThan(Date.now());
    await expect(promise).resolves.toBe(true);
    expect(anilistRequest).toHaveBeenCalledWith(expect.stringContaining('Viewer'), {}, 'tok');
    expect(get(anilistUser)).toEqual({ id: 42, name: 'nathan' });
    expect(getAniListToken()).toBe('tok');
  });

  it('returns false for a non-callback hash and stores nothing', async () => {
    await expect(handleAniListCallbackHash('#/series/x')).resolves.toBe(false);
    expect(localStorage.getItem('anilist_token')).toBeNull();
  });

  it('expired tokens read back as null and are cleared', () => {
    localStorage.setItem('anilist_token', 'old');
    localStorage.setItem('anilist_token_expires_at', String(Date.now() - 1));
    expect(getAniListToken()).toBeNull();
    expect(localStorage.getItem('anilist_token')).toBeNull();
  });

  it('disconnect clears everything', async () => {
    vi.mocked(anilistRequest).mockResolvedValue({ Viewer: { id: 1, name: 'x' } });
    await handleAniListCallbackHash('#access_token=tok&token_type=Bearer&expires_in=3600');
    disconnectAniList();
    expect(getAniListToken()).toBeNull();
    expect(get(anilistUser)).toBeNull();
    expect(localStorage.getItem('anilist_user')).toBeNull();
  });
});

describe('return hash', () => {
  it('consumes the saved return hash once', () => {
    sessionStorage.setItem('anilist_return', '#/series/One%20Piece');
    expect(consumeAniListReturnHash()).toBe('#/series/One%20Piece');
    expect(consumeAniListReturnHash()).toBeNull();
  });
});

describe('buildAniListAuthorizeUrl', () => {
  it('uses the implicit grant', () => {
    expect(buildAniListAuthorizeUrl('123')).toBe(
      'https://anilist.co/api/v2/oauth/authorize?client_id=123&response_type=token'
    );
  });
});
```

Append to `src/lib/util/hash-router.test.ts`:

```ts
import { vi, beforeEach } from 'vitest';
vi.mock('$lib/metadata/providers/anilist', () => ({
  anilistRequest: vi.fn().mockResolvedValue({ Viewer: null })
}));
import { initRouter } from './hash-router';

describe('AniList implicit-grant callback', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  test('stores the token and restores the pre-login route', () => {
    sessionStorage.setItem('anilist_return', '#/series/One%20Piece');
    window.location.hash = '#access_token=tok123&token_type=Bearer&expires_in=3600';
    const cleanup = initRouter();
    expect(localStorage.getItem('anilist_token')).toBe('tok123');
    expect(window.location.hash).toBe('#/series/One%20Piece');
    cleanup();
  });

  test('falls back to the catalog when no return route was saved', () => {
    window.location.hash = '#access_token=tok123&token_type=Bearer&expires_in=3600';
    const cleanup = initRouter();
    expect(window.location.hash).toBe('#/catalog');
    cleanup();
  });
});
```

(`hash-router.test.ts` currently imports `describe, expect, test` only — merge the extra imports into its existing import line.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/metadata/anilist-auth.test.ts src/lib/util/hash-router.test.ts`
Expected: FAIL — `anilist-auth` module missing; router test leaves the `#access_token=` hash in place.

- [ ] **Step 3: Implement `src/lib/metadata/anilist-auth.ts`**

```ts
import { browser } from '$app/environment';
import { writable, type Readable } from 'svelte/store';
import { showSnackbar } from '$lib/util/snackbar';
import { anilistRequest } from './providers/anilist';

const TOKEN_KEY = 'anilist_token';
const EXPIRES_KEY = 'anilist_token_expires_at';
const USER_KEY = 'anilist_user';
const RETURN_KEY = 'anilist_return';
const DEFAULT_TTL_SEC = 365 * 24 * 60 * 60; // AniList tokens last one year

export const ANILIST_CALLBACK_PREFIX = '#access_token=';

export interface AniListUser {
  id: number;
  name: string;
}

export function getAniListClientId(): string | undefined {
  const raw = import.meta.env.VITE_ANILIST_CLIENT_ID as string | undefined;
  const id = raw?.trim();
  return id ? id : undefined;
}

export function buildAniListAuthorizeUrl(clientId: string): string {
  return `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(clientId)}&response_type=token`;
}

function readStoredUser(): AniListUser | null {
  if (!browser) return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.id === 'number' && typeof parsed?.name === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

const _anilistUser = writable<AniListUser | null>(readStoredUser());
export const anilistUser: Readable<AniListUser | null> = { subscribe: _anilistUser.subscribe };

function clearAniListSession(): void {
  if (!browser) return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRES_KEY);
  localStorage.removeItem(USER_KEY);
  _anilistUser.set(null);
}

/** Current access token, or null when absent/expired (expired tokens are cleared). */
export function getAniListToken(): string | null {
  if (!browser) return null;
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const expiresAt = Number(localStorage.getItem(EXPIRES_KEY) || 0);
  if (expiresAt > 0 && Date.now() >= expiresAt) {
    clearAniListSession();
    return null;
  }
  return token;
}

/** Redirect flow (no popup): remember where we were, then leave for AniList. */
export function startAniListLogin(): void {
  const clientId = getAniListClientId();
  if (!browser || !clientId) return;
  sessionStorage.setItem(RETURN_KEY, window.location.hash || '#/catalog');
  window.location.assign(buildAniListAuthorizeUrl(clientId));
}

export function parseAniListCallbackHash(
  hash: string
): { accessToken: string; expiresInSec: number } | null {
  if (!hash.startsWith(ANILIST_CALLBACK_PREFIX)) return null;
  const params = new URLSearchParams(hash.slice(1));
  const accessToken = params.get('access_token');
  if (!accessToken) return null;
  const expiresInSec = Number(params.get('expires_in') || 0);
  return { accessToken, expiresInSec };
}

/**
 * Handle the implicit-grant callback fragment. Stores the token synchronously
 * (so callers can immediately proceed) and resolves the Viewer in the background.
 * Returns true when the hash was a callback and was consumed.
 */
export async function handleAniListCallbackHash(hash: string): Promise<boolean> {
  const parsed = parseAniListCallbackHash(hash);
  if (!parsed || !browser) return false;
  const ttlSec = parsed.expiresInSec > 0 ? parsed.expiresInSec : DEFAULT_TTL_SEC;
  localStorage.setItem(TOKEN_KEY, parsed.accessToken);
  localStorage.setItem(EXPIRES_KEY, String(Date.now() + ttlSec * 1000));
  try {
    const data = await anilistRequest<{ Viewer: AniListUser | null }>(
      'query { Viewer { id name } }',
      {},
      parsed.accessToken
    );
    if (data.Viewer) {
      const user = { id: data.Viewer.id, name: data.Viewer.name };
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      _anilistUser.set(user);
    }
  } catch (error) {
    console.warn('[anilist-auth] Viewer lookup failed:', error);
  }
  return true;
}

/** Return-route saved by startAniListLogin(); cleared on read. */
export function consumeAniListReturnHash(): string | null {
  if (!browser) return null;
  const value = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  return value;
}

export function disconnectAniList(): void {
  clearAniListSession();
}

/** 401 from AniList: drop the session and tell the user; pending pushes stay queued. */
export function handleAniListUnauthorized(): void {
  clearAniListSession();
  showSnackbar('AniList session expired — reconnect in Settings');
}
```

Modify `initRouter()` in `src/lib/util/hash-router.ts` — add the import at the top:

```ts
import {
  ANILIST_CALLBACK_PREFIX,
  consumeAniListReturnHash,
  handleAniListCallbackHash
} from '$lib/metadata/anilist-auth';
```

and insert immediately before the `// Parse initial hash` comment inside `initRouter`:

```ts
// AniList implicit-grant callback lands on `{origin}/#access_token=…`.
// Store the token, then put the pre-login route back before parsing.
if (window.location.hash.startsWith(ANILIST_CALLBACK_PREFIX)) {
  const callbackHash = window.location.hash;
  const returnHash = consumeAniListReturnHash() || '#/catalog';
  window.history.replaceState(null, '', '/' + returnHash);
  void handleAniListCallbackHash(callbackHash);
}
```

Env docs — `.env.example`, append:

```
# AniList progress tracking (optional — omit to hide the AniList account section)
# Create an API client at https://anilist.co/settings/developer with the deploy
# origin + trailing slash as the redirect URL (one client per origin, e.g.
# https://reader.mokuro.app/ or http://localhost:5173/ for dev).
VITE_ANILIST_CLIENT_ID=
```

`README.md` env block: add `VITE_ANILIST_CLIENT_ID=your_anilist_client_id` to the fenced block and this paragraph after the OneDrive one:

```
For AniList progress tracking, create an API client at
https://anilist.co/settings/developer whose redirect URL is your deploy origin
(e.g. `https://reader.mokuro.app/`). When unset, series linking still works but
the AniList account/tracking controls are hidden.
```

`CLAUDE.md` "Environment Variables": add `VITE_ANILIST_CLIENT_ID=your_anilist_client_id` to the block and a bullet:

```
- `VITE_ANILIST_CLIENT_ID`: required only for pushing read progress to AniList.
  Register an AniList API client (implicit grant) whose redirect URL is the deploy
  origin with a trailing slash. Searching/linking series needs no key.
```

- [ ] **Step 4: Run tests + type-check**

Run: `npx vitest run src/lib/metadata/anilist-auth.test.ts src/lib/util/hash-router.test.ts && npm run check`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metadata/anilist-auth.ts src/lib/metadata/anilist-auth.test.ts src/lib/util/hash-router.ts src/lib/util/hash-router.test.ts .env.example README.md CLAUDE.md
git commit -m "feat(anilist): implicit-grant login, token storage, router callback"
```

---

### Task 6: `progress-tracker.ts` — local pass state, push, pending queue, init

**Files:**

- Create: `src/lib/metadata/progress-tracker.ts`
- Modify: `src/routes/+layout.svelte` (onMount, after `initFileHandler();` ~line 92)
- Test: `src/lib/metadata/progress-tracker.test.ts`

**Interfaces:**

- Consumes: Task 1 (`volumes`, `registerCompletionListener`, `VolumeData`), Task 2 (`extractVolumeNumber`), Task 3 (`planProgressPush` + types), Task 4 (`settings.catalogSettings.pushProgressToAniList`), Task 5 (`getAniListToken`, `anilistUser`, `handleAniListUnauthorized`), Plan A (`getSeriesMetadata`, `updateSeriesMetadata`, `normalizeSeriesKey`, `anilistRequest`, `AniListError`), `db.volumes`, `sortVolumes`.
- Produces:

  ```ts
  export function volumeNumberFor(
    volume: VolumeMetadata,
    sortedSeriesVolumes: VolumeMetadata[],
    meta: SeriesMetadata | undefined
  ): number;
  export function computeLocalPassState(
    seriesVolumes: VolumeMetadata[],
    volumesData: Record<string, VolumeData>,
    meta: SeriesMetadata | undefined
  ): LocalPassState;
  export type PushOutcome = 'pushed' | 'nothing' | 'queued' | 'disabled';
  export function onVolumeCompleted(volumeUuid: string): void;
  export function onSeriesRestarted(seriesKey: string): void;
  export function syncSeriesNow(seriesKey: string): Promise<PushOutcome>;
  export function flushPendingPushes(): Promise<void>;
  export function initProgressTracker(): () => void;
  // exported for tests:
  export function readPendingPushes(): Record<string, PendingPush>;
  export interface PendingPush {
    seriesKey: string;
    event: 'restart' | 'sync';
    at: string;
  }
  ```

  Contract deviation (declared): `computeLocalPassState` drops the unused leading `seriesKey` parameter.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/metadata/progress-tracker.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata } from './types';

vi.mock('$app/environment', () => ({ browser: true }));

const volumesStore = writable<Record<string, any>>({});
vi.mock('$lib/settings/volume-data', () => ({
  volumes: volumesStore,
  registerCompletionListener: vi.fn(() => () => {})
}));

const settingsStore = writable<any>({ catalogSettings: { pushProgressToAniList: true } });
vi.mock('$lib/settings/settings', () => ({ settings: settingsStore }));

const dbVolumes: VolumeMetadata[] = [];
vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: {
      toArray: vi.fn(async () => dbVolumes),
      get: vi.fn(async (uuid: string) => dbVolumes.find((v) => v.volume_uuid === uuid))
    }
  }
}));

const metaByKey = new Map<string, SeriesMetadata>();
vi.mock('./store', () => ({
  getSeriesMetadata: vi.fn(async (key: string) => metaByKey.get(key)),
  updateSeriesMetadata: vi.fn(async (title: string, patch: any) => {
    const key = title.trim().replace(/\s+/g, ' ').toLowerCase();
    const next = { ...metaByKey.get(key)!, ...patch };
    metaByKey.set(key, next);
    return next;
  })
}));

class FakeAniListError extends Error {
  code: string;
  retryAfterMs?: number;
  constructor(code: string, retryAfterMs?: number) {
    super(code);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
vi.mock('./providers/anilist', () => ({
  anilistRequest: vi.fn(),
  AniListError: FakeAniListError
}));

const authUser = writable<{ id: number; name: string } | null>({ id: 1, name: 'n' });
let token: string | null = 'tok';
vi.mock('./anilist-auth', () => ({
  getAniListToken: () => token,
  anilistUser: authUser,
  handleAniListUnauthorized: vi.fn()
}));

import { anilistRequest } from './providers/anilist';
import { handleAniListUnauthorized } from './anilist-auth';
import {
  computeLocalPassState,
  readPendingPushes,
  syncSeriesNow,
  volumeNumberFor
} from './progress-tracker';

const vol = (uuid: string, title: string): VolumeMetadata =>
  ({
    volume_uuid: uuid,
    volume_title: title,
    series_title: 'One Piece',
    series_uuid: 's',
    mokuro_version: '',
    page_count: 10,
    character_count: 100,
    page_char_counts: []
  }) as VolumeMetadata;

const meta = (over: Partial<SeriesMetadata> = {}): SeriesMetadata => ({
  series_key: 'one piece',
  series_title: 'One Piece',
  external_ids: { anilist: 30013 },
  titles: {},
  synonyms: [],
  read_count: 0,
  tracking: { enabled: true, unit: 'volumes' },
  updated_at: '2026-01-01T00:00:00.000Z',
  ...over
});

describe('volumeNumberFor', () => {
  const sorted = [vol('a', 'Vol 01'), vol('b', 'Vol 02'), vol('c', 'Extras')];
  it('prefers overrides, then parsed numbers, then sort position', () => {
    const m = meta({ tracking: { enabled: true, unit: 'volumes', number_overrides: { b: 7 } } });
    expect(volumeNumberFor(sorted[1], sorted, m)).toBe(7);
    expect(volumeNumberFor(sorted[0], sorted, m)).toBe(1);
    expect(volumeNumberFor(sorted[2], sorted, m)).toBe(3);
  });
});

describe('computeLocalPassState', () => {
  const series = [vol('a', 'Vol 01'), vol('b', 'Vol 02'), vol('c', 'Vol 03')];
  it('first read in progress', () => {
    const state = computeLocalPassState(
      series,
      { a: { completed: true }, b: { completed: true } },
      meta()
    );
    expect(state).toEqual({
      passProgress: 2,
      allCompleted: false,
      passComplete: false,
      timesRead: 0,
      rereading: false
    });
  });
  it('all local volumes completed and total reached', () => {
    const state = computeLocalPassState(
      series,
      { a: { completed: true }, b: { completed: true }, c: { completed: true } },
      meta({ total_volumes: 3 })
    );
    expect(state).toEqual({
      passProgress: 3,
      allCompleted: true,
      passComplete: true,
      timesRead: 1,
      rereading: false
    });
  });
  it('re-read in flight after a restart', () => {
    const state = computeLocalPassState(
      series,
      { a: { completed: true } },
      meta({ read_count: 1, total_volumes: 3 })
    );
    expect(state).toMatchObject({
      passProgress: 1,
      timesRead: 1,
      rereading: true,
      passComplete: false
    });
  });
  it('uses total_chapters for the chapters unit', () => {
    const chapters = [vol('a', 'Chapter 1'), vol('b', 'Chapter 2')];
    const state = computeLocalPassState(
      chapters,
      { a: { completed: true }, b: { completed: true } },
      meta({ tracking: { enabled: true, unit: 'chapters' }, total_chapters: 2 })
    );
    expect(state.passComplete).toBe(true);
  });
});

describe('syncSeriesNow', () => {
  beforeEach(() => {
    localStorage.clear();
    dbVolumes.splice(0, dbVolumes.length, vol('a', 'Vol 01'), vol('b', 'Vol 02'));
    volumesStore.set({ a: { completed: true }, b: { completed: true } });
    metaByKey.clear();
    metaByKey.set('one piece', meta({ total_volumes: 20 }));
    token = 'tok';
    vi.mocked(anilistRequest).mockReset();
    vi.mocked(handleAniListUnauthorized).mockReset();
  });

  it('reads the remote entry, sends the plan and records last_pushed', async () => {
    vi.mocked(anilistRequest)
      .mockResolvedValueOnce({
        Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 1, repeat: 0 } }
      })
      .mockResolvedValueOnce({
        SaveMediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 2, repeat: 0 }
      });

    await expect(syncSeriesNow('one piece')).resolves.toBe('pushed');

    const [, mutationCall] = vi.mocked(anilistRequest).mock.calls;
    expect(mutationCall[0]).toContain('SaveMediaListEntry');
    expect(mutationCall[1]).toEqual({ mediaId: 30013, status: 'CURRENT', progressVolumes: 2 });
    expect(mutationCall[2]).toBe('tok');
    expect(metaByKey.get('one piece')!.tracking!.last_pushed).toMatchObject({
      n: 2,
      status: 'CURRENT'
    });
    expect(readPendingPushes()).toEqual({});
  });

  it('is "nothing" when remote is already ahead', async () => {
    vi.mocked(anilistRequest).mockResolvedValueOnce({
      Media: { mediaListEntry: { status: 'CURRENT', progress: 0, progressVolumes: 5, repeat: 0 } }
    });
    await expect(syncSeriesNow('one piece')).resolves.toBe('nothing');
    expect(anilistRequest).toHaveBeenCalledTimes(1);
  });

  it('is "disabled" when tracking is off, unlinked, or the master switch is off', async () => {
    metaByKey.set('one piece', meta({ tracking: { enabled: false, unit: 'volumes' } }));
    await expect(syncSeriesNow('one piece')).resolves.toBe('disabled');
    metaByKey.set('one piece', meta({ external_ids: {} }));
    await expect(syncSeriesNow('one piece')).resolves.toBe('disabled');
    metaByKey.set('one piece', meta());
    settingsStore.set({ catalogSettings: { pushProgressToAniList: false } });
    await expect(syncSeriesNow('one piece')).resolves.toBe('disabled');
    settingsStore.set({ catalogSettings: { pushProgressToAniList: true } });
  });

  it('queues when there is no token', async () => {
    token = null;
    await expect(syncSeriesNow('one piece')).resolves.toBe('queued');
    expect(readPendingPushes()['one piece']).toMatchObject({ event: 'sync' });
    expect(anilistRequest).not.toHaveBeenCalled();
  });

  it('queues on network errors and clears the session on 401', async () => {
    vi.mocked(anilistRequest).mockRejectedValueOnce(new FakeAniListError('NETWORK'));
    await expect(syncSeriesNow('one piece')).resolves.toBe('queued');
    expect(readPendingPushes()['one piece']).toBeDefined();

    vi.mocked(anilistRequest).mockRejectedValueOnce(new FakeAniListError('UNAUTHORIZED'));
    await expect(syncSeriesNow('one piece')).resolves.toBe('queued');
    expect(handleAniListUnauthorized).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/metadata/progress-tracker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/metadata/progress-tracker.ts`**

```ts
import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { db } from '$lib/catalog/db';
import { sortVolumes } from '$lib/catalog/sort-volumes';
import { settings } from '$lib/settings/settings';
import { registerCompletionListener, volumes, type VolumeData } from '$lib/settings/volume-data';
import type { VolumeMetadata } from '$lib/types';
import { anilistUser, getAniListToken, handleAniListUnauthorized } from './anilist-auth';
import {
  planProgressPush,
  type LocalPassState,
  type ProgressPushEvent,
  type ProgressPushPlan,
  type RemoteEntry
} from './progress-plan';
import { AniListError, anilistRequest } from './providers/anilist';
import { normalizeSeriesKey } from './series-key';
import { getSeriesMetadata, updateSeriesMetadata } from './store';
import type { SeriesMetadata } from './types';
import { extractVolumeNumber } from './volume-number';

const PENDING_KEY = 'anilist_pending_pushes';

export type PushOutcome = 'pushed' | 'nothing' | 'queued' | 'disabled';

/** One pending intent per series. `restart` dominates `sync` (a restart must be
 *  replayed as the explicit decrease before later completions are applied). */
export interface PendingPush {
  seriesKey: string;
  event: 'restart' | 'sync';
  at: string;
}

// ---------- pure helpers ----------

export function volumeNumberFor(
  volume: VolumeMetadata,
  sortedSeriesVolumes: VolumeMetadata[],
  meta: SeriesMetadata | undefined
): number {
  const override = meta?.tracking?.number_overrides?.[volume.volume_uuid];
  if (typeof override === 'number' && override > 0) return override;
  const parsed = extractVolumeNumber(volume.volume_title, meta?.tracking?.unit ?? 'volumes');
  if (parsed !== undefined) return parsed;
  return sortedSeriesVolumes.findIndex((v) => v.volume_uuid === volume.volume_uuid) + 1;
}

export function computeLocalPassState(
  seriesVolumes: VolumeMetadata[],
  volumesData: Record<string, Pick<VolumeData, 'completed'> | undefined>,
  meta: SeriesMetadata | undefined
): LocalPassState {
  const sorted = [...seriesVolumes].sort(sortVolumes);
  const unit = meta?.tracking?.unit ?? 'volumes';
  let passProgress = 0;
  let allCompleted = sorted.length > 0;
  for (const volume of sorted) {
    if (volumesData[volume.volume_uuid]?.completed) {
      passProgress = Math.max(passProgress, volumeNumberFor(volume, sorted, meta));
    } else {
      allCompleted = false;
    }
  }
  const total = unit === 'chapters' ? meta?.total_chapters : meta?.total_volumes;
  const passComplete = typeof total === 'number' && total > 0 && passProgress >= total;
  const readCount = meta?.read_count ?? 0;
  return {
    passProgress,
    allCompleted,
    passComplete,
    timesRead: readCount + (allCompleted ? 1 : 0),
    rereading: readCount >= 1 && !allCompleted
  };
}

// ---------- pending queue ----------

export function readPendingPushes(): Record<string, PendingPush> {
  if (!browser) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePendingPushes(pending: Record<string, PendingPush>): void {
  if (!browser) return;
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

function markPending(seriesKey: string, event: ProgressPushEvent): void {
  const pending = readPendingPushes();
  const existing = pending[seriesKey];
  const next: PendingPush['event'] =
    event === 'restart' || existing?.event === 'restart' ? 'restart' : 'sync';
  pending[seriesKey] = { seriesKey, event: next, at: new Date().toISOString() };
  writePendingPushes(pending);
}

function clearPending(seriesKey: string): void {
  const pending = readPendingPushes();
  if (pending[seriesKey]) {
    delete pending[seriesKey];
    writePendingPushes(pending);
  }
}

// ---------- AniList I/O ----------

const REMOTE_QUERY =
  'query ($id: Int) { Media(id: $id, type: MANGA) { mediaListEntry { status progress progressVolumes repeat } } }';
const SAVE_MUTATION =
  'mutation ($mediaId: Int, $status: MediaListStatus, $progress: Int, $progressVolumes: Int, $repeat: Int) { SaveMediaListEntry(mediaId: $mediaId, status: $status, progress: $progress, progressVolumes: $progressVolumes, repeat: $repeat) { status progress progressVolumes repeat } }';

async function fetchRemoteEntry(mediaId: number, token: string): Promise<RemoteEntry | null> {
  const data = await anilistRequest<{
    Media: {
      mediaListEntry: {
        status: string | null;
        progress: number | null;
        progressVolumes: number | null;
        repeat: number | null;
      } | null;
    } | null;
  }>(REMOTE_QUERY, { id: mediaId }, token);
  const entry = data.Media?.mediaListEntry;
  if (!entry) return null;
  return {
    status: entry.status ?? null,
    progress: entry.progress ?? 0,
    progressVolumes: entry.progressVolumes ?? 0,
    repeat: entry.repeat ?? 0
  };
}

async function sendPlan(mediaId: number, plan: ProgressPushPlan, token: string): Promise<void> {
  // undefined plan fields are dropped by JSON.stringify → AniList leaves them untouched
  await anilistRequest(SAVE_MUTATION, { mediaId, ...plan }, token);
}

// ---------- core ----------

async function getSeriesVolumesByKey(seriesKey: string): Promise<VolumeMetadata[]> {
  const all = await db.volumes.toArray();
  return all.filter((v) => normalizeSeriesKey(v.series_title) === seriesKey);
}

function pushEnabled(meta: SeriesMetadata | undefined): meta is SeriesMetadata {
  if (!meta?.tracking?.enabled) return false;
  if (!meta.external_ids.anilist) return false;
  return get(settings)?.catalogSettings?.pushProgressToAniList !== false;
}

let retryTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRetry(delayMs: number): void {
  if (!browser) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(
    () => {
      retryTimer = undefined;
      void flushPendingPushes();
    },
    Math.max(1000, delayMs)
  );
}

async function pushSeries(seriesKey: string, event: ProgressPushEvent): Promise<PushOutcome> {
  const meta = await getSeriesMetadata(seriesKey);
  if (!pushEnabled(meta)) return 'disabled';
  const mediaId = meta.external_ids.anilist!;
  const unit = meta.tracking?.unit ?? 'volumes';

  const token = getAniListToken();
  if (!token) {
    markPending(seriesKey, event);
    return 'queued';
  }

  const seriesVolumes = await getSeriesVolumesByKey(seriesKey);
  const local = computeLocalPassState(seriesVolumes, get(volumes), meta);

  try {
    const remote = await fetchRemoteEntry(mediaId, token);
    const plan = planProgressPush(local, remote, unit, event);
    if (!plan) {
      clearPending(seriesKey);
      return 'nothing';
    }
    await sendPlan(mediaId, plan, token);
    clearPending(seriesKey);
    await updateSeriesMetadata(meta.series_title, {
      tracking: {
        ...meta.tracking!,
        last_pushed: {
          n: local.passProgress,
          status: plan.status ?? remote?.status ?? 'CURRENT',
          at: new Date().toISOString()
        }
      }
    });
    return 'pushed';
  } catch (error) {
    markPending(seriesKey, event);
    if (error instanceof AniListError) {
      if (error.code === 'UNAUTHORIZED') handleAniListUnauthorized();
      else if (error.code === 'RATE_LIMITED') scheduleRetry(error.retryAfterMs ?? 60_000);
      else if (error.code === 'GRAPHQL') {
        // Bad media id or schema mismatch — retrying won't help.
        console.warn('[progress-tracker] AniList rejected the push:', error);
        clearPending(seriesKey);
      }
    } else {
      console.warn('[progress-tracker] push failed:', error);
    }
    return 'queued';
  }
}

// ---------- public API ----------

export function onVolumeCompleted(volumeUuid: string): void {
  if (!browser) return;
  db.volumes
    .get(volumeUuid)
    .then((volume) => {
      if (!volume) return;
      return pushSeries(normalizeSeriesKey(volume.series_title), 'completion');
    })
    .catch((error) => console.warn('[progress-tracker] onVolumeCompleted failed:', error));
}

export function onSeriesRestarted(seriesKey: string): void {
  if (!browser) return;
  pushSeries(seriesKey, 'restart').catch((error) =>
    console.warn('[progress-tracker] onSeriesRestarted failed:', error)
  );
}

export function syncSeriesNow(seriesKey: string): Promise<PushOutcome> {
  return pushSeries(seriesKey, 'sync');
}

let flushing = false;
export async function flushPendingPushes(): Promise<void> {
  if (!browser || flushing) return;
  if (!getAniListToken()) return;
  flushing = true;
  try {
    for (const pending of Object.values(readPendingPushes())) {
      if (pending.event === 'restart') {
        const outcome = await pushSeries(pending.seriesKey, 'restart');
        if (outcome === 'queued') continue;
      }
      await pushSeries(pending.seriesKey, 'sync');
    }
  } finally {
    flushing = false;
  }
}

/** Wire the tracker to completions, connectivity and login. Returns a cleanup. */
export function initProgressTracker(): () => void {
  if (!browser) return () => {};
  const unregister = registerCompletionListener(onVolumeCompleted);
  const onOnline = () => void flushPendingPushes();
  window.addEventListener('online', onOnline);
  let sawUser = false;
  const unsubUser = anilistUser.subscribe((user) => {
    if (user && !sawUser) void flushPendingPushes();
    sawUser = !!user;
  });
  void flushPendingPushes();
  return () => {
    unregister();
    window.removeEventListener('online', onOnline);
    unsubUser();
    if (retryTimer) clearTimeout(retryTimer);
  };
}
```

Mount it in `src/routes/+layout.svelte`: add `import { initProgressTracker } from '$lib/metadata/progress-tracker';` and inside `onMount`, right after `initFileHandler();`:

```ts
// AniList progress push: completion listener + pending-queue flush
initProgressTracker();
```

- [ ] **Step 4: Run tests + type-check**

Run: `npx vitest run src/lib/metadata/progress-tracker.test.ts && npm run check`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metadata/progress-tracker.ts src/lib/metadata/progress-tracker.test.ts src/routes/+layout.svelte
git commit -m "feat(anilist): progress tracker with pending queue and completion hook"
```

---

### Task 7: `reread.ts` — detection + restart

**Files:**

- Create: `src/lib/metadata/reread.ts`
- Test: `src/lib/metadata/reread.test.ts`

**Interfaces:**

- Consumes: Task 1 (`archiveAndResetVolumes`, `volumes`), Task 6 (`onSeriesRestarted`), Plan A (`getSeriesMetadataForTitle`, `updateSeriesMetadata`, `normalizeSeriesKey`), `sortVolumes`.
- Produces:

  ```ts
  export function shouldOfferReread(args: {
    volumeUuid: string;
    seriesVolumes: VolumeMetadata[];
    volumesData: Record<string, Pick<VolumeData, 'completed'> | undefined>;
    meta: SeriesMetadata | undefined;
    seriesKey: string;
  }): boolean;
  export function dismissRereadForSession(seriesKey: string): void;
  export function suppressRereadPrompt(seriesTitle: string): Promise<void>;
  export function restartSeries(
    seriesTitle: string,
    seriesVolumes: VolumeMetadata[]
  ): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/metadata/reread.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata } from './types';

vi.mock('$app/environment', () => ({ browser: true }));

const volumesStore = writable<Record<string, any>>({});
vi.mock('$lib/settings/volume-data', () => ({
  volumes: volumesStore,
  archiveAndResetVolumes: vi.fn()
}));

const metaByKey = new Map<string, SeriesMetadata>();
vi.mock('./store', () => ({
  getSeriesMetadataForTitle: vi.fn(async (title: string) =>
    metaByKey.get(title.trim().replace(/\s+/g, ' ').toLowerCase())
  ),
  updateSeriesMetadata: vi.fn(async (title: string, patch: any) => patch)
}));

vi.mock('./progress-tracker', () => ({ onSeriesRestarted: vi.fn() }));

import { archiveAndResetVolumes } from '$lib/settings/volume-data';
import { updateSeriesMetadata } from './store';
import { onSeriesRestarted } from './progress-tracker';
import {
  dismissRereadForSession,
  restartSeries,
  shouldOfferReread,
  suppressRereadPrompt
} from './reread';

const vol = (uuid: string, title: string): VolumeMetadata =>
  ({
    volume_uuid: uuid,
    volume_title: title,
    series_title: 'One Piece',
    series_uuid: 's'
  }) as VolumeMetadata;
const series = [vol('b', 'Vol 02'), vol('a', 'Vol 01'), vol('c', 'Vol 03')]; // unsorted on purpose
const allDone = { a: { completed: true }, b: { completed: true }, c: { completed: true } };

describe('shouldOfferReread', () => {
  beforeEach(() => sessionStorage.clear());

  const base = {
    seriesVolumes: series,
    volumesData: allDone,
    meta: undefined,
    seriesKey: 'one piece'
  };

  it('offers on the first volume of a fully completed series', () => {
    expect(shouldOfferReread({ ...base, volumeUuid: 'a' })).toBe(true);
  });
  it('never offers on a non-first volume', () => {
    expect(shouldOfferReread({ ...base, volumeUuid: 'b' })).toBe(false);
  });
  it('does not offer when any volume is incomplete', () => {
    expect(
      shouldOfferReread({
        ...base,
        volumeUuid: 'a',
        volumesData: { ...allDone, c: { completed: false } }
      })
    ).toBe(false);
  });
  it('respects the per-series suppression and the session dismissal', () => {
    expect(
      shouldOfferReread({
        ...base,
        volumeUuid: 'a',
        meta: { reread_prompt_suppressed: true } as SeriesMetadata
      })
    ).toBe(false);
    dismissRereadForSession('one piece');
    expect(shouldOfferReread({ ...base, volumeUuid: 'a' })).toBe(false);
  });
  it('is false for an empty series', () => {
    expect(shouldOfferReread({ ...base, volumeUuid: 'a', seriesVolumes: [] })).toBe(false);
  });
});

describe('restartSeries', () => {
  beforeEach(() => {
    vi.mocked(archiveAndResetVolumes).mockClear();
    vi.mocked(updateSeriesMetadata).mockClear();
    vi.mocked(onSeriesRestarted).mockClear();
    metaByKey.clear();
    sessionStorage.clear();
  });

  it('archives, bumps read_count when the series was fully read, clears suppression, notifies tracker', async () => {
    volumesStore.set(allDone);
    metaByKey.set('one piece', { read_count: 1, reread_prompt_suppressed: true } as SeriesMetadata);
    dismissRereadForSession('one piece');

    await restartSeries('One Piece', series);

    expect(archiveAndResetVolumes).toHaveBeenCalledWith(['b', 'a', 'c']);
    expect(updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
      read_count: 2,
      reread_prompt_suppressed: false
    });
    expect(sessionStorage.getItem('reread_dismissed:one piece')).toBeNull();
    expect(onSeriesRestarted).toHaveBeenCalledWith('one piece');
  });

  it('does not bump read_count for a partially read series', async () => {
    volumesStore.set({ a: { completed: true } });
    await restartSeries('One Piece', series);
    expect(updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
      read_count: 0,
      reread_prompt_suppressed: false
    });
  });

  it('suppressRereadPrompt persists the flag', async () => {
    await suppressRereadPrompt('One Piece');
    expect(updateSeriesMetadata).toHaveBeenCalledWith('One Piece', {
      reread_prompt_suppressed: true
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/metadata/reread.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/metadata/reread.ts`**

```ts
import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { sortVolumes } from '$lib/catalog/sort-volumes';
import { archiveAndResetVolumes, volumes, type VolumeData } from '$lib/settings/volume-data';
import type { VolumeMetadata } from '$lib/types';
import { onSeriesRestarted } from './progress-tracker';
import { normalizeSeriesKey } from './series-key';
import { getSeriesMetadataForTitle, updateSeriesMetadata } from './store';
import type { SeriesMetadata } from './types';

const sessionKey = (seriesKey: string) => `reread_dismissed:${seriesKey}`;

/**
 * Offer a restart only when the reader opens the FIRST volume (sort order) of a
 * series whose every volume is completed, unless the user suppressed the prompt
 * for this series or dismissed it this session. Opening a later volume is browsing.
 */
export function shouldOfferReread(args: {
  volumeUuid: string;
  seriesVolumes: VolumeMetadata[];
  volumesData: Record<string, Pick<VolumeData, 'completed'> | undefined>;
  meta: SeriesMetadata | undefined;
  seriesKey: string;
}): boolean {
  const sorted = [...args.seriesVolumes].sort(sortVolumes);
  if (sorted.length === 0 || sorted[0].volume_uuid !== args.volumeUuid) return false;
  if (args.meta?.reread_prompt_suppressed) return false;
  if (browser && sessionStorage.getItem(sessionKey(args.seriesKey))) return false;
  return sorted.every((v) => args.volumesData[v.volume_uuid]?.completed === true);
}

export function dismissRereadForSession(seriesKey: string): void {
  if (browser) sessionStorage.setItem(sessionKey(seriesKey), '1');
}

export async function suppressRereadPrompt(seriesTitle: string): Promise<void> {
  await updateSeriesMetadata(seriesTitle, { reread_prompt_suppressed: true });
}

/**
 * Restart series: archive every volume's current read (stats kept), reset to
 * the start, bump read_count when the whole series had been read, clear the
 * prompt suppression, and tell the tracker (REPEATING / progress 0).
 */
export async function restartSeries(
  seriesTitle: string,
  seriesVolumes: VolumeMetadata[]
): Promise<void> {
  const seriesKey = normalizeSeriesKey(seriesTitle);
  const data = get(volumes);
  const wasFullyCompleted =
    seriesVolumes.length > 0 && seriesVolumes.every((v) => data[v.volume_uuid]?.completed === true);

  archiveAndResetVolumes(seriesVolumes.map((v) => v.volume_uuid));

  const meta = await getSeriesMetadataForTitle(seriesTitle);
  await updateSeriesMetadata(seriesTitle, {
    read_count: (meta?.read_count ?? 0) + (wasFullyCompleted ? 1 : 0),
    reread_prompt_suppressed: false
  });
  if (browser) sessionStorage.removeItem(sessionKey(seriesKey));

  onSeriesRestarted(seriesKey);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/metadata/reread.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/metadata/reread.ts src/lib/metadata/reread.test.ts
git commit -m "feat(reread): restart series + re-read detection"
```

---

### Task 8: `RereadPromptModal.svelte` in the reader

**Files:**

- Create: `src/lib/components/Reader/RereadPromptModal.svelte`
- Modify: `src/lib/components/Reader/Reader.svelte` (imports ~lines 5-60; state near line 70; template inside the `{#if volume && pages …}` block next to `<SettingsButton …/>` ~line 1081)

**Interfaces:**

- Consumes: Task 7 (`shouldOfferReread`, `restartSeries`, `dismissRereadForSession`, `suppressRereadPrompt`), Plan A (`getSeriesMetadataForTitle`, `normalizeSeriesKey`), Plan B (`resolveDisplayTitle`, `catalogSettings`), Reader's `$currentSeries` (VolumeMetadata[] incl. placeholders) and `$volumes`.
- Produces: `RereadPromptModal` props `{ open: boolean (bindable); seriesTitle: string; seriesKey: string; seriesVolumes: VolumeMetadata[]; displayTitle: string }`.

- [ ] **Step 1: Create the component**

```svelte
<!-- src/lib/components/Reader/RereadPromptModal.svelte -->
<script lang="ts">
  import { Button, Modal } from 'flowbite-svelte';
  import type { VolumeMetadata } from '$lib/types';
  import {
    dismissRereadForSession,
    restartSeries,
    suppressRereadPrompt
  } from '$lib/metadata/reread';
  import { showSnackbar } from '$lib/util/snackbar';

  interface Props {
    open: boolean;
    seriesTitle: string;
    seriesKey: string;
    seriesVolumes: VolumeMetadata[];
    displayTitle: string;
  }

  let {
    open = $bindable(false),
    seriesTitle,
    seriesKey,
    seriesVolumes,
    displayTitle
  }: Props = $props();
  let busy = $state(false);

  async function restart() {
    busy = true;
    try {
      await restartSeries(seriesTitle, seriesVolumes);
      showSnackbar('Series restarted — your previous read is kept in your stats');
      open = false;
    } catch (error) {
      console.error('[reread] restart failed:', error);
      showSnackbar('Could not restart the series');
    } finally {
      busy = false;
    }
  }

  function notNow() {
    dismissRereadForSession(seriesKey);
    open = false;
  }

  async function dontAsk() {
    dismissRereadForSession(seriesKey);
    open = false;
    try {
      await suppressRereadPrompt(seriesTitle);
    } catch (error) {
      console.warn('[reread] could not persist suppression:', error);
    }
  }
</script>

<Modal bind:open size="sm" outsideclose onclose={notNow}>
  <div class="flex flex-col gap-4">
    <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Start a re-read?</h3>
    <p class="text-sm text-gray-600 dark:text-gray-400">
      You've finished <span class="font-medium">{displayTitle}</span>. Restarting resets every
      volume to the start and counts another read — your reading time and stats are kept.
    </p>
    <div class="relative z-10 flex flex-wrap justify-end gap-2">
      <Button color="alternative" size="sm" onclick={dontAsk} disabled={busy}>
        Don't ask for this series
      </Button>
      <Button color="alternative" size="sm" onclick={notNow} disabled={busy}>Not now</Button>
      <Button color="primary" size="sm" onclick={restart} disabled={busy}>Restart series</Button>
    </div>
  </div>
</Modal>
```

- [ ] **Step 2: Wire it into `Reader.svelte`**

Add imports (next to the other `$lib` imports):

```ts
import RereadPromptModal from './RereadPromptModal.svelte';
import { shouldOfferReread } from '$lib/metadata/reread';
import { getSeriesMetadataForTitle } from '$lib/metadata/store';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { resolveDisplayTitle } from '$lib/metadata/display-title';
import { catalogSettings } from '$lib/settings/settings';
import { get } from 'svelte/store';
```

(`volumes` and `$currentSeries` are already imported/used in Reader.) Add state + effect after `let volumeData = $derived($currentVolumeData);`:

```ts
// Re-read detection: once per opened volume, ask when this is the first volume
// of a fully-read series (see $lib/metadata/reread.shouldOfferReread).
let rereadPromptOpen = $state(false);
let rereadCheckedFor = $state<string | null>(null);
let rereadDisplayTitle = $state('');
let localSeriesVolumes = $derived(($currentSeries || []).filter((v) => !v.isPlaceholder));

$effect(() => {
  const v = volume;
  const seriesVolumes = localSeriesVolumes;
  if (!v || seriesVolumes.length === 0 || rereadCheckedFor === v.volume_uuid) return;
  rereadCheckedFor = v.volume_uuid;
  const seriesKey = normalizeSeriesKey(v.series_title);
  getSeriesMetadataForTitle(v.series_title)
    .then((meta) => {
      rereadDisplayTitle = resolveDisplayTitle(
        v.series_title,
        meta,
        get(catalogSettings)?.preferredTitleLanguage ?? 'imported'
      );
      if (
        shouldOfferReread({
          volumeUuid: v.volume_uuid,
          seriesVolumes,
          volumesData: get(volumes),
          meta,
          seriesKey
        })
      ) {
        rereadPromptOpen = true;
      }
    })
    .catch((error) => console.warn('[reader] reread check failed:', error));
});
```

In the template, directly after `<SettingsButton visible={overlaysVisible} />`:

```svelte
<RereadPromptModal
  bind:open={rereadPromptOpen}
  seriesTitle={volume.series_title}
  seriesKey={normalizeSeriesKey(volume.series_title)}
  seriesVolumes={localSeriesVolumes}
  displayTitle={rereadDisplayTitle || volume.series_title}
/>
```

After a restart, `page` (`$derived($progress?.[uuid] || 1)`, Reader.svelte ~line 408) resolves to 1 because the volume's progress is now 0 — no explicit navigation needed.

- [ ] **Step 3: Type-check and run the whole suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors; all tests pass.

- [ ] **Step 4: Manual verification (dev server)**

Run: `npm run dev` → import a 2-volume synthetic series (or use the `verify` skill recipe), mark both volumes complete from the series page, open volume 1 → the modal appears; "Not now" → reopen volume 1 → no modal (session); reload → modal again; "Restart series" → reader shows page 1, series page shows both volumes unread, Settings → Stats totals unchanged. Open volume 2 of a completed series → no modal.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/Reader/RereadPromptModal.svelte src/lib/components/Reader/Reader.svelte
git commit -m "feat(reader): offer series restart when a re-read starts"
```

---

### Task 9: Series page controls — tracking, read count, restart

**Files:**

- Create: `src/lib/components/Series/SeriesTrackingPanel.svelte`
- Modify: `src/lib/components/Series/SeriesMetadataBar.svelte` (Plan A) — mount the panel
- Test: `src/lib/components/Series/__tests__/SeriesTrackingPanel.test.ts`

**Interfaces:**

- Consumes: Task 6 (`computeLocalPassState`, `syncSeriesNow`), Task 7 (`restartSeries`), Task 5 (`getAniListClientId`, `anilistUser`), Plan A (`seriesMetadataMap`, `updateSeriesMetadata`, `normalizeSeriesKey`, `SeriesTracking`, `TrackingUnit`), `volumes`, `promptConfirmation` from `$lib/util/modals`, `showSnackbar`.
- Produces: `SeriesTrackingPanel` props `{ seriesTitle: string; volumes: VolumeMetadata[] }`, mounted at the bottom of `SeriesMetadataBar`.

Contract deviation (declared): Plan C's controls live in a sibling component mounted from `SeriesMetadataBar.svelte` (one-line change) instead of growing that file — keeps Plan A's component small and avoids conflicting edits.

- [ ] **Step 1: Write the failing component test**

```ts
// src/lib/components/Series/__tests__/SeriesTrackingPanel.test.ts
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import { writable } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';

vi.mock('$app/environment', () => ({ browser: true }));

const metaMap = writable(
  new Map([
    [
      'one piece',
      {
        series_key: 'one piece',
        series_title: 'One Piece',
        external_ids: { anilist: 30013 },
        titles: {},
        synonyms: [],
        read_count: 1,
        tracking: { enabled: true, unit: 'volumes' },
        updated_at: '2026-01-01T00:00:00.000Z'
      }
    ]
  ])
);
vi.mock('$lib/metadata/store', () => ({
  seriesMetadataMap: metaMap,
  updateSeriesMetadata: vi.fn(async () => ({}))
}));
vi.mock('$lib/settings/volume-data', () => ({
  volumes: writable({ a: { completed: true }, b: { completed: true } })
}));
vi.mock('$lib/metadata/anilist-auth', () => ({
  getAniListClientId: () => 'client',
  anilistUser: writable({ id: 1, name: 'nathan' })
}));
vi.mock('$lib/metadata/progress-tracker', async () => {
  const actual = await vi.importActual<any>('$lib/metadata/progress-tracker');
  return {
    computeLocalPassState: actual.computeLocalPassState,
    syncSeriesNow: vi.fn(async () => 'pushed')
  };
});
vi.mock('$lib/metadata/reread', () => ({ restartSeries: vi.fn() }));
vi.mock('$lib/util/modals', () => ({ promptConfirmation: vi.fn() }));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));

import { updateSeriesMetadata } from '$lib/metadata/store';
import { syncSeriesNow } from '$lib/metadata/progress-tracker';
import SeriesTrackingPanel from '../SeriesTrackingPanel.svelte';

const volumes = [
  { volume_uuid: 'a', volume_title: 'Vol 01', series_title: 'One Piece' },
  { volume_uuid: 'b', volume_title: 'Vol 02', series_title: 'One Piece' }
] as VolumeMetadata[];

describe('SeriesTrackingPanel', () => {
  it('shows timesRead (read_count + 1 when all completed) and edits read_count', async () => {
    const { getByText, getByLabelText } = render(SeriesTrackingPanel, {
      props: { seriesTitle: 'One Piece', volumes }
    });
    expect(getByText('Read 2 times')).toBeTruthy();
    await fireEvent.click(getByLabelText('Increase read count'));
    expect(updateSeriesMetadata).toHaveBeenCalledWith('One Piece', { read_count: 2 });
  });

  it('Sync now calls the tracker', async () => {
    const { getByText } = render(SeriesTrackingPanel, {
      props: { seriesTitle: 'One Piece', volumes }
    });
    await fireEvent.click(getByText('Sync now'));
    expect(syncSeriesNow).toHaveBeenCalledWith('one piece');
  });
});
```

Note: `vi.importActual` of `progress-tracker` pulls its real imports (`$lib/catalog/db`, `./providers/anilist`, …). If that import chain fails in jsdom, replace the partial mock with a full mock that re-implements `computeLocalPassState` by importing it from a test-only copy — simpler: mock `computeLocalPassState: () => ({ passProgress: 2, allCompleted: true, passComplete: false, timesRead: 2, rereading: false })`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/components/Series/__tests__/SeriesTrackingPanel.test.ts`
Expected: FAIL — component missing.

- [ ] **Step 3: Create `SeriesTrackingPanel.svelte`**

```svelte
<!-- src/lib/components/Series/SeriesTrackingPanel.svelte -->
<script lang="ts">
  import { Button, Select, Toggle } from 'flowbite-svelte';
  import type { VolumeMetadata } from '$lib/types';
  import type { TrackingUnit } from '$lib/metadata/types';
  import { seriesMetadataMap, updateSeriesMetadata } from '$lib/metadata/store';
  import { normalizeSeriesKey } from '$lib/metadata/series-key';
  import { computeLocalPassState, syncSeriesNow } from '$lib/metadata/progress-tracker';
  import { restartSeries } from '$lib/metadata/reread';
  import { anilistUser, getAniListClientId } from '$lib/metadata/anilist-auth';
  import { volumes as volumesStore } from '$lib/settings/volume-data';
  import { promptConfirmation } from '$lib/util/modals';
  import { showSnackbar } from '$lib/util/snackbar';

  interface Props {
    seriesTitle: string;
    volumes: VolumeMetadata[];
  }
  let { seriesTitle, volumes }: Props = $props();

  const unitOptions = [
    { value: 'volumes', name: 'Volumes' },
    { value: 'chapters', name: 'Chapters' }
  ];

  let seriesKey = $derived(normalizeSeriesKey(seriesTitle));
  let meta = $derived($seriesMetadataMap.get(seriesKey));
  let passState = $derived(computeLocalPassState(volumes, $volumesStore, meta));
  let linked = $derived(!!meta?.external_ids?.anilist);
  let trackingAvailable = $derived(linked && !!getAniListClientId());
  let tracking = $derived(meta?.tracking ?? { enabled: false, unit: 'volumes' as TrackingUnit });
  let syncing = $state(false);

  async function setReadCount(delta: number) {
    const next = Math.max(0, (meta?.read_count ?? 0) + delta);
    await updateSeriesMetadata(seriesTitle, { read_count: next });
  }

  async function setTracking(patch: Partial<{ enabled: boolean; unit: TrackingUnit }>) {
    await updateSeriesMetadata(seriesTitle, { tracking: { ...tracking, ...patch } });
  }

  async function syncNow() {
    syncing = true;
    try {
      const outcome = await syncSeriesNow(seriesKey);
      const message =
        outcome === 'pushed'
          ? 'Progress pushed to AniList'
          : outcome === 'nothing'
            ? 'AniList is already up to date'
            : outcome === 'queued'
              ? 'Queued — will push when AniList is reachable'
              : 'Tracking is off for this series';
      showSnackbar(message);
    } finally {
      syncing = false;
    }
  }

  function confirmRestart() {
    promptConfirmation(
      `Restart ${seriesTitle}? Every volume goes back to the start; your reading stats are kept.`,
      async () => {
        await restartSeries(seriesTitle, volumes);
        showSnackbar('Series restarted');
      }
    );
  }

  function formatPushed(at: string) {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? at : d.toLocaleDateString();
  }
</script>

<div class="flex flex-col gap-3 text-sm">
  <div class="flex flex-wrap items-center gap-2">
    {#key passState.timesRead}
      <span class="text-gray-700 dark:text-gray-300">Read {passState.timesRead} times</span>
    {/key}
    <Button
      size="xs"
      color="alternative"
      aria-label="Decrease read count"
      onclick={() => setReadCount(-1)}>−</Button
    >
    <Button
      size="xs"
      color="alternative"
      aria-label="Increase read count"
      onclick={() => setReadCount(1)}>+</Button
    >
    <Button size="xs" color="alternative" onclick={confirmRestart} disabled={volumes.length === 0}>
      Restart series…
    </Button>
  </div>

  {#if trackingAvailable}
    <div class="flex flex-wrap items-center gap-3">
      <Toggle
        checked={tracking.enabled}
        onchange={(e) => setTracking({ enabled: (e.target as HTMLInputElement).checked })}
      >
        Push progress to AniList
      </Toggle>
      <Select
        size="sm"
        class="w-32"
        items={unitOptions}
        value={tracking.unit}
        onchange={(e) =>
          setTracking({ unit: (e.target as HTMLSelectElement).value as TrackingUnit })}
      />
      <Button
        size="xs"
        color="alternative"
        onclick={syncNow}
        disabled={syncing || !tracking.enabled}
      >
        Sync now
      </Button>
      {#if !$anilistUser}
        <span class="text-xs text-gray-500">Connect AniList in Settings to push</span>
      {:else if tracking.last_pushed}
        {#key tracking.last_pushed.at}
          <span class="text-xs text-gray-500">
            Last pushed {tracking.unit === 'chapters' ? 'ch.' : 'vol.'}
            {tracking.last_pushed.n} · {formatPushed(tracking.last_pushed.at)}
          </span>
        {/key}
      {/if}
    </div>
  {/if}
</div>
```

Mount in `src/lib/components/Series/SeriesMetadataBar.svelte`: add `import SeriesTrackingPanel from './SeriesTrackingPanel.svelte';` and, as the last child of the bar's root container, `<SeriesTrackingPanel {seriesTitle} {volumes} />` (Plan A's bar receives `volumes: VolumeMetadata[]` — pass it straight through).

- [ ] **Step 4: Run tests + type-check**

Run: `npx vitest run src/lib/components/Series/__tests__/SeriesTrackingPanel.test.ts && npm run check`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/Series/SeriesTrackingPanel.svelte src/lib/components/Series/SeriesMetadataBar.svelte src/lib/components/Series/__tests__/SeriesTrackingPanel.test.ts
git commit -m "feat(series): tracking, read count and restart controls"
```

---

### Task 10: Settings — AniList account + master switch

**Files:**

- Create: `src/lib/components/Settings/AniListAccountSettings.svelte`
- Modify: `src/lib/components/Settings/MetadataSettings.svelte` (Plan B) — mount at the `<!-- Plan C: AniList account section mounts here -->` comment

**Interfaces:**

- Consumes: Task 5 (`getAniListClientId`, `anilistUser`, `startAniListLogin`, `disconnectAniList`), Task 4 (`catalogSettings.pushProgressToAniList`, `updateCatalogSetting`), `preserveUserGesture` is **not** needed (redirect flow, no popup).
- Produces: `AniListAccountSettings` (no props); renders nothing when the client id is unset.

- [ ] **Step 1: Create the component**

```svelte
<!-- src/lib/components/Settings/AniListAccountSettings.svelte -->
<script lang="ts">
  import { Button, Toggle } from 'flowbite-svelte';
  import {
    anilistUser,
    disconnectAniList,
    getAniListClientId,
    startAniListLogin
  } from '$lib/metadata/anilist-auth';
  import { catalogSettings, updateCatalogSetting } from '$lib/settings/settings';
  import { showSnackbar } from '$lib/util/snackbar';

  const clientId = getAniListClientId();

  function disconnect() {
    disconnectAniList();
    showSnackbar('Disconnected from AniList');
  }
</script>

{#if clientId}
  <div class="flex flex-col gap-3">
    <h4 class="text-sm font-semibold text-gray-900 dark:text-white">AniList account</h4>
    <div class="flex flex-wrap items-center gap-3">
      {#if $anilistUser}
        {#key $anilistUser.name}
          <span class="text-sm text-gray-700 dark:text-gray-300"
            >Connected as {$anilistUser.name}</span
          >
        {/key}
        <Button size="xs" color="alternative" onclick={disconnect}>Disconnect</Button>
      {:else}
        <span class="text-sm text-gray-500">Not connected</span>
        <Button size="xs" color="primary" onclick={startAniListLogin}>Connect AniList</Button>
      {/if}
    </div>
    <Toggle
      checked={$catalogSettings?.pushProgressToAniList ?? true}
      onchange={(e) =>
        updateCatalogSetting('pushProgressToAniList', (e.target as HTMLInputElement).checked)}
    >
      Push progress to AniList when a volume is finished
    </Toggle>
    <p class="text-xs text-gray-500">
      Tracking is per series: turn it on from a linked series' page. Progress only ever moves
      forward; use "Restart series" to record a re-read.
    </p>
  </div>
{/if}
```

Mount in `MetadataSettings.svelte`: add `import AniListAccountSettings from './AniListAccountSettings.svelte';` and replace the `<!-- Plan C: AniList account section mounts here -->` comment with `<AniListAccountSettings />`.

- [ ] **Step 2: Type-check + full suite**

Run: `npm run check && npx vitest run`
Expected: 0 errors; all tests pass.

- [ ] **Step 3: Manual verification against live AniList (test account)**

1. Register an AniList API client (https://anilist.co/settings/developer) with redirect URL `http://localhost:5173/`; put its id in `.env.local` as `VITE_ANILIST_CLIENT_ID`. `npm run dev`.
2. Settings → Metadata & Tracking → **Connect AniList** → approve → app returns to the same route; header shows "Connected as <name>"; `localStorage.anilist_token` set.
3. Link a series to a manga on the test account's list (or unlisted), enable tracking on the series page, mark volume 2 complete → AniList list shows `progressVolumes 2`, status CURRENT; series page shows "Last pushed vol. 2 · <date>".
4. Mark all volumes complete on a series with a known volume count → status COMPLETED.
5. Restart series → status REPEATING, progressVolumes 0; complete vol 1 → REPEATING/1; finish → COMPLETED, repeat 1; "Read 2 times".
6. Go offline (DevTools) → complete a volume → `anilist_pending_pushes` has the series; go online → entry disappears and AniList is updated.
7. Disconnect → complete a volume → queued; Connect again → flushed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/Settings/AniListAccountSettings.svelte src/lib/components/Settings/MetadataSettings.svelte
git commit -m "feat(settings): AniList account connect/disconnect + master switch"
```

---

## Self-review

**Spec coverage (Phase C):**

- AniList auth (env, redirect flow, `initRouter` callback, token keys, 401 handling, disconnect) → Task 5, Task 10.
- Progress push (trigger on false→true, volume number resolution, local pass state, remote read, `planProgressPush`, Sync now, pending queue with restart-dominates and `Retry-After`) → Tasks 1, 2, 3, 6, 9.
- Re-reads (`archivedReads`, `restartSeries`, `read_count` bump rule, `totalStats` invariance, detection prompt with three buttons and first-volume rule, "Read N times" +/-, session/persisted suppression cleared by restart) → Tasks 1, 7, 8, 9.
- UI (series bar tracking controls, settings account + master switch hidden without client id) → Tasks 9, 10.
- Testing list in spec: `extractVolumeNumber`, `planProgressPush` matrix, callback hash parsing, `restartSeries` + `totalStats` invariance, `shouldOfferReread` → all have unit tests; live AniList push → Task 10 manual steps.
- Heatmap-branch note (pass boundaries via `archivedReads[].at`) → data shape in Task 1 provides it; nothing further to build here.

**Placeholder scan:** none — every code step has full code; manual steps are concrete.

**Type consistency:** `LocalPassState`/`RemoteEntry`/`ProgressPushPlan`/`ProgressPushEvent` defined in Task 3 and used unchanged in Task 6; `PushOutcome` from Task 6 used in Task 9; `ArchivedRead`/`archiveAndResetVolumes`/`registerCompletionListener` from Task 1 used in Tasks 6–7; `TrackingUnit`/`SeriesMetadata` from Plan A everywhere; `computeLocalPassState(seriesVolumes, volumesData, meta)` (declared contract deviation) used identically in Tasks 6, 9.

**Declared contract deviations:**

1. `computeLocalPassState` has no leading `seriesKey` parameter (unused).
2. Series-page tracking controls live in `SeriesTrackingPanel.svelte` mounted from `SeriesMetadataBar.svelte`; settings account UI lives in `AniListAccountSettings.svelte` mounted from `MetadataSettings.svelte`.
3. `extractVolumeNumber` carries its own pattern lists (mirroring `series-extraction.ts`) instead of exporting that module's private, series-prefixed regexes.
4. `PendingPush` stores an intent (`event: 'restart' | 'sync'`) rather than a precomputed plan; the plan is recomputed against the live remote entry on flush.
5. Extra exports beyond the contract: `handleAniListUnauthorized`, `parseAniListCallbackHash`, `buildAniListAuthorizeUrl`, `ANILIST_CALLBACK_PREFIX` (auth); `volumeNumberFor`, `readPendingPushes`, `PushOutcome` (tracker); `suppressRereadPrompt` (reread).
