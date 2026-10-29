# Reading History Phase 3a: Stats on Events, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Time read, characters read, reading speed and time left are computed from reading-history events with one clock, an adaptive idle cutoff, skip classification and a synced manual override. The minute counter, `getEffectiveReadingTime` and the per-profile inactivity timeout are retired.

**Architecture:**

- A pure engine (`stats-engine.ts`) turns one volume's merged events into a prepared form: forget horizon applied, passes split at restarts, legacy coverage, legacy page characters inferred, skips classified. That form is cached per volume events version.
- A global pace (a robust median of ms per character) sets each view's cap. Counting is a cheap pass over the prepared views.
- A store (`stats-store.ts`) recomputes on history changes and exposes per-volume figures, the time-based recent speed and per-series speed.
- Reading that predates events survives as a one-time per-volume `legacyStats` baseline in the synced record. Merges take the element-wise minimum.
- The idle settings live in a new synced `tracking` section of `volume-data.json`. It is keyed and newest-wins with clamp and forfeit-on-bogus, like `series`.

**Tech Stack:** SvelteKit 5 runes, Svelte stores, Dexie (`mokuro_history`), Vitest + jsdom + fake-indexeddb, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-reading-history-event-log-design.md`, sections "Speed and stats", "Decided" and "Rollout 3". Long-pause prompts, `resolve` events, the review list and the "don't ask again" default are **phase 3b**, a separate plan. In 3a a pause over the cap always counts as typical time, which is the spec's "unanswered" rule.

## Global Constraints

- Idle cutoff = **characters in the layout** (whole pages, at least one page) × one global pace. No per-device-class or per-layout term (spec Decided 4).
- A view's cap is `clamp(k × expected, floor, ceiling)`, where `expected = chars_visible × pace`. With no data the cap is today's **5 min** default.
- The manual override lives in the new `tracking` section of `volume-data.json`, newest-stamp-wins, with the same future-stamp clamp as `series`. **Profiles no longer hold it.**
- Skipped views (faster than **1500 cpm**) do **not** count toward characters read; they are shown as skipped (Decided 2).
- **Recent speed** = the last N active hours across all volumes and devices, by time. No volume-granular window, so there is no cliff.
- **Time left** uses the series' own speed once it has enough data, else the recent speed.
- Legacy (converted) data is never prompted for; over the cap it counts as typical.
- Never mention the third-party public bunko deployment's domain anywhere (memory rule).
- `$derived` runs per component instance: the engine never runs inside a component. Components read memoised store values (CLAUDE.md "Svelte 5 Reactive Performance").

## Review Focus

1. **A user with years of pre-event reading.** Totals (minutes, characters) must not drop after the upgrade. The baseline is pinned by a Task 2 test: an old completed volume with no events keeps `timeReadInMinutes` and `chars`.
2. **Two devices compute different baselines.** Both converge on the minimum, whichever syncs first (Task 2 merge test).
3. **A reader left open overnight on one page.** It counts typical time, not 8 hours, and never feeds the pace with an outlier (Task 1 cap and median tests).
4. **An art-only page (0 characters)** gets the floor cap. A long look at a spread is not counted as hours (Task 1).
5. **A volume flipped through fast to find a page.** Characters are skipped, not read. A later real read of the same pages counts them as read (Task 1 pass test).

---

## Rulings made in this plan (constants and semantics)

- `DEFAULT_K = 3`.
- `FLOOR_MS = 60_000`.
- `CEILING_MS = 30 min`.
- `NO_DATA_CAP_MS = 5 min`.
- `SKIP_CPM = 1500`.
- Pace samples: views with ≥ 20 visible characters and `0 < dwell ≤ CEILING_MS`. Only the newest 500 count; fewer than 30 means no pace.
- Recent window: 8 h of counted time. Confidence: ≥ 6 h high, ≥ 4 h medium, ≥ 30 min low, otherwise the completed-volume fallback.
- Series speed: used once the series has ≥ 60 min of counted samples.
- A skip view's dwell counts in time read, but not in speed.
- A page counts as **read** in a pass when any non-skip view of that pass showed it. It counts as **skipped** only when skip views alone showed it. Each page's characters belong, for speed, to the first non-skip view in the pass that showed it.
- A legacy view's characters = the next legacy turn's `chars_before` minus its own (the old pair rule). A legacy view over the cap counts neither time nor characters (the old idle-skip rule). A legacy view with unknown dwell counts 0.
- `legacyStats = { time_ms, chars }` is computed once per volume:
  - on this device's first phase-3 pass (after the first successful sync, or at startup when no provider is connected);
  - afterwards, only for records still carrying `timeReadInMinutes > 0`.
  - `time_ms = max(0, timeReadInMinutes·60000 − event time)`.
  - `chars = max(0, (chars + Σ archived chars) − (event read + event skipped))`.
  - A forget drops it.
- `timeReadInMinutes` is frozen: kept and parsed, never written again. The volume editor edits the derived time and records an `adjust` with the delta.
- Pausing the live timer ends the open view (as a hidden tab does). The next page turn resumes.

---

### Task 1: Pure stats engine

**Files:**

- Create: `src/lib/reading-history/stats-engine.ts`
- Test: `src/lib/reading-history/stats-engine.test.ts`
- Modify: `src/lib/reading-history/project-turns.ts` (export the coverage builder as `nativeCoverage`)

**Interfaces — Produces:**

```ts
export const DEFAULT_K = 3,
  FLOOR_MS = 60_000,
  CEILING_MS = 1_800_000,
  NO_DATA_CAP_MS = 300_000,
  SKIP_CPM = 1500;
export interface IdleSettings {
  k: number;
  overrideMs: number | null;
}
export interface PreparedView {
  t: number;
  end: number;
  dwell: number | null;
  chars: number;
  skip: boolean;
  legacy: boolean;
  newChars: number;
}
export interface PreparedVolume {
  views: PreparedView[];
  readChars: number;
  skippedChars: number;
  adjustMs: number;
  adjustChars: number;
}
export function prepareVolume(events: ReadingEvent[]): PreparedVolume;
export function estimatePace(volumes: Iterable<PreparedVolume>): number | null; // ms per char
export function viewCap(chars: number, pace: number | null, idle: IdleSettings): number;
export interface SpeedSample {
  end: number;
  ms: number;
  chars: number;
}
export interface VolumeTotals {
  timeMs: number;
  readChars: number;
  skippedChars: number;
  lastReadAt: number | null;
  samples: SpeedSample[];
}
export function countVolume(
  prepared: PreparedVolume,
  pace: number | null,
  idle: IdleSettings
): VolumeTotals;
export interface SpeedEstimate {
  charsPerMinute: number;
  minutes: number;
}
export function speedFromSamples(samples: SpeedSample[], windowMs?: number): SpeedEstimate;
```

- [ ] **Step 1: Write the failing tests.** Build each scenario as a fixture with a `view(t, first, last, page_chars, dwell, device?)` helper and `restart`/`forget`/`adjust` helpers, then assert:
  - a single view's dwell under the cap counts in full;
  - a view of 400 characters at 8 h dwell counts `clamp(k·expected, floor, ceiling)`-bounded typical time, i.e. `min(cap, clamp(expected, FLOOR, cap))`;
  - a 0-character page caps at `FLOOR_MS`;
  - with fewer than 30 pace samples the cap is `NO_DATA_CAP_MS`;
  - the override replaces the cap;
  - 1000 characters in 10 s is a skip: its time counts, its characters land in `skippedChars`, it yields no sample;
  - pages skipped and then read slowly in the same pass count as read, not skipped;
  - a restart starts a new pass, so the same pages read twice count twice;
  - a forget hides earlier events;
  - a legacy turn covered by a native view is ignored;
  - legacy page characters come from consecutive `chars_before`;
  - a legacy view over the cap counts nothing;
  - `adjust` deltas add to time and characters;
  - the pace median ignores an overnight outlier;
  - `speedFromSamples` takes the newest samples up to the window, by time, with no cliff (a 5 h volume does not drop the others).
- [ ] **Step 2: Run** `npx vitest run src/lib/reading-history/stats-engine.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `stats-engine.ts`:
  - Native views use `chars = Σ page_chars` and `pages = first..last` with per-page characters.
  - Legacy views are single pages, with characters inferred from the next legacy event's `chars_before`.
  - Order views by `(t, device, seq)`; split passes at `restart` events.
  - In each pass, first mark the pages shown by non-skip views as read, then attribute `newChars` to the first non-skip view showing each read page. Pages shown only by skip views add to `skippedChars`.
  - `countVolume`: `counted = dwell === null ? 0 : dwell <= cap ? dwell : (legacy ? 0 : min(dwell, clamp(expected, FLOOR, cap)))`. Samples come from non-skip views with `counted > 0`. Legacy views over the cap count neither time nor characters (prepared `newChars` is zeroed for them at count time and moved out of `readChars`).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): stats engine — passes, skips, adaptive cap, speed by time`.

### Task 2: Stats store, baselines and the merge

**Files:**

- Create: `src/lib/reading-history/stats-store.ts` and `stats-store.test.ts`
- Modify:
  - `turns-store.ts` (keep `adjust`)
  - `src/lib/settings/volume-data.ts` (`legacyStats` field, parse/toJSON)
  - `src/lib/util/sync/volume-record-merge.ts` (min-merge, forget drops it)
  - `src/lib/util/sync/unified-sync-service.ts` (call `fillLegacyBaselines` after a successful sync)
  - `src/routes/+layout.svelte` (start the store; no-provider first pass)

**Interfaces — Consumes:** Task 1. **Produces:**

```ts
export interface VolumeFigures {
  minutes: number;
  timeMs: number;
  chars: number;
  skippedChars: number;
  lastReadAt: number | null;
}
export const readingStats: Readable<ReadingStatsState>; // { ready, pace, recent: ReadingSpeedResult, byVolume: Map<string, VolumeTotals> }
export function figuresFor(
  state: ReadingStatsState,
  volume: string,
  record?: { legacyStats?: LegacyStats }
): VolumeFigures;
export function seriesSpeed(state: ReadingStatsState, volumeIds: string[]): ReadingSpeedResult; // series data ≥ 60 min, else state.recent
export async function fillLegacyBaselines(): Promise<number>; // volumes given a baseline
export function initReadingStats(): void;
export const idleSettings: Readable<IdleSettings>; // from Task 3; Task 2 uses the default until then
```

`VolumeData.legacyStats?: { time_ms: number; chars: number }`, and `mergeLegacyStats(a, b)` = element-wise min.

- [ ] Write failing tests:
  - figures = engine + baseline;
  - `fillLegacyBaselines` on a completed volume without events sets `{time_ms: 120·60000, chars: total}` once, and a second call is a no-op;
  - a volume read with events gets residual time 0 when events explain it;
  - min-merge of two baselines is order-independent;
  - a forget tombstone merge drops it;
  - recomputation is memoised per volume version (an unrelated volume's event does not re-prepare others);
  - the recent speed falls back to completed-volume totals under 30 min of samples.
- [ ] Run; expect FAIL. Implement. Run; expect PASS. Run `npm run check`. Commit `feat(history): stats store with one-time legacy baselines`.

### Task 3: The synced `tracking` section (idle override and k)

**Files:**

- Create: `src/lib/settings/tracking-data.ts` and its test.
- Modify:
  - `unified-sync-service.ts`: parse, bogus detection and the duplicate fold beside `series`; compose; compare the raw section on upload.
  - `volume-data.ts` `parseVolumesFromJson`: skip the `tracking` key.
  - `ReaderToggles.svelte`: replace the inactivity slider with "Idle cutoff: Automatic | N min".
  - `settings.ts`: remove `inactivityTimeoutMinutes`.

**Produces:**

```ts
export const TRACKING_SECTION_KEY = 'tracking';
export interface IdleEntry {
  k?: number;
  override_minutes?: number | null;
  lastUpdated: string;
}
export type TrackingState = { idle?: IdleEntry };
export function parseTrackingSection(raw: unknown): TrackingState;
export function detectBogusTrackingKeys(raw: unknown, now?: number): Set<string>;
export function mergeTrackingSections(local, cloud, bogus): TrackingState;
export const trackingState: Writable<TrackingState>;
export function setIdleOverride(minutes: number | null): void;
export const idleSettings: Readable<IdleSettings>;
```

- [ ] Failing tests:
  - parse coerces `k` to [1, 20] and `override_minutes` to [1, 60] or null;
  - newest wins;
  - a future stamp is clamped and forfeits to a local entry;
  - a sync round-trip in `unified-sync-service.test.ts` uploads a local override and adopts a newer cloud one;
  - `parseVolumesFromJson` ignores `tracking`.
- [ ] Implement, check, commit `feat(history): synced idle cutoff in volume-data.json tracking section`.

### Task 4: Consumers on the new figures; delete the old speed maths

**Files:**

- `settings/reading-speed.ts`: `personalizedReadingSpeed` = `readingStats.recent`.
- `util/reading-speed.ts`: delete `calculateTurnStats`, `calculateTimeFromPageTurns`, `getEffectiveReadingTime`, `calculateReadingSpeed*`, and the `SESSION/ESTIMATION` constants. Keep `ReadingSpeedResult`, `calculateVolumeTimeToFinish` and `calculateEstimatedTime`.
- `util/reading-speed-history.ts`: `processVolumeSpeedData` and `calculateReadingSpeedStats` take a `figures(volumeId)` accessor instead of raw `timeReadInMinutes`/`chars`. Add `totalSkippedChars`.
- `volume-data.ts` `totalStats`: minutes and characters from figures, plus `charsSkipped`.
- `VolumeItem.svelte`, `SeriesView.svelte`, `Timer.svelte`, `ReadingSpeedView.svelte` (incl. `hasReadingData` = any views), `Settings/Stats.svelte` (show skipped).
- Time left: `VolumeItem` uses `seriesSpeed(series volume ids)`, as does `SeriesView`.

- [ ] Failing tests:
  - the `reading-speed-history` tests are rewritten on the accessor: a completed volume's cpm comes from figures, and the total includes the baseline;
  - `totalStats` comes from figures;
  - a `SeriesView` time-left unit test via the series-speed helper.
- [ ] Implement, run the affected suites and `npm run check`, commit `feat(history): stats views read event figures; old turn maths removed`.

### Task 5: One clock — the live timer, pause, retiring the counter

**Files:**

- Create: `src/lib/reading-history/live-view.ts` (`liveView` store of the open view `{volume, since, chars}`, `readingPaused` store).
- Modify:
  - `view-tracker.ts` (optional `onChange` listener)
  - `Reader.svelte` (publish `liveView`; `setView(pageHidden || $readingPaused ? null : view)`; a page change clears the pause; drop `setTimeoutDuration`)
  - `ReaderView.svelte` (drop `setTimeoutDuration`)
  - `Timer.svelte` (minutes = figures + `min(now − since, cap)` on a 15 s tick; Reading / Idle / Paused; click toggles `readingPaused`; no `startCount`)
  - `volume-data.ts` (delete `startCount`)
  - `volume-editor.ts` and `VolumeEditorModal.svelte` (load the derived minutes; save records `adjust` = new − derived; never write `timeReadInMinutes`)
  - `activity-tracker.ts` (fixed 5 min timeout; callbacks optional)

- [ ] Failing tests:
  - ViewTracker `onChange` reports open/close;
  - a live-minutes helper `liveMinutes(figures, open, now, cap)` caps at the cap;
  - the editor saves time as an `adjust` delta against the derived time and leaves `timeReadInMinutes` unchanged (`stat-edit-events.test.ts`).
- [ ] Implement, check, commit `feat(history): one clock — live timer from events, pause ends the view`.

### Task 6: End to end and docs

**Files:**

- Create: `e2e/reading-stats.spec.ts`. Import a synthetic volume, read three pages with real dwell, return to the series and assert:
  - "Time Read" equals the counted dwell;
  - the reader timer shows the same figure;
  - a fast flip of 5 pages shows as skipped in Settings → Stats;
  - an idle cutoff override set on one context arrives on a second context after sync (shared WebDAV stub, as in `history-sync.spec.ts`).
- Modify: CLAUDE.md (a "Stats on events (phase 3a)" paragraph in the Reading history section; the `tracking` section in "What syncs where") and the spec (an "As built" note under Speed and stats).

- [ ] Write the spec, run `E2E_PORT=<free> npx playwright test e2e/reading-stats.spec.ts`, fix, run the full e2e suite (zero failures), commit `test(e2e): reading stats from events` and `docs(history): phase 3a stats as built`.
