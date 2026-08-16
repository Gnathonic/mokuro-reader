# Series Metadata — Plan B: Titles Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each series under the user's preferred title language (native / romaji / english / as-imported) plus its free-text tag, everywhere a series title is displayed, without touching the stored `series_title` (folder name, grouping key, route key, cloud path).

**Architecture:** A pure `resolveDisplayTitle()` turns `(series_title, SeriesMetadata, global preference)` into a display string. The catalog store computes it **once per recompute** by joining the volume list with the `seriesMetadataMap` liveQuery store and the synced `catalogSettings.preferredTitleLanguage` setting, and exposes `Series.displayTitle` / `Series.searchTerms`. Views that already hold a `series_title` (SeriesView, VolumeTextView) resolve it locally with the same helper. A new "Metadata & Tracking" settings accordion hosts the global preference; the per-series override lives in Plan A's `SeriesMetadataBar`.

**Tech Stack:** SvelteKit 5 (runes), Svelte stores + Dexie `liveQuery`, Flowbite Svelte (`Select`, `AccordionItem`, `Label`), Vitest (jsdom).

**Spec:** `docs/superpowers/specs/2026-08-16-series-metadata-linking-design.md` — sections "Display title overlay", "UI", "Data model" (`title_preference`, `tag`), "Testing".

**Depends on Plan A** (`docs/superpowers/plans/2026-08-16-series-metadata-a-link-embed-sync.md`) being merged: it provides `src/lib/metadata/types.ts` (`SeriesMetadata`, `DisplayTitleLanguage`), `src/lib/metadata/series-key.ts` (`normalizeSeriesKey`), `src/lib/metadata/store.ts` (`seriesMetadataMap`, `getSeriesMetadataForTitle`, `updateSeriesMetadata`), and `src/lib/components/Series/SeriesMetadataBar.svelte`.

## Global Constraints

- Work in worktree `/home/nathan/Projects/mokuro-reader-worktrees/feat/series-metadata` (branch `feat/series-metadata`). Never commit in the main checkout.
- **`series_title` is never derived from metadata.** Grouping (`deriveSeriesFromVolumes`), routing (`#/series/<series_title>`, `currentSeries`), cloud paths (`${series_title}/${volume_title}`), rename input, Anki `{series}` variable, Exstatic events (`fireExstaticEvent(... title: volume.series_title)`), `MergeSeriesView`, `ExtractionModal` filename preview all keep the raw title. Only _human-facing series labels_ change.
- `resolveDisplayTitle` semantics (spec): `pref = meta?.title_preference ?? globalPref`; `'imported'` → `seriesTitle`; otherwise `titles[pref]`, falling back `english → romaji → native → seriesTitle`; then `+ ' ' + tag` when `tag.trim()` is non-empty (single space, tag verbatim).
- Display titles are computed **once per catalog recompute** (in `deriveSeriesFromVolumes`), never in per-card `$derived` (CLAUDE.md "Svelte 5 Reactive Performance").
- Dynamic text that Migaku/Yomitan may mutate is wrapped in `{#key …}` when it changes in place (CLAUDE.md "Extension Compatibility & DOM Keying") — used for the SeriesView `<h3>`.
- Setting name is exactly `catalogSettings.preferredTitleLanguage: DisplayTitleLanguage`, default `'imported'`, synced with profiles.
- Tests: `npx vitest run <path>` (repo script `npm test` = `vitest` watch mode). Type-check: `npm run check`. Format: `npx prettier --write <files>` (lint-staged runs `prettier --check` on commit).
- Commit after every task with a conventional message; `git add` only the files listed in the task.

---

### Task 1: `preferredTitleLanguage` setting + migration

**Files:**

- Modify: `src/lib/settings/settings.ts:116-127` (`CatalogSettings` type), `:340-350` (`defaultSettings.catalogSettings`), `:471-474` (`migrateProfiles` catalogSettings merge)
- Test: `src/lib/settings/settings.test.ts`

**Interfaces:**

- Consumes: `DisplayTitleLanguage` from `src/lib/metadata/types.ts` (Plan A): `'imported' | 'native' | 'romaji' | 'english'`.
- Produces: `CatalogSettings.preferredTitleLanguage: DisplayTitleLanguage`; readable through the existing `catalogSettings` derived store (`src/lib/settings/settings.ts:597`) and writable through the existing `updateCatalogSetting('preferredTitleLanguage', value)`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/settings/settings.test.ts`:

```ts
describe('preferredTitleLanguage migration', () => {
  it('defaults a profile with no catalogSettings.preferredTitleLanguage to imported', () => {
    const out = migrateProfiles({ Test: { catalogSettings: { stackCount: 2 } } as any });
    expect(out.Test.catalogSettings.preferredTitleLanguage).toBe('imported');
    // Existing catalog values must survive the merge
    expect(out.Test.catalogSettings.stackCount).toBe(2);
  });

  it('preserves a valid preferredTitleLanguage', () => {
    const out = migrateProfiles({
      Test: { catalogSettings: { preferredTitleLanguage: 'romaji' } } as any
    });
    expect(out.Test.catalogSettings.preferredTitleLanguage).toBe('romaji');
  });

  it('coerces an unknown preferredTitleLanguage back to imported', () => {
    const out = migrateProfiles({
      Test: { catalogSettings: { preferredTitleLanguage: 'klingon' } } as any
    });
    expect(out.Test.catalogSettings.preferredTitleLanguage).toBe('imported');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/settings/settings.test.ts`
Expected: the first and third tests FAIL (`preferredTitleLanguage` is `undefined` / `'klingon'`), the second passes by accident of the spread — that is fine.

- [ ] **Step 3: Add the type, default and migration guard**

In `src/lib/settings/settings.ts`, add the type import near the other imports at the top of the file:

```ts
import type { DisplayTitleLanguage } from '$lib/metadata/types';
```

Extend the `CatalogSettings` type (line ~116):

```ts
export type CatalogSettings = {
  stackingPreset: CatalogStackingPreset;
  horizontalStep: number;
  verticalStep: number;
  stackCount: number;
  hideReadVolumes: boolean;
  centerHorizontal: boolean;
  centerVertical: boolean;
  compactCloudSeries: boolean;
  dropShadow: boolean;
  /** Which series title to display in the catalog/series pages. Folder name is untouched. */
  preferredTitleLanguage: DisplayTitleLanguage;
};
```

Extend `defaultSettings.catalogSettings` (line ~340):

```ts
  catalogSettings: {
    stackingPreset: 'default',
    horizontalStep: 11,
    verticalStep: 5,
    stackCount: 3,
    hideReadVolumes: true,
    centerHorizontal: true,
    centerVertical: false,
    compactCloudSeries: false,
    dropShadow: true,
    preferredTitleLanguage: 'imported'
  }
```

In `migrateProfiles`, right after the existing `migratedProfile.catalogSettings = { ...defaultSettings.catalogSettings, ...(profile.catalogSettings || {}) };` block (line ~471), add:

```ts
// Validate preferredTitleLanguage (added 2026-08 with series metadata linking)
const validTitleLanguages: DisplayTitleLanguage[] = ['imported', 'native', 'romaji', 'english'];
if (
  !validTitleLanguages.includes(
    migratedProfile.catalogSettings.preferredTitleLanguage as DisplayTitleLanguage
  )
) {
  migratedProfile.catalogSettings.preferredTitleLanguage = 'imported';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/settings/settings.test.ts`
Expected: all PASS.

- [ ] **Step 5: Type-check and commit**

Run: `npm run check` — expected: 0 errors (the `presets` record in `CatalogSettings.svelte` is typed with its own inline shape, so it does not need the new key).

```bash
git add src/lib/settings/settings.ts src/lib/settings/settings.test.ts
git commit -m "feat(settings): add catalogSettings.preferredTitleLanguage with migration"
```

---

### Task 2: `resolveDisplayTitle` + `seriesSearchTerms`

**Files:**

- Create: `src/lib/metadata/display-title.ts`
- Test: `src/lib/metadata/display-title.test.ts`

**Interfaces:**

- Consumes: `SeriesMetadata`, `DisplayTitleLanguage` from `src/lib/metadata/types.ts` (Plan A).
- Produces:
  - `resolveDisplayTitle(seriesTitle: string, meta: SeriesMetadata | undefined, globalPref: DisplayTitleLanguage): string`
  - `seriesSearchTerms(seriesTitle: string, meta: SeriesMetadata | undefined): string[]` — lowercased, trimmed, de-duplicated, non-empty terms: the folder title, every language title, every synonym, the tag.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/metadata/display-title.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { SeriesMetadata } from './types';
import { resolveDisplayTitle, seriesSearchTerms } from './display-title';

function meta(overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return {
    series_key: 'one piece',
    series_title: 'One Piece',
    external_ids: { anilist: 30013, mal: 13 },
    titles: { native: 'ONE PIECE', romaji: 'ONE PIECE (romaji)', english: 'One Piece (en)' },
    synonyms: ['ワンピース', 'OP'],
    read_count: 0,
    updated_at: '2026-08-16T00:00:00.000Z',
    ...overrides
  };
}

describe('resolveDisplayTitle', () => {
  it('returns the folder title when there is no metadata', () => {
    expect(resolveDisplayTitle('One Piece', undefined, 'english')).toBe('One Piece');
  });

  it("returns the folder title for the 'imported' preference even when titles exist", () => {
    expect(resolveDisplayTitle('One Piece', meta(), 'imported')).toBe('One Piece');
  });

  it('returns the requested language when present', () => {
    expect(resolveDisplayTitle('One Piece', meta(), 'native')).toBe('ONE PIECE');
    expect(resolveDisplayTitle('One Piece', meta(), 'romaji')).toBe('ONE PIECE (romaji)');
    expect(resolveDisplayTitle('One Piece', meta(), 'english')).toBe('One Piece (en)');
  });

  it('per-series title_preference overrides the global preference', () => {
    const m = meta({ title_preference: 'native' });
    expect(resolveDisplayTitle('One Piece', m, 'english')).toBe('ONE PIECE');
  });

  it("per-series 'imported' override beats a global language preference", () => {
    const m = meta({ title_preference: 'imported' });
    expect(resolveDisplayTitle('One Piece', m, 'english')).toBe('One Piece');
  });

  it('falls back english → romaji → native → folder title when the requested language is missing', () => {
    // english missing → romaji
    expect(
      resolveDisplayTitle('folder', meta({ titles: { romaji: 'R', native: 'N' } }), 'english')
    ).toBe('R');
    // native requested & missing → english first
    expect(
      resolveDisplayTitle('folder', meta({ titles: { romaji: 'R', english: 'E' } }), 'native')
    ).toBe('E');
    // romaji requested & missing, english missing → native
    expect(resolveDisplayTitle('folder', meta({ titles: { native: 'N' } }), 'romaji')).toBe('N');
    // nothing at all → folder title
    expect(resolveDisplayTitle('folder', meta({ titles: {} }), 'romaji')).toBe('folder');
  });

  it('treats blank language titles as missing', () => {
    expect(
      resolveDisplayTitle('folder', meta({ titles: { english: '   ', romaji: 'R' } }), 'english')
    ).toBe('R');
  });

  it('appends the tag with a single space, verbatim', () => {
    expect(resolveDisplayTitle('One Piece', meta({ tag: '[color]' }), 'imported')).toBe(
      'One Piece [color]'
    );
    expect(resolveDisplayTitle('One Piece', meta({ tag: '[color]' }), 'english')).toBe(
      'One Piece (en) [color]'
    );
  });

  it('ignores an empty or whitespace-only tag', () => {
    expect(resolveDisplayTitle('One Piece', meta({ tag: '' }), 'imported')).toBe('One Piece');
    expect(resolveDisplayTitle('One Piece', meta({ tag: '   ' }), 'imported')).toBe('One Piece');
  });

  it('trims surrounding whitespace from the tag but keeps inner spacing', () => {
    expect(resolveDisplayTitle('One Piece', meta({ tag: '  bw scans ' }), 'imported')).toBe(
      'One Piece bw scans'
    );
  });
});

describe('seriesSearchTerms', () => {
  it('returns just the lowercased folder title without metadata', () => {
    expect(seriesSearchTerms('One Piece', undefined)).toEqual(['one piece']);
  });

  it('includes folder title, all language titles, synonyms and tag, lowercased and de-duplicated', () => {
    const terms = seriesSearchTerms('One Piece', meta({ tag: '[Color]' }));
    expect(new Set(terms)).toEqual(
      new Set(['one piece', 'one piece (romaji)', 'one piece (en)', 'ワンピース', 'op', '[color]'])
    );
    // 'ONE PIECE' (native) lowercases to 'one piece' and must not appear twice
    expect(terms.filter((t) => t === 'one piece')).toHaveLength(1);
  });

  it('drops blank entries', () => {
    const terms = seriesSearchTerms(
      '  ',
      meta({ titles: { english: ' ' }, synonyms: ['', 'x'], tag: ' ' })
    );
    expect(terms).toEqual(['x']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/metadata/display-title.test.ts`
Expected: FAIL — `Cannot find module './display-title'`.

- [ ] **Step 3: Implement**

Create `src/lib/metadata/display-title.ts`:

```ts
import type { DisplayTitleLanguage, SeriesMetadata, SeriesTitles } from './types';

/** Fallback order when the requested language is missing (spec: english → romaji → native → folder). */
const FALLBACK_ORDER: Array<keyof SeriesTitles> = ['english', 'romaji', 'native'];

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the human-facing title for a series.
 *
 * Never changes the stored `series_title` (folder name / grouping key / route key):
 * this is a pure presentation overlay.
 *
 *   pref = meta.title_preference ?? globalPref
 *   'imported'  → seriesTitle
 *   otherwise   → titles[pref], falling back english → romaji → native → seriesTitle
 *   then        → + ' ' + tag   (when tag is non-blank)
 */
export function resolveDisplayTitle(
  seriesTitle: string,
  meta: SeriesMetadata | undefined,
  globalPref: DisplayTitleLanguage
): string {
  const pref: DisplayTitleLanguage = meta?.title_preference ?? globalPref;

  let base = seriesTitle;
  if (pref !== 'imported' && meta) {
    const requested = nonBlank(meta.titles?.[pref]);
    if (requested) {
      base = requested;
    } else {
      for (const lang of FALLBACK_ORDER) {
        const candidate = nonBlank(meta.titles?.[lang]);
        if (candidate) {
          base = candidate;
          break;
        }
      }
    }
  }

  const tag = nonBlank(meta?.tag);
  return tag ? `${base} ${tag}` : base;
}

/**
 * Lowercased, trimmed, de-duplicated search terms for a series: the folder title,
 * every language title, every synonym and the tag. Used by the catalog search box.
 */
export function seriesSearchTerms(seriesTitle: string, meta: SeriesMetadata | undefined): string[] {
  const raw: Array<string | undefined> = [
    seriesTitle,
    meta?.titles?.native,
    meta?.titles?.romaji,
    meta?.titles?.english,
    ...(meta?.synonyms ?? []),
    meta?.tag
  ];

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of raw) {
    const term = nonBlank(value)?.toLowerCase();
    if (term && !seen.has(term)) {
      seen.add(term);
      terms.push(term);
    }
  }
  return terms;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/metadata/display-title.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/lib/metadata/display-title.ts src/lib/metadata/display-title.test.ts
git add src/lib/metadata/display-title.ts src/lib/metadata/display-title.test.ts
git commit -m "feat(metadata): resolveDisplayTitle + seriesSearchTerms"
```

---

### Task 3: `Series.displayTitle` / `Series.searchTerms` in `deriveSeriesFromVolumes`

**Files:**

- Modify: `src/lib/catalog/catalog.ts` (whole file, 46 lines)
- Test: `src/lib/catalog/catalog.test.ts` (new)

**Interfaces:**

- Consumes: `normalizeSeriesKey` (`src/lib/metadata/series-key.ts`, Plan A — Plan A already replaced the private `normalizeSeriesTitle` here with it; if that edit is not present, do it in this task), `resolveDisplayTitle`, `seriesSearchTerms` (Task 2), `SeriesMetadata`, `DisplayTitleLanguage`.
- Produces:

  ```ts
  export interface Series {
    title: string; // raw series_title — grouping/route/cloud identity (unchanged)
    displayTitle: string; // NEW — resolveDisplayTitle(...)
    searchTerms: string[]; // NEW — lowercased terms incl. displayTitle
    series_uuid: string;
    volumes: VolumeMetadata[];
  }
  export function deriveSeriesFromVolumes(
    volumeEntries: VolumeMetadata[],
    metaMap?: Map<string, SeriesMetadata>, // keyed by series_key
    pref: DisplayTitleLanguage = 'imported'
  ): Series[];
  ```

  Series are sorted by `displayTitle` (base-insensitive `localeCompare`).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/catalog/catalog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata } from '$lib/metadata/types';
import { deriveSeriesFromVolumes } from './catalog';

function vol(series: string, volume: string): VolumeMetadata {
  return {
    mokuro_version: '0.4.11',
    series_title: series,
    series_uuid: `uuid-${series}`,
    volume_title: volume,
    volume_uuid: `${series}-${volume}`,
    page_count: 10,
    character_count: 100,
    page_char_counts: [10, 20]
  };
}

function meta(seriesTitle: string, overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return {
    series_key: seriesTitle.trim().replace(/\s+/g, ' ').toLowerCase(),
    series_title: seriesTitle,
    external_ids: {},
    titles: {},
    synonyms: [],
    read_count: 0,
    updated_at: '2026-08-16T00:00:00.000Z',
    ...overrides
  };
}

describe('deriveSeriesFromVolumes', () => {
  it('groups by normalized series_title and keeps title = raw folder title', () => {
    const series = deriveSeriesFromVolumes([vol('One Piece', '1'), vol('one  piece', '2')]);
    expect(series).toHaveLength(1);
    expect(series[0].title).toBe('One Piece'); // first-seen raw title
    expect(series[0].volumes.map((v) => v.volume_title)).toEqual(['1', '2']);
  });

  it('displayTitle defaults to the raw title without metadata / imported preference', () => {
    const [s] = deriveSeriesFromVolumes([vol('One Piece', '1')]);
    expect(s.displayTitle).toBe('One Piece');
    expect(s.searchTerms).toEqual(['one piece']);
  });

  it('applies metadata + global preference to displayTitle and searchTerms', () => {
    const metaMap = new Map<string, SeriesMetadata>([
      [
        'one piece',
        meta('One Piece', {
          titles: { english: 'One Piece (en)', native: 'ONE PIECE' },
          synonyms: ['ワンピース'],
          tag: '[color]'
        })
      ]
    ]);
    const [s] = deriveSeriesFromVolumes([vol('One Piece', '1')], metaMap, 'english');
    expect(s.title).toBe('One Piece'); // identity untouched
    expect(s.displayTitle).toBe('One Piece (en) [color]');
    expect(s.searchTerms).toContain('ワンピース');
    expect(s.searchTerms).toContain('one piece (en) [color]');
  });

  it('per-series title_preference wins over the global preference', () => {
    const metaMap = new Map<string, SeriesMetadata>([
      [
        'one piece',
        meta('One Piece', { titles: { english: 'E', native: 'N' }, title_preference: 'native' })
      ]
    ]);
    const [s] = deriveSeriesFromVolumes([vol('One Piece', '1')], metaMap, 'english');
    expect(s.displayTitle).toBe('N');
  });

  it('sorts series by displayTitle', () => {
    const metaMap = new Map<string, SeriesMetadata>([
      ['zzz', meta('zzz', { titles: { english: 'Aardvark' } })]
    ]);
    const series = deriveSeriesFromVolumes(
      [vol('Middle', '1'), vol('zzz', '1')],
      metaMap,
      'english'
    );
    expect(series.map((s) => s.displayTitle)).toEqual(['Aardvark', 'Middle']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/catalog/catalog.test.ts`
Expected: FAIL — `displayTitle` is `undefined` (and the sort test fails).

- [ ] **Step 3: Rewrite `src/lib/catalog/catalog.ts`**

```ts
import type { VolumeMetadata } from '$lib/types';
import type { DisplayTitleLanguage, SeriesMetadata } from '$lib/metadata/types';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { resolveDisplayTitle, seriesSearchTerms } from '$lib/metadata/display-title';
import { sortVolumes } from './sort-volumes';

export interface Series {
  /** Raw `series_title` — grouping key, route key and cloud folder name. Never derived. */
  title: string;
  /** Human-facing title: preferred-language title (or folder title) + tag. */
  displayTitle: string;
  /** Lowercased search terms: folder title, language titles, synonyms, tag, displayTitle. */
  searchTerms: string[];
  series_uuid: string;
  volumes: VolumeMetadata[];
}

function sortByDisplayTitle(a: Series, b: Series) {
  return a.displayTitle.localeCompare(b.displayTitle, undefined, { sensitivity: 'base' });
}

/**
 * Group volumes into series (by normalized folder title) and attach display
 * titles. Display titles are computed HERE, once per recompute — never in
 * per-card `$derived` (see CLAUDE.md "Svelte 5 Reactive Performance").
 */
export function deriveSeriesFromVolumes(
  volumeEntries: Array<VolumeMetadata>,
  metaMap?: Map<string, SeriesMetadata>,
  pref: DisplayTitleLanguage = 'imported'
): Series[] {
  // Group volumes by normalized series title (user-visible identity)
  const titleMap = new Map<string, Series>();

  for (const entry of volumeEntries) {
    const key = normalizeSeriesKey(entry.series_title);
    let series = titleMap.get(key);
    if (series === undefined) {
      const meta = metaMap?.get(key);
      const displayTitle = resolveDisplayTitle(entry.series_title, meta, pref);
      const searchTerms = seriesSearchTerms(entry.series_title, meta);
      const displayLower = displayTitle.toLowerCase();
      if (!searchTerms.includes(displayLower)) searchTerms.push(displayLower);

      series = {
        title: entry.series_title,
        displayTitle,
        searchTerms,
        series_uuid: entry.series_uuid,
        volumes: []
      };
      titleMap.set(key, series);
    }
    series.volumes.push(entry);
  }

  // Convert map to array and sort everything
  const titles = Array.from(titleMap.values());

  // Sort series by display title, and volumes within each series
  titles.sort(sortByDisplayTitle);
  for (const series of titles) {
    series.volumes.sort(sortVolumes);
  }

  return titles;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/catalog/catalog.test.ts`
Expected: all PASS.

- [ ] **Step 5: Type-check the callers**

Run: `npm run check`. Expected: 0 errors — the only callers are `src/lib/catalog/index.ts` (default args) and any test; `Series` consumers (`Catalog.svelte`, `VolumeEditorModal.svelte` via `getAllSeriesOptions` — that one uses its own type, verify with grep `deriveSeriesFromVolumes`).

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/lib/catalog/catalog.ts src/lib/catalog/catalog.test.ts
git add src/lib/catalog/catalog.ts src/lib/catalog/catalog.test.ts
git commit -m "feat(catalog): compute series displayTitle/searchTerms once per recompute"
```

---

### Task 4: Join metadata + preference into the `catalog` store

**Files:**

- Modify: `src/lib/catalog/index.ts:99-106` (`catalog` derived store)

**Interfaces:**

- Consumes: `seriesMetadataMap: Readable<Map<string, SeriesMetadata>>` from `src/lib/metadata/store.ts` (Plan A; emits an empty `Map` before load), `catalogSettings` derived store from `src/lib/settings/settings.ts:597`.
- Produces: `catalog` now re-derives when metadata or the preference changes; `currentSeries` keeps matching on raw `s.title` (unchanged).

- [ ] **Step 1: Edit the store**

In `src/lib/catalog/index.ts`, add imports:

```ts
import { seriesMetadataMap } from '$lib/metadata/store';
import { catalogSettings } from '$lib/settings/settings';
```

Replace the `catalog` derived store:

```ts
// Each derived store needs to be passed as an array if using multiple inputs.
// Display titles are resolved here (once per recompute) from series metadata +
// the synced preferredTitleLanguage setting; grouping/routing still use series_title.
export const catalog = derived(
  [volumesWithPlaceholders, seriesMetadataMap, catalogSettings],
  ([$volumesWithPlaceholders, $seriesMetadataMap, $catalogSettings]) => {
    // Return null while loading (before first data emission)
    if ($volumesWithPlaceholders === undefined) {
      return null;
    }
    return deriveSeriesFromVolumes(
      Object.values($volumesWithPlaceholders),
      $seriesMetadataMap,
      $catalogSettings?.preferredTitleLanguage ?? 'imported'
    );
  }
);
```

`currentSeries` (lines ~108-121) is left exactly as is — it matches `$routeParams.manga` against `s.title` (raw folder title).

- [ ] **Step 2: Verify no import cycle and types**

Run: `grep -rn "from '\$lib/catalog'" src/lib/settings/ src/lib/metadata/store.ts` — expected: no output from `src/lib/settings/` (settings must not import the catalog index, or the derived store would cycle). `store.ts` imports `db` from `$lib/catalog/db` only, which is fine.
Run: `npm run check` — expected: 0 errors.

- [ ] **Step 3: Smoke-run the app**

Run: `npm run dev -- --port 5180` and open `http://localhost:5180/#/catalog` in a browser (or use the `verify` skill). Expected: catalog renders exactly as before (preference defaults to `imported`, no metadata yet → `displayTitle === title`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/catalog/index.ts
git commit -m "feat(catalog): derive display titles from series metadata + preference"
```

---

### Task 5: Catalog grid/list — display title, sort, search

**Files:**

- Modify: `src/lib/components/Catalog.svelte:164-218` (sort/filter), `:326-336` and `:359-369` (each blocks)
- Modify: `src/lib/components/CatalogItem.svelte:16-21` (props), `:720-722` (title text)
- Modify: `src/lib/components/CatalogListItem.svelte:12-17` (props), `:105` (title text)

**Interfaces:**

- Consumes: `Series.displayTitle`, `Series.searchTerms` (Task 3).
- Produces: `CatalogItem` and `CatalogListItem` gain an optional prop `displayTitle?: string` (defaults to `volume.series_title`).

- [ ] **Step 1: Sort and search by display title in `Catalog.svelte`**

In the `sortedCatalog` `$derived.by` (line ~164) replace the three `a.title.localeCompare(b.title, …)` / `b.title.localeCompare(a.title, …)` comparisons and the search filter:

```ts
const query = search.trim().toLowerCase();

return [...$catalog]
  .sort((a, b) => {
    if ($miscSettings.gallerySorting === 'ASC') {
      return a.displayTitle.localeCompare(b.displayTitle, undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    } else if ($miscSettings.gallerySorting === 'DESC') {
      return b.displayTitle.localeCompare(a.displayTitle, undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    } else {
      // SMART sorting
      // … (existing completion / lastUpdated logic unchanged) …

      // If all else is equal, use natural sorting on display title
      return a.displayTitle.localeCompare(b.displayTitle, undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    }
  })
  .filter((item) => {
    if (!query) return true;
    // Matches folder title, AniList titles, synonyms, tag and the display title
    return item.searchTerms.some((term) => term.includes(query));
  });
```

(Keep the SMART branch body identical apart from the final `localeCompare` line — only the property changes from `title` to `displayTitle`.)

- [ ] **Step 2: Pass `displayTitle` to the cards**

Update the four `{#each}` blocks (local grid, local list, placeholder grid, placeholder list). Each currently reads:

```svelte
{#each localSeries as { title, volumes } (title)}
  <CatalogItem {volumes} providerName={providerDisplayName} />
{/each}
```

Change every one to destructure and pass `displayTitle` (keying stays on the raw `title` — stable identity):

```svelte
{#each localSeries as { title, displayTitle, volumes } (title)}
  <CatalogItem {volumes} {displayTitle} providerName={providerDisplayName} />
{/each}
```

and likewise `<CatalogListItem {volumes} {displayTitle} providerName={providerDisplayName} />` for the two list blocks, and the two `placeholderSeries` blocks.

- [ ] **Step 3: Accept and render the prop in `CatalogItem.svelte`**

Props block (line ~16):

```ts
interface Props {
  volumes: VolumeMetadata[]; // Pre-computed by parent - avoids O(N) re-filtering
  providerName?: string; // Shared across all items - avoids repeated lookups
  displayTitle?: string; // Pre-resolved by the catalog store; falls back to series_title
}

let { volumes, providerName = 'Cloud', displayTitle }: Props = $props();
```

Title text (line ~720):

```svelte
<p class="line-clamp-2 font-semibold" style="width: {containerDimensions.outerWidth}px;">
  {displayTitle ?? volume.series_title}
</p>
```

`navId` (line ~580) stays `volume?.series_title` — routes use the raw title.

- [ ] **Step 4: Same in `CatalogListItem.svelte`**

Props (line ~12):

```ts
interface Props {
  volumes: VolumeMetadata[]; // Pre-computed by parent - avoids O(N) re-filtering
  providerName?: string; // Shared across all items - avoids repeated lookups
  displayTitle?: string; // Pre-resolved by the catalog store; falls back to series_title
}

let { volumes, providerName = 'Cloud', displayTitle }: Props = $props();
```

Title text (line ~105):

```svelte
<p class:text-green-400={isComplete} class="font-semibold">
  {displayTitle ?? volume.series_title}
</p>
```

- [ ] **Step 5: Verify**

Run: `npm run check` — expected: 0 errors.
Run: `npx vitest run src/lib/components` — expected: existing component tests still pass.
Manual (dev server / `verify` skill): with a linked series (Plan A modal) and Settings → Metadata & Tracking → "English" (Task 8, or temporarily set via `updateCatalogSetting('preferredTitleLanguage','english')` in the console), the card shows the English title + tag; typing a synonym or the tag in the search box finds the series; ASC/DESC sort orders by the displayed name; clicking the card still opens `#/series/<folder title>`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/lib/components/Catalog.svelte src/lib/components/CatalogItem.svelte src/lib/components/CatalogListItem.svelte
git add src/lib/components/Catalog.svelte src/lib/components/CatalogItem.svelte src/lib/components/CatalogListItem.svelte
git commit -m "feat(catalog): show display titles; search matches alt titles, synonyms and tag"
```

---

### Task 6: SeriesView header + document title, VolumeTextView subtitle

**Files:**

- Modify: `src/lib/views/SeriesView.svelte` — imports (top of `<script>`), a new derived near `manga`/`placeholders` (line ~207), `<svelte:head><title>` (line ~729), `<h3>` (line ~776), placeholder `<h3>` (line ~954)
- Modify: `src/lib/views/VolumeTextView.svelte:174-176`

**Interfaces:**

- Consumes: `resolveDisplayTitle` (Task 2), `seriesMetadataMap` (Plan A store), `normalizeSeriesKey` (Plan A), `catalogSettings` (settings).
- Produces: nothing new; the rename input (`renameValue = manga[0].series_title`, line ~630) and every cloud/rename/delete call keep using the raw title.

- [ ] **Step 1: SeriesView — resolve once**

Add imports in `SeriesView.svelte` `<script>`:

```ts
import { catalogSettings } from '$lib/settings/settings';
import { seriesMetadataMap } from '$lib/metadata/store';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { resolveDisplayTitle } from '$lib/metadata/display-title';
```

After `let placeholders = $derived(...)` (line ~208) add:

```ts
// Raw folder title (identity) and its human-facing overlay. The overlay is
// presentation only: rename/cloud/delete flows below keep using seriesTitle.
let seriesTitle = $derived(manga[0]?.series_title || placeholders[0]?.series_title || '');
let seriesDisplayTitle = $derived(
  seriesTitle
    ? resolveDisplayTitle(
        seriesTitle,
        $seriesMetadataMap.get(normalizeSeriesKey(seriesTitle)),
        $catalogSettings?.preferredTitleLanguage ?? 'imported'
      )
    : ''
);
```

- [ ] **Step 2: Use it in the three display sites**

`<svelte:head>` (line ~729):

```svelte
<svelte:head>
  <title>{seriesDisplayTitle || 'Manga'}</title>
</svelte:head>
```

Local-series header `<h3>` (line ~776) — wrap in `{#key}` so Migaku/Yomitan mutations of the heading are discarded when the title changes in place (e.g. after linking):

```svelte
{#key seriesDisplayTitle}
  <h3 class="min-w-0 flex-shrink-2 px-2 text-2xl font-bold">{seriesDisplayTitle}</h3>
{/key}
```

Placeholder-only header `<h3>` (line ~954):

```svelte
<h3 class="min-w-0 flex-shrink-2 px-2 text-2xl font-bold text-gray-400">
  {seriesDisplayTitle || 'Cloud Series'}
</h3>
```

Do **not** touch: `startRename` (`renameValue = manga[0].series_title`), `promptConfirmation(\`Delete ${seriesTitle} from …\`)`messages that name the cloud folder,`deleteSeriesFromCloudByTitle`, `executeRenameSeries(oldTitle, …)`.

- [ ] **Step 3: VolumeTextView subtitle**

Add imports to `src/lib/views/VolumeTextView.svelte`:

```ts
import { catalogSettings } from '$lib/settings/settings';
import { seriesMetadataMap } from '$lib/metadata/store';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { resolveDisplayTitle } from '$lib/metadata/display-title';
```

Add a derived next to where `volume` is defined:

```ts
let seriesDisplayTitle = $derived(
  volume
    ? resolveDisplayTitle(
        volume.series_title,
        $seriesMetadataMap.get(normalizeSeriesKey(volume.series_title)),
        $catalogSettings?.preferredTitleLanguage ?? 'imported'
      )
    : ''
);
```

Replace line ~175:

```svelte
<p class="mb-4 text-lg text-gray-600 dark:text-gray-400">
  {seriesDisplayTitle} • Text-only view for language analysis
</p>
```

- [ ] **Step 4: Verify**

Run: `npm run check` — expected: 0 errors.
Manual: open a linked series with preference `english` — tab title, header and placeholder header show the display title; click the pencil → the rename box is prefilled with the **folder** title; VolumeTextView subtitle shows the display title.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/lib/views/SeriesView.svelte src/lib/views/VolumeTextView.svelte
git add src/lib/views/SeriesView.svelte src/lib/views/VolumeTextView.svelte
git commit -m "feat(series): show display title in series header, tab title and text view"
```

---

### Task 7: Per-series title-language override in `SeriesMetadataBar`

**Files:**

- Modify: `src/lib/components/Series/SeriesMetadataBar.svelte` (Plan A component; props `seriesTitle: string`, `volumes: VolumeMetadata[]`)

**Interfaces:**

- Consumes: `updateSeriesMetadata(seriesTitle, patch)` and `seriesMetadataMap` (Plan A store), `DisplayTitleLanguage`.
- Produces: writes `title_preference` (`undefined` = "Default", i.e. follow the global setting).

- [ ] **Step 1: Add the select**

In the bar's `<script>` add (merge with Plan A's existing imports — `Select` and `Label` from `flowbite-svelte`, `updateSeriesMetadata`/`seriesMetadataMap` may already be imported):

```ts
import { Label, Select } from 'flowbite-svelte';
import { updateSeriesMetadata, seriesMetadataMap } from '$lib/metadata/store';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import type { DisplayTitleLanguage } from '$lib/metadata/types';

const titleLanguageOptions = [
  { value: 'default', name: 'Default (global setting)' },
  { value: 'imported', name: 'As imported (folder name)' },
  { value: 'native', name: 'Native (日本語)' },
  { value: 'romaji', name: 'Romaji' },
  { value: 'english', name: 'English' }
];

let meta = $derived($seriesMetadataMap.get(normalizeSeriesKey(seriesTitle)));
let titlePreferenceValue = $derived(meta?.title_preference ?? 'default');

async function onTitlePreferenceChange(e: Event & { currentTarget: HTMLSelectElement }) {
  const value = e.currentTarget.value;
  await updateSeriesMetadata(seriesTitle, {
    title_preference: value === 'default' ? undefined : (value as DisplayTitleLanguage)
  });
}
```

(If Plan A already declares `meta` from the same map, reuse it instead of redeclaring.)

In the markup, in the same controls row as the tag text field, add:

```svelte
<div class="flex min-w-[14rem] flex-col gap-1">
  <Label class="text-xs text-gray-500 uppercase">Title language</Label>
  <Select
    size="sm"
    items={titleLanguageOptions}
    value={titlePreferenceValue}
    onchange={onTitlePreferenceChange}
  />
</div>
```

Note on clearing the override: "Default" must _remove_ `title_preference`. Plan A's
`updateSeriesMetadata` does `stripUndefined({ ...existing, ...patch, ... })`, so an explicitly
present `undefined` in the patch overwrites the stored value and is then dropped — i.e. it
deletes the key. No store change is needed; add this regression test to
`src/lib/metadata/store.test.ts` so the behaviour stays locked:

```ts
it('clears title_preference when the patch sets it to undefined', async () => {
  await updateSeriesMetadata('One Piece', { title_preference: 'native' });
  await updateSeriesMetadata('One Piece', { title_preference: undefined });
  expect((await getSeriesMetadataForTitle('One Piece'))?.title_preference).toBeUndefined();
});
```

- [ ] **Step 2: Verify**

Run: `npm run check` and `npx vitest run src/lib/metadata` — expected: green.
Manual: on a linked series, switch the select to Native → header, tab title and catalog card update immediately (liveQuery); switch back to Default → follows Settings.

- [ ] **Step 3: Commit**

```bash
npx prettier --write src/lib/components/Series/SeriesMetadataBar.svelte
git add src/lib/components/Series/SeriesMetadataBar.svelte src/lib/metadata/store.ts src/lib/metadata/store.test.ts
git commit -m "feat(series): per-series title language override"
```

(Only add `store.ts`/`store.test.ts` if Step 1's note required the change.)

---

### Task 8: `MetadataSettings` accordion with the global preference

**Files:**

- Create: `src/lib/components/Settings/MetadataSettings.svelte`
- Modify: `src/lib/components/Settings/Settings.svelte:8-17` (imports), `:88-99` (accordion list)

**Interfaces:**

- Consumes: `catalogSettings`, `updateCatalogSetting` from `$lib/settings/settings`; `DisplayTitleLanguage`.
- Produces: the accordion item that Plan C extends with the AniList account section (mount point marked with a comment).

- [ ] **Step 1: Create the component**

`src/lib/components/Settings/MetadataSettings.svelte`:

```svelte
<script lang="ts">
  import { AccordionItem, Label, Select } from 'flowbite-svelte';
  import { catalogSettings, updateCatalogSetting } from '$lib/settings/settings';
  import type { DisplayTitleLanguage } from '$lib/metadata/types';

  const titleLanguageOptions: { value: DisplayTitleLanguage; name: string }[] = [
    { value: 'imported', name: 'As imported (folder name)' },
    { value: 'native', name: 'Native (日本語)' },
    { value: 'romaji', name: 'Romaji' },
    { value: 'english', name: 'English' }
  ];
</script>

<AccordionItem>
  {#snippet header()}Metadata &amp; tracking{/snippet}
  <div class="flex flex-col gap-4">
    <div>
      <Label class="mb-2 text-sm font-medium">Preferred series title</Label>
      <Select
        items={titleLanguageOptions}
        value={$catalogSettings?.preferredTitleLanguage ?? 'imported'}
        onchange={(e) =>
          updateCatalogSetting(
            'preferredTitleLanguage',
            e.currentTarget.value as DisplayTitleLanguage
          )}
      />
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        Applies to series linked to AniList. Folder names are never changed; when a language is
        missing the reader falls back to English → Romaji → Native → folder name. Each series can
        override this on its page.
      </p>
    </div>

    <!-- Plan C mounts the AniList account section (Connect/Disconnect, push-on-completion switch) here. -->
  </div>
</AccordionItem>
```

- [ ] **Step 2: Mount it in the drawer**

In `src/lib/components/Settings/Settings.svelte` add the import next to the other settings imports:

```ts
import MetadataSettings from './MetadataSettings.svelte';
```

and add it to the accordion right after `<CatalogSettings />`:

```svelte
<CatalogSettings />
<MetadataSettings />
<AppearanceSettings />
```

- [ ] **Step 3: Verify**

Run: `npm run check` — expected: 0 errors.
Manual: open Settings → "Metadata & tracking" → change the select → catalog cards / series header update; reload → persisted (profiles); with cloud sync on, the value travels in `profiles.json`.

- [ ] **Step 4: Commit**

```bash
npx prettier --write src/lib/components/Settings/MetadataSettings.svelte src/lib/components/Settings/Settings.svelte
git add src/lib/components/Settings/MetadataSettings.svelte src/lib/components/Settings/Settings.svelte
git commit -m "feat(settings): Metadata & tracking accordion with preferred title language"
```

---

### Task 9: End-to-end check + docs

**Files:**

- Modify (only if it enumerates catalog features — check with `grep -n "AniList\|title" README.md`): `README.md`. No `CLAUDE.md` change is needed.

- [ ] **Step 1: Full test + type run**

Run: `npx vitest run` — expected: all green (baseline was ~740+ tests before this branch; new: settings ×3, display-title ×13, catalog ×5).
Run: `npm run check` — expected: 0 errors. Run: `npm run lint` — expected: clean.

- [ ] **Step 2: Runtime verification with the `verify` skill**

Invoke the project `verify` skill: import a synthetic 2-volume series, link it via Plan A's modal to an AniList entry (or seed `series_metadata` through the store in the page console), set tag `[color]`, then:

1. Settings → Metadata & tracking → English: catalog card, list row, series header, tab title show `<English title> [color]`.
2. Search box: the folder title, the Japanese title, a synonym and `[color]` each find the series.
3. Series page → Title language → Native overrides the global setting.
4. Pencil (rename) still prefills the folder name; renaming still works and the display title follows the moved record.
5. Reader Exstatic events / Anki `{series}` still emit the folder title (check console / AnkiFieldModal preview).

- [ ] **Step 3: Commit any doc touch-ups**

```bash
git add README.md
git commit -m "docs: mention preferred series title language"
```

(Skip if nothing changed.)

---

## Intentionally unchanged (raw `series_title` stays)

| Site                                                                                                             | Why                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `SeriesView.svelte` rename input (`renameValue`), `executeRenameSeries`                                          | edits the folder name itself                                 |
| `SeriesView.svelte` cloud delete prompts, `deleteSeriesFromCloudByTitle`                                         | names the cloud folder                                       |
| `Reader.svelte:395,690` `fireExstaticEvent(... title: volume.series_title)`                                      | external stats API identity                                  |
| `Reader.svelte:758`, `QuickActions.svelte:45`, `TextBoxes.svelte:158`, `AnkiFieldModal.svelte:90-141` `{series}` | Anki field variable — user templates rely on stable identity |
| `MergeSeriesView.svelte`, `ExtractionModal.svelte` filename preview, `VolumeEditorModal.svelte` series dropdown  | operate on folder identity / filenames                       |
| `CatalogItem`/`CatalogListItem` `navId`, `currentSeries` route match                                             | routes use `#/series/<series_title>`                         |

## Self-review notes

- Spec coverage (Phase B): setting + migration (T1), `resolveDisplayTitle` incl. fallback chain and tag (T2), catalog compute-once + sort + search (T3–T5), display sites Catalog/SeriesView/tab title/VolumeTextView (T5–T6; the reader has no series-title label — `Reader.svelte` `<title>` uses `volume_title`), per-series override select in the bar (T7), settings accordion (T8), `{#key}` on the header (T6), grouping/routes/cloud unchanged (table above).
- Contract deviations: `Series` gains `searchTerms: string[]` in addition to the contract's `displayTitle` (additive; needed so search runs once per recompute). `deriveSeriesFromVolumes(volumes, metaMap?, pref = 'imported')` matches the contract.
- Type consistency: `DisplayTitleLanguage` values `'imported' | 'native' | 'romaji' | 'english'` used identically in T1, T2, T7, T8; `preferredTitleLanguage` spelled the same in T1, T4, T6, T8; `updateSeriesMetadata(seriesTitle, patch)` matches the contract signature.
