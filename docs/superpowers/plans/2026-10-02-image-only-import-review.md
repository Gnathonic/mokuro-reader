# Image-Only Import Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every image-only import (no `.mokuro`) ends in a step-through review that shows ONE series at a time — series name with library autocomplete, naming mode, start number, per-volume rename — and each approved series starts importing while the next one is reviewed.

**Architecture:** `runImportFiles` lists every archive pairing's entry NAMES before routing (zip central directory only, one archive at a time, nothing but strings retained), turns image-only folders and archive inner volumes into review candidates, groups them into series (pure, `image-only-review.ts`) and appends the groups to a review SESSION store that the dialog steps through. Each decision calls back into the import service, which names the group (`nameGroup`) and appends the approved sources to the existing strictly sequential queue — archives carry an `archiveReview` (names by inner path, `approved: true`) so `processArchiveContents` runs its normal PASS 1 but never prompts. Archives the pre-scan could not see (nested archives, listing failures, deep links) raise the same review from inside the queue.

**Tech Stack:** SvelteKit 5 (runes), TypeScript, Svelte stores, Dexie (fake-indexeddb in tests), @zip.js/zip.js, Flowbite Svelte, Vitest + @testing-library/svelte, Playwright (Chromium + WebKit).

**Spec:** `docs/superpowers/specs/2026-10-02-image-only-import-review-design.md` (owner-approved 2026-10-02). Read it fully before starting, especially "Mobile constraints (must hold)".

**Task order vs the spec's list.** Tasks are ordered so that every commit leaves a working app: the dialog (Task 5) is mounted beside the old prompt before the import service switches over to it (Task 6), and the old prompt is deleted in the same commit that stops using it.

| Plan task | Spec part                                                                            |
| --------- | ------------------------------------------------------------------------------------ |
| 1         | §2 grouping, §4 `nameGroup`                                                          |
| 2         | §1 pre-scan (names-only listing, one at a time, failure → today's path)              |
| 3         | §3 review session store + bridge                                                     |
| 4         | §3 existing-series autocomplete data, start-number defaults                          |
| 5         | §3 dialog                                                                            |
| 6         | §1/§5 wiring: pre-scan, approval → queue, in-queue fallback, mixed archives, routing |
| 7         | §1 mobile constraints + §7 browser verification                                      |

## Global Constraints

- Work only in `/home/nathan/Projects/mokuro-reader-worktrees/feat/285-folder-name-titles` (branch `feat/285-folder-name-titles`). Never commit in `/home/nathan/Projects/mokuro-reader`. Never `git stash`. Stage with explicit pathspecs only. Do not push.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- "The pre-scan adds one central-directory read per archive (a few KB from the end of the file) and retains no bytes; peak memory during an import must not rise." — measured in Task 7, not assumed.
- "Extraction, the queue's one-at-a-time order and the worker pool are not changed."
- "The dialog must work at phone width (one column, the volume list scrolls, buttons stay reachable above the on-screen keyboard while a name is edited)."
- "Files are read only after the user picked them, as today" — "an extraction that fails to read its file must surface as a normal per-volume import error, not a hang."
- Picker `accept` keeps its MIME types for iOS (`UploadModal.svelte` is not touched).
- Naming modes unchanged from f9e75433: "Cleaned up = series name + generated number in natural source order, padded to max(2, digits); Folder names = the volume's literal folder/archive name. No number is ever parsed out of a name."
- "Identity (uuid source) stays the candidate's literal location and never depends on the series field, mode, start or a rename."
- `.mokuro` volumes: "silent, as today."
- Modal action buttons sit in a `relative z-10` container (CLAUDE.md night-mode rule).
- Browser verification runs on its own port — 5198 for this branch, 5197 for the base measurement — never 5173, 5174, 5176.
- Never mention the third-party public bunko deployment's domain anywhere (code, comments, commits).
- Baselines at plan time (tip 8374e7ea): `npx vitest run src/lib/import` → 16 files / 302 tests pass; `npm run check` → `svelte-check found 0 errors and 0 warnings`. Neither may regress.

## Review Focus

- **A `series.json` dropped with an image-only series while another series' volumes drain the queue** — a person expects the sidecar to land on the series it describes once that series is approved and saved; today's "apply when the queue drains" would apply it early (keyed to nothing) and drop it for good. Pinned in Task 6 (`series-file-import.test.ts`, "waits for its review").
- **Typing an existing series name in other case or with reserved characters** ("killing bites", "Re: Zero?") — a person expects to join the library's "Killing Bites" / "Re： Zero？" and continue its numbering, not to start a near-duplicate series at 01. Pinned in Task 4 (`canonicalSeriesTitle`) and Task 5 (the field snaps on blur and when the library loads).
- **Dismissing the dialog by accident, and the dialog's own teardown close** — a person expects a stray tap outside to do nothing and the last Import to decide exactly one group; Flowbite's dialog fires a native close on teardown that must never become "skip all". Pinned in Task 5 (dialog shell tests: one decision per group, outside click does nothing).
- **A second drop, pick or deep link while a review is open** — a person expects it to join the same review and to wait its turn; a lone `.mokuro` volume must not be "direct-processed" in parallel with a running queue (two archives in memory at once on a phone). Pinned in Task 6 ("a second import while the review is open joins it", "a lone .mokuro volume dropped while a review is open waits its turn in the queue").
- **An archive that cannot be read when its turn comes** (corrupt, or a picked File iOS expired while the user was reviewing) — a person expects that volume to show a normal import error and the rest of the batch to import, not a hang or a lost review. Pinned in Task 6 ("an archive that cannot be read fails like any import error").

---

## File Structure

| File                                                                                                    | Status        | Responsibility                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/import/image-only-review.ts`                                                                   | create        | Pure: candidate/group types, `groupCandidates`, `defaultNaming`, `nameGroup`, `canonicalSeriesTitle`, `LibrarySeries` type                         |
| `src/lib/import/image-only-naming.ts`                                                                   | modify        | Keeps `ImportNames`, `storedTitle`; exports `locateVolume`; loses `planImageOnlyNames` & friends (Task 6)                                          |
| `src/lib/import/archive-listing.ts`                                                                     | create        | Names → pairings for an archive (`planArchiveListing`, shared by PASS 1 and the pre-scan), `scanArchiveListing`, `prescanArchives`, path helpers   |
| `src/lib/import/review-session.ts`                                                                      | create        | The review SESSION store: append groups, current step ("Series k of n"), decide current, skip all remaining                                        |
| `src/lib/import/import-ui.ts`                                                                           | modify        | Bridge gains `reviewImageOnly(groups, onDecision)` (Task 3); loses `promptImageOnly` (Task 6)                                                      |
| `src/lib/import/library-series.ts`                                                                      | create        | Keys-only library reads: `listLibrarySeries`, `existingVolumeCount`                                                                                |
| `src/lib/components/ImageOnlyReviewStep.svelte`                                                         | create        | One series step: series field + datalist, mode, start, volume rows, buttons                                                                        |
| `src/lib/components/ImageOnlyReviewDialog.svelte`                                                       | create        | Modal shell bound to the session; keys a step per group; Escape/close = skip all                                                                   |
| `src/lib/import/types.ts`                                                                               | modify        | `ArchiveReview`, `PairedSource.archiveReview`                                                                                                      |
| `src/lib/import/import-service.ts`                                                                      | modify        | PASS 1 through `planArchiveListing` (Task 2); pre-scan, review offering, approval → queue, in-queue fallback, routing, series.json timing (Task 6) |
| `src/lib/util/modals.ts`, `src/lib/components/ImageOnlyImportModal.svelte`, `src/routes/+layout.svelte` | modify/delete | Old single-boolean prompt removed (Task 6); new dialog mounted (Task 5)                                                                            |
| `src/lib/import/__tests__/helpers/review-bridge.ts`                                                     | create        | Test stand-in for the dialog: `installReviewer`, `approveAsDialogWould`, `dialogDefaults`                                                          |
| `e2e/image-only-review.spec.ts`, `e2e/import-memory.spec.ts`                                            | create        | Browser end to end (Chromium + WebKit), phone width; opt-in memory measurement                                                                     |

---

### Task 1: Group candidates into series and name one group

**Files:**

- Create: `src/lib/import/image-only-review.ts`
- Modify: `src/lib/import/image-only-naming.ts` (export `locate` as `locateVolume`)
- Test: `src/lib/import/__tests__/image-only-review.test.ts`

**Interfaces:**

- Consumes: `ImportNames`, `storedTitle` from `image-only-naming.ts`; `extractSeriesName`, `generateDeterministicUUID` (`$lib/util/series-extraction`); `naturalSort` (`$lib/util/natural-sort`); `generateUUID` (`$lib/util/uuid`).
- Produces:
  - `type NamingMode = 'cleaned' | 'folder'`
  - `interface ReviewCandidate { id: string; basePath: string; titlePath?: string; source: string }`
  - `interface ReviewGroup { id: string; series: string; candidates: ReviewCandidate[]; ownUuids: string[]; existingCount: number }`
  - `interface GroupNaming { series: string; mode: NamingMode; start: number; overrides: Record<string, string> }`
  - `groupCandidates(candidates: ReviewCandidate[]): ReviewGroup[]` (`existingCount` = 0; the import service fills it)
  - `defaultNaming(group: ReviewGroup, mode: NamingMode): GroupNaming`
  - `nameGroup(group: ReviewGroup, naming: GroupNaming): Map<string, ImportNames>` keyed by candidate id
  - from `image-only-naming.ts`: `locateVolume(p: Pick<PairedSource, 'basePath' | 'titlePath'>): { parent: string | null; own: string; identity: string }`

- [ ] **Step 1: Export `locateVolume` from `image-only-naming.ts`**

In `src/lib/import/image-only-naming.ts` replace

```ts
function locate(pairing: NamingInput) {
```

with

```ts
/** Where a volume sits: its parent folder (if any), its own name, its uuid source. */
export function locateVolume(pairing: Pick<PairedSource, 'basePath' | 'titlePath'>) {
```

and rename the three call sites `locate(` → `locateVolume(` (in `planImageOnlyNames`, `cleanedSeriesTitles`, `importIdentities`). Run `grep -n "locate(" src/lib/import/image-only-naming.ts` — expect only `locateVolume(` matches.

- [ ] **Step 2: Write the failing test**

Create `src/lib/import/__tests__/image-only-review.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  defaultNaming,
  groupCandidates,
  nameGroup,
  type ReviewCandidate
} from '../image-only-review';
import { storedTitle } from '../image-only-naming';
import { generateDeterministicUUID } from '$lib/util/series-extraction';

const candidate = (id: string, basePath: string, titlePath?: string): ReviewCandidate => ({
  id,
  basePath,
  titlePath,
  source: titlePath ?? basePath
});

const summary = (candidates: ReviewCandidate[]) =>
  groupCandidates(candidates).map((g) => ({
    series: g.series,
    ids: g.candidates.map((c) => c.id)
  }));

describe('groupCandidates (#285)', () => {
  it('groups volumes that have a parent folder by that folder, literally', () => {
    expect(
      summary([
        candidate('k1', 'Killing Bites/Killing Bites 01'),
        candidate('c2', 'Chained Soldier (Semi-Color)/02'),
        candidate('c1', 'Chained Soldier (Semi-Color)/01')
      ])
    ).toEqual([
      { series: 'Chained Soldier (Semi-Color)', ids: ['c1', 'c2'] },
      { series: 'Killing Bites', ids: ['k1'] }
    ]);
  });

  it('groups loose archives by the series their names carry', () => {
    expect(summary(['v10', 'v02', 'v01'].map((v) => candidate(v, `Killing Bites ${v}`)))).toEqual([
      { series: 'Killing Bites', ids: ['v01', 'v02', 'v10'] }
    ]);
  });

  it('keeps an archive of volume folders as one series, named after the archive', () => {
    expect(
      summary([
        candidate('a', 'v01 extra', 'Series Pack [Digital]/v01 extra'),
        candidate('b', 'v02 extra', 'Series Pack [Digital]/v02 extra')
      ])
    ).toEqual([{ series: 'Series Pack [Digital]', ids: ['a', 'b'] }]);
  });

  it('puts a loose volume and a series folder of the same name in one step', () => {
    expect(
      summary([
        candidate('l', 'Killing Bites v05'),
        candidate('f', 'Killing Bites/Killing Bites 01')
      ])
    ).toEqual([{ series: 'Killing Bites', ids: ['f', 'l'] }]);
  });

  it('keeps different series apart and orders them by name', () => {
    expect(
      summary([
        candidate('d', 'Dorohedoro 05'),
        candidate('b', 'Berserk v01'),
        candidate('x', 'Chained Soldier (Semi-Color)/01')
      ]).map((g) => g.series)
    ).toEqual(['Berserk', 'Chained Soldier (Semi-Color)', 'Dorohedoro']);
  });

  it('orders volumes naturally by their literal names', () => {
    const [group] = groupCandidates(['10', '2', '01'].map((v) => candidate(v, `Big/${v}`)));
    expect(group.candidates.map((c) => c.id)).toEqual(['01', '2', '10']);
  });

  it('knows the uuids its volumes will be saved under, and starts with no existing count', () => {
    const [group] = groupCandidates([candidate('a', 'Chained Soldier (Semi-Color)/01')]);
    expect(group.ownUuids).toEqual([generateDeterministicUUID('Chained Soldier (Semi-Color)/01')]);
    expect(group.existingCount).toBe(0);
  });
});

describe('nameGroup (#285)', () => {
  const chained = () =>
    groupCandidates([
      candidate('c10', 'Chained Soldier (Semi-Color)/10'),
      candidate('c2', 'Chained Soldier (Semi-Color)/2'),
      candidate('c1', 'Chained Soldier (Semi-Color)/01')
    ])[0];
  const ids = ['c1', 'c2', 'c10'];
  const volumes = (names: Map<string, { volume: string }>) =>
    ids.map((id) => names.get(id)?.volume);

  it('cleaned: the series name, numbered from the start in natural folder order', () => {
    const g = chained();
    expect(volumes(nameGroup(g, defaultNaming(g, 'cleaned')))).toEqual([
      'Chained Soldier (Semi-Color) 01',
      'Chained Soldier (Semi-Color) 02',
      'Chained Soldier (Semi-Color) 03'
    ]);
  });

  it('cleaned: starts after the volumes the series already has', () => {
    const g = { ...chained(), existingCount: 20 };
    expect(volumes(nameGroup(g, defaultNaming(g, 'cleaned')))).toEqual([
      'Chained Soldier (Semi-Color) 21',
      'Chained Soldier (Semi-Color) 22',
      'Chained Soldier (Semi-Color) 23'
    ]);
  });

  it('pads to the widest number, never below two digits', () => {
    const [g] = groupCandidates(
      Array.from({ length: 120 }, (_, i) => candidate(`p${i}`, `Big/${i + 1}`))
    );
    const names = nameGroup(g, defaultNaming(g, 'cleaned'));
    expect(names.get('p0')?.volume).toBe('Big 001');
    expect(names.get('p119')?.volume).toBe('Big 120');
    const late = nameGroup(g, { ...defaultNaming(g, 'cleaned'), start: 990 });
    expect(late.get('p0')?.volume).toBe('Big 0990');
  });

  it('an invalid start number counts from 1', () => {
    const g = chained();
    for (const start of [0, -3, Number.NaN, 2.5]) {
      expect(nameGroup(g, { ...defaultNaming(g, 'cleaned'), start }).get('c1')?.volume).toBe(
        'Chained Soldier (Semi-Color) 01'
      );
    }
  });

  it("folder: each volume's literal name under the step's series", () => {
    const g = chained();
    const names = nameGroup(g, defaultNaming(g, 'folder'));
    expect(volumes(names)).toEqual(['01', '2', '10']);
    expect(names.get('c1')?.series).toBe('Chained Soldier (Semi-Color)');
  });

  it('takes the series typed in the step for every volume; blank keeps the group series', () => {
    const g = chained();
    const typed = nameGroup(g, { ...defaultNaming(g, 'cleaned'), series: '  Chained Soldier ' });
    expect(volumes(typed)).toEqual([
      'Chained Soldier 01',
      'Chained Soldier 02',
      'Chained Soldier 03'
    ]);
    expect([...typed.values()].every((n) => n.series === 'Chained Soldier')).toBe(true);
    const blank = nameGroup(g, { ...defaultNaming(g, 'cleaned'), series: '   ' });
    expect(blank.get('c1')?.series).toBe('Chained Soldier (Semi-Color)');
  });

  it('a renamed volume keeps its name in both modes; a blank rename is no rename', () => {
    const g = chained();
    const overrides = { c2: 'Extra', c10: '   ' };
    expect(volumes(nameGroup(g, { ...defaultNaming(g, 'cleaned'), overrides }))).toEqual([
      'Chained Soldier (Semi-Color) 01',
      'Extra',
      'Chained Soldier (Semi-Color) 03'
    ]);
    expect(volumes(nameGroup(g, { ...defaultNaming(g, 'folder'), overrides }))).toEqual([
      '01',
      'Extra',
      '10'
    ]);
  });

  it('keeps identity on the literal location, whatever the step chose', () => {
    const g = chained();
    const a = nameGroup(g, defaultNaming(g, 'cleaned'));
    const b = nameGroup(g, {
      series: 'Other',
      mode: 'folder',
      start: 7,
      overrides: { c1: 'Renamed' }
    });
    for (const id of ids) expect(a.get(id)?.identity).toBe(b.get(id)?.identity);
    expect(a.get('c10')?.identity).toBe('Chained Soldier (Semi-Color)/10');
  });

  it('a loose volume: identity is its own name, the series is the extracted one in both modes', () => {
    const [g] = groupCandidates([candidate('g', 'Gleipnir v01 (2023) (Digital)')]);
    expect(nameGroup(g, defaultNaming(g, 'cleaned')).get('g')).toEqual({
      series: 'Gleipnir',
      volume: 'Gleipnir 01',
      identity: 'Gleipnir v01 (2023) (Digital)'
    });
    expect(nameGroup(g, defaultNaming(g, 'folder')).get('g')).toEqual({
      series: 'Gleipnir',
      volume: 'Gleipnir v01 (2023) (Digital)',
      identity: 'Gleipnir v01 (2023) (Digital)'
    });
  });

  it('names an archive volume by where the archive sat (titlePath)', () => {
    const [g] = groupCandidates([candidate('v', 'Vol 1', 'Pack/Vol 1')]);
    expect(nameGroup(g, defaultNaming(g, 'folder')).get('v')).toMatchObject({
      series: 'Pack',
      volume: 'Vol 1'
    });
    expect(nameGroup(g, defaultNaming(g, 'cleaned')).get('v')).toMatchObject({
      series: 'Pack',
      volume: 'Pack 01'
    });
  });

  it('stores names in their sanitized form, as saveVolume will', () => {
    const [g] = groupCandidates([candidate('r', 'Re: Zero?/Vol 1.')]);
    const folder = nameGroup(g, defaultNaming(g, 'folder')).get('r')!;
    expect([storedTitle(folder.series), storedTitle(folder.volume)]).toEqual([
      'Re： Zero？',
      'Vol 1․'
    ]);
    expect(storedTitle(nameGroup(g, defaultNaming(g, 'cleaned')).get('r')!.volume)).toBe(
      'Re： Zero？ 01'
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/import/__tests__/image-only-review.test.ts`
Expected: FAIL — `Failed to resolve import "../image-only-review"`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/import/image-only-review.ts`:

```ts
/**
 * Image-only import review (#285): the volumes an import found without a
 * `.mokuro`, grouped into series, and the names one series step gives them.
 *
 * A CANDIDATE is one image-only volume — an image folder, or a volume inside a
 * picked archive found by the pre-import listing — with its literal location.
 * The review shows ONE series at a time, so candidates are grouped:
 *
 * - with a parent folder (a series folder, or the archive holding volume
 *   folders): by that parent's literal name;
 * - loose (a bare archive, or a picked folder holding images directly): by the
 *   series the cleaned-up extraction reads from its name, so
 *   `Killing Bites v01.cbz` … `v10.cbz` dropped together are one step.
 *
 * Candidates whose series is stored under the same title are one group.
 * Groups are ordered by series name, volumes by their literal names (natural).
 *
 * `nameGroup` turns one step's choices into the names each volume is saved
 * under. The uuid source (`identity`) is always the literal location and never
 * depends on the series field, the mode, the start number or a rename.
 */

import { extractSeriesName, generateDeterministicUUID } from '$lib/util/series-extraction';
import { naturalSort } from '$lib/util/natural-sort';
import { generateUUID } from '$lib/util/uuid';
import { locateVolume, storedTitle, type ImportNames } from './image-only-naming';

export type NamingMode = 'cleaned' | 'folder';

/** One image-only volume offered for review. Strings only — never bytes. */
export interface ReviewCandidate {
  /** Unique within the import session. */
  id: string;
  basePath: string;
  /** Its literal location when `basePath` alone loses it (archive volumes). */
  titlePath?: string;
  /** What the user picked, shown in grey beside the name. */
  source: string;
}

/** One series step of the review. */
export interface ReviewGroup {
  id: string;
  /** Default series name: the parent's literal name, or extracted from a loose name. */
  series: string;
  /** Natural order of each candidate's own literal name. */
  candidates: ReviewCandidate[];
  /** The uuids these volumes are saved under (from their literal locations). */
  ownUuids: string[];
  /** Volumes `series` already has outside this group; set by the import service. */
  existingCount: number;
}

/** What the user chose for one step. */
export interface GroupNaming {
  series: string;
  mode: NamingMode;
  /** First generated number (`cleaned` only). */
  start: number;
  /** Candidate id → name the user typed. Blank = not renamed. */
  overrides: Record<string, string>;
}

export function groupCandidates(candidates: ReviewCandidate[]): ReviewGroup[] {
  const groups = new Map<
    string,
    { series: string; members: { candidate: ReviewCandidate; own: string }[] }
  >();
  for (const candidate of candidates) {
    const { parent, own } = locateVolume(candidate);
    const series = parent ?? extractSeriesName(candidate.basePath);
    const key = storedTitle(series);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { series, members: [] }));
    group.members.push({ candidate, own });
  }

  return [...groups.values()]
    .sort((a, b) => naturalSort(a.series, b.series))
    .map(({ series, members }) => {
      const ordered = members
        .sort((a, b) => naturalSort(a.own, b.own))
        .map((member) => member.candidate);
      return {
        id: generateUUID(),
        series,
        candidates: ordered,
        ownUuids: ordered.map((c) => generateDeterministicUUID(locateVolume(c).identity)),
        existingCount: 0
      };
    });
}

/** The step as it first appears: the group's series, numbering after its volumes. */
export function defaultNaming(group: ReviewGroup, mode: NamingMode): GroupNaming {
  return { series: group.series, mode, start: group.existingCount + 1, overrides: {} };
}

/** The names each of the group's volumes is saved under, keyed by candidate id. */
export function nameGroup(group: ReviewGroup, naming: GroupNaming): Map<string, ImportNames> {
  const series = naming.series.trim() || group.series;
  const start = Number.isInteger(naming.start) && naming.start >= 1 ? naming.start : 1;
  const width = Math.max(2, String(start + group.candidates.length - 1).length);
  const names = new Map<string, ImportNames>();
  group.candidates.forEach((candidate, i) => {
    const { own, identity } = locateVolume(candidate);
    const generated =
      naming.mode === 'folder' ? own : `${series} ${String(start + i).padStart(width, '0')}`;
    const typed = naming.overrides[candidate.id]?.trim();
    names.set(candidate.id, { series, volume: typed || generated, identity });
  });
  return names;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/import/__tests__/image-only-review.test.ts src/lib/import/__tests__/image-only-naming.test.ts`
Expected: PASS (both files; the old `planImageOnlyNames` tests still pass — it is deleted in Task 6).

- [ ] **Step 6: Commit**

```bash
git add src/lib/import/image-only-review.ts src/lib/import/image-only-naming.ts src/lib/import/__tests__/image-only-review.test.ts
git commit -m "feat(import): group image-only volumes into series and name one group (#285)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Names-only archive listing and the pre-scan

**Files:**

- Create: `src/lib/import/archive-listing.ts`
- Modify: `src/lib/import/import-service.ts` — `filesToEntries`/`isThumbnailSidecarPath` (~130–162), `stripArchiveExtension`/`joinTitlePath` (~438–446), `processArchiveContents` PASS 1 (~466–577) and its `pathPrefix` (~632)
- Test: `src/lib/import/__tests__/archive-listing.test.ts`

**Interfaces:**

- Consumes: `pairMokuroWithSources` (`./pairing`), `extractLayerEntries`/`ExtractedLayerEntry` (`$lib/reader/edit/layer-import`), `isSeriesFilePath` (`$lib/metadata/series-file`).
- Produces (all in `archive-listing.ts`):
  - `interface ListedEntry { filename: string; data: ArrayBuffer }` (same shape `decompressArchiveRaw` returns)
  - `isThumbnailSidecarPath(path: string, sourceStems?: Set<string>): boolean` (moved)
  - `stripArchiveExtension(path: string): string`, `joinTitlePath(parent: string, child: string): string` (moved)
  - `interface ArchiveListingPlan { mokuroPairings; imageOnlyPairings; innerPaths: Map<string, string>; nestedArchivePaths: string[]; seriesFilePaths: string[]; layerEntries: ExtractedLayerEntry[]; warnings: string[] }`
  - `planArchiveListing(entries: ListedEntry[], archive: { name: string; titlePath: string }, externalMokuro?: File | null): Promise<ArchiveListingPlan>`
  - `interface InnerVolume { innerPath: string; basePath: string; titlePath: string }`
  - `type ArchiveScan = { kind: 'unlisted' } | { kind: 'silent' } | { kind: 'review'; inner: InnerVolume[]; importsRegardless: boolean }`
  - `scanArchiveListing(entries, archive): Promise<ArchiveScan>`
  - `type ListArchive = (file: File) => Promise<ListedEntry[]>`
  - `prescanArchives(pairings: PairedSource[], list: ListArchive): Promise<Map<string, ArchiveScan>>` keyed by pairing id; only archive pairings without an external `.mokuro` appear
  - `archiveSourceLabel(file: File, innerPath: string): string`

- [ ] **Step 1: Write the failing test**

Create `src/lib/import/__tests__/archive-listing.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  archiveSourceLabel,
  planArchiveListing,
  prescanArchives,
  scanArchiveListing,
  type ListedEntry
} from '../archive-listing';
import type { PairedSource } from '../types';

const listed = (...names: string[]): ListedEntry[] =>
  names.map((filename) => ({ filename, data: new ArrayBuffer(0) }));

const archive = (name: string, titlePath = name.replace(/\.(cbz|zip)$/i, '')) => ({
  name,
  titlePath
});

function archivePairing(name: string, opts: { path?: string; mokuro?: File } = {}): PairedSource {
  const file = new File([new Uint8Array([1])], name);
  if (opts.path) Object.defineProperty(file, 'webkitRelativePath', { value: opts.path });
  return {
    id: `id-${name}`,
    mokuroFile: opts.mokuro ?? null,
    source: { type: 'archive', file },
    basePath: name.replace(/\.cbz$/i, ''),
    estimatedSize: 1,
    imageOnly: false
  };
}

describe('planArchiveListing', () => {
  it('pairs a mixed archive from its names alone', async () => {
    const plan = await planArchiveListing(
      listed('A.mokuro', 'A/001.jpg', 'B/001.jpg', 'B/002.jpg', 'series.json', 'Extra.cbz'),
      archive('Pack.zip')
    );
    expect(plan.mokuroPairings.map((p) => p.basePath)).toEqual(['A']);
    expect(plan.imageOnlyPairings.map((p) => [p.basePath, p.titlePath])).toEqual([['B', 'Pack/B']]);
    expect([...plan.innerPaths.values()]).toEqual(['B']);
    expect(plan.nestedArchivePaths).toEqual(['Extra.cbz']);
    expect(plan.seriesFilePaths).toEqual(['series.json']);
  });

  it('names a volume whose pages sit at the archive root after the archive', async () => {
    const plan = await planArchiveListing(
      listed('001.jpg', '002.jpg'),
      archive('Gleipnir v01 (2023) (Digital).cbz')
    );
    const [volume] = plan.imageOnlyPairings;
    expect(volume.basePath).toBe('Gleipnir v01 (2023) (Digital)');
    expect(volume.titlePath).toBe('Gleipnir v01 (2023) (Digital)');
    expect(plan.innerPaths.get(volume.id)).toBe('.');
  });

  it('never takes an exported thumbnail sidecar for a volume of its own', async () => {
    const plan = await planArchiveListing(
      listed('Vol 1/001.jpg', 'Vol 1.webp'),
      archive('Vol 1.cbz')
    );
    expect(plan.imageOnlyPairings.map((p) => plan.innerPaths.get(p.id))).toEqual(['Vol 1']);
  });

  it('holds OCR layer files aside instead of pairing them', async () => {
    const plan = await planArchiveListing(
      listed('A.mokuro', 'A.gcv.mokuro', 'A/001.jpg'),
      archive('A.cbz')
    );
    expect(plan.mokuroPairings).toHaveLength(1);
    expect(plan.layerEntries.map((e) => e.path)).toEqual(['A.gcv.mokuro']);
  });
});

describe('scanArchiveListing', () => {
  it('stays silent when every volume has its .mokuro', async () => {
    expect(await scanArchiveListing(listed('A.mokuro', 'A/001.jpg'), archive('A.cbz'))).toEqual({
      kind: 'silent'
    });
  });

  it('stays silent for an archive of archives — those are reviewed when the queue opens them', async () => {
    expect(
      await scanArchiveListing(listed('Vol 1.cbz', 'Vol 2.cbz'), archive('Outer.zip'))
    ).toEqual({ kind: 'silent' });
  });

  it('offers the image-only volumes, by name only', async () => {
    expect(
      await scanArchiveListing(listed('v01/001.jpg', 'v02/001.jpg'), archive('Series Pack.zip'))
    ).toEqual({
      kind: 'review',
      importsRegardless: false,
      inner: [
        { innerPath: 'v01', basePath: 'v01', titlePath: 'Series Pack/v01' },
        { innerPath: 'v02', basePath: 'v02', titlePath: 'Series Pack/v02' }
      ]
    });
  });

  it('a mixed archive imports its .mokuro volumes whatever the review decides', async () => {
    const scan = await scanArchiveListing(
      listed('A.mokuro', 'A/001.jpg', 'B/001.jpg'),
      archive('Pack.zip')
    );
    expect(scan).toMatchObject({ kind: 'review', importsRegardless: true });
  });
});

describe('prescanArchives', () => {
  it('lists archives one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const list = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return listed('001.jpg');
    });
    await prescanArchives(
      [archivePairing('a.cbz'), archivePairing('b.cbz'), archivePairing('c.cbz')],
      list
    );
    expect(list).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });

  it('never lists an archive that came with its own .mokuro, or a folder', async () => {
    const list = vi.fn(async () => listed('001.jpg'));
    const folder: PairedSource = {
      id: 'dir',
      mokuroFile: null,
      source: { type: 'directory', files: new Map() },
      basePath: 'x',
      estimatedSize: 0,
      imageOnly: false
    };
    const scans = await prescanArchives(
      [archivePairing('v.cbz', { mokuro: new File(['{}'], 'v.mokuro') }), folder],
      list
    );
    expect(list).not.toHaveBeenCalled();
    expect(scans.size).toBe(0);
  });

  it('leaves an archive it cannot list on the queue path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scans = await prescanArchives([archivePairing('broken.cbz')], async () => {
      throw new Error('End of central directory not found');
    });
    expect(scans.get('id-broken.cbz')).toEqual({ kind: 'unlisted' });
    warn.mockRestore();
  });

  it('names a picked archive by where it sat', async () => {
    const scans = await prescanArchives(
      [archivePairing('Vol 03 extra.cbz', { path: 'My Series (2023)/Vol 03 extra.cbz' })],
      async () => listed('001.jpg')
    );
    expect(scans.get('id-Vol 03 extra.cbz')).toMatchObject({
      kind: 'review',
      inner: [{ innerPath: '.', titlePath: 'My Series (2023)/Vol 03 extra' }]
    });
  });

  it('keeps nothing but names: no file, no bytes', async () => {
    const scans = await prescanArchives([archivePairing('p.zip')], async () =>
      listed('v01/001.jpg', 'v02/001.jpg')
    );
    const holdsBytes = (value: unknown): boolean =>
      value instanceof Blob ||
      value instanceof ArrayBuffer ||
      (typeof value === 'object' && value !== null && Object.values(value).some(holdsBytes));
    expect(holdsBytes([...scans.values()])).toBe(false);
  });
});

describe('archiveSourceLabel', () => {
  it('shows the picked archive, and the folder inside it', () => {
    const file = new File([], 'Pack.zip');
    expect(archiveSourceLabel(file, '.')).toBe('Pack.zip');
    expect(archiveSourceLabel(file, 'v01')).toBe('Pack.zip › v01');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/import/__tests__/archive-listing.test.ts`
Expected: FAIL — `Failed to resolve import "../archive-listing"`.

- [ ] **Step 3: Write `archive-listing.ts`**

Create `src/lib/import/archive-listing.ts`. The body of `archiveFileEntries` is MOVED verbatim from `processArchiveContents` (import-service.ts ~482–529) so the queue and the pre-scan pair an archive identically:

```ts
/**
 * What an archive holds, read from its entry NAMES (#285).
 *
 * The queue's PASS 1 (`processArchiveContents`, with the `.mokuro` bytes in
 * hand) and the pre-import scan (names only — zip.js reads the central
 * directory, a few KB from the end of the file) both turn an archive listing
 * into volume pairings HERE, so the review offers exactly the image-only
 * volumes the queue will later find.
 *
 * The pre-scan keeps nothing but strings: an archive's listing is reduced to
 * the inner paths and title paths of its image-only volumes and a flag, then
 * dropped. Archives are listed one at a time.
 */

import type { FileEntry, PairedSource } from './types';
import { isArchiveExtension, isImageExtension, isMokuroExtension, isSystemFile } from './types';
import { pairMokuroWithSources } from './pairing';
import { isSeriesFilePath } from '$lib/metadata/series-file';
import { extractLayerEntries, type ExtractedLayerEntry } from '$lib/reader/edit/layer-import';

/** One archive entry as listed: `data` is empty unless its bytes were extracted. */
export interface ListedEntry {
  filename: string;
  data: ArrayBuffer;
}

export function isThumbnailSidecarPath(path: string, sourceStems?: Set<string>): boolean {
  const filename = path.split('/').pop()?.toLowerCase() || '';
  if (!filename.endsWith('.webp')) return false;
  if (!sourceStems || sourceStems.size === 0) return false;
  const stem = filename.slice(0, -5);
  return sourceStems.has(stem);
}

/** `path` without an archive extension. */
export function stripArchiveExtension(path: string): string {
  return path.replace(/\.(zip|cbz|cbr|rar|7z)$/i, '');
}

/** `parent/child`, where `.`/empty children are the parent itself. */
export function joinTitlePath(parent: string, child: string): string {
  return child === '' || child === '.' ? parent : `${parent}/${child}`;
}

/** An archive listing as pairing input (mokuro bytes kept, images as empty placeholders). */
function archiveFileEntries(entries: ListedEntry[]): {
  fileEntries: FileEntry[];
  nestedArchivePaths: string[];
  seriesFilePaths: string[];
} {
  const fileEntries: FileEntry[] = [];
  const nestedArchivePaths: string[] = [];
  const seriesFilePaths: string[] = [];

  // Source stems from mokuro files and top-level folders, for sidecar detection.
  // The exporter places thumbnail sidecars at the archive root as {VolumeTitle}.webp,
  // matching the mokuro filename stem or the image folder name.
  const archiveSourceStems = new Set<string>();
  for (const entry of entries) {
    if (isSystemFile(entry.filename)) continue;
    const ext = entry.filename.split('.').pop()?.toLowerCase() || '';
    const name = entry.filename.split('/').pop() || entry.filename;
    if (isMokuroExtension(ext)) {
      archiveSourceStems.add(name.replace(/\.mokuro$/i, '').toLowerCase());
    }
    if (entry.filename.includes('/')) {
      const topFolder = entry.filename.split('/')[0].toLowerCase();
      if (topFolder) archiveSourceStems.add(topFolder);
    }
  }

  for (const entry of entries) {
    if (isSystemFile(entry.filename)) continue;
    const ext = entry.filename.split('.').pop()?.toLowerCase() || '';
    const filename = entry.filename.split('/').pop() || entry.filename;

    if (isSeriesFilePath(entry.filename)) {
      seriesFilePaths.push(entry.filename);
    } else if (isMokuroExtension(ext)) {
      fileEntries.push({
        path: entry.filename,
        file: new File([entry.data], filename, { lastModified: Date.now() })
      });
    } else if (isImageExtension(ext)) {
      if (isThumbnailSidecarPath(entry.filename, archiveSourceStems)) continue;
      fileEntries.push({
        path: entry.filename,
        file: new File([], filename, { lastModified: Date.now() })
      });
    } else if (isArchiveExtension(ext)) {
      nestedArchivePaths.push(entry.filename);
    }
  }

  return { fileEntries, nestedArchivePaths, seriesFilePaths };
}

export interface ArchiveListingPlan {
  mokuroPairings: PairedSource[];
  /** `titlePath` set; a root-level volume's `basePath` renamed to the archive stem. */
  imageOnlyPairings: PairedSource[];
  /** Image-only pairing id → its path INSIDE the archive (`.` = the root), as listed. */
  innerPaths: Map<string, string>;
  nestedArchivePaths: string[];
  seriesFilePaths: string[];
  /** `<stem>.<id>.mokuro` layer entries, for the caller to stash (or ignore). */
  layerEntries: ExtractedLayerEntry[];
  warnings: string[];
}

/**
 * An archive's volumes, from its listing. `archive.titlePath` is where the
 * archive itself sits, extension dropped (the literal-location half that the
 * inside path alone loses).
 */
export async function planArchiveListing(
  entries: ListedEntry[],
  archive: { name: string; titlePath: string },
  externalMokuro: File | null = null
): Promise<ArchiveListingPlan> {
  const { fileEntries, nestedArchivePaths, seriesFilePaths } = archiveFileEntries(entries);
  if (externalMokuro) fileEntries.push({ path: externalMokuro.name, file: externalMokuro });

  const layerSplit = extractLayerEntries(fileEntries);
  const { pairings, warnings } = await pairMokuroWithSources(layerSplit.entries);
  const mokuroPairings = pairings.filter((p) => !p.imageOnly);
  const imageOnlyPairings = pairings.filter((p) => p.imageOnly);

  const archiveStem = stripArchiveExtension(archive.name);
  const innerPaths = new Map<string, string>();
  for (const pairing of imageOnlyPairings) {
    innerPaths.set(pairing.id, pairing.basePath);
    // A volume is named from where it sits in the archive AND where the
    // archive sits — `basePath` here is only the inside half.
    pairing.titlePath = joinTitlePath(archive.titlePath, pairing.basePath);
    if (pairing.basePath === '.' || pairing.basePath === '') pairing.basePath = archiveStem;
  }

  return {
    mokuroPairings,
    imageOnlyPairings,
    innerPaths,
    nestedArchivePaths,
    seriesFilePaths,
    layerEntries: [...layerSplit.layers, ...layerSplit.standalone],
    warnings
  };
}

export interface InnerVolume {
  /** Path inside the archive (`.` = its root) — the key approved names travel under. */
  innerPath: string;
  basePath: string;
  titlePath: string;
}

export type ArchiveScan =
  /** Could not be listed: the queue opens it as today and reviews it there. */
  | { kind: 'unlisted' }
  /** Nothing image-only: imports silently, as today. */
  | { kind: 'silent' }
  /** Image-only volumes to review; `importsRegardless` = it also holds .mokuro volumes or archives. */
  | { kind: 'review'; inner: InnerVolume[]; importsRegardless: boolean };

export async function scanArchiveListing(
  entries: ListedEntry[],
  archive: { name: string; titlePath: string }
): Promise<ArchiveScan> {
  const plan = await planArchiveListing(entries, archive);
  if (plan.imageOnlyPairings.length === 0) return { kind: 'silent' };
  return {
    kind: 'review',
    inner: plan.imageOnlyPairings.map((p) => ({
      innerPath: plan.innerPaths.get(p.id) ?? p.basePath,
      basePath: p.basePath,
      titlePath: p.titlePath ?? p.basePath
    })),
    importsRegardless: plan.mokuroPairings.length > 0 || plan.nestedArchivePaths.length > 0
  };
}

/** Lists an archive's entry names without extracting entry bytes. */
export type ListArchive = (file: File) => Promise<ListedEntry[]>;

/**
 * Pre-scan every picked archive that carries no external `.mokuro`, ONE AT A
 * TIME. Keyed by pairing id; pairings that are not scanned are absent.
 */
export async function prescanArchives(
  pairings: PairedSource[],
  list: ListArchive
): Promise<Map<string, ArchiveScan>> {
  const scans = new Map<string, ArchiveScan>();
  for (const pairing of pairings) {
    if (pairing.source.type !== 'archive' || pairing.mokuroFile) continue;
    const file = pairing.source.file;
    const titlePath =
      pairing.titlePath ?? stripArchiveExtension(file.webkitRelativePath || file.name);
    try {
      scans.set(
        pairing.id,
        await scanArchiveListing(await list(file), { name: file.name, titlePath })
      );
    } catch (error) {
      console.warn(
        `[Import] Could not list ${file.name}; it is reviewed when the queue opens it`,
        error
      );
      scans.set(pairing.id, { kind: 'unlisted' });
    }
  }
  return scans;
}

/** The grey source line of an archive volume in the review. */
export function archiveSourceLabel(file: File, innerPath: string): string {
  const picked = file.webkitRelativePath || file.name;
  return innerPath === '.' || innerPath === '' ? picked : `${picked} › ${innerPath}`;
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx vitest run src/lib/import/__tests__/archive-listing.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 5: Route `processArchiveContents` PASS 1 through `planArchiveListing`**

In `src/lib/import/import-service.ts`:

1. Add to the imports:

```ts
import {
  isThumbnailSidecarPath,
  joinTitlePath,
  planArchiveListing,
  stripArchiveExtension
} from './archive-listing';
```

2. Delete the local `isThumbnailSidecarPath` (~156–162), `stripArchiveExtension` and `joinTitlePath` (~438–446) — `filesToEntries` and the nested-archive code now use the imported ones.

3. In `processArchiveContents`, replace everything from `onProgress?.('Analyzing structure...', 15);` down to and including the `originalBasePaths` loop (the block ending just before `// If there are image-only pairings, prompt user for confirmation`) with:

```ts
onProgress?.('Analyzing structure...', 15);

// The same names → pairings step the pre-import scan runs
// (archive-listing.ts), here with the `.mokuro` bytes in hand.
const archivePath =
  archiveTitlePath ?? stripArchiveExtension(archiveFile.webkitRelativePath || archiveFile.name);
const plan = await planArchiveListing(
  scanResult.entries,
  { name: archiveFile.name, titlePath: archivePath },
  externalMokuroFile
);
for (const warning of plan.warnings) console.warn('[Archive Import]', warning);
// `<stem>.<id>.mokuro` entries beside a volume are its OCR layers, not
// volumes of their own: hold them until the volume is saved.
stashLayerEntries(plan.layerEntries);
const { mokuroPairings, imageOnlyPairings, nestedArchivePaths, seriesFilePaths } = plan;
```

4. In PASS 2's `volumeDefs`, replace

```ts
const pathPrefix = originalBasePaths.get(pairing.id) ?? pairing.basePath;
```

with

```ts
const pathPrefix = plan.innerPaths.get(pairing.id) ?? pairing.basePath;
```

5. Remove `isMokuroExtension` and `isArchiveExtension` from the `./types` import — their only uses were in the moved block (`grep -n "isMokuroExtension\|isArchiveExtension" src/lib/import/import-service.ts` must print nothing afterwards). `extractLayerEntries` stays: `runImportFiles` still uses it.

- [ ] **Step 6: Run the import suite — behaviour must be unchanged**

Run: `npx vitest run src/lib/import && npx eslint src/lib/import/import-service.ts src/lib/import/archive-listing.ts`
Expected: 17 files pass (302 + 14 tests); eslint prints nothing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/import/archive-listing.ts src/lib/import/import-service.ts src/lib/import/__tests__/archive-listing.test.ts
git commit -m "feat(import): plan an archive's volumes from its entry names, shared by the queue and a pre-scan (#285)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The review session store and the UI bridge

**Files:**

- Create: `src/lib/import/review-session.ts`
- Modify: `src/lib/import/import-ui.ts` (add `reviewImageOnly`; `promptImageOnly` stays until Task 6)
- Create: `src/lib/import/__tests__/helpers/review-bridge.ts`
- Test: `src/lib/import/__tests__/review-session.test.ts`

**Interfaces:**

- Consumes: `ReviewGroup`, `GroupNaming`, `defaultNaming` (Task 1).
- Produces:
  - `type GroupDecision = { action: 'import'; naming: GroupNaming } | { action: 'skip' }`
  - `type OnGroupDecision = (groupId: string, decision: GroupDecision) => void`
  - `interface ReviewSessionState { pending: { group: ReviewGroup; onDecision: OnGroupDecision }[]; decided: number }`
  - `reviewSession: Writable<ReviewSessionState>`
  - `appendReviewGroups(groups: ReviewGroup[], onDecision: OnGroupDecision): void`
  - `currentStep(state: ReviewSessionState): { group: ReviewGroup; step: number; total: number } | null`
  - `decideCurrent(decision: GroupDecision): void`, `skipAllRemaining(): void`
  - Bridge: `ImportUiBridge.reviewImageOnly(groups: ReviewGroup[], onDecision: OnGroupDecision): void` — never blocks; default appends to the session.
  - Test helper: `installReviewer(decide?: ((g: ReviewGroup) => GroupDecision) | 'manual'): Reviewer`, `approveAsDialogWould(g): GroupDecision`, `dialogDefaults(g): GroupNaming`, `interface Reviewer { offered: ReviewGroup[]; pending: { group: ReviewGroup; decide(d: GroupDecision): void }[]; restore(): void }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/import/__tests__/review-session.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/modals', () => ({ promptMissingFiles: vi.fn() }));

import {
  appendReviewGroups,
  currentStep,
  decideCurrent,
  reviewSession,
  skipAllRemaining,
  type GroupDecision
} from '../review-session';
import { getImportUiBridge } from '../import-ui';
import type { ReviewGroup } from '../image-only-review';
import { installReviewer } from './helpers/review-bridge';

const group = (series: string): ReviewGroup => ({
  id: `g-${series}`,
  series,
  candidates: [],
  ownUuids: [],
  existingCount: 0
});
const importIt: GroupDecision = {
  action: 'import',
  naming: { series: 'x', mode: 'cleaned', start: 1, overrides: {} }
};
const step = () => {
  const s = currentStep(get(reviewSession));
  return s && { series: s.group.series, step: s.step, total: s.total };
};

describe('review session (#285)', () => {
  beforeEach(() => reviewSession.set({ pending: [], decided: 0 }));

  it('has no step while nothing is pending', () => {
    expect(step()).toBeNull();
  });

  it('steps through the groups in order, "Series k of n"', () => {
    const onDecision = vi.fn();
    appendReviewGroups([group('A'), group('B')], onDecision);
    expect(step()).toEqual({ series: 'A', step: 1, total: 2 });
    decideCurrent(importIt);
    expect(onDecision).toHaveBeenCalledWith('g-A', importIt);
    expect(step()).toEqual({ series: 'B', step: 2, total: 2 });
  });

  it('closes after the last decision and numbers the next review from 1', () => {
    appendReviewGroups([group('A')], vi.fn());
    decideCurrent({ action: 'skip' });
    expect(step()).toBeNull();
    appendReviewGroups([group('C')], vi.fn());
    expect(step()).toEqual({ series: 'C', step: 1, total: 1 });
  });

  it('a second import appends to the open review instead of replacing it', () => {
    const first = vi.fn();
    const second = vi.fn();
    appendReviewGroups([group('A'), group('B')], first);
    decideCurrent(importIt);
    appendReviewGroups([group('C')], second);
    expect(step()).toEqual({ series: 'B', step: 2, total: 3 });
    decideCurrent({ action: 'skip' });
    decideCurrent(importIt);
    expect(first.mock.calls.map(([id]) => id)).toEqual(['g-A', 'g-B']);
    expect(second).toHaveBeenCalledWith('g-C', importIt);
  });

  it('skip all remaining skips every pending group, in order, and closes', () => {
    const onDecision = vi.fn();
    appendReviewGroups([group('A'), group('B'), group('C')], onDecision);
    decideCurrent(importIt);
    skipAllRemaining();
    expect(onDecision.mock.calls).toEqual([
      ['g-A', importIt],
      ['g-B', { action: 'skip' }],
      ['g-C', { action: 'skip' }]
    ]);
    expect(step()).toBeNull();
  });

  it('a decision callback that throws neither blocks the others nor the session', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const later = vi.fn();
    appendReviewGroups([group('A')], () => {
      throw new Error('boom');
    });
    appendReviewGroups([group('B')], later);
    skipAllRemaining();
    expect(later).toHaveBeenCalledWith('g-B', { action: 'skip' });
    expect(step()).toBeNull();
    error.mockRestore();
  });

  it('the callback runs after the session moved on, so it can append more', () => {
    appendReviewGroups([group('A')], () => appendReviewGroups([group('Nested')], vi.fn()));
    decideCurrent(importIt);
    expect(step()).toEqual({ series: 'Nested', step: 1, total: 1 });
  });

  it('deciding with nothing pending does nothing', () => {
    expect(() => decideCurrent(importIt)).not.toThrow();
    expect(step()).toBeNull();
  });

  it('the default bridge offers groups to the session', () => {
    const onDecision = vi.fn();
    getImportUiBridge().reviewImageOnly([group('A')], onDecision);
    expect(step()).toEqual({ series: 'A', step: 1, total: 1 });
  });

  it('installReviewer stands in for the dialog and restores the bridge', () => {
    const reviewer = installReviewer();
    const onDecision = vi.fn();
    getImportUiBridge().reviewImageOnly([group('A')], onDecision);
    expect(reviewer.offered.map((g) => g.series)).toEqual(['A']);
    expect(onDecision).toHaveBeenCalledWith('g-A', {
      action: 'import',
      naming: { series: 'A', mode: 'cleaned', start: 1, overrides: {} }
    });
    expect(step()).toBeNull();
    reviewer.restore();
    getImportUiBridge().reviewImageOnly([group('B')], vi.fn());
    expect(step()).toEqual({ series: 'B', step: 1, total: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/import/__tests__/review-session.test.ts`
Expected: FAIL — `Failed to resolve import "../review-session"`.

- [ ] **Step 3: Write `review-session.ts`**

```ts
/**
 * The image-only review SESSION (#285): one queue of series steps shared by
 * every import that needs a decision. `importFiles` calls (and the queue's
 * in-place fallback) APPEND groups; the dialog shows the first pending one as
 * "Series k of n" and decides it. A second drop while a review is open joins
 * it instead of replacing it.
 *
 * Decisions are callbacks, never awaited here: the import service enqueues an
 * approved series at once and the dialog moves on to the next step.
 */

import { get, writable } from 'svelte/store';
import type { GroupNaming, ReviewGroup } from './image-only-review';

export type GroupDecision = { action: 'import'; naming: GroupNaming } | { action: 'skip' };
export type OnGroupDecision = (groupId: string, decision: GroupDecision) => void;

export interface ReviewSessionState {
  pending: { group: ReviewGroup; onDecision: OnGroupDecision }[];
  /** Steps already decided in this session, for "Series k of n". */
  decided: number;
}

export const reviewSession = writable<ReviewSessionState>({ pending: [], decided: 0 });

export function appendReviewGroups(groups: ReviewGroup[], onDecision: OnGroupDecision): void {
  if (groups.length === 0) return;
  reviewSession.update((s) => ({
    ...s,
    pending: [...s.pending, ...groups.map((group) => ({ group, onDecision }))]
  }));
}

/** The step on screen, or null when no review is open. */
export function currentStep(
  state: ReviewSessionState
): { group: ReviewGroup; step: number; total: number } | null {
  const head = state.pending[0];
  if (!head) return null;
  return {
    group: head.group,
    step: state.decided + 1,
    total: state.decided + state.pending.length
  };
}

function notify(entry: ReviewSessionState['pending'][number], decision: GroupDecision): void {
  try {
    entry.onDecision(entry.group.id, decision);
  } catch (error) {
    console.error('[Import] Review decision failed:', error);
  }
}

export function decideCurrent(decision: GroupDecision): void {
  const { pending, decided } = get(reviewSession);
  const [head, ...rest] = pending;
  if (!head) return;
  // Move on first: a callback that appends (the queue's fallback) lands behind.
  reviewSession.set(
    rest.length > 0 ? { pending: rest, decided: decided + 1 } : { pending: [], decided: 0 }
  );
  notify(head, decision);
}

export function skipAllRemaining(): void {
  const { pending } = get(reviewSession);
  reviewSession.set({ pending: [], decided: 0 });
  for (const entry of pending) notify(entry, { action: 'skip' });
}
```

- [ ] **Step 4: Add `reviewImageOnly` to the bridge**

In `src/lib/import/import-ui.ts` add the imports

```ts
import { appendReviewGroups, type OnGroupDecision } from './review-session';
import type { ReviewGroup } from './image-only-review';
```

add to `interface ImportUiBridge` (after `promptImageOnly`):

```ts
  /**
   * Offer image-only volumes for review, one series group per step (#285).
   * Never blocks: `onDecision` is called once per group, whenever the user
   * decides it (Import, Skip, or Skip all remaining).
   */
  reviewImageOnly(groups: ReviewGroup[], onDecision: OnGroupDecision): void;
```

and to the default `uiBridge` object (after `promptImageOnly`):

```ts
  reviewImageOnly: (groups, onDecision) => appendReviewGroups(groups, onDecision),
```

- [ ] **Step 5: Write the test helper**

Create `src/lib/import/__tests__/helpers/review-bridge.ts`:

```ts
/**
 * Test stand-in for the image-only review dialog (#285): installs a
 * `reviewImageOnly` bridge that records every group offered and decides it —
 * at once, like a user accepting the dialog's defaults, or by hand ('manual').
 */

import { get } from 'svelte/store';
import { miscSettings } from '$lib/settings/misc';
import { getImportUiBridge, setImportUiBridge } from '../../import-ui';
import { defaultNaming, type GroupNaming, type ReviewGroup } from '../../image-only-review';
import type { GroupDecision } from '../../review-session';

/** What the dialog shows first: the last mode used, numbering after the series' volumes. */
export function dialogDefaults(group: ReviewGroup): GroupNaming {
  return defaultNaming(group, get(miscSettings).keepFolderNamesAsTitles ? 'folder' : 'cleaned');
}

export function approveAsDialogWould(group: ReviewGroup): GroupDecision {
  return { action: 'import', naming: dialogDefaults(group) };
}

export interface Reviewer {
  /** Every group offered, in order. */
  offered: ReviewGroup[];
  /** 'manual' only: groups waiting for `decide`. */
  pending: { group: ReviewGroup; decide: (decision: GroupDecision) => void }[];
  restore: () => void;
}

export function installReviewer(
  decide: ((group: ReviewGroup) => GroupDecision) | 'manual' = approveAsDialogWould
): Reviewer {
  const original = getImportUiBridge();
  const reviewer: Reviewer = {
    offered: [],
    pending: [],
    restore: () => setImportUiBridge(original)
  };
  setImportUiBridge({
    ...original,
    reviewImageOnly(groups, onDecision) {
      for (const group of groups) {
        reviewer.offered.push(group);
        if (decide === 'manual') {
          reviewer.pending.push({ group, decide: (d) => onDecision(group.id, d) });
        } else {
          onDecision(group.id, decide(group));
        }
      }
    }
  });
  return reviewer;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/import/__tests__/review-session.test.ts src/lib/import`
Expected: PASS; the whole import directory still green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/import/review-session.ts src/lib/import/import-ui.ts src/lib/import/__tests__/review-session.test.ts src/lib/import/__tests__/helpers/review-bridge.ts
git commit -m "feat(import): a review session that steps through image-only series, and its bridge (#285)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Library series data and start-number defaults

**Files:**

- Create: `src/lib/import/library-series.ts`
- Modify: `src/lib/import/image-only-review.ts` (add `LibrarySeries`, `canonicalSeriesTitle`)
- Test: `src/lib/import/__tests__/library-series.test.ts`; extend `src/lib/import/__tests__/image-only-review.test.ts`

**Interfaces:**

- Consumes: `seriesVolumeUuids` (`./database`), `storedTitle`, `normalizeSeriesKey` (`$lib/metadata/series-key`).
- Produces:
  - `interface LibrarySeries { title: string; count: number }` (in `image-only-review.ts`, pure)
  - `canonicalSeriesTitle(library: readonly LibrarySeries[], typed: string): string | undefined` (pure)
  - `listLibrarySeries(): Promise<LibrarySeries[]>` — distinct `series_title` with volume counts, index order, keys only
  - `existingVolumeCount(series: string, exclude?: Iterable<string>): Promise<number>` — volumes stored under `storedTitle(series)` minus `exclude` uuids, keys only

- [ ] **Step 1: Write the failing tests**

Create `src/lib/import/__tests__/library-series.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db: any = new Dexie('library-series-test');
  db.version(1).stores({ volumes: 'volume_uuid, series_uuid, series_title' });
  return { db };
});

import { db } from '$lib/catalog/db';
import { existingVolumeCount, listLibrarySeries } from '../library-series';

const row = (volume_uuid: string, series_title: string, extra: object = {}) => ({
  volume_uuid,
  series_uuid: 's',
  series_title,
  volume_title: volume_uuid,
  thumbnail: new File([new Uint8Array(64)], 't.webp'),
  ...extra
});

describe('library series (#285)', () => {
  beforeEach(async () => {
    await db.volumes.clear();
    await db.volumes.bulkPut([
      row('kb1', 'Killing Bites'),
      row('kb2', 'Killing Bites', { metadata_only: true }),
      row('d1', 'Dorohedoro'),
      row('r1', 'Re： Zero？')
    ]);
  });

  it('lists each series once with its volume count, metadata-only rows included', async () => {
    expect(await listLibrarySeries()).toEqual([
      { title: 'Dorohedoro', count: 1 },
      { title: 'Killing Bites', count: 2 },
      { title: 'Re： Zero？', count: 1 }
    ]);
  });

  it('reads keys only, never a row', async () => {
    const reads = ['toArray', 'each', 'get', 'bulkGet'].map((m) => vi.spyOn(db.volumes, m as any));
    await listLibrarySeries();
    await existingVolumeCount('Killing Bites', []);
    for (const spy of reads) expect(spy).not.toHaveBeenCalled();
  });

  it('counts a series without the volumes of the group being reviewed', async () => {
    expect(await existingVolumeCount('Killing Bites')).toBe(2);
    expect(await existingVolumeCount('Killing Bites', ['kb2'])).toBe(1);
    expect(await existingVolumeCount('Nothing Yet')).toBe(0);
  });

  it('counts the series as it is stored (sanitized)', async () => {
    expect(await existingVolumeCount('Re: Zero?')).toBe(1);
  });
});
```

Append to `src/lib/import/__tests__/image-only-review.test.ts` (and add `canonicalSeriesTitle` to its import from `'../image-only-review'`):

```ts
describe('canonicalSeriesTitle (#285)', () => {
  const library = [
    { title: 'Killing Bites', count: 2 },
    { title: 'Re： Zero？', count: 1 }
  ];

  it("returns the library's spelling of a series typed in another case or spacing", () => {
    expect(canonicalSeriesTitle(library, 'killing  bites ')).toBe('Killing Bites');
  });

  it('matches a name typed with reserved characters to its stored form', () => {
    expect(canonicalSeriesTitle(library, 're: zero?')).toBe('Re： Zero？');
  });

  it('returns nothing for a new series or an empty field', () => {
    expect(canonicalSeriesTitle(library, 'Dorohedoro')).toBeUndefined();
    expect(canonicalSeriesTitle(library, '   ')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/import/__tests__/library-series.test.ts src/lib/import/__tests__/image-only-review.test.ts`
Expected: FAIL — `Failed to resolve import "../library-series"` and `canonicalSeriesTitle is not a function`.

- [ ] **Step 3: Add the pure helper to `image-only-review.ts`**

Add the import `import { normalizeSeriesKey } from '$lib/metadata/series-key';` and append:

```ts
/** A series the library already has (keys only: title + how many volumes). */
export interface LibrarySeries {
  title: string;
  count: number;
}

/**
 * The library's own spelling of the series `typed` names — case, spacing and
 * reserved characters aside, the way the catalog groups series — so a typed
 * "killing bites" joins "Killing Bites" (and continues its numbering) instead
 * of starting a near-duplicate series.
 */
export function canonicalSeriesTitle(
  library: readonly LibrarySeries[],
  typed: string
): string | undefined {
  if (!typed.trim()) return undefined;
  const key = normalizeSeriesKey(storedTitle(typed.trim()));
  return library.find((s) => normalizeSeriesKey(s.title) === key)?.title;
}
```

- [ ] **Step 4: Write `library-series.ts`**

```ts
/**
 * The library's series, for the image-only review (#285): what the series
 * field autocompletes to, and where a series' numbering continues.
 *
 * Keys only — the `series_title` index and primary keys. Rows carry
 * thumbnails; reading them to count would cost a blob read per volume.
 */

import { db } from '$lib/catalog/db';
import { seriesVolumeUuids } from './database';
import { storedTitle } from './image-only-naming';
import type { LibrarySeries } from './image-only-review';

/** Every series title the library has, once, with its volume count (index order). */
export async function listLibrarySeries(): Promise<LibrarySeries[]> {
  // One keys-only read of the index: duplicates included, so it carries the counts.
  const keys = await db.volumes.orderBy('series_title').keys();
  const counts = new Map<string, number>();
  for (const key of keys) {
    const title = String(key);
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return [...counts].map(([title, count]) => ({ title, count }));
}

/**
 * How many volumes `series` (as it would be stored) already has, not counting
 * `exclude` — the group's own uuids, so re-importing a series keeps its numbers.
 */
export async function existingVolumeCount(
  series: string,
  exclude: Iterable<string> = []
): Promise<number> {
  const skip = new Set(exclude);
  const uuids = await seriesVolumeUuids(storedTitle(series));
  return uuids.filter((uuid) => !skip.has(uuid)).length;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/import/__tests__/library-series.test.ts src/lib/import/__tests__/image-only-review.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/import/library-series.ts src/lib/import/image-only-review.ts src/lib/import/__tests__/library-series.test.ts src/lib/import/__tests__/image-only-review.test.ts
git commit -m "feat(import): library series and volume counts for the review, keys only (#285)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The review dialog

**Files:**

- Create: `src/lib/components/ImageOnlyReviewStep.svelte`
- Create: `src/lib/components/ImageOnlyReviewDialog.svelte`
- Modify: `src/routes/+layout.svelte` (mount the dialog beside `<ImageOnlyImportModal />`; the old one goes in Task 6)
- Test: `src/lib/components/__tests__/ImageOnlyReviewStep.test.ts`, `src/lib/components/__tests__/ImageOnlyReviewDialog.test.ts`

**Interfaces:**

- Consumes: `reviewSession`, `currentStep`, `decideCurrent`, `skipAllRemaining`, `GroupDecision` (Task 3); `nameGroup`, `canonicalSeriesTitle`, `LibrarySeries`, `NamingMode`, `ReviewGroup` (Tasks 1, 4); `listLibrarySeries`, `existingVolumeCount` (Task 4); `storedTitle`; `miscSettings`, `updateMiscSetting`.
- Produces: `ImageOnlyReviewStep` props `{ group: ReviewGroup; step: number; total: number; library: LibrarySeries[]; initialMode: NamingMode; onDecide(d: GroupDecision): void; onSkipAll(): void }`; `ImageOnlyReviewDialog` (no props). Test ids used by Task 7: `image-only-review` (the `<dialog>`), `review-step`, `review-series`, `review-start`, `review-volumes`, `review-volume-name`, `review-volume-source`, `review-close`.

- [ ] **Step 1: Write the failing step-component test**

Create `src/lib/components/__tests__/ImageOnlyReviewStep.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';

const { existingVolumeCount } = vi.hoisted(() => ({
  existingVolumeCount: vi.fn(async (_series: string, _exclude?: Iterable<string>) => 0)
}));
vi.mock('$lib/import/library-series', () => ({
  existingVolumeCount,
  listLibrarySeries: vi.fn(async () => [])
}));

import ImageOnlyReviewStep from '../ImageOnlyReviewStep.svelte';
import { groupCandidates, type ReviewGroup } from '$lib/import/image-only-review';
import { miscSettings } from '$lib/settings/misc';

const candidate = (id: string, path: string) => ({
  id,
  basePath: path,
  titlePath: path,
  source: `picked/${path}`
});

function chainedGroup(existingCount = 0, series = 'Chained Soldier (Semi-Color)'): ReviewGroup {
  const [group] = groupCandidates([
    candidate('c1', `${series}/01`),
    candidate('c2', `${series}/02`),
    candidate('c3', `${series}/03`)
  ]);
  return { ...group, existingCount };
}

function renderStep(props: Record<string, unknown> = {}) {
  const onDecide = vi.fn();
  const onSkipAll = vi.fn();
  const utils = render(ImageOnlyReviewStep, {
    props: {
      group: chainedGroup(),
      step: 1,
      total: 2,
      library: [],
      initialMode: 'cleaned',
      onDecide,
      onSkipAll,
      ...props
    }
  });
  const q = <T extends Element>(id: string) =>
    utils.container.querySelector<T>(`[data-testid="${id}"]`)!;
  const names = () =>
    [
      ...utils.container.querySelectorAll<HTMLInputElement>('[data-testid="review-volume-name"]')
    ].map((i) => i.value);
  const nameInputs = () => [
    ...utils.container.querySelectorAll<HTMLInputElement>('[data-testid="review-volume-name"]')
  ];
  return { ...utils, onDecide, onSkipAll, q, names, nameInputs };
}

describe('ImageOnlyReviewStep (#285)', () => {
  beforeEach(() => {
    existingVolumeCount.mockReset();
    existingVolumeCount.mockImplementation(async () => 0);
    miscSettings.set({ ...get(miscSettings), keepFolderNamesAsTitles: false });
  });
  afterEach(() => cleanup());

  it('shows the step, the series and each volume with its source', () => {
    const { q, names, container } = renderStep();
    expect(q('review-step').textContent?.trim()).toBe('Series 1 of 2');
    expect(q<HTMLInputElement>('review-series').value).toBe('Chained Soldier (Semi-Color)');
    expect(names()).toEqual([
      'Chained Soldier (Semi-Color) 01',
      'Chained Soldier (Semi-Color) 02',
      'Chained Soldier (Semi-Color) 03'
    ]);
    expect(
      [...container.querySelectorAll('[data-testid="review-volume-source"]')].map(
        (s) => s.textContent
      )
    ).toEqual([
      'picked/Chained Soldier (Semi-Color)/01',
      'picked/Chained Soldier (Semi-Color)/02',
      'picked/Chained Soldier (Semi-Color)/03'
    ]);
  });

  it('starts numbering after the volumes the series already has', () => {
    const { names } = renderStep({ group: chainedGroup(4) });
    expect(names()[0]).toBe('Chained Soldier (Semi-Color) 05');
  });

  it('folder names: literal names, and no start number', async () => {
    const { names, getByText, container } = renderStep();
    await fireEvent.click(getByText('Folder names'));
    expect(names()).toEqual(['01', '02', '03']);
    expect(container.querySelector('[data-testid="review-start"]')).toBeNull();
  });

  it('a renamed volume keeps its name through mode, start and series changes', async () => {
    const { names, nameInputs, getByText, q } = renderStep();
    await fireEvent.input(nameInputs()[2], { target: { value: 'Extra' } });
    await fireEvent.click(getByText('Folder names'));
    expect(names()).toEqual(['01', '02', 'Extra']);
    await fireEvent.click(getByText('Cleaned up'));
    await fireEvent.input(q('review-start'), { target: { value: '5' } });
    expect(names()).toEqual([
      'Chained Soldier (Semi-Color) 05',
      'Chained Soldier (Semi-Color) 06',
      'Extra'
    ]);
    await fireEvent.input(q('review-series'), { target: { value: 'Chained' } });
    expect(names()).toEqual(['Chained 05', 'Chained 06', 'Extra']);
  });

  it('choosing an existing series continues after its volumes', async () => {
    existingVolumeCount.mockImplementation(async (series: string) =>
      series === 'Killing Bites' ? 7 : 0
    );
    const { names, q } = renderStep();
    await fireEvent.input(q('review-series'), { target: { value: 'Killing Bites' } });
    await waitFor(() => expect(names()[0]).toBe('Killing Bites 08'));
    expect(existingVolumeCount).toHaveBeenLastCalledWith('Killing Bites', chainedGroup().ownUuids);
  });

  it('a start number the user typed survives a series change', async () => {
    existingVolumeCount.mockImplementation(async () => 7);
    const { names, q } = renderStep();
    await fireEvent.input(q('review-start'), { target: { value: '3' } });
    await fireEvent.input(q('review-series'), { target: { value: 'Killing Bites' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(names()[0]).toBe('Killing Bites 03');
  });

  it("a series typed in another case snaps to the library's spelling on blur", async () => {
    const { q } = renderStep({ library: [{ title: 'Killing Bites', count: 2 }] });
    await fireEvent.input(q('review-series'), { target: { value: 'killing bites' } });
    await fireEvent.blur(q('review-series'));
    expect(q<HTMLInputElement>('review-series').value).toBe('Killing Bites');
  });

  it("an untouched series folder named in another case takes the library's spelling", async () => {
    const { q } = renderStep({
      group: chainedGroup(0, 'killing bites'),
      library: [{ title: 'Killing Bites', count: 2 }]
    });
    await waitFor(() => expect(q<HTMLInputElement>('review-series').value).toBe('Killing Bites'));
  });

  it('offers the library series as suggestions', () => {
    const { container } = renderStep({ library: [{ title: 'Killing Bites', count: 2 }] });
    const option = container.querySelector('datalist option') as HTMLOptionElement;
    expect(option.value).toBe('Killing Bites');
    expect(option.textContent).toContain('2 volumes');
  });

  it('a cleared volume name falls back to the generated one, never an empty title', async () => {
    const { names, nameInputs, getByText, onDecide } = renderStep();
    await fireEvent.input(nameInputs()[0], { target: { value: '' } });
    await fireEvent.blur(nameInputs()[0]);
    expect(names()[0]).toBe('Chained Soldier (Semi-Color) 01');
    await fireEvent.click(getByText('Import'));
    expect(onDecide.mock.calls[0][0].naming.overrides).toEqual({});
  });

  it('Import hands over the choices and remembers the mode', async () => {
    const { getByText, nameInputs, onDecide } = renderStep();
    await fireEvent.click(getByText('Folder names'));
    await fireEvent.input(nameInputs()[1], { target: { value: 'Two' } });
    await fireEvent.click(getByText('Import'));
    expect(onDecide).toHaveBeenCalledWith({
      action: 'import',
      naming: {
        series: 'Chained Soldier (Semi-Color)',
        mode: 'folder',
        start: 1,
        overrides: { c2: 'Two' }
      }
    });
    expect(get(miscSettings).keepFolderNamesAsTitles).toBe(true);
  });

  it('starts in the last mode used', () => {
    miscSettings.set({ ...get(miscSettings), keepFolderNamesAsTitles: true });
    const { names } = renderStep({ initialMode: 'folder' });
    expect(names()).toEqual(['01', '02', '03']);
  });

  it('cannot import with no series name', async () => {
    const { q, getByText, onDecide } = renderStep();
    await fireEvent.input(q('review-series'), { target: { value: '   ' } });
    expect((getByText('Import') as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(getByText('Import'));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('Skip skips this series; Skip all remaining and close skip everything left', async () => {
    const { getByText, q, onDecide, onSkipAll } = renderStep();
    await fireEvent.click(getByText('Skip'));
    expect(onDecide).toHaveBeenCalledWith({ action: 'skip' });
    await fireEvent.click(getByText('Skip all remaining'));
    await fireEvent.click(q('review-close'));
    expect(onSkipAll).toHaveBeenCalledTimes(2);
  });

  it('offers "Skip all remaining" only while more series follow', () => {
    const { queryByText } = renderStep({ step: 2, total: 2 });
    expect(queryByText('Skip all remaining')).toBeNull();
  });

  it('keeps the buttons in a stacking context above the dialog body (night mode)', () => {
    const { getByText } = renderStep();
    const row = getByText('Import').closest('div.relative')!;
    expect(row.className).toContain('z-10');
  });

  it('lays the volumes out in one scrolling column', () => {
    const { q } = renderStep();
    expect(q('review-volumes').className).toContain('overflow-y-auto');
  });
});
```

- [ ] **Step 2: Write the failing dialog-shell test**

Create `src/lib/components/__tests__/ImageOnlyReviewDialog.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';

vi.mock('$lib/import/library-series', () => ({
  listLibrarySeries: vi.fn(async () => [{ title: 'Killing Bites', count: 2 }]),
  existingVolumeCount: vi.fn(async () => 0)
}));

import ImageOnlyReviewDialog from '../ImageOnlyReviewDialog.svelte';
import { appendReviewGroups, reviewSession } from '$lib/import/review-session';
import { groupCandidates } from '$lib/import/image-only-review';

const groupOf = (series: string) =>
  groupCandidates([
    {
      id: `${series}-1`,
      basePath: `${series}/01`,
      titlePath: `${series}/01`,
      source: `${series}/01`
    }
  ])[0];
const stepText = () => document.querySelector('[data-testid="review-step"]')?.textContent?.trim();
const dialog = () => document.querySelector('[data-testid="image-only-review"]') as HTMLElement;

describe('ImageOnlyReviewDialog (#285)', () => {
  beforeEach(() => reviewSession.set({ pending: [], decided: 0 }));
  afterEach(() => cleanup());

  it('shows nothing while no review is pending', () => {
    render(ImageOnlyReviewDialog);
    expect(document.querySelector('[data-testid="review-step"]')).toBeNull();
  });

  it('steps through the series, one decision each — closing after the last decides nothing more', async () => {
    const onDecision = vi.fn();
    appendReviewGroups([groupOf('Alpha'), groupOf('Beta')], onDecision);
    const { getByText } = render(ImageOnlyReviewDialog);
    await waitFor(() => expect(stepText()).toBe('Series 1 of 2'));
    await fireEvent.click(getByText('Skip'));
    await waitFor(() => expect(stepText()).toBe('Series 2 of 2'));
    await fireEvent.click(getByText('Import'));
    await waitFor(() => expect(document.querySelector('[data-testid="review-step"]')).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(onDecision.mock.calls.map(([, d]) => d.action)).toEqual(['skip', 'import']);
  });

  it('Escape skips everything still pending', async () => {
    const onDecision = vi.fn();
    appendReviewGroups([groupOf('Alpha'), groupOf('Beta')], onDecision);
    render(ImageOnlyReviewDialog);
    await waitFor(() => expect(stepText()).toBe('Series 1 of 2'));
    dialog().dispatchEvent(new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(get(reviewSession).pending).toHaveLength(0));
    expect(onDecision.mock.calls.map(([, d]) => d.action)).toEqual(['skip', 'skip']);
  });

  it('a tap outside the dialog skips nothing', async () => {
    const onDecision = vi.fn();
    appendReviewGroups([groupOf('Alpha')], onDecision);
    render(ImageOnlyReviewDialog);
    await waitFor(() => expect(stepText()).toBe('Series 1 of 1'));
    await fireEvent.click(dialog(), { clientX: 0, clientY: 0 });
    expect(onDecision).not.toHaveBeenCalled();
    expect(stepText()).toBe('Series 1 of 1');
  });

  it('a review appended while it is open extends the count', async () => {
    appendReviewGroups([groupOf('Alpha')], vi.fn());
    render(ImageOnlyReviewDialog);
    await waitFor(() => expect(stepText()).toBe('Series 1 of 1'));
    appendReviewGroups([groupOf('Beta')], vi.fn());
    await waitFor(() => expect(stepText()).toBe('Series 1 of 2'));
  });

  it('offers the library series to the series field', async () => {
    appendReviewGroups([groupOf('Alpha')], vi.fn());
    render(ImageOnlyReviewDialog);
    await waitFor(() =>
      expect(document.querySelector('datalist option')?.getAttribute('value')).toBe('Killing Bites')
    );
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run src/lib/components/__tests__/ImageOnlyReviewStep.test.ts src/lib/components/__tests__/ImageOnlyReviewDialog.test.ts`
Expected: FAIL — `Failed to resolve import "../ImageOnlyReviewStep.svelte"` / `"../ImageOnlyReviewDialog.svelte"`.

- [ ] **Step 4: Write `ImageOnlyReviewStep.svelte`**

```svelte
<script lang="ts">
  import { Button } from 'flowbite-svelte';
  import { CloseOutline } from 'flowbite-svelte-icons';
  import { storedTitle } from '$lib/import/image-only-naming';
  import {
    canonicalSeriesTitle,
    nameGroup,
    type LibrarySeries,
    type NamingMode,
    type ReviewGroup
  } from '$lib/import/image-only-review';
  import { existingVolumeCount } from '$lib/import/library-series';
  import type { GroupDecision } from '$lib/import/review-session';
  import { updateMiscSetting } from '$lib/settings/misc';

  interface Props {
    group: ReviewGroup;
    step: number;
    total: number;
    library: LibrarySeries[];
    initialMode: NamingMode;
    onDecide: (decision: GroupDecision) => void;
    onSkipAll: () => void;
  }

  let { group, step, total, library, initialMode, onDecide, onSkipAll }: Props = $props();

  // The dialog re-creates this step per group ({#key}), so these start from
  // the group once and are the user's from then on.
  // svelte-ignore state_referenced_locally
  let series = $state(group.series);
  // svelte-ignore state_referenced_locally
  let mode = $state<NamingMode>(initialMode);
  // svelte-ignore state_referenced_locally
  let start = $state(group.existingCount + 1);
  let startEdited = $state(false);
  let seriesEdited = $state(false);
  let overrides = $state<Record<string, string>>({});

  const names = $derived(nameGroup(group, { series, mode, start, overrides }));
  const canImport = $derived(series.trim().length > 0);

  let countRequest = 0;
  let countTimer: ReturnType<typeof setTimeout> | undefined;

  /** A new series name: numbering follows that series' volumes unless the start was typed. */
  function setSeries(value: string) {
    series = value;
    clearTimeout(countTimer);
    const request = ++countRequest;
    countTimer = setTimeout(async () => {
      const count = await existingVolumeCount(value, group.ownUuids);
      if (request === countRequest && !startEdited) start = count + 1;
    }, 200);
  }

  $effect(() => () => clearTimeout(countTimer));

  // Once the library has loaded, an untouched series field takes the
  // library's spelling of the series it names ("killing bites").
  $effect(() => {
    if (seriesEdited) return;
    const canonical = canonicalSeriesTitle(library, series);
    if (canonical && canonical !== series) setSeries(canonical);
  });

  function seriesInput(value: string) {
    seriesEdited = true;
    setSeries(value);
  }

  function seriesBlur() {
    const canonical = canonicalSeriesTitle(library, series);
    if (canonical && canonical !== series) setSeries(canonical);
  }

  function startInput(value: string) {
    startEdited = true;
    const n = Number.parseInt(value, 10);
    if (Number.isInteger(n) && n >= 1) start = n;
  }

  function nameBlur(id: string) {
    if (!overrides[id]?.trim()) delete overrides[id];
  }

  function importGroup() {
    if (!canImport) return;
    updateMiscSetting('keepFolderNamesAsTitles', mode === 'folder');
    const typed: Record<string, string> = {};
    for (const [id, name] of Object.entries(overrides)) if (name.trim()) typed[id] = name;
    onDecide({
      action: 'import',
      naming: { series: series.trim(), mode, start, overrides: typed }
    });
  }

  /**
   * Bound to the VISUAL viewport, which shrinks when a phone raises its
   * keyboard, so the buttons below the list stay on screen while a name is
   * being edited.
   */
  function fitVisualViewport(node: HTMLElement) {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => node.style.setProperty('--review-vvh', `${viewport.height}px`);
    update();
    viewport.addEventListener('resize', update);
    return { destroy: () => viewport.removeEventListener('resize', update) };
  }
</script>

<div
  use:fitVisualViewport
  class="flex flex-col gap-3"
  style="max-height: min(80svh, calc(var(--review-vvh, 100svh) - 5rem))"
  data-testid="review-step-body"
>
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <p
        class="text-xs font-medium tracking-wide text-gray-500 uppercase dark:text-gray-400"
        data-testid="review-step"
      >
        Series {step} of {total}
      </p>
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Import without OCR text</h3>
      <p class="text-sm text-gray-600 dark:text-gray-400">
        {group.candidates.length}
        {group.candidates.length === 1 ? 'volume has' : 'volumes have'} no .mokuro file.
      </p>
    </div>
    <button
      type="button"
      class="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-600 dark:hover:text-white"
      aria-label="Close and skip all remaining"
      data-testid="review-close"
      onclick={onSkipAll}
    >
      <CloseOutline class="h-5 w-5" />
    </button>
  </div>

  <label class="flex flex-col gap-1 text-sm">
    <span class="font-medium text-gray-700 dark:text-gray-300">Series</span>
    <input
      type="text"
      list="review-series-{group.id}"
      autocomplete="off"
      enterkeyhint="done"
      data-testid="review-series"
      class="w-full rounded-lg border border-gray-300 bg-gray-50 p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
      value={series}
      oninput={(e) => seriesInput(e.currentTarget.value)}
      onblur={seriesBlur}
    />
    <datalist id="review-series-{group.id}">
      {#each library as entry (entry.title)}
        <option value={entry.title}>{entry.count} {entry.count === 1 ? 'volume' : 'volumes'}</option
        >
      {/each}
    </datalist>
  </label>

  <div class="flex flex-wrap items-center gap-3">
    <div
      class="inline-flex rounded-lg border border-gray-200 p-0.5 dark:border-gray-600"
      role="radiogroup"
      aria-label="Volume names"
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'cleaned'}
        class="rounded-md px-3 py-1 text-sm {mode === 'cleaned'
          ? 'bg-blue-600 text-white'
          : 'text-gray-700 dark:text-gray-300'}"
        onclick={() => (mode = 'cleaned')}
      >
        Cleaned up
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'folder'}
        class="rounded-md px-3 py-1 text-sm {mode === 'folder'
          ? 'bg-blue-600 text-white'
          : 'text-gray-700 dark:text-gray-300'}"
        onclick={() => (mode = 'folder')}
      >
        Folder names
      </button>
    </div>
    {#if mode === 'cleaned'}
      <label class="flex items-center gap-2 text-sm">
        <span class="text-gray-700 dark:text-gray-300">Start at</span>
        <input
          type="number"
          inputmode="numeric"
          min="1"
          data-testid="review-start"
          class="w-20 rounded-lg border border-gray-300 bg-gray-50 p-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
          value={start}
          oninput={(e) => startInput(e.currentTarget.value)}
        />
      </label>
    {/if}
  </div>
  <p class="text-xs text-gray-500 dark:text-gray-400">
    {#if mode === 'folder'}
      Each volume's own folder or file name, exactly as written.
    {:else}
      The series name, with volumes numbered in folder order.
    {/if}
  </p>

  <ul
    class="min-h-0 flex-1 divide-y overflow-y-auto overscroll-contain rounded-lg border dark:divide-gray-600 dark:border-gray-600"
    data-testid="review-volumes"
  >
    {#each group.candidates as candidate (candidate.id)}
      {@const saved = storedTitle(names.get(candidate.id)?.volume ?? '')}
      <li class="flex flex-col gap-0.5 px-3 py-2">
        <input
          type="text"
          aria-label="Volume name"
          enterkeyhint="done"
          data-testid="review-volume-name"
          class="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm text-gray-900 focus:border-blue-500 dark:text-white"
          value={overrides[candidate.id] ?? saved}
          oninput={(e) => (overrides[candidate.id] = e.currentTarget.value)}
          onblur={() => nameBlur(candidate.id)}
        />
        {#if overrides[candidate.id]?.trim() && saved !== overrides[candidate.id]}
          <span class="px-1 text-xs text-gray-500 dark:text-gray-400">Saved as {saved}</span>
        {/if}
        <span
          class="truncate px-1 text-xs text-gray-400 dark:text-gray-500"
          title={candidate.source}
          data-testid="review-volume-source">{candidate.source}</span
        >
      </li>
    {/each}
  </ul>

  <div class="relative z-10 flex flex-wrap justify-end gap-2 pt-1">
    {#if total > step}
      <Button color="alternative" size="sm" onclick={onSkipAll}>Skip all remaining</Button>
    {/if}
    <Button color="alternative" size="sm" onclick={() => onDecide({ action: 'skip' })}>Skip</Button>
    <Button color="blue" size="sm" disabled={!canImport} onclick={importGroup}>Import</Button>
  </div>
</div>
```

- [ ] **Step 5: Write `ImageOnlyReviewDialog.svelte`**

```svelte
<script lang="ts">
  import { Modal } from 'flowbite-svelte';
  import { get } from 'svelte/store';
  import { miscSettings } from '$lib/settings/misc';
  import {
    currentStep,
    decideCurrent,
    reviewSession,
    skipAllRemaining
  } from '$lib/import/review-session';
  import { listLibrarySeries } from '$lib/import/library-series';
  import type { LibrarySeries } from '$lib/import/image-only-review';
  import ImageOnlyReviewStep from './ImageOnlyReviewStep.svelte';

  const step = $derived(currentStep($reviewSession));
  const open = $derived(step !== null);
  let library = $state<LibrarySeries[]>([]);

  // The library's series, re-read (keys only) for every step, so a series
  // approved a step ago is already a suggestion.
  $effect(() => {
    const groupId = step?.group.id;
    if (!groupId) return;
    let live = true;
    listLibrarySeries()
      .then((list) => {
        if (live) library = list;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  });

  // Escape (the dialog's cancel) = Skip all remaining. Never the dialog's own
  // close on teardown: by then nothing is pending.
  function cancel(event: Event) {
    event.preventDefault();
    if (get(reviewSession).pending.length > 0) skipAllRemaining();
  }
</script>

<Modal
  {open}
  size="md"
  placement="top-center"
  dismissable={false}
  outsideclose={false}
  oncancel={cancel}
  data-testid="image-only-review"
>
  {#if step}
    {#key step.group.id}
      <ImageOnlyReviewStep
        group={step.group}
        step={step.step}
        total={step.total}
        {library}
        initialMode={$miscSettings.keepFolderNamesAsTitles ? 'folder' : 'cleaned'}
        onDecide={decideCurrent}
        onSkipAll={skipAllRemaining}
      />
    {/key}
  {/if}
</Modal>
```

- [ ] **Step 6: Run the component tests to verify they pass**

Run: `npx vitest run src/lib/components/__tests__/ImageOnlyReviewStep.test.ts src/lib/components/__tests__/ImageOnlyReviewDialog.test.ts`
Expected: PASS. If `data-testid` does not reach the `<dialog>` element (check `document.querySelector('dialog')?.outerHTML`), pass it through Flowbite's `classes`/rest props the way the rendered markup shows — do not wrap the Modal in an extra element, Task 7 measures the `<dialog>` box.

- [ ] **Step 7: Mount the dialog**

In `src/routes/+layout.svelte` add `import ImageOnlyReviewDialog from '$lib/components/ImageOnlyReviewDialog.svelte';` next to the `ImageOnlyImportModal` import, and `<ImageOnlyReviewDialog />` on the line after `<ImageOnlyImportModal />`.

- [ ] **Step 8: Type-check and lint**

Run: `npm run check 2>&1 | tail -1 && npx eslint src/lib/components/ImageOnlyReviewStep.svelte src/lib/components/ImageOnlyReviewDialog.svelte`
Expected: `svelte-check found 0 errors and 0 warnings`; eslint prints nothing.

- [ ] **Step 9: Commit**

```bash
git add src/lib/components/ImageOnlyReviewStep.svelte src/lib/components/ImageOnlyReviewDialog.svelte src/lib/components/__tests__/ImageOnlyReviewStep.test.ts src/lib/components/__tests__/ImageOnlyReviewDialog.test.ts src/routes/+layout.svelte
git commit -m "feat(import): the image-only review dialog, one series per step (#285)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the review into the import

**Files:**

- Modify: `src/lib/import/types.ts` (`ArchiveReview`, `PairedSource.archiveReview`, doc of `importNames`)
- Modify: `src/lib/import/import-service.ts` (imports, `hasUnfinishedImports`, `processArchiveContents`, `processSingleVolume`, `processQueue`, `runImportFiles`, new helpers; delete `promptForImageOnlyImport`, `existingVolumeCounts`)
- Modify: `src/lib/import/image-only-naming.ts` (delete `planImageOnlyNames`, `cleanedSeriesTitles`, `importIdentities`, preview types)
- Modify: `src/lib/import/import-ui.ts` (delete `promptImageOnly`, `SeriesImportInfo`)
- Modify: `src/lib/util/modals.ts` (delete the image-only modal store and prompt)
- Delete: `src/lib/components/ImageOnlyImportModal.svelte`, `src/lib/import/__tests__/image-only-naming.test.ts`
- Modify: `src/routes/+layout.svelte` (remove the old modal)
- Test: create `src/lib/import/__tests__/image-only-review-import.test.ts`; update `keep-folder-names.test.ts`, `integration.test.ts`, `deep-link-import.test.ts`, `series-file-import.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–4; `ImportUiBridge.reviewImageOnly`.
- Produces:
  - `interface ArchiveReview { approved: true; names: Map<string, ImportNames> }` — approved names by the volume's path INSIDE the archive (`.` = root); an inner image-only volume not in `names` was skipped.
  - `PairedSource.archiveReview?: ArchiveReview`
  - Behaviour: `importFiles` resolves once routing is done and every group has been OFFERED; approved image-only sources always go through the queue; direct processing only for a lone `.mokuro` pairing when no review is pending and the queue is idle; `series.json` files apply only once the queue is drained AND no review group is pending.

- [ ] **Step 1: Write the failing import-service test**

Create `src/lib/import/__tests__/image-only-review-import.test.ts`:

```ts
/**
 * The image-only review driving a real import (#285): archives are listed
 * before anything is extracted, image-only volumes are offered one series at
 * a time, and each approval goes straight to the queue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { get } from 'svelte/store';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';

vi.mock('$lib/catalog/db', async () => {
  const { default: Dexie } = await import('dexie');
  const db: any = new Dexie('image-only-review-import-test');
  db.version(1).stores({
    volumes: 'volume_uuid, series_uuid, series_title',
    volume_ocr: 'volume_uuid',
    volume_files: 'volume_uuid',
    series_metadata: 'series_key',
    series_index: 'series_key'
  });
  db.processThumbnails = async () => undefined;
  return { db };
});
vi.mock('$lib/catalog/thumbnails', () => ({
  generateThumbnail: async () => ({
    file: new File([new Uint8Array([1])], 'thumb.webp', { type: 'image/webp' }),
    width: 10,
    height: 14
  })
}));
vi.mock('$lib/util/snackbar', () => ({ showSnackbar: vi.fn() }));
vi.mock('$lib/util/progress-tracker', () => ({
  progressTrackerStore: { addProcess: vi.fn(), updateProcess: vi.fn(), removeProcess: vi.fn() }
}));
vi.mock('$lib/util/modals', () => ({
  promptMissingFiles: (_info: unknown, onContinue: () => void) => onContinue()
}));
vi.mock('$lib/metadata/series-file-sync', () => ({ scheduleSeriesFileWrite: vi.fn() }));
vi.mock('$lib/util/file-processing-pool', () => ({
  getFileProcessingPool: async () => ({ addTask: () => {} }),
  incrementPoolUsers: () => {},
  decrementPoolUsers: () => {}
}));

import { db } from '$lib/catalog/db';
import { importFiles, importQueue, isImporting } from '../import-service';
import { decideCurrent, reviewSession, skipAllRemaining } from '../review-session';
import { defaultNaming } from '../image-only-review';
import { approveAsDialogWould, installReviewer, type Reviewer } from './helpers/review-bridge';

// zip.js writes the archive through a Blob stream; jsdom's Blob has none.
if (typeof Blob !== 'undefined' && !Blob.prototype.stream) {
  Blob.prototype.stream = function (this: Blob) {
    const bytes = this.arrayBuffer();
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(await bytes));
        controller.close();
      }
    });
  } as Blob['stream'];
}

const IMAGE: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3]);

function picked(path: string, bytes: Uint8Array<ArrayBuffer> | Blob = IMAGE): File {
  const file = new File([bytes], path.split('/').pop()!, { lastModified: 1_700_000_000_000 });
  if (path.includes('/')) Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

async function zipOf(entries: Array<string | { path: string; data: Uint8Array }>): Promise<Blob> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    bufferedWrite: false,
    extendedTimestamp: false
  });
  for (const entry of entries) {
    const { path, data } = typeof entry === 'string' ? { path: entry, data: IMAGE } : entry;
    await writer.add(path, new Uint8ArrayReader(data));
  }
  return new Blob([await writer.close()]);
}

const mokuro = (title: string, volume: string) =>
  new TextEncoder().encode(
    JSON.stringify({
      version: '0.2.1',
      title,
      title_uuid: `${title}-series`,
      volume,
      volume_uuid: `${title}-${volume}`,
      pages: [{ version: '0.2.1', img_width: 1, img_height: 1, img_path: '001.jpg', blocks: [] }]
    })
  );

async function waitForQueue(): Promise<void> {
  const start = Date.now();
  while (
    (get(isImporting) || get(importQueue).some((i) => i.status !== 'error')) &&
    Date.now() - start < 10_000
  ) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function rows() {
  return (await db.volumes.toArray())
    .map((r) => ({ series: r.series_title, volume: r.volume_title }))
    .sort((a, b) => a.volume.localeCompare(b.volume));
}

/** Display titles of every item that passed through the import queue. */
function recordQueue() {
  const titles = new Set<string>();
  const stop = importQueue.subscribe((q) => q.forEach((item) => titles.add(item.displayTitle)));
  return { titles, stop };
}

let reviewer: Reviewer | undefined;

beforeEach(async () => {
  importQueue.set([]);
  reviewSession.set({ pending: [], decided: 0 });
  await Promise.all([db.volumes.clear(), db.volume_ocr.clear(), db.volume_files.clear()]);
});

afterEach(() => {
  reviewer?.restore();
  reviewer = undefined;
});

describe('pre-scanned archives', () => {
  it('a batch of loose .cbz is ONE series step, never a prompt per archive', async () => {
    reviewer = installReviewer();
    const files = await Promise.all(
      ['01', '02', '03'].map(async (n) =>
        picked(`Killing Bites v${n}.cbz`, await zipOf(['001.jpg']))
      )
    );
    await importFiles(files);
    await waitForQueue();
    expect(reviewer.offered.map((g) => [g.series, g.candidates.map((c) => c.source)])).toEqual([
      ['Killing Bites', ['Killing Bites v01.cbz', 'Killing Bites v02.cbz', 'Killing Bites v03.cbz']]
    ]);
    expect(await rows()).toEqual(
      ['01', '02', '03'].map((n) => ({ series: 'Killing Bites', volume: `Killing Bites ${n}` }))
    );
  });

  it('a series archive of volume folders is one step named after the archive', async () => {
    reviewer = installReviewer();
    await importFiles([
      picked('Series Pack [Digital].zip', await zipOf(['v01/001.jpg', 'v02/001.jpg']))
    ]);
    await waitForQueue();
    expect(reviewer.offered.map((g) => [g.series, g.candidates.length])).toEqual([
      ['Series Pack [Digital]', 2]
    ]);
    expect((await rows()).map((r) => r.volume)).toEqual([
      'Series Pack [Digital] 01',
      'Series Pack [Digital] 02'
    ]);
  });

  it('a mixed archive imports its .mokuro volume even when its image-only part is skipped', async () => {
    reviewer = installReviewer(() => ({ action: 'skip' }));
    const pack = await zipOf([
      { path: 'A.mokuro', data: mokuro('Mixed', 'A') },
      'A/001.jpg',
      'B/001.jpg'
    ]);
    await importFiles([picked('Pack.zip', pack)]);
    await waitForQueue();
    expect(reviewer.offered.map((g) => g.series)).toEqual(['Pack']);
    expect(await rows()).toEqual([{ series: 'Mixed', volume: 'A' }]);
  });

  it('a mixed archive imports both parts when its image-only part is approved', async () => {
    reviewer = installReviewer();
    const pack = await zipOf([
      { path: 'A.mokuro', data: mokuro('Mixed', 'A') },
      'A/001.jpg',
      'B/001.jpg'
    ]);
    await importFiles([picked('Pack.zip', pack)]);
    await waitForQueue();
    expect(await rows()).toEqual([
      { series: 'Mixed', volume: 'A' },
      { series: 'Pack', volume: 'Pack 01' }
    ]);
  });

  it('a skipped archive with no .mokuro volume is never queued', async () => {
    reviewer = installReviewer(() => ({ action: 'skip' }));
    const queued = recordQueue();
    await importFiles([picked('Dorohedoro v01.cbz', await zipOf(['001.jpg']))]);
    await waitForQueue();
    queued.stop();
    expect([...queued.titles]).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});

describe('approval order', () => {
  const twoSeries = () => [
    picked('Chained Soldier (Semi-Color)/01/001.jpg'),
    picked('Chained Soldier (Semi-Color)/02/001.jpg'),
    picked('Killing Bites/Killing Bites 01/001.jpg')
  ];

  it('series 1 imports while series 2 is still waiting for its decision', async () => {
    reviewer = installReviewer('manual');
    await importFiles(twoSeries());
    expect(reviewer.pending.map((p) => p.group.series)).toEqual([
      'Chained Soldier (Semi-Color)',
      'Killing Bites'
    ]);
    expect(await db.volumes.count()).toBe(0);

    reviewer.pending[0].decide(approveAsDialogWould(reviewer.pending[0].group));
    await waitForQueue();
    expect(await rows()).toEqual([
      { series: 'Chained Soldier (Semi-Color)', volume: 'Chained Soldier (Semi-Color) 01' },
      { series: 'Chained Soldier (Semi-Color)', volume: 'Chained Soldier (Semi-Color) 02' }
    ]);

    reviewer.pending[1].decide(approveAsDialogWould(reviewer.pending[1].group));
    await waitForQueue();
    expect((await rows()).map((r) => r.volume)).toContain('Killing Bites 01');
  });

  it('an approved image-only volume goes through the queue, even alone', async () => {
    reviewer = installReviewer();
    const queued = recordQueue();
    await importFiles([picked('Killing Bites/Killing Bites 01/001.jpg')]);
    await waitForQueue();
    queued.stop();
    expect([...queued.titles]).toEqual(['Killing Bites 01']);
  });

  it('a second import while the review is open joins it', async () => {
    await importFiles([picked('Chained Soldier (Semi-Color)/01/001.jpg')]);
    await importFiles([picked('Killing Bites/Killing Bites 01/001.jpg')]);
    expect(get(reviewSession).pending.map((p) => p.group.series)).toEqual([
      'Chained Soldier (Semi-Color)',
      'Killing Bites'
    ]);
    const approveCurrent = () =>
      decideCurrent({
        action: 'import',
        naming: defaultNaming(get(reviewSession).pending[0].group, 'cleaned')
      });
    approveCurrent();
    approveCurrent();
    await waitForQueue();
    expect((await rows()).map((r) => r.volume)).toEqual([
      'Chained Soldier (Semi-Color) 01',
      'Killing Bites 01'
    ]);
  });

  it('a lone .mokuro volume dropped while a review is open waits its turn in the queue', async () => {
    await importFiles([picked('Killing Bites/Killing Bites 01/001.jpg')]);
    const queued = recordQueue();
    const solo = await zipOf([
      { path: 'Solo.mokuro', data: mokuro('Solo', 'Vol 1') },
      'Solo/001.jpg'
    ]);
    await importFiles([picked('Solo.cbz', solo)]);
    await waitForQueue();
    queued.stop();
    expect([...queued.titles]).toEqual(['Solo']);
    expect(await rows()).toEqual([{ series: 'Solo', volume: 'Vol 1' }]);
    expect(get(reviewSession).pending).toHaveLength(1);
    skipAllRemaining();
  });

  it('skip and skip all remaining import nothing and queue nothing', async () => {
    const queued = recordQueue();
    await importFiles([...twoSeries(), picked('Dorohedoro/Dorohedoro 01/001.jpg')]);
    expect(get(reviewSession).pending).toHaveLength(3);
    decideCurrent({ action: 'skip' });
    skipAllRemaining();
    await waitForQueue();
    queued.stop();
    expect([...queued.titles]).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});

describe('reviewed when the queue reaches them', () => {
  it('an archive inside an archive is reviewed when the queue opens it', async () => {
    reviewer = installReviewer();
    const inner = new Uint8Array(await (await zipOf(['001.jpg'])).arrayBuffer());
    const outer = await zipOf([{ path: 'Vol 1 (2020).cbz', data: inner }]);
    await importFiles([picked('Outer Series (Digital).zip', outer)]);
    await waitForQueue();
    expect(reviewer.offered.map((g) => g.series)).toEqual(['Outer Series (Digital)']);
    expect(await rows()).toEqual([
      { series: 'Outer Series (Digital)', volume: 'Outer Series (Digital) 01' }
    ]);
  });

  it('an archive that cannot be read fails like any import error; the rest of the batch imports', async () => {
    reviewer = installReviewer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await importFiles([
      picked('Broken.cbz', new Blob([new Uint8Array([1, 2, 3, 4])])),
      picked('Dorohedoro v01.cbz', await zipOf(['001.jpg'])),
      picked('Dorohedoro v02.cbz', await zipOf(['001.jpg']))
    ]);
    await waitForQueue();
    expect(reviewer.offered.map((g) => g.series)).toEqual(['Dorohedoro']);
    expect((await rows()).map((r) => r.volume)).toEqual(['Dorohedoro 01', 'Dorohedoro 02']);
    expect(get(importQueue).map((i) => [i.displayTitle, i.status])).toEqual([['Broken', 'error']]);
    warn.mockRestore();
    error.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/import/__tests__/image-only-review-import.test.ts`
Expected: FAIL — the service still calls `promptImageOnly` (the mocked `$lib/util/modals` has no `promptImageOnlyImport` → `TypeError`), `reviewer.offered` stays empty.

- [ ] **Step 3: Add `ArchiveReview` to `types.ts`**

After the `PairedSource.importNames` field, replace its doc and add the new field:

```ts
  /**
   * The names an image-only volume is saved under, decided in the image-only
   * review (`nameGroup`, #285).
   */
  importNames?: ImportNames;
  /**
   * An archive whose image-only volumes were reviewed before it was queued
   * (#285). `processArchiveContents` takes their names from here and never
   * prompts. Its `.mokuro` volumes import regardless.
   */
  archiveReview?: ArchiveReview;
```

and below `PairedSource`:

```ts
export interface ArchiveReview {
  approved: true;
  /**
   * Approved names by the volume's path INSIDE the archive (`.` = its root),
   * as `planArchiveListing` reports it. An image-only volume not listed here
   * was skipped.
   */
  names: Map<string, ImportNames>;
}
```

Also change the `DecompressedVolume.importNames` doc to: `The names an image-only volume is saved under, decided in the image-only review (`nameGroup`, #285).`

- [ ] **Step 4: Rewire `import-service.ts`**

4a. Imports. Replace `import { cleanedSeriesTitles, importIdentities, planImageOnlyNames } from './image-only-naming';` with

```ts
import type { ImportNames } from './image-only-naming';
import {
  groupCandidates,
  nameGroup,
  type ReviewCandidate,
  type ReviewGroup
} from './image-only-review';
import { existingVolumeCount } from './library-series';
```

extend the Task 2 `archive-listing` import with `archiveSourceLabel, prescanArchives, type ArchiveScan, type ListedEntry`, add `ArchiveReview` to the `./types` type import, and remove `seriesVolumeUuids` from the `./database` import and the `generateDeterministicUUID` import (both were only used by `existingVolumeCounts`).

4b. Pending reviews count as unfinished work. Replace `hasUnfinishedImports` with:

```ts
/**
 * Image-only review groups offered but not decided yet (#285). An approval
 * still has volumes to save, so they keep a batch's `series.json` waiting.
 */
let pendingReviewGroups = 0;

/**
 * Is work still outstanding — queued, processing, or waiting in review?
 *
 * Deliberately NOT `queue.length === 0`: failed items stay in the store until
 * the user clears them, and a pinned `error` item must not stop later imports
 * from applying their `series.json` (the pending files would then sit in the
 * batch and risk being keyed to an unrelated import).
 */
function hasUnfinishedImports(): boolean {
  return (
    pendingReviewGroups > 0 ||
    get(importQueue).some((item) => item.status === 'queued' || item.status === 'processing')
  );
}
```

4c. `processArchiveContents`: add a fifth parameter and replace the prompt block. Signature:

```ts
async function processArchiveContents(
  archiveFile: File,
  externalMokuroFile: File | null,
  onProgress?: (status: string, progress: number) => void,
  archiveTitlePath?: string,
  review?: ArchiveReview
): Promise<{
```

Add to its doc comment: `@param review - Names approved in the pre-import review; without it, image-only volumes are reviewed here (nested archives, unlisted archives, deep links).` Replace

```ts
// If there are image-only pairings, prompt user for confirmation
let confirmedImageOnlyPairings: PairedSource[] = [];
if (imageOnlyPairings.length > 0) {
  const confirmed = await promptForImageOnlyImport(imageOnlyPairings);
  if (confirmed) {
    confirmedImageOnlyPairings = imageOnlyPairings;
  }
}
```

with

```ts
// Image-only volumes: named in the pre-import review when the archive was
// listed before it was queued; otherwise reviewed now (#285).
let confirmedImageOnlyPairings: PairedSource[] = [];
if (imageOnlyPairings.length > 0) {
  const approved = review
    ? namesFromReview(imageOnlyPairings, plan.innerPaths, review)
    : await reviewInQueue(imageOnlyPairings, archiveFile, plan.innerPaths);
  confirmedImageOnlyPairings = imageOnlyPairings.filter((pairing) => {
    pairing.importNames = approved.get(pairing.id);
    return pairing.importNames !== undefined;
  });
}
```

4d. `processSingleVolume`'s archive branch passes the review:

```ts
const result = await processArchiveContents(
  source.source.file,
  source.mokuroFile,
  onProgress,
  source.titlePath,
  source.archiveReview
);
```

4e. `processQueue`'s `finally`: replace

```ts
// The queue is drained: every volume of this batch has a stored title, so
// any `series.json` that came with it can finally be keyed to a series.
await applyImportedSeriesFiles();
```

with

```ts
// The queue is drained and no review step is still open: every volume of
// this batch has a stored title, so any `series.json` that came with it
// can finally be keyed to a series. (A series still in review has
// volumes to come; its approval runs the queue again.)
if (!hasUnfinishedImports()) await applyImportedSeriesFiles();
```

4f. `runImportFiles`: replace the span from the line `// Separate image-only pairings from mokuro pairings` down to and including the line `if (routing.directProcess) {` (it ends the old `// Decide routing` block) with:

```ts
    // Image-only folders are reviewed; archives are LISTED first (entry names
    // only, one at a time) so their image-only volumes join the same review
    // instead of stopping the queue archive by archive (#285).
    const imageOnlyFolders = pairingResult.pairings.filter((p) => p.imageOnly);
    const others = pairingResult.pairings.filter((p) => !p.imageOnly);
    incrementPoolUsers();
    let scans: Map<string, ArchiveScan>;
    try {
      scans = await prescanArchives(others, listArchiveNames);
    } finally {
      decrementPoolUsers();
    }

    const plain: PairedSource[] = [];
    const candidates: ReviewCandidate[] = [];
    const targets = new Map<string, ReviewTarget>();
    for (const pairing of imageOnlyFolders) {
      candidates.push({
        id: pairing.id,
        basePath: pairing.basePath,
        titlePath: pairing.titlePath,
        source: pairing.basePath
      });
      targets.set(pairing.id, { kind: 'folder', pairing });
    }
    for (const pairing of others) {
      const scan = scans.get(pairing.id);
      if (scan?.kind !== 'review' || pairing.source.type !== 'archive') {
        plain.push(pairing);
        continue;
      }
      const held: HeldArchive = {
        pairing,
        waiting: new Set(),
        names: new Map(),
        importsRegardless: scan.importsRegardless,
        settled: false
      };
      for (const inner of scan.inner) {
        const id = `${pairing.id}:${inner.innerPath}`;
        candidates.push({
          id,
          basePath: inner.basePath,
          titlePath: inner.titlePath,
          source: archiveSourceLabel(pairing.source.file, inner.innerPath)
        });
        targets.set(id, { kind: 'archive', held, innerPath: inner.innerPath });
        held.waiting.add(id);
      }
    }

    if (plain.length === 0 && candidates.length === 0) {
      getImportUiBridge().notify('No volumes to import');
      return result;
    }

    // Notify caller that preparation is complete
    options?.onPreparing?.(plain.length + candidates.length);

    // `.mokuro` volumes route as before — but a lone one is processed directly
    // only when nothing else is running or waiting in review: two imports at
    // once would hold two archives in memory (the queue is strictly sequential).
    const routing = decideImportRouting(plain);
    if (routing.directProcess && candidates.length === 0 && !hasUnfinishedImports()) {
```

The direct-processing body that follows (`// Single item - process directly` … its `finally { isImporting.set(false); currentImport.set(null); }`) stays exactly as it is. Then replace the old branch after it — `} else {` / `// Multiple items - queue all` … `result.imported = routing.queuedItems.length;` / `}` — with:

```ts
    } else if (plain.length > 0) {
      enqueueAtEnd(plain);
      processQueue();
      // The queue processes in the background.
      result.imported = plain.length;
    }

    // Image-only volumes: one review step per series. Each approval is queued
    // at once, so series 1 imports while series 2 is on screen.
    if (candidates.length > 0) await offerForReview(candidates, targets);
```

4g. Replace `promptForImageOnlyImport` and `existingVolumeCounts` (the two functions after `runImportFiles`) with:

```ts
/** What approving a review candidate queues. */
type ReviewTarget =
  | { kind: 'folder'; pairing: PairedSource }
  | { kind: 'archive'; held: HeldArchive; innerPath: string };

/** A pre-scanned archive waiting for the review of its image-only volumes. */
interface HeldArchive {
  pairing: PairedSource;
  /** Candidate ids not decided yet; the archive is queued once, after the last. */
  waiting: Set<string>;
  names: Map<string, ImportNames>;
  /** It also holds `.mokuro` volumes or archives: queued whatever the review decides. */
  importsRegardless: boolean;
  settled: boolean;
}

/** Entry names of an archive — central directory only, no entry bytes. */
async function listArchiveNames(file: File): Promise<ListedEntry[]> {
  return (await decompressArchiveRaw(file, undefined, undefined, true)).entries;
}

function enqueueAtEnd(sources: PairedSource[]): void {
  const items = sources.map(createLocalQueueItem);
  items.forEach(addToProgressTracker);
  importQueue.update((q) => [...q, ...items]);
}

/** Each group's count of volumes its series already has, outside the group (keys only). */
async function withExistingCounts(groups: ReviewGroup[]): Promise<ReviewGroup[]> {
  for (const group of groups) {
    group.existingCount = await existingVolumeCount(group.series, group.ownUuids);
  }
  return groups;
}

/**
 * Offer a batch's image-only volumes for review and queue each approved
 * group as soon as it is decided. Resolves once the groups are OFFERED — the
 * user reviews while earlier approvals import.
 */
async function offerForReview(
  candidates: ReviewCandidate[],
  targets: Map<string, ReviewTarget>
): Promise<void> {
  const groups = await withExistingCounts(groupCandidates(candidates));
  const undecided = new Set(groups.map((g) => g.id));
  pendingReviewGroups += groups.length;

  getImportUiBridge().reviewImageOnly(groups, (groupId, decision) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group || !undecided.delete(groupId)) return;
    pendingReviewGroups--;

    const names = decision.action === 'import' ? nameGroup(group, decision.naming) : undefined;
    const ready: PairedSource[] = [];
    for (const candidate of group.candidates) {
      const target = targets.get(candidate.id);
      const approved = names?.get(candidate.id);
      if (!target) continue;
      if (target.kind === 'folder') {
        if (approved) {
          target.pairing.importNames = approved;
          ready.push(target.pairing);
        }
        continue;
      }
      const { held } = target;
      held.waiting.delete(candidate.id);
      if (approved) held.names.set(target.innerPath, approved);
      if (held.waiting.size === 0 && !held.settled) {
        held.settled = true;
        if (held.names.size > 0 || held.importsRegardless) {
          held.pairing.archiveReview = { approved: true, names: held.names };
          ready.push(held.pairing);
        }
      }
    }

    if (ready.length > 0) {
      enqueueAtEnd(ready);
      processQueue();
    } else if (!hasUnfinishedImports()) {
      // Everything skipped and nothing running: settle the batch's series.json.
      void applyImportedSeriesFiles();
    }
  });
}

/** Approved names of an archive reviewed before it was queued, by pairing id. */
function namesFromReview(
  pairings: PairedSource[],
  innerPaths: Map<string, string>,
  review: ArchiveReview
): Map<string, ImportNames> {
  const names = new Map<string, ImportNames>();
  for (const pairing of pairings) {
    const approved = review.names.get(innerPaths.get(pairing.id) ?? pairing.basePath);
    if (approved) names.set(pairing.id, approved);
  }
  return names;
}

/**
 * Review an archive's image-only volumes from inside the queue — archives the
 * pre-scan could not see (nested in another archive, unlisted, deep links).
 * The queue waits for these groups' decisions, as it always waited here.
 */
async function reviewInQueue(
  pairings: PairedSource[],
  archiveFile: File,
  innerPaths: Map<string, string>
): Promise<Map<string, ImportNames>> {
  const candidates: ReviewCandidate[] = pairings.map((p) => ({
    id: p.id,
    basePath: p.basePath,
    titlePath: p.titlePath,
    source: archiveSourceLabel(archiveFile, innerPaths.get(p.id) ?? p.basePath)
  }));
  const groups = await withExistingCounts(groupCandidates(candidates));
  const approved = new Map<string, ImportNames>();
  const undecided = new Set(groups.map((g) => g.id));
  pendingReviewGroups += groups.length;
  await new Promise<void>((resolve) => {
    getImportUiBridge().reviewImageOnly(groups, (groupId, decision) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group || !undecided.delete(groupId)) return;
      pendingReviewGroups--;
      if (decision.action === 'import') {
        for (const [id, names] of nameGroup(group, decision.naming)) approved.set(id, names);
      }
      if (undecided.size === 0) resolve();
    });
  });
  return approved;
}
```

- [ ] **Step 5: Remove the old single-boolean prompt**

5a. `src/lib/import/image-only-naming.ts` — final content:

```ts
/**
 * Names for image-only volumes (#285): what a reviewed volume is saved under,
 * and where on disk it sits.
 *
 * The volume's uuid comes from its literal location (`identity`), not from
 * the names the review chose, so it is the same whatever the series field,
 * mode, start number or rename: re-importing a folder finds the volume
 * already there instead of adding a duplicate, and two batches that number
 * differently can never overwrite each other. `processVolume` saves exactly
 * these names (`DecompressedVolume.importNames`). Grouping and naming live in
 * `image-only-review.ts`.
 */

import { extractFolderTitlesFromPath } from '$lib/util/series-extraction';
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';
import type { PairedSource } from './types';

/** The names one image-only volume is saved under. */
export interface ImportNames {
  series: string;
  volume: string;
  /** Its literal location ("Series folder/Volume folder"), the uuid source. */
  identity: string;
}

/** Stored form of a title segment, as `saveVolume` writes it. */
export function storedTitle(title: string): string {
  return sanitizeTitleSegment(title) || 'Untitled';
}

/** Where a volume sits: its parent folder (if any), its own name, its uuid source. */
export function locateVolume(pairing: Pick<PairedSource, 'basePath' | 'titlePath'>) {
  const { seriesTitle, volumeTitle, hasParent } = extractFolderTitlesFromPath(
    pairing.titlePath ?? pairing.basePath
  );
  return {
    parent: hasParent ? seriesTitle : null,
    own: volumeTitle,
    identity: hasParent ? `${seriesTitle}/${volumeTitle}` : volumeTitle
  };
}
```

5b. `src/lib/import/import-ui.ts`: delete the `SeriesImportInfo` interface, `promptImageOnly` from the interface and from the default bridge, and drop `promptImageOnlyImport`, `ImageOnlyNaming`, `SeriesImportInfo as ModalSeriesImportInfo` from the `$lib/util/modals` imports (keep `promptMissingFiles`, `MissingFilesInfo`).

5c. `src/lib/util/modals.ts`: delete the block from `// Image-only import confirmation modal` through the end of `promptImageOnlyImport` (the `SeriesImportInfo`, `ImageOnlyNaming`, `ImageOnlyImportModal` types, `imageOnlyImportModalStore`, `promptImageOnlyImport`).

5d. `git rm src/lib/components/ImageOnlyImportModal.svelte src/lib/import/__tests__/image-only-naming.test.ts` (its cases live on in `image-only-review.test.ts`, Task 1).

5e. `src/routes/+layout.svelte`: remove the `ImageOnlyImportModal` import and the `<ImageOnlyImportModal />` line.

5f. Verify nothing still names the old prompt:

Run: `grep -rn "promptImageOnly\|imageOnlyImportModalStore\|planImageOnlyNames\|ImageOnlyImportModal\b\|cleanedSeriesTitles\|importIdentities" src`
Expected: matches only in the four test files updated in Step 6 (their `vi.mock('$lib/util/modals')` blocks).

- [ ] **Step 6: Update the existing tests to review through the stand-in**

6a. `src/lib/import/__tests__/keep-folder-names.test.ts`

- Header comment: replace `the image-only confirmation prompt` with `the image-only review`.
- Replace the whole block from `/** Every series list the image-only confirmation prompt was shown. */` through the end of its `vi.mock('$lib/util/modals', …)` with:

```ts
vi.mock('$lib/util/modals', () => ({
  promptMissingFiles: (_info: unknown, onContinue: () => void) => onContinue()
}));
```

- Add imports after `import { processVolume } from '../processing';`:

```ts
import { nameGroup } from '../image-only-review';
import { storedTitle } from '../image-only-naming';
import { dialogDefaults, installReviewer, type Reviewer } from './helpers/review-bridge';
```

- In `describe('importing image-only volumes')`: declare `let reviewer: Reviewer;`; in its `beforeEach` replace `promptedSeries.length = 0; promptedNaming.length = 0;` with `reviewer = installReviewer();`; change its `afterEach` to `afterEach(() => { reviewer.restore(); setKeepFolderNames(false); });`.
- Replace `describe('the prompt previews exactly the names the import saves', …)` with:

```ts
describe('the review offers exactly the names the import saves', () => {
  const files = () => [
    picked('Chained Soldier (Semi-Color)/01/page_0000.jpg'),
    picked('Chained Soldier (Semi-Color)/02/page_0000.jpg'),
    picked('Killing Bites/Killing Bites 01/001.webp')
  ];
  const sorted = (rows: { series: string; volume: string }[]) =>
    [...rows].sort((a, b) => a.volume.localeCompare(b.volume));

  for (const keep of [false, true]) {
    it(keep ? 'folder names' : 'cleaned up', async () => {
      setKeepFolderNames(keep);
      const rows = await importAndRead(files());
      const offered = reviewer.offered.flatMap((group) =>
        [...nameGroup(group, dialogDefaults(group)).values()].map((n) => ({
          series: storedTitle(n.series),
          volume: storedTitle(n.volume)
        }))
      );
      expect(sorted(offered)).toEqual(sorted(titles(rows)));
    });
  }
});
```

- Every `expect(promptedSeries).toEqual([['X']]);` becomes `expect(reviewer.offered.map((g) => g.series)).toEqual(['X']);` (four places: `My Series (2023) [Digital]` ×2, `Downloads`, `Series Pack [Digital]`).
- A loose volume's series is now the review's (extracted) series in both modes. Replace the test `'on: the archive name is both series and volume'` with:

```ts
it('on: a loose archive keeps its own name, under the series the review offered', async () => {
  setKeepFolderNames(true);
  const rows = await importAndRead([await archive()]);
  expect(titles(rows)).toEqual([{ series: 'Gleipnir', volume: 'Gleipnir v01 (2023) (Digital)' }]);
  expect(reviewer.offered.map((g) => g.series)).toEqual(['Gleipnir']);
});
```

and in `'on: a picked root-level folder names both series and volume'` rename it to `'on: a picked root-level folder keeps its own name under the extracted series'` with expectation `[{ series: 'Gleipnir', volume: 'Gleipnir v01 (2023) (Digital)' }]`.

6b. `src/lib/import/__tests__/integration.test.ts`

- Replace the modals mock (`// Mock modals - auto-confirm …` block) with:

```ts
// Mock modals - auto-continue with missing files (image-only volumes are
// reviewed through the bridge stand-in below)
vi.mock('$lib/util/modals', () => ({
  promptMissingFiles: vi.fn().mockImplementation((_info, onContinue, _onCancel) => {
    setTimeout(() => onContinue(), 0);
  })
}));
```

- After `import { showSnackbar } from '$lib/util/snackbar';` add:

```ts
import { installReviewer, type Reviewer } from './helpers/review-bridge';

// Every image-only review step is approved as the dialog shows it.
let reviewer: Reviewer;
beforeEach(() => {
  reviewer = installReviewer();
});
afterEach(() => reviewer.restore());
```

6c. `src/lib/import/__tests__/deep-link-import.test.ts` and `src/lib/import/__tests__/series-file-import.test.ts`: delete the `promptImageOnlyImport: …` line from each `vi.mock('$lib/util/modals', …)`; import `installReviewer` (and `type Reviewer`) from `./helpers/review-bridge`. In deep-link-import, declare `let reviewer: Reviewer;` above the top-level `beforeEach`, add `reviewer = installReviewer();` as its first line and `reviewer.restore();` as the first line of the top-level `afterEach`. In series-file-import, add file-level hooks right after the imports:

```ts
let reviewer: Reviewer;
beforeEach(() => {
  reviewer = installReviewer();
});
afterEach(() => reviewer.restore());
```

6d. Pin the `series.json` timing (Review Focus). In `series-file-import.test.ts` add `isImporting` to the `../import-service` import, `approveAsDialogWould` to the helper import, and append:

```ts
describe('a series.json beside an image-only series waits for its review', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetImportedSeriesFiles();
    await clearDb();
    importQueue.set([]);
    reviewer.restore();
    reviewer = installReviewer('manual');
  });

  afterEach(() => resetImportedSeriesFiles());

  async function waitForIdle(): Promise<void> {
    const start = Date.now();
    while (
      (get(isImporting) ||
        get(importQueue).some((i) => i.status === 'queued' || i.status === 'processing')) &&
      Date.now() - start < 10_000
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function pickedAt(path: string, bytes: BlobPart): File {
    const file = new File([bytes], path.split('/').pop()!, { lastModified: 1_700_000_000_000 });
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    return file;
  }

  it('is applied once the reviewed volumes are saved, not when the queue first drains', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sidecar = pickedAt(
      'Killing Bites/series.json',
      JSON.stringify(seriesFileFor('Killing Bites'))
    );
    const page = pickedAt('Killing Bites/Killing Bites 01/001.jpg', new Uint8Array([1, 2, 3]));
    // A .mokuro volume of another series in the same drop drains the queue first.
    const other = await buildVolumeArchive('Vol 1.cbz', mokuroText);

    await importFiles([sidecar, page, other]);
    await waitForIdle();
    expect(await db.volumes.count()).toBe(1);
    expect(await db.series_metadata.get('killing bites')).toBeUndefined();

    reviewer.pending[0].decide(approveAsDialogWould(reviewer.pending[0].group));
    await waitForIdle();
    await new Promise((r) => setTimeout(r, 50));
    expect((await db.series_metadata.get('killing bites'))?.external_ids).toEqual({
      anilist: 30013
    });
  });
});
```

(`get` comes from `svelte/store` — add `import { get } from 'svelte/store';` if the file does not import it yet.)

- [ ] **Step 7: Run everything touched**

Run: `npx vitest run src/lib/import src/lib/components/__tests__/ImageOnlyReviewStep.test.ts src/lib/components/__tests__/ImageOnlyReviewDialog.test.ts`
Expected: all PASS (the 302 baseline minus the deleted `image-only-naming.test.ts` cases, plus the new ones).

Run: `npm test 2>&1 | tail -5`
Expected: the whole suite passes.

Run: `npm run check 2>&1 | tail -1 && npm run lint 2>&1 | tail -5`
Expected: `svelte-check found 0 errors and 0 warnings`; lint clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/import/types.ts src/lib/import/import-service.ts src/lib/import/image-only-naming.ts src/lib/import/import-ui.ts src/lib/util/modals.ts src/routes/+layout.svelte src/lib/import/__tests__/image-only-review-import.test.ts src/lib/import/__tests__/keep-folder-names.test.ts src/lib/import/__tests__/integration.test.ts src/lib/import/__tests__/deep-link-import.test.ts src/lib/import/__tests__/series-file-import.test.ts
git commit -m "feat(import): review image-only volumes one series at a time; approvals queue at once (#285)

Archives are listed (names only, one at a time) before routing, so loose
.cbz batches become one review step instead of one prompt per archive inside
the queue. Approved series import while the next is on screen; nested,
unlisted and deep-linked archives are reviewed when the queue reaches them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`git rm` in Step 5d already staged the two deletions; check `git status --short` shows nothing else staged.)

---

### Task 7: Verification in real browsers, at phone width, and memory before/after

**Files:**

- Create: `e2e/image-only-review.spec.ts`
- Create: `e2e/import-memory.spec.ts` (opt-in: skipped unless `IMPORT_MEMORY=1`)

**Interfaces:**

- Consumes: the test ids from Task 5; `importFiles` (`/src/lib/import/index.ts`) and `db` (`/src/lib/catalog/db.ts`) through the Vite dev server, as `e2e/ocr-editor.spec.ts` does.

- [ ] **Step 1: Write the end-to-end spec**

Create `e2e/image-only-review.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * The image-only review (#285) in the real app: picked files, the review
 * dialog, the queue and IndexedDB. Uses the owner's layouts —
 * "Chained Soldier (Semi-Color)/01..", "Killing Bites/Killing Bites 01.." —
 * plus loose .cbz files, the way phones import.
 */

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

function put(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG);
}

/** Loose `.cbz` archives with one page at their root, like a phone's Downloads. */
function looseArchives(root: string, names: string[]): string[] {
  return names.map((name) => {
    const pages = mkdtempSync(join(root, 'pages-'));
    put(join(pages, '001.png'));
    const cbz = join(root, `${name}.cbz`);
    execFileSync('zip', ['-q', '-j', cbz, join(pages, '001.png')]);
    return cbz;
  });
}

const navButtons = (page: Page) => page.locator('div.flex.gap-5 > button');
const review = (page: Page) => page.locator('[data-testid="image-only-review"]');
const stepLabel = (page: Page) => review(page).locator('[data-testid="review-step"]');
const seriesField = (page: Page) => review(page).locator('[data-testid="review-series"]');
const names = (page: Page) => review(page).locator('[data-testid="review-volume-name"]');
const reviewButton = (page: Page, text: string) =>
  review(page).locator('button', { hasText: new RegExp(`^${text}$`) });
const nameValues = (page: Page) =>
  names(page).evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(navButtons(page).nth(2)).toBeVisible();
}

/** Pick through the real Import modal (nav icon → choose files/folder → Import). */
async function pick(
  page: Page,
  button: 'choose files' | 'choose folder',
  paths: string | string[]
) {
  await navButtons(page).nth(2).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('dialog button', { hasText: button }).click();
  await (await chooser).setFiles(paths);
  await page.locator('dialog button', { hasText: /^Import$/ }).click();
}

/** `importFiles` straight from the page — what a drop or a second pick calls. */
async function importInPage(page: Page, entries: { path: string; b64: string }[]) {
  await page.evaluate(async (items) => {
    const { importFiles } = await import('/src/lib/import/index.ts');
    const files = items.map(({ path, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], path.split('/').pop()!);
      if (path.includes('/')) Object.defineProperty(file, 'webkitRelativePath', { value: path });
      return file;
    });
    void importFiles(files);
  }, entries);
}

async function savedTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    return (await db.volumes.toArray())
      .filter((r) => !r.metadata_only)
      .map((r) => `${r.series_title} / ${r.volume_title}`)
      .sort();
  });
}

test('picked loose .cbz files are reviewed as one series and import', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'review-e2e-'));
  const cbz = looseArchives(root, ['Dorohedoro v01', 'Dorohedoro v02', 'Dorohedoro v03']);
  await openApp(page);
  await pick(page, 'choose files', cbz);

  await expect(stepLabel(page)).toHaveText('Series 1 of 1');
  await expect(seriesField(page)).toHaveValue('Dorohedoro');
  await expect
    .poll(() => nameValues(page))
    .toEqual(['Dorohedoro 01', 'Dorohedoro 02', 'Dorohedoro 03']);
  await expect(review(page).locator('[data-testid="review-volume-source"]')).toHaveText([
    'Dorohedoro v01.cbz',
    'Dorohedoro v02.cbz',
    'Dorohedoro v03.cbz'
  ]);
  await reviewButton(page, 'Import').click();
  await expect(review(page)).toBeHidden();
  await expect
    .poll(() => savedTitles(page), { timeout: 30_000 })
    .toEqual([
      'Dorohedoro / Dorohedoro 01',
      'Dorohedoro / Dorohedoro 02',
      'Dorohedoro / Dorohedoro 03'
    ]);
});

test("the owner's layouts: one step per series, and series 1 imports while series 2 is on screen", async ({
  page,
  browserName
}) => {
  test.skip(
    browserName !== 'chromium',
    'folder picking (webkitdirectory) is exercised in Chromium'
  );
  const root = mkdtempSync(join(tmpdir(), 'review-e2e-'));
  const library = join(root, 'library');
  for (const v of ['01', '02', '03'])
    put(join(library, 'Chained Soldier (Semi-Color)', v, '001.png'));
  for (const v of ['Killing Bites 01', 'Killing Bites 02'])
    put(join(library, 'Killing Bites', v, '001.png'));
  const loose = looseArchives(root, ['Dorohedoro v01', 'Dorohedoro v02']);

  await openApp(page);
  // The library already holds two Killing Bites volumes (removed from this device).
  await page.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    await db.volumes.bulkPut(
      [1, 2].map((n) => ({
        volume_uuid: `seed-kb-${n}`,
        series_uuid: 'seed-kb',
        series_title: 'Killing Bites',
        volume_title: `Killing Bites 0${n}`,
        mokuro_version: '',
        page_count: 1,
        character_count: 0,
        page_char_counts: [0],
        metadata_only: true as const
      }))
    );
  });

  await pick(page, 'choose folder', library);
  await expect(stepLabel(page)).toHaveText('Series 1 of 2');
  // A second import while the review is open joins it.
  await importInPage(
    page,
    loose.map((p) => ({ path: basename(p), b64: readFileSync(p).toString('base64') }))
  );
  await expect(stepLabel(page)).toHaveText('Series 1 of 3');

  // Series 1: rename one volume, try both modes, start at 5.
  await expect(seriesField(page)).toHaveValue('Chained Soldier (Semi-Color)');
  await expect
    .poll(() => nameValues(page))
    .toEqual([
      'Chained Soldier (Semi-Color) 01',
      'Chained Soldier (Semi-Color) 02',
      'Chained Soldier (Semi-Color) 03'
    ]);
  await names(page).nth(2).fill('Chained Soldier Extra');
  await reviewButton(page, 'Folder names').click();
  await expect.poll(() => nameValues(page)).toEqual(['01', '02', 'Chained Soldier Extra']);
  await reviewButton(page, 'Cleaned up').click();
  await review(page).locator('[data-testid="review-start"]').fill('5');
  await expect
    .poll(() => nameValues(page))
    .toEqual([
      'Chained Soldier (Semi-Color) 05',
      'Chained Soldier (Semi-Color) 06',
      'Chained Soldier Extra'
    ]);
  await reviewButton(page, 'Import').click();

  // Series 2 is on screen while series 1 imports.
  await expect(stepLabel(page)).toHaveText('Series 2 of 3');
  await expect
    .poll(() => savedTitles(page), { timeout: 30_000 })
    .toEqual([
      'Chained Soldier (Semi-Color) / Chained Soldier (Semi-Color) 05',
      'Chained Soldier (Semi-Color) / Chained Soldier (Semi-Color) 06',
      'Chained Soldier (Semi-Color) / Chained Soldier Extra'
    ]);
  await expect(stepLabel(page)).toHaveText('Series 2 of 3');

  // Series 2 continues after the volumes the library already has.
  await expect(seriesField(page)).toHaveValue('Killing Bites');
  await expect(review(page).locator('[data-testid="review-start"]')).toHaveValue('3');
  await expect.poll(() => nameValues(page)).toEqual(['Killing Bites 03', 'Killing Bites 04']);
  await expect(review(page).locator('datalist option[value="Killing Bites"]')).toHaveCount(1);
  await reviewButton(page, 'Import').click();

  // Series 3, the loose archives: skipped.
  await expect(stepLabel(page)).toHaveText('Series 3 of 3');
  await expect(seriesField(page)).toHaveValue('Dorohedoro');
  await reviewButton(page, 'Skip').click();
  await expect(review(page)).toBeHidden();

  await expect
    .poll(() => savedTitles(page), { timeout: 30_000 })
    .toEqual([
      'Chained Soldier (Semi-Color) / Chained Soldier (Semi-Color) 05',
      'Chained Soldier (Semi-Color) / Chained Soldier (Semi-Color) 06',
      'Chained Soldier (Semi-Color) / Chained Soldier Extra',
      'Killing Bites / Killing Bites 03',
      'Killing Bites / Killing Bites 04'
    ]);
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('one column, the list scrolls, the buttons stay on screen; closing skips everything', async ({
    page
  }, testInfo) => {
    await openApp(page);
    await importInPage(
      page,
      Array.from({ length: 30 }, (_, i) => ({
        path: `Long Series/${String(i + 1).padStart(2, '0')}/001.png`,
        b64: PNG_B64
      }))
    );
    await expect(stepLabel(page)).toHaveText('Series 1 of 1');

    const layout = () =>
      page.evaluate(() => {
        const dialog = document
          .querySelector('[data-testid="image-only-review"]')!
          .getBoundingClientRect();
        const list = document.querySelector('[data-testid="review-volumes"]') as HTMLElement;
        const importButton = [
          ...document.querySelectorAll('[data-testid="image-only-review"] button')
        ]
          .find((b) => b.textContent?.trim() === 'Import')!
          .getBoundingClientRect();
        return {
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          dialogLeft: dialog.left,
          dialogRight: dialog.right,
          width: window.innerWidth,
          height: window.innerHeight,
          listScrolls: list.scrollHeight > list.clientHeight,
          importBottom: importButton.bottom
        };
      });

    const before = await layout();
    await page.screenshot({ path: testInfo.outputPath('review-phone.png') });
    expect(before.pageOverflow).toBeLessThanOrEqual(0);
    expect(before.dialogLeft).toBeGreaterThanOrEqual(0);
    expect(before.dialogRight).toBeLessThanOrEqual(before.width);
    expect(before.listScrolls).toBe(true);
    expect(before.importBottom).toBeLessThanOrEqual(before.height);

    // Editing a name (where a phone raises its keyboard) keeps the buttons on screen.
    await names(page).nth(29).focus();
    const editing = await layout();
    expect(editing.importBottom).toBeLessThanOrEqual(editing.height);

    await review(page).locator('[data-testid="review-close"]').click();
    await expect(review(page)).toBeHidden();
    await page.waitForTimeout(500);
    expect(await savedTitles(page)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it in Chromium on a dedicated port**

Run: `E2E_PORT=5198 E2E_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome npx playwright test e2e/image-only-review.spec.ts --reporter=list`
Expected: `3 passed`. Open `test-results/*/review-phone.png` and look at it: one column, no clipped buttons. If a selector inside the Flowbite `<dialog>` misses, use CSS locators as above, never `getByRole` (it does not match inside these dialogs — `verify` skill note).

- [ ] **Step 3: Run it in WebKit**

WebKit was made runnable on this machine on 2026-10-02 without root: `npx playwright install webkit` hangs at extraction under Node 26, and the Ubuntu 24.04 fallback build needs `libicu74`, `libxml2.so.2`, `libflite1` and `libjxl.so.0.8`, which Arch does not ship. Check first:

Run: `ls ~/.cache/ms-playwright/webkit-2248/minibrowser-wpe/sys/lib/libicuuc.so.74 && node -e "require('playwright-core').webkit.launch().then(b=>{console.log('webkit ok');return b.close()})"`
Expected: the path, then `webkit ok`.

If it fails, rebuild it into the Playwright cache (no root needed; scratch dir `$S`):

```bash
S=$(mktemp -d) && cd "$S"
curl -sSLo webkit.zip https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2248/webkit-ubuntu-24.04.zip
rm -rf ~/.cache/ms-playwright/webkit-2248 && mkdir -p ~/.cache/ms-playwright/webkit-2248
unzip -q webkit.zip -d ~/.cache/ms-playwright/webkit-2248
curl -sSLO http://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu74_74.2-1ubuntu3.1_amd64.deb
curl -sSLO http://archive.ubuntu.com/ubuntu/pool/main/libx/libxml2/libxml2_2.9.14+dfsg-1.3ubuntu3_amd64.deb
curl -sSLO http://archive.ubuntu.com/ubuntu/pool/universe/f/flite/libflite1_2.2-6build3_amd64.deb
curl -sSLO https://archive.archlinux.org/packages/l/libjxl/libjxl-0.8.2-2-x86_64.pkg.tar.zst
for d in *.deb; do mkdir -p "x-$d" && (cd "x-$d" && bsdtar -xf "../$d" && bsdtar -xf data.tar.*); done
mkdir -p x-jxl && bsdtar -xf libjxl-0.8.2-2-x86_64.pkg.tar.zst -C x-jxl
mkdir -p libs && find . -path '*/usr/lib*' -name '*.so*' \( -type f -o -type l \) -exec cp -a {} libs/ \;
for b in minibrowser-wpe minibrowser-gtk; do cp -an libs/. ~/.cache/ms-playwright/webkit-2248/$b/sys/lib/; done
```

(The bundle's `MiniBrowser` wrapper overwrites `LD_LIBRARY_PATH` with its own `lib:sys/lib`, so the libraries must go INTO `sys/lib`.) If the playwright version in `node_modules` changed, use the build number `npx playwright install --dry-run webkit` prints instead of 2248.

Run: `E2E_PORT=5198 npx playwright test e2e/image-only-review.spec.ts --browser=webkit --reporter=list`
Expected: `2 passed, 1 skipped` (the folder-picker test is Chromium-only). This is API compatibility only — not iOS memory.

- [ ] **Step 4: Write the memory measurement**

Create `e2e/import-memory.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Peak memory while importing 20 picked image-only archives (#285): main-thread
 * JS heap (CDP Performance.getMetrics) and the summed RSS of this browser's
 * renderer processes, which hold the page AND its workers. Run on the base and
 * on the branch; the branch must not be higher. Opt-in: IMPORT_MEMORY=1.
 *
 * `performance.measureUserAgentSpecificMemory()` needs cross-origin isolation,
 * which the app does not have — the result records `crossOriginIsolated` to show it.
 */

const ARCHIVES = 20;
const PAGES = 30;

test.skip(!process.env.IMPORT_MEMORY, 'memory measurement: run with IMPORT_MEMORY=1');

function buildArchives(): string[] {
  const root = mkdtempSync(join(tmpdir(), 'import-memory-'));
  const pages = join(root, 'pages');
  mkdirSync(pages);
  for (let i = 1; i <= PAGES; i++) {
    execFileSync('magick', [
      '-size',
      '1200x1700',
      'plasma:fractal',
      '-quality',
      '92',
      join(pages, `${String(i).padStart(3, '0')}.jpg`)
    ]);
  }
  const files = readdirSync(pages).map((f) => join(pages, f));
  return Array.from({ length: ARCHIVES }, (_, i) => {
    const cbz = join(root, `Memtest v${String(i + 1).padStart(2, '0')}.cbz`);
    execFileSync('zip', ['-q', '-0', '-j', cbz, ...files]);
    return cbz;
  });
}

/** Summed RSS (bytes) of this test browser's renderer processes. */
function rendererRss(): number {
  const procs = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] }));
  const tree = new Set(
    procs
      .filter(
        (p) => p.args.includes('playwright_chromiumdev_profile') && !p.args.includes('--type=')
      )
      .map((p) => p.pid)
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (!tree.has(p.pid) && tree.has(p.ppid)) {
        tree.add(p.pid);
        grew = true;
      }
    }
  }
  return procs
    .filter((p) => tree.has(p.pid) && p.args.includes('--type=renderer'))
    .reduce((sum, p) => sum + p.rss * 1024, 0);
}

test('peak memory while importing 20 picked image-only archives', async ({
  page,
  context
}, testInfo) => {
  test.setTimeout(15 * 60_000);
  const archives = buildArchives();

  await page.goto('/');
  await page.locator('div.flex.gap-5 > button').nth(2).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('dialog button', { hasText: 'choose files' }).click();
  await (await chooser).setFiles(archives);

  const baseline = rendererRss();
  expect(baseline, 'found this browser’s renderer processes').toBeGreaterThan(0);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const samples: { t: number; heap: number; rss: number }[] = [];
  let sampling = true;
  const t0 = Date.now();
  const sampler = (async () => {
    while (sampling) {
      const { metrics } = await cdp.send('Performance.getMetrics');
      samples.push({
        t: Date.now() - t0,
        heap: metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0,
        rss: rendererRss()
      });
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  await page.locator('dialog button', { hasText: /^Import$/ }).click();
  // Approve image-only confirmations as they appear: the base's prompt per
  // archive ("Image-Only Import") or the branch's review.
  const approve = page
    .locator(
      'dialog:has-text("Image-Only Import") button, [data-testid="image-only-review"] button'
    )
    .filter({ hasText: /^Import$/ });
  const deadline = Date.now() + 12 * 60_000;
  let saved = 0;
  while (saved < ARCHIVES && Date.now() < deadline) {
    if (
      await approve
        .first()
        .isVisible()
        .catch(() => false)
    )
      await approve
        .first()
        .click()
        .catch(() => {});
    saved = await page.evaluate(async () =>
      (await import('/src/lib/catalog/db.ts')).db.volumes.count()
    );
    await page.waitForTimeout(200);
  }
  sampling = false;
  await sampler;
  expect(saved).toBe(ARCHIVES);

  const result = {
    label: process.env.IMPORT_MEMORY_LABEL ?? 'unlabelled',
    crossOriginIsolated: await page.evaluate(() => self.crossOriginIsolated),
    baselineRendererRssMB: +(baseline / 2 ** 20).toFixed(1),
    peakRendererRssMB: +(Math.max(...samples.map((s) => s.rss)) / 2 ** 20).toFixed(1),
    peakJsHeapMB: +(Math.max(...samples.map((s) => s.heap)) / 2 ** 20).toFixed(1),
    durationS: +((samples.at(-1)?.t ?? 0) / 1000).toFixed(1),
    samples: samples.length
  };
  writeFileSync(testInfo.outputPath('import-memory.json'), JSON.stringify(result, null, 2));
  console.log('[import-memory]', JSON.stringify(result));
});
```

- [ ] **Step 5: Measure the base (before)**

```bash
cd /home/nathan/Projects/mokuro-reader-worktrees
git -C feat/285-folder-name-titles worktree add --detach ../perf-base-285 8374e7ea
cp feat/285-folder-name-titles/e2e/import-memory.spec.ts perf-base-285/e2e/
cd perf-base-285 && npm ci
E2E_PORT=5197 IMPORT_MEMORY=1 IMPORT_MEMORY_LABEL=base \
  E2E_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome \
  npx playwright test e2e/import-memory.spec.ts --repeat-each=3 --workers=1 --reporter=list
```

Run nothing else browser-heavy meanwhile (the RSS sum is per browser tree, but CPU contention skews timing). Expected: `3 passed`, three `[import-memory]` lines.

- [ ] **Step 6: Measure the branch (after)**

```bash
cd /home/nathan/Projects/mokuro-reader-worktrees/feat/285-folder-name-titles
E2E_PORT=5198 IMPORT_MEMORY=1 IMPORT_MEMORY_LABEL=branch \
  E2E_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome \
  npx playwright test e2e/import-memory.spec.ts --repeat-each=3 --workers=1 --reporter=list
```

Expected: `3 passed`.

Summarise both sides:

```bash
for d in /home/nathan/Projects/mokuro-reader-worktrees/perf-base-285 /home/nathan/Projects/mokuro-reader-worktrees/feat/285-folder-name-titles; do
  node -e '
    const fs = require("fs"), path = require("path");
    const files = []; (function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p = path.join(d,e.name); e.isDirectory() ? walk(p) : e.name === "import-memory.json" && files.push(p); } })(process.argv[1] + "/test-results");
    const runs = files.map((f) => JSON.parse(fs.readFileSync(f)));
    const med = (k) => runs.map((r) => r[k]).sort((a,b)=>a-b)[Math.floor(runs.length/2)];
    console.log(runs[0]?.label, "runs", runs.length, "median peak renderer RSS MB", med("peakRendererRssMB"), "median peak JS heap MB", med("peakJsHeapMB"), "all", JSON.stringify(runs.map(r=>[r.peakRendererRssMB,r.peakJsHeapMB])));
  ' "$d"
done
```

Acceptance: branch median peak renderer RSS ≤ base median × 1.05 AND branch median peak JS heap ≤ base median × 1.05 (5% = run-to-run noise). If either exceeds it, STOP: do not tune numbers — find what the pre-scan retains (heap snapshot via CDP `HeapProfiler.takeHeapSnapshot` during the review) and fix it before going on. Record the table (both sides, all runs) for the PR description.

- [ ] **Step 7: Remove the base worktree**

```bash
git -C /home/nathan/Projects/mokuro-reader-worktrees/feat/285-folder-name-titles worktree remove --force ../perf-base-285
```

(It is a purpose-made detached worktree; nothing in it is kept.)

- [ ] **Step 8: Final full checks**

Run: `npm test 2>&1 | tail -4 && npm run check 2>&1 | tail -1 && npm run lint 2>&1 | tail -3`
Expected: all unit tests pass; `svelte-check found 0 errors and 0 warnings`; lint clean.

Run: `grep -rn "mokuro\.moe" src e2e docs/superpowers/plans/2026-10-02-image-only-import-review.md`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add e2e/image-only-review.spec.ts e2e/import-memory.spec.ts
git commit -m "test(import): image-only review end to end in Chromium and WebKit, phone width, memory (#285)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Hand off what cannot be verified here**

Report to the owner, with the memory table and the phone screenshot: the real-device check on Android and iOS is still needed before merge (spec §1) — pick 5+ loose `.cbz` from Files/Downloads, review, edit a name with the on-screen keyboard up (buttons must stay reachable), background the app mid-review on iOS and then approve (an expired file must end as a per-volume import error, not a hang).

---

## Self-Review

**Spec coverage.**
§1 pre-scan: names-only listing through `decompressArchiveRaw` list-only mode (Task 6 `listArchiveNames`), one at a time and strings only (Task 2 tests), failure → `unlisted` → queue path (Tasks 2, 6), nested archives in-queue (Task 6). Mobile constraints: memory measured before/after (Task 7 Steps 4–6); extraction/queue/pool untouched (only PASS 1's pairing moved, behaviour-tested by the unchanged suite); phone width (Task 5 layout, Task 7 phone test); read failure → error (Task 6); WebKit (Task 7 Step 3); owner device check (Task 7 Step 10).
§2 candidates and grouping: Task 1. §3 session (Task 3), autocomplete and counts (Task 4), dialog incl. "Series k of n", per-series mode saved on Import, start number recomputed unless edited, sticky renames, three buttons in `relative z-10`, close = skip all (Task 5). §4 `nameGroup`, identity stability, stored form (Task 1; the dialog shows `storedTitle`, Task 5). §5 approval → queue with `importNames` / `archiveReview` (`approved: true`), mixed archives, skipped archives not queued, `importFiles` resolves once offered, direct routing only for `.mokuro` (Task 6). §6 unchanged: cloud downloads untouched; deep links reach the in-queue review (Task 6, `deep-link-import.test.ts`). §7 testing: every listed case has a test (Tasks 1, 4, 5, 6, 7).

**Placeholder scan.** Searched for TBD/TODO/"similar to"/"handle edge cases": none. Edits to existing files quote the code they replace.

**Type consistency.** `ReviewCandidate`/`ReviewGroup`/`GroupNaming`/`NamingMode` (Task 1) are used unchanged in Tasks 3–6; `GroupDecision`/`OnGroupDecision` (Task 3) in Tasks 5–6; `ArchiveScan`/`ListedEntry`/`prescanArchives`/`archiveSourceLabel`/`planArchiveListing` (Task 2) in Task 6; `LibrarySeries`/`canonicalSeriesTitle` live in `image-only-review.ts` and `listLibrarySeries`/`existingVolumeCount` in `library-series.ts` (Task 4), imported from exactly there in Tasks 5–6; `ArchiveReview.names` is a `Map` everywhere (Task 6 types, `offerForReview`, `namesFromReview`).

**Review Focus.** Each of the five lines has its test in the owning task (Tasks 4, 5, 6 — named in the Review Focus section).
