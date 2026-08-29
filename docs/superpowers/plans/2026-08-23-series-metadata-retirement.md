# `series-metadata.json` Retirement & Field Redistribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the root `series-metadata.json` sync file and redistribute everything it carried — facts and spine offsets into `<Series>/series.json`, series-level reading state into a `series` section of `volume-data.json`, AniList display data into nothing at all (fetched transiently), `title_preference` into oblivion — while upgrading `profiles.json` to the automatic sync treatment `volume-data.json` already has.

**Architecture:** The local `series_metadata` Dexie table survives as local storage; only its root sync file dies, taking `merge.ts`, `syncSeriesMetadata()` and its allowlist entry with it. Each field moves to the transport that matches its nature: shareable facts already ride `series.json`, so spine offsets join them there as _index_ data (same rules as `archive_size` — local-wins/fill, never stamped as facts, published through a new non-facts trigger on the debounced writer); per-user reading state (`read_count`, `reread_prompt_suppressed`, `tracking`) moves to a new `src/lib/settings/series-data.ts` store persisted in `volume-data.json`'s reserved `series` key with its per-key newest-wins semantics; AniList totals stop being stored at all and are fetched in the GraphQL request the push already makes.

**Tech Stack:** SvelteKit 5 runes, Dexie 4 + fake-indexeddb, Svelte stores + localStorage, Vitest + jsdom, Playwright (e2e), TypeScript.

**Spec:** `docs/superpowers/specs/2026-08-23-catalog-distribution-design.md` — section **"Amendment 2026-08-23: `series-metadata.json` retired; field redistribution (user decisions)"** is what this plan implements. Companion plans: `2026-08-23-catalog-distribution-client.md` (in flight, same worktree) and `2026-08-23-catalog-distribution-bunko.md` (separate repo).

## Global Constraints

Copied verbatim from the spec amendment; every task's requirements implicitly include these.

- **The file is gone, not deprecated** — "`series-metadata.json` is REMOVED — never shipped, no legacy support. Writer, reader, merge machinery, and its root-allowlist entry go; a stale file in an existing cloud is inert junk. The local `series_metadata` table remains as local storage; only the root sync file dies."
- **Facts** — "(`external_ids`, `titles`, `synonyms`, `tag`, `unit`) — transported ONLY by `<Series>/series.json` (+ `catalog.json` compilation). Facts stamps unchanged."
- **Spine offsets are FILE FACTS** — "(same archives ⇒ same cover geometry): `spine_offset` becomes a top-level optional in `series.json`, per-volume offsets ride volume entries — index rules like `archive_size` (installed-override/fill, never stamped as facts). Bunko contract: accepted index fields. Bunko users inherit the uploader's shelf alignment."
- **Series-level reading state** — "(`read_count`, `reread_prompt_suppressed`, `tracking{}`) — moves to a `series` section of `volume-data.json`, gaining its per-key newest-wins sync semantics. Never in shared files."
- **AniList-derived display data** — "(`format`, `status`, `total_volumes`, `total_chapters`, `cover_url`) — NOT STORED. Shown transiently in the link picker from search results only. The tracker's COMPLETED logic fetches totals in the same AniList request the push already makes (`fetchRemoteEntry` query gains `media { volumes chapters }`); `detectTrackingUnit`'s overshoot rule applies only when totals are present in that context (marker-based detection otherwise)."
- **`title_preference`** — "deleted (globally ignored legacy field). Profile-level preferences live in `profiles.json`, which is upgraded to the same automatic read/merge/push treatment `volume-data.json` has (it is currently neglected)."
- **Best-effort writes** (unchanged, from the base spec) — "All metadata writes (`series.json`, `catalog.json`) are best-effort: on failure, log at debug, keep the provider fully functional (NO read-only fallback, no snackbar), retry on the next natural trigger."
- **`FACTLESS_UPDATED_AT`** is exactly `'1970-01-01T00:00:00.000Z'` and must never be `new Date()`.
- **Compact JSON** — `series.json` is serialized only through `stringifySeriesFile`, never pretty-printed.
- **No data migrations** — the feature is unreleased. Stale cloud `series-metadata.json` files are tolerated and ignored, never read, never deleted.
- **CLAUDE.md rules** (binding):
  - `$derived`/`$derived.by()` run for EVERY component instance — no expensive work or logging in per-card derived.
  - Modal action-button containers get `relative z-10`.
  - `{#key}` blocks around dynamic text extensions mutate (Migaku/Yomitan).
  - Always use the Dexie instance from `src/lib/catalog/db.ts`.
  - Worktree-based development: work happens in `/home/nathan/Projects/mokuro-reader-worktrees/feat/series-metadata`, never in the main checkout.
- **Verification port is 5199** — port 5173 belongs to the user. Playwright runs with `E2E_PORT=5199` (and `E2E_CHROMIUM` when a browser binary is already cached).

## File Structure

| File                                                                   | Responsibility after this plan                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/settings/series-data.ts` (new)                                | Series reading-state store (`read_count`/`reread_prompt_suppressed`/`tracking` keyed by `series_key`), its sanitizer + merge |
| `src/lib/settings/series-data.test.ts` (new)                           | Unit tests for the store, the sanitizer and the newest-wins merge                                                            |
| `src/lib/settings/volume-data.ts`                                      | Reserves the `series` key out of the volume map; otherwise unchanged                                                         |
| `src/lib/metadata/types.ts`                                            | `SeriesMetadata` shrinks to facts + offsets + stamps; gains `SeriesTotals`                                                   |
| `src/lib/metadata/store.ts`                                            | Loses the removed fields; gains the index-change listener; `upsertFromSeriesFile` fills offsets                              |
| `src/lib/metadata/merge.ts` + `merge.test.ts`                          | **DELETED** — root-file machinery                                                                                            |
| `src/lib/metadata/sanitize.ts`                                         | `sanitizeVolumeOffset` (scalar) replaces `sanitizeVolumeOffsets` (map); `sanitizeTitlePreference` deleted                    |
| `src/lib/metadata/series-file.ts`                                      | `spine_offset` top-level + per-entry `offset`: build (union/fill), parse, cache merge                                        |
| `src/lib/metadata/spine-offsets.ts`                                    | Stores explicit `0` (a reset must beat the published value) instead of deleting the key                                      |
| `src/lib/metadata/series-file-sync.ts`                                 | Registers the index-change listener as a second, non-facts write trigger                                                     |
| `src/lib/metadata/reread.ts`                                           | Reads/writes suppression + read count through the series reading-state store                                                 |
| `src/lib/metadata/progress-tracker.ts`                                 | Pass state from the reading-state store; totals from the push's own GraphQL response                                         |
| `src/lib/metadata/tracking-unit.ts`                                    | Totals become a caller-supplied parameter (present only in the push context)                                                 |
| `src/lib/metadata/providers/anilist.ts`                                | `toSeriesMetadataPatch` shrinks to the facts                                                                                 |
| `src/lib/util/sync/unified-sync-service.ts`                            | `series` section of `volume-data.json`; `syncSeriesMetadata` deleted; profiles synced unconditionally                        |
| `src/lib/util/sync/syncable-file.ts`                                   | `series-metadata.json` leaves the root-config allowlist                                                                      |
| `src/lib/components/Series/SeriesTrackingPanel.svelte`                 | Read count / suppression / last-pushed from the reading-state store                                                          |
| `src/lib/components/Series/SeriesMetadataBar.svelte`                   | Same, read-only                                                                                                              |
| `src/lib/components/Reader/Reader.svelte` + `RereadPromptModal.svelte` | Suppression flag from the store, synchronously                                                                               |
| `e2e/series-metadata-retirement.spec.ts` (new)                         | In-app verification of every redistribution, port 5199                                                                       |

---

### Task 1: `series.json` transports the shelf alignment

**Files:**

- Modify: `src/lib/metadata/sanitize.ts` (add `sanitizeVolumeOffset`)
- Modify: `src/lib/metadata/series-file.ts` (`SeriesFile.spine_offset`, `SeriesFileVolume.offset`, build/parse/merge)
- Modify: `src/lib/metadata/spine-offsets.ts:122-145` (`buildPatch` stores explicit zeros)
- Modify: `src/lib/metadata/store.ts:234-283` (`upsertFromSeriesFile` fills offsets)
- Modify: `src/lib/components/CatalogItem.svelte:325-333` (comment only — the writer no longer deletes keys)
- Modify: `docs/superpowers/plans/2026-08-23-catalog-distribution-bunko.md:10` (contract §2)
- Test: `src/lib/metadata/series-file.test.ts`, `src/lib/metadata/store.test.ts`

**Interfaces:**

- Consumes: `SPINE_OFFSET_LIMIT`, `VOLUME_OFFSET_LIMIT`, `sanitizeSpineOffset` from `./sanitize`; `SeriesMetadata.spine_offset` / `.volume_offsets` (unchanged shape) from `./types`.
- Produces:
  - `sanitizeVolumeOffset(value: unknown): number | undefined` — finite, clamped to ±`VOLUME_OFFSET_LIMIT`; `0` is a real value ("no nudge here"), junk is `undefined`.
  - `interface SeriesFileVolume { …; offset?: number }` — px nudge for that volume's spine.
  - `interface SeriesFile { …; spine_offset?: number }` — percent added to the catalog's horizontal step.
  - `buildSeriesFile(args)` / `parseSeriesFile(value)` / `mergeSeriesFileForCache(...)` — signatures unchanged, offsets now carried.
  - `upsertFromSeriesFile(seriesTitle, file): Promise<boolean>` — signature unchanged; now also fills missing offsets without touching the facts stamp.

- [ ] **Step 1: Write the failing series-file tests**

Append to `src/lib/metadata/series-file.test.ts`:

```ts
describe('spine offsets in series.json', () => {
  const meta = (partial: Partial<SeriesMetadata> = {}): SeriesMetadata => ({
    ...createEmptySeriesMetadata('One Piece'),
    ...partial
  });

  it('publishes the local shelf alignment as index data, not as facts', () => {
    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: meta({ spine_offset: 12, volume_offsets: { 'vol-1': -30 } }),
      localVolumes: [volume()]
    })!;

    expect(file.spine_offset).toBe(12);
    expect(file.volumes[0].offset).toBe(-30);
    // Offsets are not facts: an offsets-only record still publishes nothing to
    // outrank anybody's link.
    expect(file.updated_at).toBe(FACTLESS_UPDATED_AT);
  });

  it('carries the published alignment through when this library has none', () => {
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT,
      spine_offset: 8,
      volumes: [{ ...volumeToIndexEntry(volume()), offset: 25 }]
    };

    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: meta(),
      localVolumes: [volume()],
      existing
    })!;

    expect(file.spine_offset).toBe(8);
    expect(file.volumes[0].offset).toBe(25);
  });

  it('lets a local reset (an explicit 0) clear the published alignment', () => {
    const existing: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT,
      spine_offset: 8,
      volumes: [{ ...volumeToIndexEntry(volume()), offset: 25 }]
    };

    const file = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: meta({ spine_offset: 0, volume_offsets: { 'vol-1': 0 } }),
      localVolumes: [volume()],
      existing
    })!;

    expect('spine_offset' in file).toBe(false);
    expect('offset' in file.volumes[0]).toBe(false);
  });

  it('round-trips offsets through stringify → parse and drops junk', () => {
    const built = buildSeriesFile({
      seriesTitle: 'One Piece',
      meta: meta({ spine_offset: 12, volume_offsets: { 'vol-1': -30 } }),
      localVolumes: [volume()]
    })!;

    expect(parseSeriesFile(JSON.parse(stringifySeriesFile(built)))).toEqual(built);

    const junk = parseSeriesFile({
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-08-23T00:00:00.000Z',
      spine_offset: 9999,
      volumes: [{ ...volumeToIndexEntry(volume()), offset: 'nope' }]
    })!;

    expect(junk.spine_offset).toBe(50); // clamped to SPINE_OFFSET_LIMIT
    expect('offset' in junk.volumes[0]).toBe(false);
  });

  it('keeps the offsets of the winning side when caching an imported file', () => {
    const cached: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-08-01T00:00:00.000Z',
      spine_offset: 5,
      volumes: []
    };
    const arriving: SeriesFile = {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: '2026-08-20T00:00:00.000Z',
      volumes: [{ ...volumeToIndexEntry(volume()), offset: 11 }]
    };

    const merged = mergeSeriesFileForCache('One Piece', arriving, cached);

    expect('spine_offset' in merged).toBe(false);
    expect(merged.volumes[0].offset).toBe(11);
  });
});
```

Add `stringifySeriesFile` to the existing import block at the top of the file if it is not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/metadata/series-file.test.ts`
Expected: FAIL — `spine_offset` and `offset` are not on the built files (`undefined`).

- [ ] **Step 3: Add the scalar offset sanitizer**

In `src/lib/metadata/sanitize.ts`, add below `sanitizeVolumeOffsets`:

```ts
/**
 * One volume's spine nudge, in px: any finite number, clamped to
 * ±`VOLUME_OFFSET_LIMIT`.
 *
 * `0` is a REAL value here, not a gap — it is how a device that reset its shelf
 * overrides an alignment another device published (`buildSeriesFile` then omits
 * the field entirely, so a zero never reaches the file itself).
 */
export function sanitizeVolumeOffset(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return clamp(value, VOLUME_OFFSET_LIMIT);
}
```

- [ ] **Step 4: Carry the offsets in the file type, the builder and the parser**

In `src/lib/metadata/series-file.ts`, extend the two interfaces:

```ts
export interface SeriesFileVolume {
  volume_uuid: string;
  volume_title: string;
  page_count: number;
  character_count: number;
  /** `''` for image-only volumes. */
  mokuro_version: string;
  spine_width?: number;
  /**
   * Bytes of the volume's `.cbz` — a fact of the archive, like `spine_width`,
   * so a reader can show the download size before fetching anything. Optional
   * everywhere: older files and factless writers simply omit it, and readers
   * ignore its absence.
   */
  archive_size?: number;
  /**
   * Horizontal nudge for this volume's spine on the catalog shelf, in px.
   *
   * A file fact like `spine_width`: the same archives have the same cover
   * geometry, so the alignment one library measured is worth inheriting. INDEX
   * data, never facts — it does not move `updated_at` and never decides a
   * facts merge. Omitted when there is no nudge (a zero is never written).
   */
  offset?: number;
}
```

```ts
export interface SeriesFile {
  version: 2;
  series_title: string;
  external_ids: SeriesExternalIds;
  titles: SeriesTitles;
  synonyms: string[];
  tag?: string;
  /** Are these archives volumes or chapters? Absent = auto-detect from the titles. */
  unit?: TrackingUnit;
  /**
   * Percent added to the catalog's global horizontal spine step for this
   * series. Index data like the per-volume `offset` — same reasoning, same
   * rules, never a fact.
   */
  spine_offset?: number;
  updated_at: string;
  volumes: SeriesFileVolume[];
}
```

Import the two new helpers at the top of the file:

```ts
import {
  ID_KEYS,
  TITLE_KEYS,
  isRecord,
  normalizeUpdatedAt,
  sanitizeExternalIds,
  sanitizeSpineOffset,
  sanitizeSynonyms,
  sanitizeTag,
  sanitizeTitles,
  sanitizeTrackingUnit,
  sanitizeVolumeOffset
} from './sanitize';
```

In `buildSeriesFile`, insert this block immediately after the `cloudVolumeTitles` prune and **before** `volumes.sort(compareEntries)`:

```ts
// ---- index data: the shelf alignment ----
// Same rules as `archive_size`: this library's value wins where it has one,
// the published value rides through where it does not, and neither ever
// moves the facts stamp. A device that never linked the series still
// publishes the alignment it measured, and a bunko user inherits the
// uploader's shelf. A local ZERO is a deliberate reset, so it suppresses the
// published value instead of inheriting it back — and is then omitted from
// the file, which is what keeps build → parse an identity.
const publishedOffsets = new Map<string, number>();
for (const entry of existing?.volumes ?? []) {
  if (entry.offset !== undefined) publishedOffsets.set(entry.volume_uuid, entry.offset);
}
const localOffsets = meta?.volume_offsets ?? {};
volumes = volumes.map((entry) => {
  const hasLocal = Object.prototype.hasOwnProperty.call(localOffsets, entry.volume_uuid);
  const local = hasLocal ? sanitizeVolumeOffset(localOffsets[entry.volume_uuid]) : undefined;
  const offset = local ?? publishedOffsets.get(entry.volume_uuid);
  if (!offset) {
    if (entry.offset === undefined) return entry;
    const cleared = { ...entry };
    delete cleared.offset;
    return cleared;
  }
  return entry.offset === offset ? entry : { ...entry, offset };
});
```

Then, in the same function, build the top-level value just before the `file` literal and attach it alongside `tag`/`unit`:

```ts
const spineOffset = sanitizeSpineOffset(meta?.spine_offset) ?? existing?.spine_offset;

const file: SeriesFile = {
  version: 2,
  series_title: seriesTitle,
  external_ids,
  titles,
  synonyms,
  updated_at,
  volumes
};
if (tag) file.tag = tag;
if (unit) file.unit = unit;
// A local 0 (a reset) sanitizes to 0 and therefore drops the field — exactly
// what the reset means. Absent locally, the published value rides through.
if (spineOffset) file.spine_offset = spineOffset;
return file;
```

In `parseVolumeEntry`, after the `archive_size` line:

```ts
const offset = sanitizeVolumeOffset(value.offset);
if (offset) entry.offset = offset;
```

In `parseSeriesFile`, after the `unit` block:

```ts
const spineOffset = sanitizeSpineOffset(value.spine_offset);
if (spineOffset) file.spine_offset = spineOffset;
```

In `mergeSeriesFileForCache`, extend the "drop what the losing side had" tail:

```ts
const merged: SeriesFile = { ...base, series_title: seriesTitle, volumes };
if (!base.tag) delete merged.tag;
if (!base.unit) delete merged.unit;
// The alignment follows the same winner as the facts: a cached copy must not
// resurrect an offset the arriving (newer) file cleared.
if (!base.spine_offset) delete merged.spine_offset;
return merged;
```

- [ ] **Step 5: Run the series-file tests to verify they pass**

Run: `npx vitest run src/lib/metadata/series-file.test.ts`
Expected: PASS (all pre-existing tests included).

- [ ] **Step 6: Write the failing store test for the fill rule**

Append to `src/lib/metadata/store.test.ts` inside the top-level `describe('series metadata store', …)`:

```ts
it('fills missing spine offsets from a sidecar without touching the facts stamp', async () => {
  await updateSeriesMetadata('One Piece', { external_ids: { anilist: 13 } });
  const before = (await getSeriesMetadataForTitle('One Piece'))!;

  const applied = await upsertFromSeriesFile('One Piece', {
    version: 2,
    series_title: 'One Piece',
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at: FACTLESS_UPDATED_AT,
    spine_offset: 9,
    volumes: [
      {
        volume_uuid: 'vol-1',
        volume_title: 'Vol 1',
        page_count: 1,
        character_count: 1,
        mokuro_version: '0.4.11',
        offset: -20
      }
    ]
  });

  expect(applied).toBe(true);
  const after = (await getSeriesMetadataForTitle('One Piece'))!;
  expect(after.spine_offset).toBe(9);
  expect(after.volume_offsets).toEqual({ 'vol-1': -20 });
  // Index data, not facts: the link and its stamp are untouched.
  expect(after.external_ids).toEqual({ anilist: 13 });
  expect(after.facts_updated_at).toBe(before.facts_updated_at);
});

it('never overrides an offset this library already has', async () => {
  await updateSeriesMetadata('One Piece', {
    spine_offset: 3,
    volume_offsets: { 'vol-1': 7 }
  });

  await upsertFromSeriesFile('One Piece', {
    version: 2,
    series_title: 'One Piece',
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at: FACTLESS_UPDATED_AT,
    spine_offset: 9,
    volumes: [
      {
        volume_uuid: 'vol-1',
        volume_title: 'Vol 1',
        page_count: 1,
        character_count: 1,
        mokuro_version: '0.4.11',
        offset: -20
      },
      {
        volume_uuid: 'vol-2',
        volume_title: 'Vol 2',
        page_count: 1,
        character_count: 1,
        mokuro_version: '0.4.11',
        offset: 4
      }
    ]
  });

  const after = (await getSeriesMetadataForTitle('One Piece'))!;
  expect(after.spine_offset).toBe(3);
  expect(after.volume_offsets).toEqual({ 'vol-1': 7, 'vol-2': 4 });
});

it('creates a record from an offsets-only sidecar without giving it a facts clock', async () => {
  const applied = await upsertFromSeriesFile('Berserk', {
    version: 2,
    series_title: 'Berserk',
    external_ids: {},
    titles: {},
    synonyms: [],
    updated_at: FACTLESS_UPDATED_AT,
    spine_offset: 6,
    volumes: []
  });

  expect(applied).toBe(true);
  const record = (await getSeriesMetadataForTitle('Berserk'))!;
  expect(record.spine_offset).toBe(6);
  expect(record.facts_updated_at).toBeUndefined();
});
```

- [ ] **Step 7: Run the store tests to verify they fail**

Run: `npx vitest run src/lib/metadata/store.test.ts`
Expected: FAIL — `spine_offset` is `undefined` on the record; the offsets-only case returns `false`.

- [ ] **Step 8: Fill offsets in `upsertFromSeriesFile`**

Replace the body of `upsertFromSeriesFile` in `src/lib/metadata/store.ts` (keep the existing doc comment and append the two paragraphs below to it):

```ts
/**
 * … (existing doc comment) …
 *
 * Spine offsets ride the file as INDEX data, not facts, so they are applied on
 * their own terms: only where this library has no value of its own (fill, never
 * override — the local shelf is the local shelf), and regardless of the facts
 * stamp comparison, which decides nothing about them. Applying them never moves
 * `facts_updated_at`.
 *
 * A file with no facts and no local record still creates one when it carries
 * offsets: that record has no facts clock, so `buildSeriesFile` still treats
 * this library as having no opinion about the series' facts.
 */
export async function upsertFromSeriesFile(
  seriesTitle: string,
  file: SeriesFile
): Promise<boolean> {
  const key = normalizeSeriesKey(seriesTitle);
  return db.transaction('rw', db.series_metadata, async () => {
    const existing = await db.series_metadata.get(key);
    // No local facts stamp = no local opinion, so any sidecar with facts applies.
    const localStamp = existing ? factsStamp(existing) : undefined;
    const stampWins = localStamp === undefined || localStamp < file.updated_at;
    // An index-only file for a series we hold no record for says nothing about
    // the facts — creating an empty record from it would publish that emptiness.
    const applyFacts = stampWins && (!!existing || hasSeriesFacts(file));
    const offsets = offsetsToFill(existing, file);
    if (!applyFacts && !offsets) return false;

    const base = existing ?? createEmptySeriesMetadata(seriesTitle, file.updated_at);
    const linked = hasAnyId(file.external_ids);
    const linkChanged = !sameExternalIds(base.external_ids, file.external_ids);
    const next = stripUndefined<SeriesMetadata>({
      ...base,
      series_key: key,
      series_title: seriesTitle,
      ...(applyFacts
        ? {
            external_ids: { ...file.external_ids },
            titles: { ...file.titles },
            synonyms: [...file.synonyms],
            tag: file.tag,
            unit: file.unit,
            // The record's own stamp never moves backwards.
            updated_at: file.updated_at > base.updated_at ? file.updated_at : base.updated_at,
            facts_updated_at: file.updated_at,
            linked_at: linked
              ? linkChanged
                ? file.updated_at
                : (base.linked_at ?? file.updated_at)
              : undefined
          }
        : {}),
      ...(offsets ?? {})
    });
    await db.series_metadata.put(next);
    return true;
  });
}
```

Add the helper just above it:

```ts
/**
 * The offsets a sidecar can contribute: fill-only, so anything this library
 * already decided stays untouched. `undefined` = nothing to add.
 */
function offsetsToFill(
  existing: SeriesMetadata | undefined,
  file: SeriesFile
): Pick<SeriesMetadata, 'spine_offset' | 'volume_offsets'> | undefined {
  const patch: Pick<SeriesMetadata, 'spine_offset' | 'volume_offsets'> = {};
  let changed = false;

  if (existing?.spine_offset === undefined && file.spine_offset !== undefined) {
    patch.spine_offset = file.spine_offset;
    changed = true;
  }

  const merged = { ...(existing?.volume_offsets ?? {}) };
  for (const entry of file.volumes) {
    if (entry.offset === undefined) continue;
    if (merged[entry.volume_uuid] !== undefined) continue;
    merged[entry.volume_uuid] = entry.offset;
    changed = true;
  }
  if (Object.keys(merged).length > 0) patch.volume_offsets = merged;

  return changed ? patch : undefined;
}
```

- [ ] **Step 9: Run the store tests to verify they pass**

Run: `npx vitest run src/lib/metadata/store.test.ts`
Expected: PASS.

- [ ] **Step 10: Make a reset store an explicit zero**

In `src/lib/metadata/spine-offsets.ts`, replace the two lines in `buildPatch` that erase values:

```ts
return (existing) => {
  const patch: SeriesMetadataPatch = {};
  if (hasSpineOffset) {
    // Stored even at 0: a 0 is a deliberate reset, and `buildSeriesFile` needs
    // to see it to suppress an alignment another device published (an absent
    // value means "no opinion", which INHERITS the published one).
    patch.spine_offset = spineOffset;
  }
  if (hasVolumeOffsets || resetVolumes) {
    // "Reset all" keeps every key at 0 for the same reason: the zeros are what
    // outrank the published nudges. They never reach the file — the writer
    // omits zero offsets — and never reach the layout, which filters them.
    const next: Record<string, number> = resetVolumes
      ? Object.fromEntries(Object.keys(existing.volume_offsets ?? {}).map((uuid) => [uuid, 0]))
      : { ...(existing.volume_offsets ?? {}) };
    for (const [uuid, px] of Object.entries(volumeOffsets)) next[uuid] = px;
    patch.volume_offsets = Object.keys(next).length > 0 ? next : undefined;
  }
  return patch;
};
```

Update the module doc comment's second paragraph (it names the deleted root file):

```ts
/**
 * … (first paragraph unchanged) …
 *
 * These are user-visible catalog layout AND a property of the archives themselves —
 * the same covers have the same geometry — so they live on the local `SeriesMetadata`
 * record and are published as INDEX data in the shared `series.json` sidecar
 * (`spine_offset` top-level, per-volume `offset` on the entries). Writing them must
 * never touch `facts_updated_at` — see `updateSeriesMetadata`.
 *
 * … (debounce paragraph unchanged) …
 */
```

In `src/lib/components/CatalogItem.svelte:331`, correct the now-wrong comment:

```svelte
    // 0 is stored, not deleted: it is what outranks an alignment published by
    // another device (see spine-offsets.ts).
    writeSpineOffsets({ volumeOffsets: { [volumeUuid]: px } });
```

- [ ] **Step 11: Run the offset tests**

Run: `npx vitest run src/lib/metadata/spine-offsets.test.ts src/lib/components/__tests__/CatalogItem.test.ts src/lib/components/Series/__tests__/SeriesSpineShowcase.test.ts`
Expected: PASS. If a test asserts that a 0 deletes the key (`expect(patch.volume_offsets).toBeUndefined()` after a reset), update it to expect the zeroed map — the reset behaviour the USER sees is unchanged (`getSpineOffsets` filters zeros), only the stored representation changed.

- [ ] **Step 12: Record the bunko contract**

In `docs/superpowers/plans/2026-08-23-catalog-distribution-bunko.md`, replace contract item 2 with:

```markdown
2. **Compiled `series.json`** — v2, compact JSON, exactly the reader's shape: `{version:2, series_title, external_ids, titles, synonyms, tag?, unit?, spine_offset?, updated_at, volumes:[{volume_uuid, volume_title, page_count, character_count, mokuro_version, spine_width?, archive_size?, offset?}]}`. `updated_at` = facts stamp (fact edits only); `1970-01-01T00:00:00.000Z` when bunko holds no facts for the series. Volume entries come from the `.mokuro` files (uuid/title/pages/chars/version; `spine_width` when known) plus `archive_size` (bytes of the `.cbz`, from a plain stat). `spine_offset` (percent, ±50) and per-entry `offset` (px, ±500) are the shelf alignment: INDEX fields, accepted and preserved verbatim from an intercepted PUT, never validated as facts and never allowed to move the facts stamp. No per-page arrays. Readers ignore unknown keys; bunko must too.
```

- [ ] **Step 13: Run the full suite and commit**

Run: `npx vitest run`
Expected: PASS.

```bash
git add src/lib/metadata/sanitize.ts src/lib/metadata/series-file.ts src/lib/metadata/series-file.test.ts src/lib/metadata/store.ts src/lib/metadata/store.test.ts src/lib/metadata/spine-offsets.ts src/lib/metadata/spine-offsets.test.ts src/lib/components/CatalogItem.svelte docs/superpowers/plans/2026-08-23-catalog-distribution-bunko.md
git commit -m "feat(metadata): publish the shelf alignment in series.json as index data"
```

---

### Task 2: Offset edits publish `series.json` without a facts bump

**Files:**

- Modify: `src/lib/metadata/store.ts` (index-change listener registry)
- Modify: `src/lib/metadata/series-file-sync.ts:487-507` (`initSeriesFileSync` registers it)
- Test: `src/lib/metadata/store.test.ts`, `src/lib/metadata/series-file-sync.test.ts`

**Interfaces:**

- Consumes: `registerFactsChangeListener` (existing pattern), `scheduleSeriesFileWrite(seriesTitle, options?)` from `./series-file-sync`.
- Produces: `registerIndexChangeListener(fn: (seriesTitle: string) => void): () => void` — fires after a local write that changed `spine_offset` or `volume_offsets`, never for `upsertFromSeriesFile`, never for fact edits (those already have their own listener).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/metadata/store.test.ts` (inside the top-level describe):

```ts
it('notifies index listeners for an offset edit and facts listeners for a fact edit', async () => {
  const indexed: string[] = [];
  const facts: string[] = [];
  const offIndex = registerIndexChangeListener((title) => indexed.push(title));
  const offFacts = registerFactsChangeListener((title) => facts.push(title));

  try {
    await updateSeriesMetadata('One Piece', { spine_offset: 4 });
    await updateSeriesMetadata('One Piece', { volume_offsets: { 'vol-1': 8 } });
    await updateSeriesMetadata('One Piece', { tag: 'color' });
    // A re-write of the same values changes nothing and must stay quiet.
    await updateSeriesMetadata('One Piece', { spine_offset: 4 });

    expect(indexed).toEqual(['One Piece', 'One Piece']);
    expect(facts).toEqual(['One Piece']);
  } finally {
    offIndex();
    offFacts();
  }
});

it('does not notify index listeners when a sidecar fills the offsets', async () => {
  const indexed: string[] = [];
  const off = registerIndexChangeListener((title) => indexed.push(title));

  try {
    await upsertFromSeriesFile('One Piece', {
      version: 2,
      series_title: 'One Piece',
      external_ids: {},
      titles: {},
      synonyms: [],
      updated_at: FACTLESS_UPDATED_AT,
      spine_offset: 6,
      volumes: []
    });

    expect(indexed).toEqual([]);
  } finally {
    off();
  }
});
```

Add `registerIndexChangeListener` and `registerFactsChangeListener` to the `./store` import block at the top of the test file.

Replace the existing `series-file-sync.test.ts` test at line 420 (`does NOT fire for a per-user edit …`) with:

```ts
it('fires after an offset edit — the shelf alignment is published too', async () => {
  await updateSeriesMetadata('One Piece', { spine_offset: 6 });
  await vi.advanceTimersByTimeAsync(2000);

  expect(writeSeriesFile).toHaveBeenCalledWith('One Piece');
  // Index data: the facts clock must not have moved.
  expect(metaRows.get('one piece')?.facts_updated_at).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/metadata/store.test.ts src/lib/metadata/series-file-sync.test.ts`
Expected: FAIL with "registerIndexChangeListener is not a function" / `writeSeriesFile` never called.

- [ ] **Step 3: Add the index-change registry**

In `src/lib/metadata/store.ts`, next to `FACT_KEYS`:

```ts
/**
 * The INDEX keys — data that rides `series.json`'s volume entries rather than
 * its facts. Changing one has to publish a new sidecar (a shelf alignment is
 * worth sharing) but must never move `facts_updated_at`, which is what decides
 * whose link wins.
 */
const INDEX_KEYS = ['spine_offset', 'volume_offsets'] as const;

function changesIndex(existing: SeriesMetadata, patch: SeriesMetadataPatch): boolean {
  return INDEX_KEYS.some((key) => key in patch && !sameValue(patch[key], existing[key]));
}
```

Below the facts listener registry:

```ts
type IndexChangeListener = (seriesTitle: string) => void;
const indexChangeListeners = new Set<IndexChangeListener>();

/**
 * Called after a local write that actually changed the shelf alignment
 * (`spine_offset`, `volume_offsets`). The NON-FACTS trigger for the debounced
 * `series.json` writer: the file has to be republished, but nothing about the
 * facts changed, so `facts_updated_at` stays where it was.
 *
 * Never fires for `upsertFromSeriesFile` — that applies what a sidecar already
 * says, and republishing it would be a write loop between devices. Same
 * registration-hook shape as `registerFactsChangeListener`, for the same reason
 * (this module must not import the cloud layer). Returns an unregister function.
 */
export function registerIndexChangeListener(fn: IndexChangeListener): () => void {
  indexChangeListeners.add(fn);
  return () => {
    indexChangeListeners.delete(fn);
  };
}

function notifyIndexChanged(seriesTitle: string): void {
  for (const fn of indexChangeListeners) {
    try {
      fn(seriesTitle);
    } catch (error) {
      console.warn('[series-metadata] index-change listener failed:', error);
    }
  }
}
```

In `updateSeriesMetadata`, track the flag inside the transaction and notify after the commit:

```ts
  let factsChanged = false;
  let indexChanged = false;
  const next = await db.transaction('rw', db.series_metadata, async () => {
    …
    factsChanged = changesFacts(existing, resolved);
    indexChanged = changesIndex(existing, resolved);
    …
  });

  // After the commit, so a listener that reads the record back sees this write.
  if (factsChanged) notifyFactsChanged(seriesTitle);
  if (indexChanged) notifyIndexChanged(seriesTitle);
  return next;
```

- [ ] **Step 4: Subscribe the writer to it**

In `src/lib/metadata/series-file-sync.ts`, import the new hook and register it:

```ts
import { registerFactsChangeListener, registerIndexChangeListener } from './store';
```

```ts
export function initSeriesFileSync(): () => void {
  if (!browser) return () => {};
  if (teardown) return teardown;

  const unregisterFacts = registerFactsChangeListener((seriesTitle) =>
    scheduleSeriesFileWrite(seriesTitle)
  );
  // The non-facts trigger: a shelf alignment change republishes the sidecar
  // with the SAME facts stamp (see `registerIndexChangeListener`). Both funnel
  // into the same per-series debounce, so an edit that moves both costs one write.
  const unregisterIndex = registerIndexChangeListener((seriesTitle) =>
    scheduleSeriesFileWrite(seriesTitle)
  );

  const dispose = () => {
    if (teardown !== dispose) return;
    teardown = null;
    unregisterFacts();
    unregisterIndex();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pendingTitles.clear();
    pendingOptions.clear();
  };

  teardown = dispose;
  return dispose;
}
```

Also update the module doc comment's third bullet:

```ts
 * - Driven by `registerFactsChangeListener` and `registerIndexChangeListener`,
 *   which only fire for local edits — facts, or the shelf alignment. Anything
 *   arriving FROM a sidecar (`upsertFromSeriesFile`) never schedules a write,
 *   so two devices cannot ping-pong the same file.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/metadata/store.test.ts src/lib/metadata/series-file-sync.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/metadata/store.ts src/lib/metadata/store.test.ts src/lib/metadata/series-file-sync.ts src/lib/metadata/series-file-sync.test.ts
git commit -m "feat(metadata): republish series.json on a shelf-alignment edit, facts stamp untouched"
```

---

### Task 3: The `series` section of `volume-data.json` (local half)

**Files:**

- Create: `src/lib/settings/series-data.ts`
- Create: `src/lib/settings/series-data.test.ts`
- Modify: `src/lib/settings/volume-data.ts:224-236` (reserve the key)
- Modify: `src/lib/settings/index.ts` (re-export)
- Test: `src/lib/settings/volume-data.test.ts`

**Interfaces:**

- Consumes: `sanitizeTracking`, `isRecord`, `normalizeUpdatedAt` from `$lib/metadata/sanitize`; `SeriesTracking` from `$lib/metadata/types`.
- Produces (all from `$lib/settings/series-data`):
  - `const SERIES_SECTION_KEY = 'series'`
  - `interface SeriesReadingState { read_count: number; reread_prompt_suppressed?: boolean; tracking?: SeriesTracking; lastUpdated: string }`
  - `type SeriesReadingStates = Record<string, SeriesReadingState>` (keyed by `series_key`)
  - `const seriesReadingState: Writable<SeriesReadingStates>`
  - `function readingStateFor(states: SeriesReadingStates, seriesKey: string): SeriesReadingState`
  - `function updateSeriesReadingState(seriesKey: string, patch: SeriesReadingStatePatchInput): SeriesReadingState`
  - `function parseSeriesSection(raw: unknown): SeriesReadingStates`
  - `function mergeSeriesSections(local: SeriesReadingStates, cloud: SeriesReadingStates): SeriesReadingStates`
  - `function clearSeriesReadingState(): void` (tests + "clear all data")

- [ ] **Step 1: Write the failing tests**

Create `src/lib/settings/series-data.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

import {
  SERIES_SECTION_KEY,
  clearSeriesReadingState,
  mergeSeriesSections,
  parseSeriesSection,
  readingStateFor,
  seriesReadingState,
  updateSeriesReadingState
} from './series-data';

describe('series reading state', () => {
  beforeEach(() => {
    clearSeriesReadingState();
    window.localStorage.clear();
  });

  it('reserves the section key so it can never collide with a volume uuid', () => {
    expect(SERIES_SECTION_KEY).toBe('series');
  });

  it('defaults to a zeroed state for an unknown series', () => {
    const state = readingStateFor(get(seriesReadingState), 'one piece');
    expect(state.read_count).toBe(0);
    expect(state.reread_prompt_suppressed).toBeUndefined();
    expect(state.tracking).toBeUndefined();
  });

  it('stamps every write and resolves a functional patch against the stored state', () => {
    const first = updateSeriesReadingState('one piece', { read_count: 1 });
    const second = updateSeriesReadingState('one piece', (existing) => ({
      read_count: existing.read_count + 1
    }));

    expect(second.read_count).toBe(2);
    expect(second.lastUpdated > first.lastUpdated).toBe(true);
    expect(get(seriesReadingState)['one piece'].read_count).toBe(2);
  });

  it('steps past a stored stamp that sits in the future (clock skew)', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    seriesReadingState.set({
      'one piece': { read_count: 1, lastUpdated: future }
    });

    const written = updateSeriesReadingState('one piece', { read_count: 2 });

    expect(written.lastUpdated > future).toBe(true);
  });

  it('clears a flag by patching it to undefined', () => {
    updateSeriesReadingState('one piece', { reread_prompt_suppressed: true });
    const cleared = updateSeriesReadingState('one piece', {
      reread_prompt_suppressed: undefined
    });

    expect('reread_prompt_suppressed' in cleared).toBe(false);
  });

  it('persists to localStorage under the volume-data section key', () => {
    updateSeriesReadingState('one piece', { read_count: 3 });
    expect(JSON.parse(window.localStorage.getItem('series-data')!)).toEqual({
      'one piece': { read_count: 3, lastUpdated: expect.any(String) }
    });
  });

  it('sanitizes an untrusted section: junk counts, junk flags, junk tracking', () => {
    const parsed = parseSeriesSection({
      'one piece': {
        read_count: -3,
        reread_prompt_suppressed: 'yes',
        tracking: { number_overrides: { 'vol-1': 2.5, 'vol-2': 4 }, enabled: true },
        lastUpdated: '2026-08-01T00:00:00.000Z'
      },
      berserk: { read_count: 2, lastUpdated: 'not a date' },
      '': { read_count: 9, lastUpdated: '2026-08-01T00:00:00.000Z' },
      nope: 'not an object'
    });

    expect(parsed).toEqual({
      'one piece': {
        read_count: 0,
        tracking: { number_overrides: { 'vol-2': 4 } },
        lastUpdated: '2026-08-01T00:00:00.000Z'
      },
      berserk: { read_count: 2, lastUpdated: new Date(0).toISOString() }
    });
  });

  it('merges newest-lastUpdated-wins per series, keeping local on a tie', () => {
    const local = {
      'one piece': { read_count: 2, lastUpdated: '2026-08-10T00:00:00.000Z' },
      berserk: { read_count: 1, lastUpdated: '2026-08-10T00:00:00.000Z' }
    };
    const cloud = {
      'one piece': { read_count: 5, lastUpdated: '2026-08-20T00:00:00.000Z' },
      berserk: { read_count: 9, lastUpdated: '2026-08-10T00:00:00.000Z' },
      vinland: { read_count: 1, lastUpdated: '2026-08-05T00:00:00.000Z' }
    };

    expect(mergeSeriesSections(local, cloud)).toEqual({
      'one piece': { read_count: 5, lastUpdated: '2026-08-20T00:00:00.000Z' },
      berserk: { read_count: 1, lastUpdated: '2026-08-10T00:00:00.000Z' },
      vinland: { read_count: 1, lastUpdated: '2026-08-05T00:00:00.000Z' }
    });
  });
});
```

Append to `src/lib/settings/volume-data.test.ts`:

```ts
describe('parseVolumesFromJson', () => {
  it('never turns the reserved series section into a phantom volume', () => {
    const parsed = parseVolumesFromJson(
      JSON.stringify({
        'vol-1': { progress: 3 },
        series: { 'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' } }
      })
    );

    expect(Object.keys(parsed)).toEqual(['vol-1']);
  });
});
```

Add `parseVolumesFromJson` to the `./volume-data` import block in that test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/settings/series-data.test.ts src/lib/settings/volume-data.test.ts`
Expected: FAIL — `./series-data` does not exist; the volume map contains a `series` entry.

- [ ] **Step 3: Write the store**

Create `src/lib/settings/series-data.ts`:

```ts
import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';
import { isRecord, normalizeUpdatedAt, sanitizeTracking } from '$lib/metadata/sanitize';
import type { SeriesTracking } from '$lib/metadata/types';

/**
 * Series-level READING STATE: how many times a series has been read, whether
 * its re-read prompt is muted, and the AniList tracking bookkeeping.
 *
 * This is per-user state, never a fact about the archives, so it travels with
 * the other per-user state — in `volume-data.json`, under the reserved
 * `series` key — and gains that file's per-key newest-wins merge. It is
 * deliberately NOT in `series.json` or `catalog.json`: those are shared with
 * everyone who can read the library folder.
 *
 * Keyed by `normalizeSeriesKey(series_title)`, the same key the local
 * `series_metadata` table uses.
 */

/**
 * The one key inside `volume-data.json` that is not a volume uuid. Volume uuids
 * are uuids, so nothing can collide with it — but `parseVolumesFromJson` still
 * skips it explicitly rather than relying on that.
 */
export const SERIES_SECTION_KEY = 'series';

/** localStorage key for the local copy (the volume map lives under `volumes`). */
export const SERIES_DATA_STORAGE_KEY = 'series-data';

export interface SeriesReadingState {
  /** Archived completed passes; `timesRead` = read_count + (all volumes completed now ? 1 : 0). */
  read_count: number;
  reread_prompt_suppressed?: boolean;
  tracking?: SeriesTracking;
  /** ISO merge key — newest wins per series, exactly like `lastProgressUpdate`. */
  lastUpdated: string;
}

export type SeriesReadingStates = Record<string, SeriesReadingState>;

export type SeriesReadingStatePatch = Partial<Omit<SeriesReadingState, 'lastUpdated'>>;

/**
 * Either a plain patch, or one built from the state as it is at write time.
 * Two writers touch the same series from different places — the progress
 * tracker (`tracking.last_pushed`) and the series panel (`read_count`) — and
 * both write whole objects, so a patch built from a state read earlier would
 * silently undo the other's edit.
 */
export type SeriesReadingStatePatchInput =
  | SeriesReadingStatePatch
  | ((existing: SeriesReadingState) => SeriesReadingStatePatch);

function emptyState(): SeriesReadingState {
  return { read_count: 0, lastUpdated: new Date(0).toISOString() };
}

/** The state for a series, or a zeroed one — callers never deal with `undefined`. */
export function readingStateFor(
  states: SeriesReadingStates,
  seriesKey: string
): SeriesReadingState {
  return states[seriesKey] ?? emptyState();
}

/** Drop `undefined` values so a cleared flag disappears from storage and JSON. */
function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/**
 * A local edit must always supersede what is stored, even when the stored stamp
 * is in the future (clock skew on another device, a hand-edited cloud file):
 * plain `now` would lose every merge until real time caught up.
 */
function nextTimestamp(existing: string | undefined, now: number = Date.now()): string {
  const previous = existing ? Date.parse(existing) : NaN;
  return new Date(Number.isNaN(previous) ? now : Math.max(now, previous + 1)).toISOString();
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate an untrusted `series` section (cloud JSON, or this device's own
 * localStorage after a hand edit).
 *
 * Entries that are not objects, or whose key is empty, are dropped. Every field
 * is validated with the same helpers the metadata files use: `read_count`
 * coerced to a non-negative integer, a boolean-or-absent
 * `reread_prompt_suppressed`, `tracking` validated field by field (it steers
 * writes to the user's AniList account), and `lastUpdated` normalized to ISO —
 * an unparsable stamp becomes the epoch, which loses every merge instead of
 * winning them all.
 */
export function parseSeriesSection(raw: unknown): SeriesReadingStates {
  if (!isRecord(raw)) return {};
  const out: SeriesReadingStates = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim() || !isRecord(value)) continue;
    const entry: SeriesReadingState = {
      read_count: isNonNegativeInteger(value.read_count) ? value.read_count : 0,
      lastUpdated: normalizeUpdatedAt(value.lastUpdated) ?? new Date(0).toISOString()
    };
    if (value.reread_prompt_suppressed === true) entry.reread_prompt_suppressed = true;
    const tracking = sanitizeTracking(value.tracking);
    if (tracking) entry.tracking = tracking;
    out[key] = entry;
  }

  return out;
}

/** Newest `lastUpdated` wins per series; a tie keeps local. */
export function mergeSeriesSections(
  local: SeriesReadingStates,
  cloud: SeriesReadingStates
): SeriesReadingStates {
  const merged: SeriesReadingStates = { ...local };
  for (const [key, cloudState] of Object.entries(cloud)) {
    const localState = merged[key];
    if (!localState || cloudState.lastUpdated > localState.lastUpdated) merged[key] = cloudState;
  }
  return merged;
}

const initial: SeriesReadingStates = browser
  ? parseSeriesSection(JSON.parse(window.localStorage.getItem(SERIES_DATA_STORAGE_KEY) || '{}'))
  : {};

export const seriesReadingState = writable<SeriesReadingStates>(initial);

seriesReadingState.subscribe((states) => {
  if (!browser) return;
  window.localStorage.setItem(SERIES_DATA_STORAGE_KEY, JSON.stringify(states));
});

/**
 * Merge `patch` into a series' state and stamp it. Synchronous: this is a plain
 * store over localStorage, so a UI read right after a write already sees it
 * (no liveQuery round-trip to race).
 */
export function updateSeriesReadingState(
  seriesKey: string,
  patch: SeriesReadingStatePatchInput
): SeriesReadingState {
  let written = emptyState();
  seriesReadingState.update((states) => {
    const existing = states[seriesKey] ?? emptyState();
    const resolved = typeof patch === 'function' ? patch(existing) : patch;
    written = stripUndefined<SeriesReadingState>({
      ...existing,
      ...resolved,
      lastUpdated: nextTimestamp(existing.lastUpdated)
    });
    return { ...states, [seriesKey]: written };
  });
  return written;
}

/** Read one series' state outside a component (`get` + default in one call). */
export function getSeriesReadingState(seriesKey: string): SeriesReadingState {
  return readingStateFor(get(seriesReadingState), seriesKey);
}

/** Replace the whole table — the sync merge's write-back, and tests. */
export function setSeriesReadingStates(states: SeriesReadingStates): void {
  seriesReadingState.set(states);
}

export function clearSeriesReadingState(): void {
  seriesReadingState.set({});
}
```

- [ ] **Step 4: Reserve the key in the volume map**

In `src/lib/settings/volume-data.ts`, import the constant and skip it:

```ts
import { SERIES_SECTION_KEY } from './series-data';
```

```ts
export function parseVolumesFromJson(storedData: string): Volumes {
  try {
    const parsed = JSON.parse(storedData);
    return Object.fromEntries(
      Object.entries(parsed)
        // Filter out entries with empty/invalid volume IDs (bug cleanup), and the
        // reserved `series` section — series-level reading state shares this file
        // but is not a volume (see `$lib/settings/series-data`).
        .filter(([key]) => key && key.length > 0 && key !== SERIES_SECTION_KEY)
        .map(([key, value]) => [key, VolumeData.fromJSON(value)])
    );
  } catch {
    return {};
  }
}
```

- [ ] **Step 5: Re-export from the settings barrel**

In `src/lib/settings/index.ts`:

```ts
export * from './volume-data';
export * from './series-data';
export * from './settings';
export * from './misc';
export * from './extraction';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/settings/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/settings/series-data.ts src/lib/settings/series-data.test.ts src/lib/settings/volume-data.ts src/lib/settings/volume-data.test.ts src/lib/settings/index.ts
git commit -m "feat(settings): series reading-state store backed by volume-data.json's series section"
```

---

### Task 4: Sync the `series` section through `volume-data.json`

**Files:**

- Modify: `src/lib/util/sync/unified-sync-service.ts:322-479` (download shape, merge, upload composition)
- Test: `src/lib/util/sync/unified-sync-service.test.ts`

**Interfaces:**

- Consumes: `parseSeriesSection`, `mergeSeriesSections`, `seriesReadingState`, `setSeriesReadingStates`, `SERIES_SECTION_KEY`, `SeriesReadingStates` from `$lib/settings`.
- Produces:
  - `interface CloudVolumeDataFile { volumes: Record<string, VolumeData>; series: SeriesReadingStates }`
  - `downloadVolumeDataFile(provider, reloadCacheOnFileNotFound?): Promise<CloudVolumeDataFile | null>` (was: the volume map directly).

- [ ] **Step 1: Update the existing duplicate-handling assertions**

In `src/lib/util/sync/unified-sync-service.test.ts`, the six calls to `svc.downloadVolumeDataFile(...)` now return `{ volumes, series }`. Make exactly these edits:

```ts
// 'merges the readable copies and skips a ghost duplicate…'
expect(result.volumes).toEqual(goodData);
expect(result.series).toEqual({});
```

```ts
// 'keeps the readable copy when the FIRST listed duplicate is the ghost'
expect(result.volumes).toEqual(goodData);
```

```ts
// 'tolerates NOT_FOUND from deleting a ghost duplicate (already converged)'
await expect(svc.downloadVolumeDataFile(provider)).resolves.toMatchObject({
  volumes: goodData
});
```

```ts
// 'merges duplicates newest-lastProgressUpdate-wins…'
expect(result.volumes['vol-1'].progress).toBe(9);
expect(result.volumes['vol-2'].progress).toBe(1);
```

`returns null after one cache refresh when every copy is missing` and `propagates transient download errors…` are unchanged.

- [ ] **Step 2: Write the failing section tests**

Add to the same file, after the duplicate-handling describe:

```ts
describe('the series section of volume-data.json', () => {
  const seriesJson = (series: unknown) => ({
    'vol-1': { lastProgressUpdate: '2026-01-02T00:00:00Z', progress: 5 },
    series
  });

  it('reads the section out of the file instead of treating it as a volume', async () => {
    stubCache([fileMeta('only')]);
    const provider = makeProvider(async () =>
      jsonBlob(
        seriesJson({ 'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' } })
      )
    );

    const result = await svc.downloadVolumeDataFile(provider);

    expect(Object.keys(result.volumes)).toEqual(['vol-1']);
    expect(result.series).toEqual({
      'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' }
    });
  });

  it('folds the section across duplicate copies, newest per series wins', async () => {
    const [first, second] = [fileMeta('first'), fileMeta('second')];
    stubCache([first, second]);
    const provider = makeProvider(async (file) =>
      jsonBlob(
        seriesJson(
          file.fileId === 'first'
            ? { 'one piece': { read_count: 1, lastUpdated: '2026-08-01T00:00:00.000Z' } }
            : { 'one piece': { read_count: 4, lastUpdated: '2026-08-20T00:00:00.000Z' } }
        )
      )
    );

    const result = await svc.downloadVolumeDataFile(provider);

    expect(result.series['one piece'].read_count).toBe(4);
  });

  it('writes the merged section back locally and uploads it beside the volumes', async () => {
    setSeriesReadingStates({
      berserk: { read_count: 7, lastUpdated: '2026-08-22T00:00:00.000Z' }
    });
    stubCache([fileMeta('only')]);
    const uploads: Array<{ path: string; body: unknown }> = [];
    const provider = {
      type: 'mega',
      downloadFile: vi.fn(async () =>
        jsonBlob(
          seriesJson({ 'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' } })
        )
      ),
      uploadFile: vi.fn(async (path: string, blob: Blob) => {
        uploads.push({ path, body: JSON.parse(await blob.text()) });
      })
    } as unknown as SyncProvider;

    await svc.syncVolumeData(provider);

    expect(get(seriesReadingState)).toEqual({
      berserk: { read_count: 7, lastUpdated: '2026-08-22T00:00:00.000Z' },
      'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' }
    });
    expect(uploads).toHaveLength(1);
    expect((uploads[0].body as Record<string, unknown>).series).toEqual({
      berserk: { read_count: 7, lastUpdated: '2026-08-22T00:00:00.000Z' },
      'one piece': { read_count: 2, lastUpdated: '2026-08-20T00:00:00.000Z' }
    });
  });

  it('omits the section entirely when there is no series state at all', async () => {
    setSeriesReadingStates({});
    stubCache([]);
    const uploads: Array<Record<string, unknown>> = [];
    const provider = {
      type: 'mega',
      downloadFile: vi.fn(),
      uploadFile: vi.fn(async (_path: string, blob: Blob) => {
        uploads.push(JSON.parse(await blob.text()));
      })
    } as unknown as SyncProvider;

    await svc.syncVolumeData(provider);

    // Nothing to say and nothing in the cloud: no upload at all.
    expect(uploads).toEqual([]);
  });
});
```

Extend the `$lib/settings` mock at the top of the file so the real series-data module is used for these tests:

```ts
vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  const seriesData = await vi.importActual<typeof import('$lib/settings/series-data')>(
    '$lib/settings/series-data'
  );
  return {
    ...seriesData,
    volumesWithTrash: writable({}),
    profiles: writable({}),
    profilesWithTrash: writable({}),
    migrateProfiles: vi.fn((p: unknown) => p),
    parseVolumesFromJson: vi.fn((json: string) => JSON.parse(json))
  };
});
```

and add the imports the new tests need:

```ts
import { get } from 'svelte/store';
import { seriesReadingState, setSeriesReadingStates } from '$lib/settings';
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/util/sync/unified-sync-service.test.ts`
Expected: FAIL — `result.volumes` is `undefined`; the uploaded body has no `series` key.

- [ ] **Step 4: Thread the section through download / merge / upload**

In `src/lib/util/sync/unified-sync-service.ts`, add the imports:

```ts
import {
  volumesWithTrash,
  profiles,
  profilesWithTrash,
  parseVolumesFromJson,
  migrateProfiles,
  parseSeriesSection,
  mergeSeriesSections,
  seriesReadingState,
  setSeriesReadingStates,
  SERIES_SECTION_KEY,
  type SeriesReadingStates
} from '$lib/settings';
```

Add the shape next to `SyncResult`:

```ts
/**
 * `volume-data.json` as it comes off the cloud: the volume map plus the
 * reserved `series` section (series-level reading state). Two independently
 * merged halves of one file — volumes by `lastProgressUpdate`, series by
 * `lastUpdated`.
 */
export interface CloudVolumeDataFile {
  volumes: Record<string, any>;
  series: SeriesReadingStates;
}
```

Rework `downloadVolumeDataFile` — the duplicate path folds both halves:

```ts
  private async downloadVolumeDataFile(
    provider: SyncProvider,
    reloadCacheOnFileNotFound = true
  ): Promise<CloudVolumeDataFile | null> {
    try {
      const volumeDataFiles = await this.findVolumeDataFiles(provider);

      if (volumeDataFiles.length === 0) {
        return null;
      }

      if (volumeDataFiles.length > 1) {
        console.log(
          `📦 Found ${volumeDataFiles.length} volume-data.json files - merging and deduplicating...`
        );

        const downloads = await Promise.allSettled(
          volumeDataFiles.map(async (file) => {
            const blob = await provider.downloadFile(file);
            const data = await this.blobToJson(blob);
            return {
              volumes: parseVolumesFromJson(JSON.stringify(data)),
              series: parseSeriesSection(data?.[SERIES_SECTION_KEY])
            };
          })
        );

        const transient = downloads.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected' && !this.isFileNotFoundError(result.reason)
        );
        if (transient) {
          throw transient.reason;
        }

        const readable = downloads
          .map((result, index) => ({ result, index }))
          .filter(
            (entry): entry is { result: PromiseFulfilledResult<CloudVolumeDataFile>; index: number } =>
              entry.result.status === 'fulfilled'
          );

        if (readable.length === 0) {
          throw (downloads[0] as PromiseRejectedResult).reason;
        }

        const merged: any = {};
        let mergedSeries: SeriesReadingStates = {};
        for (const entry of readable) {
          for (const [volumeId, volumeData] of Object.entries(entry.result.value.volumes)) {
            const existing = merged[volumeId];
            if (!existing) {
              merged[volumeId] = volumeData;
            } else {
              const existingTime = new Date(existing.lastProgressUpdate || 0).getTime();
              const newTime = new Date((volumeData as any).lastProgressUpdate || 0).getTime();
              if (newTime > existingTime) {
                merged[volumeId] = volumeData;
              }
            }
          }
          // The series section folds by its own key, newest `lastUpdated` wins.
          mergedSeries = mergeSeriesSections(mergedSeries, entry.result.value.series);
        }

        const keepIndex = readable[0].index;
        for (let i = 0; i < volumeDataFiles.length; i++) {
          if (i === keepIndex) continue;
          console.log(`🗑️ Deleting duplicate volume-data.json (${volumeDataFiles[i].fileId})`);
          try {
            await provider.deleteFile(volumeDataFiles[i]);
          } catch (error) {
            if (!this.isFileNotFoundError(error)) throw error;
          }
        }

        console.log(`✅ Merged ${readable.length} readable copies into 1`);
        return { volumes: merged, series: mergedSeries };
      }

      const blob = await provider.downloadFile(volumeDataFiles[0]);
      const data = await this.blobToJson(blob);
      return {
        volumes: parseVolumesFromJson(JSON.stringify(data)),
        series: parseSeriesSection(data?.[SERIES_SECTION_KEY])
      };
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        if (reloadCacheOnFileNotFound) {
          console.log('📥 Download failed with file not found - refreshing cache and retrying...');
          const cache = cacheManager.getCache(provider.type);
          if (cache) {
            await cache.fetch();
          }
          return await this.downloadVolumeDataFile(provider, false);
        } else {
          return null;
        }
      }
      throw error;
    }
  }
```

Compose the payload and use it in `syncVolumeData`:

```ts
  /**
   * The bytes of `volume-data.json`: the volume map, plus the `series` section
   * when there is any. Omitted when empty so a library that has never had
   * series-level state produces byte-identical files to before this existed —
   * no spurious upload, no mtime churn on every other device.
   */
  private composeVolumeDataFile(volumes: any, series: SeriesReadingStates): any {
    return Object.keys(series).length > 0
      ? { ...volumes, [SERIES_SECTION_KEY]: series }
      : { ...volumes };
  }

  private async syncVolumeData(provider: SyncProvider): Promise<void> {
    // Step 1: Download cloud data (volumes + the series section)
    const cloud = await this.downloadVolumeDataFile(provider);

    // Step 2: Get local data (including tombstones for deletion sync)
    const localVolumes = get(volumesWithTrash);

    // Step 3: Merge each half by its own key
    const mergedVolumes = this.mergeVolumeData(localVolumes, cloud?.volumes || {});
    const mergedSeries = mergeSeriesSections(get(seriesReadingState), cloud?.series ?? {});

    // Step 4: Purge tombstones older than 30 days
    const purgedVolumes = this.purgeTombstones(mergedVolumes);

    // Step 5: Update local storage (including tombstones)
    volumesWithTrash.set(purgedVolumes);
    setSeriesReadingStates(mergedSeries);

    // Step 6: Upload if anything differs from what the cloud holds
    const nextFile = this.composeVolumeDataFile(purgedVolumes, mergedSeries);
    const cloudFile = this.composeVolumeDataFile(cloud?.volumes ?? {}, cloud?.series ?? {});

    if (JSON.stringify(nextFile) !== JSON.stringify(cloudFile)) {
      await this.uploadVolumeDataFile(provider, nextFile);
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/util/sync/unified-sync-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/util/sync/unified-sync-service.ts src/lib/util/sync/unified-sync-service.test.ts
git commit -m "feat(sync): carry series reading state in volume-data.json's series section"
```

---

### Task 5: Retire `series-metadata.json`

**Files:**

- Delete: `src/lib/metadata/merge.ts`, `src/lib/metadata/merge.test.ts`
- Modify: `src/lib/util/sync/unified-sync-service.ts` (remove `syncSeriesMetadata` + helpers + `stableStringify`)
- Modify: `src/lib/util/sync/unified-sync-service.test.ts` (delete the `syncSeriesMetadata` describe)
- Modify: `src/lib/util/sync/syncable-file.ts:1-31,60-79` (allowlist + comments)
- Modify: `src/lib/util/sync/syncable-file.test.ts`
- Modify: `src/lib/util/sync/providers/google-drive/drive-files-cache.ts:120` (comment)
- Modify: `src/lib/metadata/sanitize.ts` (drop `sanitizeTitlePreference`, `sanitizeVolumeOffsets`)
- Modify: `src/lib/metadata/series-file.ts:392-403` (comment), `src/lib/metadata/catalog-file.ts:21,272` (comments), `src/lib/metadata/types.ts:29-33` (comment), `src/lib/metadata/store.ts` (comments)

**Interfaces:**

- Consumes: nothing new.
- Produces: `isRootConfigFile('series-metadata.json') === false`. `mergeSeriesMetadata`, `sanitizeCloudSeriesMetadata`, `sanitizeTitlePreference` and `sanitizeVolumeOffsets` no longer exist. `getAllSeriesMetadata` / `replaceAllSeriesMetadata` keep their signatures (still used by the catalog writer and the tracker).

- [ ] **Step 1: Write the failing allowlist test**

In `src/lib/util/sync/syncable-file.test.ts`, replace the two `series-metadata.json` expectations with:

```ts
it('no longer treats series-metadata.json as a root config file', () => {
  // Retired 2026-08-23: facts ride series.json, reading state rides
  // volume-data.json. A stale copy in an existing cloud folder is inert junk —
  // never listed, never downloaded, never written.
  expect(isRootConfigFile('series-metadata.json')).toBe(false);
  expect(isSyncableFile('series-metadata.json')).toBe(false);
});
```

Check the file's existing imports and add `isRootConfigFile`/`isSyncableFile` only if they are missing.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/util/sync/syncable-file.test.ts`
Expected: FAIL — both return `true`.

- [ ] **Step 3: Delete the root file machinery**

```bash
git rm src/lib/metadata/merge.ts src/lib/metadata/merge.test.ts
```

In `src/lib/util/sync/unified-sync-service.ts` delete:

- the imports `getAllSeriesMetadata`, `replaceAllSeriesMetadata`, `mergeSeriesMetadata`, `sanitizeCloudSeriesMetadata`, `type SeriesMetadata`;
- the `stableStringify` and `sortKeysDeep` helpers (they existed only for that comparison);
- the methods `findSeriesMetadataFile`, `downloadSeriesMetadataFile`, `uploadSeriesMetadataFile`, `syncSeriesMetadata`;
- the call site in `syncProvider`:

```ts
// Sync volume data (read progress + series-level reading state)
console.log('🔄 Syncing volume data...');
await this.syncVolumeData(provider);
console.log('✅ Volume data synced');
```

(that whole `try { await this.syncSeriesMetadata(provider); } catch …` block goes.)

In `src/lib/util/sync/unified-sync-service.test.ts` delete the entire `describe('syncSeriesMetadata — series-metadata.json', …)` block and the `vi.mock('$lib/metadata/store', …)` factory with its `localSeries`/`replaceAll` fixtures.

In `src/lib/util/sync/syncable-file.ts`:

```ts
 * - Root config files: volume-data.json (read progress + series-level reading
 *   state) and profiles.json (settings profiles), plus catalog.json (the
 *   compiled library index)
```

```ts
const ROOT_CONFIG_FILENAMES = new Set(['volume-data.json', 'profiles.json', CATALOG_FILE_NAME]);
```

and, in the `isBestEffortMetadataPath` doc comment:

```ts
 * Progress (`volume-data.json`) and profiles are deliberately NOT in this set:
 * those are the user's own state, and a silent failure there really is a
 * problem worth surfacing.
```

Below `ROOT_CONFIG_FILENAMES`, add the tolerate-and-ignore note:

```ts
// series-metadata.json is deliberately NOT listed: it was retired on 2026-08-23
// before ever shipping (facts moved to <Series>/series.json, reading state to
// volume-data.json's `series` section). A stale copy may still sit in a folder
// somebody synced from a dev build — keep ignoring it, exactly like libraries.json.
```

In `src/lib/util/sync/providers/google-drive/drive-files-cache.ts:120`:

```ts
// volume-data.json, profiles.json, catalog.json
```

- [ ] **Step 4: Drop the now-unused sanitizers**

In `src/lib/metadata/sanitize.ts`, delete `sanitizeTitlePreference` (its only caller was `merge.ts`; the profile-level `preferredTitleLanguage` uses `isDisplayTitleLanguage`, which stays) and `sanitizeVolumeOffsets` (the map form; `sanitizeVolumeOffset` from Task 1 is what the sidecar uses). Update the module doc comment:

```ts
/**
 * Shared validation rules for untrusted series metadata. Every boundary where
 * foreign data enters the app — the per-series `series.json` sidecar
 * (`series-file.ts`), the root `catalog.json` (`catalog-file.ts`) and the
 * `series` section of `volume-data.json` (`$lib/settings/series-data`) — uses
 * these, so a value rejected in one place cannot slip through another.
 */
```

- [ ] **Step 5: Fix the comments that name the dead file**

- `src/lib/metadata/types.ts:29-33` →

```ts
/**
 * Per-series metadata record. PK = normalizeSeriesKey(series_title).
 * LOCAL storage only — this table is never uploaded as a whole. The facts
 * (`external_ids`/`titles`/`synonyms`/`tag`/`unit`) are shared per series via
 * `series.json` (`series-file.ts`) and compiled into `catalog.json`; the shelf
 * alignment rides the same file as index data.
 */
```

- `src/lib/metadata/series-file.ts` (`parseSeriesFile` doc) → "…every field is re-validated with the shared helpers in `sanitize.ts`…" (drop "the same helpers the `series-metadata.json` merge uses").
- `src/lib/metadata/catalog-file.ts:21` → `/** Basename of the root catalog file, stored at the root of the library folder. */`
- `src/lib/metadata/catalog-file.ts:272` → "…so every field goes through the same sanitizers `series.json` uses…".
- `src/lib/metadata/store.ts`: in `factsStamp`'s and `changesFacts`'s comments, replace "root series-metadata.json" / "title-preference toggle" with "a spine-offset nudge, a finished reread or a tracking push"; in `upsertFromSeriesFile`'s comment, replace the sentence about "the root series-metadata.json merge is newest updated_at wins" with:

```ts
// The record's own stamp never moves backwards: `moveSeriesMetadataKey`
// resolves a rename collision by it, and lowering it to an older file
// stamp would let a pre-link copy of the record win that comparison.
```

- [ ] **Step 6: Run everything**

Run: `npx vitest run && npm run check`
Expected: PASS, no type errors. `npm run check` is what catches a leftover import of the deleted module.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(sync)!: retire series-metadata.json — no root file, no merge machinery"
```

---

### Task 6: Reading state moves off `SeriesMetadata`

**Files:**

- Modify: `src/lib/metadata/types.ts` (drop `read_count`, `reread_prompt_suppressed`, `tracking`; keep `SeriesTracking` itself)
- Modify: `src/lib/metadata/reread.ts`
- Modify: `src/lib/metadata/progress-tracker.ts`
- Modify: `src/lib/components/Series/SeriesTrackingPanel.svelte`, `SeriesMetadataBar.svelte`
- Modify: `src/lib/components/Reader/Reader.svelte:99-117`, `src/lib/components/Reader/RereadPromptModal.svelte:60-70`
- Test: `src/lib/metadata/reread.test.ts`, `src/lib/metadata/progress-tracker.test.ts`, `src/lib/components/Series/__tests__/SeriesTrackingPanel.test.ts`, `src/lib/components/Series/__tests__/SeriesMetadataBar.test.ts`

**Interfaces:**

- Consumes: `seriesReadingState`, `readingStateFor`, `getSeriesReadingState`, `updateSeriesReadingState`, `SeriesReadingState` from `$lib/settings/series-data`.
- Produces:
  - `SeriesMetadata` = `{ series_key, series_title, external_ids, titles, synonyms, tag?, unit?, spine_offset?, volume_offsets?, format?, status?, total_volumes?, total_chapters?, cover_url?, title_preference?, updated_at, facts_updated_at?, linked_at? }` (the AniList display fields and `title_preference` leave in Task 7).
  - `shouldOfferReread(args: { volumeUuid; seriesVolumes; volumesData; suppressed: boolean; seriesKey }): boolean`
  - `suppressRereadPrompt(seriesTitle: string): void` (synchronous now)
  - `restartSeries(seriesTitle, seriesVolumes): Promise<void>` (unchanged signature)
  - `volumeNumberFor(volume, sortedSeriesVolumes, tracking: SeriesTracking | undefined, unit: TrackingUnit): number`
  - `computeLocalPassState(seriesVolumes, volumesData, state: SeriesReadingState | undefined, unit: TrackingUnit): LocalPassState`

- [ ] **Step 1: Write the failing tests**

In `src/lib/metadata/reread.test.ts`, replace the `meta`-carrying arguments with the flag and the store. The three call shapes to change:

```ts
// shouldOfferReread(...) — every call site in this file
expect(
  shouldOfferReread({
    volumeUuid: 'v1',
    seriesVolumes,
    volumesData,
    suppressed: false,
    seriesKey: 'one piece'
  })
).toBe(true);
```

```ts
// 'respects the per-series suppression and the session dismissal'
expect(
  shouldOfferReread({
    volumeUuid: 'v1',
    seriesVolumes,
    volumesData,
    suppressed: true,
    seriesKey: 'one piece'
  })
).toBe(false);
```

and add:

```ts
it('bumps read_count in the reading-state store, not on the metadata record', async () => {
  clearSeriesReadingState();
  await restartSeries('One Piece', seriesVolumes);

  expect(getSeriesReadingState('one piece').read_count).toBe(1);
  expect(getSeriesReadingState('one piece').reread_prompt_suppressed).toBeUndefined();
});

it('suppressRereadPrompt writes the flag to the reading-state store', () => {
  clearSeriesReadingState();
  suppressRereadPrompt('One Piece');

  expect(getSeriesReadingState('one piece').reread_prompt_suppressed).toBe(true);
});
```

Point the file's existing `vi.mock('./store', …)` at the reading-state store instead (the record store is no longer touched by `reread.ts`): delete the `updateSeriesMetadata` mock and import `clearSeriesReadingState`, `getSeriesReadingState` from `$lib/settings/series-data`. The two tests named `archives, bumps read_count…` and `does not touch read_count…` assert on `getSeriesReadingState('one piece').read_count` instead of the recorded metadata patch.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/metadata/reread.test.ts`
Expected: FAIL — `suppressed` is not read; `restartSeries` still writes the record.

- [ ] **Step 3: Move the fields off the type**

In `src/lib/metadata/types.ts`, delete from `SeriesMetadata`:

```ts
  read_count: number;
  reread_prompt_suppressed?: boolean;
  tracking?: SeriesTracking;
```

and add a pointer above `SeriesTracking` (which stays — the reading-state store owns instances of it now):

```ts
/**
 * Per-series push bookkeeping. Stored in the reading-state store
 * (`$lib/settings/series-data`), never on the shared record: it is per-user
 * state, and it travels in `volume-data.json`'s `series` section.
 *
 * Neither a switch nor a unit lives here any more: pushing is one global setting
 * (`catalogSettings.pushProgressToAniList`) and the unit is an objective fact
 * about the archives (`SeriesMetadata.unit`).
 */
```

In `createEmptySeriesMetadata`, drop `read_count: 0`.

- [ ] **Step 4: Rewrite `reread.ts`**

```ts
import { browser } from '$app/environment';
import { get } from 'svelte/store';
import { sortVolumes } from '$lib/catalog/sort-volumes';
import { archiveAndResetVolumes, volumes, type VolumeData } from '$lib/settings/volume-data';
import { updateSeriesReadingState } from '$lib/settings/series-data';
import type { VolumeMetadata } from '$lib/types';
import { onSeriesRestarted } from './progress-tracker';
import { normalizeSeriesKey } from './series-key';

const sessionKey = (seriesKey: string) => `reread_dismissed:${seriesKey}`;

/** Cloud-only placeholders (never downloaded) don't count as "read" or "unread" —
 * exclude them from both the "first volume" and "all completed" checks. */
const localOnly = (volumes: VolumeMetadata[]) => volumes.filter((v) => !v.isPlaceholder);

/**
 * Offer a restart only when the reader opens the FIRST local volume (sort order,
 * placeholders excluded) of a series whose every local volume is completed,
 * unless the user suppressed the prompt for this series or dismissed it this
 * session. Opening a later volume is browsing.
 *
 * `suppressed` is passed in rather than read here: it lives in the reading-state
 * store, which the caller already holds (synchronously — no DB round trip).
 */
export function shouldOfferReread(args: {
  volumeUuid: string;
  seriesVolumes: VolumeMetadata[];
  volumesData: Record<string, Pick<VolumeData, 'completed'> | undefined>;
  suppressed: boolean;
  seriesKey: string;
}): boolean {
  const sorted = [...localOnly(args.seriesVolumes)].sort(sortVolumes);
  if (sorted.length === 0 || sorted[0].volume_uuid !== args.volumeUuid) return false;
  if (args.suppressed) return false;
  if (browser && sessionStorage.getItem(sessionKey(args.seriesKey))) return false;
  return sorted.every((v) => args.volumesData[v.volume_uuid]?.completed === true);
}

export function dismissRereadForSession(seriesKey: string): void {
  if (browser) sessionStorage.setItem(sessionKey(seriesKey), '1');
}

export function suppressRereadPrompt(seriesTitle: string): void {
  updateSeriesReadingState(normalizeSeriesKey(seriesTitle), { reread_prompt_suppressed: true });
}

/**
 * Restart series: archive every local volume's current read (stats kept), reset
 * to the start, bump read_count when the whole (local) series had been read,
 * clear the prompt suppression, and tell the tracker (REPEATING / progress 0).
 * Placeholders (cloud-only, never downloaded) are neither archived/reset nor
 * counted toward "was fully completed".
 */
export async function restartSeries(
  seriesTitle: string,
  seriesVolumes: VolumeMetadata[]
): Promise<void> {
  const seriesKey = normalizeSeriesKey(seriesTitle);
  const local = localOnly(seriesVolumes);
  const data = get(volumes);
  const wasFullyCompleted =
    local.length > 0 && local.every((v) => data[v.volume_uuid]?.completed === true);

  archiveAndResetVolumes(local.map((v) => v.volume_uuid));

  // Functional patch: the tracker writes `tracking.last_pushed` for the same
  // series from another module.
  updateSeriesReadingState(seriesKey, (existing) => ({
    read_count: wasFullyCompleted ? existing.read_count + 1 : existing.read_count,
    reread_prompt_suppressed: undefined
  }));
  if (browser) sessionStorage.removeItem(sessionKey(seriesKey));

  onSeriesRestarted(seriesKey);
}
```

`RereadPromptModal.svelte:66` loses its `await`:

```svelte
suppressRereadPrompt(seriesTitle);
```

- [ ] **Step 5: Move the tracker onto the store**

In `src/lib/metadata/progress-tracker.ts`:

```ts
import { getSeriesReadingState, updateSeriesReadingState } from '$lib/settings/series-data';
import type { SeriesReadingState } from '$lib/settings/series-data';
import type { SeriesTracking } from './types';
```

```ts
/**
 * `unit` is a parameter, not something resolved here: detection regex-scans
 * every title in the series, so resolving it per volume would be O(n²) on a
 * long series — and this runs inside `$derived`s on the series page.
 */
export function volumeNumberFor(
  volume: VolumeMetadata,
  sortedSeriesVolumes: VolumeMetadata[],
  tracking: SeriesTracking | undefined,
  unit: TrackingUnit
): number {
  const override = tracking?.number_overrides?.[volume.volume_uuid];
  if (typeof override === 'number' && override > 0) return override;
  const parsed = extractVolumeNumber(volume.volume_title, unit);
  if (parsed !== undefined) return parsed;
  return sortedSeriesVolumes.findIndex((v) => v.volume_uuid === volume.volume_uuid) + 1;
}

/**
 * `unit` is resolved by the caller — from the FULL title list (cloud
 * placeholders included), which this function's `seriesVolumes` deliberately is
 * not. `state` is the series' reading state; `undefined` means "never read".
 */
export function computeLocalPassState(
  seriesVolumes: VolumeMetadata[],
  volumesData: Record<string, Pick<VolumeData, 'completed'> | undefined>,
  state: SeriesReadingState | undefined,
  unit: TrackingUnit
): LocalPassState {
  const sorted = [...seriesVolumes].sort(sortVolumes);
  let passProgress = 0;
  let allCompleted = sorted.length > 0;
  for (const volume of sorted) {
    if (volumesData[volume.volume_uuid]?.completed) {
      passProgress = Math.max(passProgress, volumeNumberFor(volume, sorted, state?.tracking, unit));
    } else {
      allCompleted = false;
    }
  }
  const readCount = state?.read_count ?? 0;
  return {
    passProgress,
    allCompleted,
    // Totals are not stored anywhere; the push path fills this in from the
    // AniList response (see `runPush`). Without them a pass is never "complete".
    passComplete: false,
    timesRead: readCount + (allCompleted ? 1 : 0),
    rereading: readCount >= 1 && !allCompleted
  };
}
```

In `alreadySettled`, take the state instead of the record:

```ts
function alreadySettled(
  seriesKey: string,
  local: LocalPassState,
  state: SeriesReadingState,
  unit: TrackingUnit
): boolean {
  const recent = recentCompletions.get(seriesKey);
  if (
    recent &&
    recent.signature === passSignature(local) &&
    Date.now() - recent.at < COMPLETION_DEBOUNCE_MS
  ) {
    return true;
  }
  const lastPushed = state.tracking?.last_pushed;
  …
}
```

In `runPush`, read the state alongside the record and write `last_pushed` through the store:

```ts
const seriesVolumes = await getSeriesVolumesByKey(seriesKey);
const state = getSeriesReadingState(seriesKey);
const unit = await resolveUnitForPush(seriesKey, meta, seriesVolumes);
const local = computeLocalPassState(seriesVolumes, get(volumes), state, unit);

if (event === 'completion') {
  if (alreadySettled(seriesKey, local, state, unit)) return 'nothing';
  recentCompletions.set(seriesKey, { signature: passSignature(local), at: Date.now() });
}
```

```ts
const unchangedProgress =
  (unit === 'chapters' ? remote?.progress : remote?.progressVolumes) ??
  state.tracking?.last_pushed?.n ??
  0;
// A functional patch, resolved against the state as it is now: two round
// trips happened since `state` was read and a number override may have
// landed in between.
updateSeriesReadingState(seriesKey, (existing) => ({
  tracking: {
    ...(existing.tracking ?? {}),
    last_pushed: {
      n:
        plan.progressVolumes ??
        plan.progress ??
        (event === 'read_count' ? unchangedProgress : local.passProgress),
      status: plan.status ?? remote?.status ?? 'CURRENT',
      at: new Date().toISOString()
    }
  }
}));
return 'pushed';
```

Delete the now-unused `const current = (await getSeriesMetadata(seriesKey)) ?? meta;` line and the `updateSeriesMetadata` import if nothing else in the module uses it (`resolveUnitForPush` and `pushEnabled` only read).

- [ ] **Step 6: Move the two panels**

`SeriesTrackingPanel.svelte` — swap the imports and the four derived values, and delete the optimistic-count block (a store write is visible on the next read; there is no liveQuery to race):

```svelte
  import { seriesMetadataMap, updateSeriesMetadata, type SeriesMetadataPatchInput } from '$lib/metadata/store';
  import {
    readingStateFor,
    seriesReadingState,
    updateSeriesReadingState
  } from '$lib/settings/series-data';
```

```svelte
let meta = $derived($seriesMetadataMap.get(seriesKey)); let state =
$derived(readingStateFor($seriesReadingState, seriesKey)); let readCount =
$derived(state.read_count); let lastPushed = $derived(state.tracking?.last_pushed); let passState =
$derived(computeLocalPassState(localVolumes, $volumesStore, state, resolvedUnit));
```

```svelte
  function setReadCount(delta: number) {
    const before = readCount;
    const next = Math.max(0, before + delta);
    // The − button is disabled at 0, and a second fast click lands here too:
    // either way a no-op must not spend a write (and the sync it would cause).
    if (next === before) return;
    try {
      // Functional patch: `restartSeries` bumps the same counter from another
      // module, so the delta applies to the state as stored.
      updateSeriesReadingState(seriesKey, (existing) => ({
        read_count: Math.max(0, existing.read_count + delta)
      }));
    } catch (error) {
      console.error('[series-tracking] could not save the read count:', error);
      showSnackbar("Couldn't save the read count");
      return;
    }
    // "Read N times" is AniList's repeat count. Nothing else pushes it — a
    // correction here is deliberate, so it travels in both directions.
    onReadCountChanged(seriesKey)
      .then((outcome) => {
        if (outcome === 'failed') showSnackbar('AniList rejected the read count');
      })
      .catch((error) => console.warn('[series-tracking] read count push failed:', error));
  }

  /** The reader's "Don't ask for this series" is permanent — this is its undo. */
  function askAgainAboutRereads() {
    try {
      updateSeriesReadingState(seriesKey, { reread_prompt_suppressed: undefined });
    } catch (error) {
      console.error('[series-tracking] could not reset the re-read prompt:', error);
      showSnackbar("Couldn't reset the re-read prompt");
    }
  }
```

and in the markup, `{#if meta?.reread_prompt_suppressed}` becomes `{#if state.reread_prompt_suppressed}`. The `write()` helper and `setUnit` stay exactly as they are — the unit is still a fact on the record.

`SeriesMetadataBar.svelte`:

```svelte
import {(readingStateFor, seriesReadingState)} from '$lib/settings/series-data';
```

```svelte
let state = $derived(readingStateFor($seriesReadingState, normalizeSeriesKey(seriesTitle))); let
passState = $derived(computeLocalPassState(localVolumes, $volumesData, state, resolvedUnit)); let
lastPushed = $derived(state.tracking?.last_pushed);
```

`Reader.svelte` — the suppression flag is synchronous now, so it no longer needs the DB read to be honest about it:

```svelte
        if (
          shouldOfferReread({
            volumeUuid: v.volume_uuid,
            seriesVolumes,
            volumesData: get(volumes),
            suppressed: getSeriesReadingState(seriesKey).reread_prompt_suppressed === true,
            seriesKey
          })
        ) {
```

with `import { getSeriesReadingState } from '$lib/settings/series-data';` added. Keep the surrounding `getSeriesMetadataForTitle` read — it still supplies `rereadDisplayTitle` — but replace its stale comment:

```svelte
// The record read is for the display title only; the suppression flag comes // from the
reading-state store, which is synchronous and therefore always // current (a just-finished
restartSeries() has already cleared it).
```

- [ ] **Step 7: Update the tracker and panel tests**

In `src/lib/components/Series/__tests__/SeriesTrackingPanel.test.ts`:

- add a hoisted store for the reading state and mock the module:

```ts
    seriesReadingState: createStore<Record<string, unknown>>({}),
```

```ts
vi.mock('$lib/settings/series-data', () => ({
  seriesReadingState: h.seriesReadingState,
  readingStateFor: (states: Record<string, any>, key: string) =>
    states[key] ?? { read_count: 0, lastUpdated: new Date(0).toISOString() },
  updateSeriesReadingState: vi.fn(
    (
      key: string,
      patch:
        | Record<string, unknown>
        | ((existing: Record<string, unknown>) => Record<string, unknown>)
    ) => {
      const states = h.seriesReadingState.get();
      const existing = states[key] ?? { read_count: 0, lastUpdated: new Date(0).toISOString() };
      const resolved = typeof patch === 'function' ? patch(existing as any) : patch;
      const next = Object.fromEntries(
        Object.entries({ ...existing, ...resolved, lastUpdated: new Date().toISOString() }).filter(
          ([, v]) => v !== undefined
        )
      );
      h.seriesReadingState.set({ ...states, [key]: next });
      return next;
    }
  )
}));
```

- the read-count tests seed `h.seriesReadingState.set({ 'one piece': { read_count: N, lastUpdated: '…' } })` instead of putting `read_count` on the metadata record, and assert against `h.seriesReadingState.get()['one piece'].read_count`;
- `lands both of two rapid clicks instead of writing the same value twice` keeps its meaning (the store is synchronous, so the second click reads the first click's value) — only the seeding/assertions change;
- `reports a failed write` mocks `updateSeriesReadingState` to throw once and asserts the snackbar;
- the re-read suppression group seeds/asserts `reread_prompt_suppressed` on the same store.

`SeriesMetadataBar.test.ts` gets the same mock and seeds `read_count`/`tracking.last_pushed` there.

`progress-tracker.test.ts`: every `computeLocalPassState(volumes, data, meta, unit)` call passes a reading state (`{ read_count: n, lastUpdated: '…' }` or `undefined`) instead of the record, and every `volumeNumberFor(volume, sorted, meta, unit)` passes `meta.tracking` (now `state.tracking`). Where a test asserted `passComplete` from `total_volumes`, move it to Task 7's totals-aware coverage (delete it here and re-add it there — Task 7 Step 1 re-adds them explicitly).

- [ ] **Step 8: Run everything**

Run: `npx vitest run && npm run check`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(metadata): series reading state moves to volume-data.json's series section"
```

---

### Task 7: AniList display data stops being stored

**Files:**

- Modify: `src/lib/metadata/types.ts` (drop `format`/`status`/`total_volumes`/`total_chapters`/`cover_url`/`title_preference`; add `SeriesTotals`)
- Modify: `src/lib/metadata/store.ts` (`unlinkSeries`, `upsertFromSeriesFile` link-change clearing)
- Modify: `src/lib/metadata/providers/anilist.ts:180-201` (`toSeriesMetadataPatch`)
- Modify: `src/lib/metadata/tracking-unit.ts` (totals become a parameter)
- Modify: `src/lib/metadata/progress-tracker.ts` (`REMOTE_QUERY`, `fetchRemoteEntry`, `resolveUnitForPush`, `runPush`)
- Modify: `src/lib/metadata/display-title.ts:33` (comment)
- Test: `src/lib/metadata/progress-tracker.test.ts`, `src/lib/metadata/providers/anilist.test.ts`, `src/lib/metadata/store.test.ts`, `src/lib/metadata/tracking-unit.test.ts`, `src/lib/metadata/display-title.test.ts`

**Interfaces:**

- Consumes: `detectTrackingUnit(volumeTitles, totals?)` (unchanged, still takes `{ total_volumes?, total_chapters? }`).
- Produces:
  - `interface SeriesTotals { volumes?: number; chapters?: number }` (in `./types`) — fetched, never stored.
  - `resolveTrackingUnit(meta: Pick<SeriesMetadata,'unit'> | undefined, seriesVolumes, totals?: SeriesTotals)`
  - `computeLocalPassState(seriesVolumes, volumesData, state, unit, totals?: SeriesTotals)` — `passComplete` is true only when totals say so.
  - `toSeriesMetadataPatch(r)` returns `{ external_ids, titles, synonyms }` only.

- [ ] **Step 1: Write the failing tests**

In `src/lib/metadata/providers/anilist.test.ts`, replace the `toSeriesMetadataPatch` expectation:

```ts
it('toSeriesMetadataPatch maps a result to the FACTS only — display data is never stored', () => {
  expect(toSeriesMetadataPatch(r)).toEqual({
    external_ids: { anilist: 30013, mal: 13 },
    titles: { native: 'ワンピース', romaji: 'One Piece', english: 'One Piece' },
    synonyms: ['OP']
  });
});
```

(keep the existing `r` fixture and the `noMal` case, whose expectation becomes `{ anilist: 30013 }` with the same three keys.)

In `src/lib/metadata/progress-tracker.test.ts`, add:

```ts
  it('asks AniList for the series totals in the same request as the entry', async () => {
    const queries: string[] = [];
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      queries.push(JSON.parse(String(init.body)).query);
      return anilistResponse({
        Media: { volumes: 5, chapters: 100, mediaListEntry: null }
      });
    });

    await syncSeriesNow('one piece');

    expect(queries[0]).toContain('volumes');
    expect(queries[0]).toContain('chapters');
  });

  it('marks a pass COMPLETED from the fetched totals, never from a stored count', async () => {
    // 5 volumes locally, all completed; AniList says the series has 5.
    …seed five completed volumes…
    fetchMock.mockImplementation(async () =>
      anilistResponse({ Media: { volumes: 5, chapters: null, mediaListEntry: null } })
    );

    await syncSeriesNow('one piece');

    expect(lastMutationVariables()).toMatchObject({ status: 'COMPLETED', progressVolumes: 5 });
  });
```

Use the file's existing AniList fetch/mutation helpers rather than inventing new ones — read the top of `progress-tracker.test.ts` and reuse `anilistResponse` / the mutation-capture helper it already defines, renaming the calls above to match.

In `src/lib/metadata/tracking-unit.test.ts`, add:

```ts
it('uses the overshoot rule only when the caller supplies totals', () => {
  const titles = [{ volume_title: '150' }];

  expect(resolveTrackingUnit(undefined, titles).unit).toBe('volumes');
  expect(resolveTrackingUnit(undefined, titles, { volumes: 20, chapters: 900 }).unit).toBe(
    'chapters'
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/metadata/providers/anilist.test.ts src/lib/metadata/tracking-unit.test.ts src/lib/metadata/progress-tracker.test.ts`
Expected: FAIL — the patch still carries `format`/`status`/totals; `resolveTrackingUnit` takes two arguments.

- [ ] **Step 3: Shrink the record**

In `src/lib/metadata/types.ts`, delete `format`, `status`, `total_volumes`, `total_chapters`, `cover_url` and `title_preference` from `SeriesMetadata`, delete the now-unused `DisplayTitleLanguage` import usage there **only if** nothing else in the file needs it (the type itself stays exported — `settings.ts` uses it), and add:

```ts
/**
 * Series totals as AniList reports them. FETCHED, never stored: they belong to
 * the external record, they go stale, and the one place that needs them (the
 * push) already makes the request that carries them.
 */
export interface SeriesTotals {
  volumes?: number;
  chapters?: number;
}
```

In `src/lib/metadata/store.ts`:

```ts
/**
 * Remove the external link and the facts it brought; keep everything this
 * library owns — `tag`, the shelf alignment, `unit` (it describes the archives
 * in the folder, not the link that was just removed).
 */
export async function unlinkSeries(seriesTitle: string): Promise<SeriesMetadata> {
  return updateSeriesMetadata(seriesTitle, {
    external_ids: {},
    titles: {},
    synonyms: [],
    linked_at: undefined
  });
}
```

and in `upsertFromSeriesFile` delete the `linkChanged ? { format: undefined, … } : {}` spread and the `linkChanged` variable's only other use — keep `linkChanged` itself, `linked_at` still needs it. Delete the doc paragraph beginning "The file carries no fetched facts (`format`/`status`/totals/`cover_url`)".

In `src/lib/metadata/providers/anilist.ts`:

```ts
/**
 * Fields to write into the SeriesMetadata record when the user picks a result:
 * the FACTS, and nothing else.
 *
 * The display data a result also carries (`format`, `status`, volume/chapter
 * totals, cover art) is deliberately not stored — it belongs to AniList, it goes
 * stale, and the two places that want it have it already: the link picker shows
 * it straight off the search result, and the tracker fetches the totals in the
 * request it makes anyway.
 */
export function toSeriesMetadataPatch(r: MetadataSearchResult): SeriesMetadataPatch {
  return {
    external_ids: r.idMal != null ? { anilist: r.id, mal: r.idMal } : { anilist: r.id },
    titles: { ...r.titles },
    synonyms: [...r.synonyms]
  };
}
```

`SeriesLinkModal.svelte` needs no change: `detailLine()` already reads `r.format`/`r.status`/`r.volumes`/`r.chapters` off the search result.

- [ ] **Step 4: Totals become a parameter**

`src/lib/metadata/tracking-unit.ts`:

```ts
import type { VolumeMetadata } from '$lib/types';
import type { SeriesMetadata, SeriesTotals, TrackingUnit } from './types';
import { detectTrackingUnit } from './volume-number';

/**
 * The unit this series' archives are numbered in, and where the answer came from.
 *
 * `meta.unit` is a shared fact (`series.json`), written only when someone
 * corrects the guess — so a stored value always wins. Everything else is
 * detected from the volume titles. `totals` are AniList's, and nothing stores
 * them: only the push path has them (it fetches them alongside the list entry),
 * so everywhere else detection is marker-based and the overshoot tie-break
 * simply does not apply. Cloud placeholders count: they carry titles, which is
 * all the detector reads.
 */
export function resolveTrackingUnit(
  meta: Pick<SeriesMetadata, 'unit'> | undefined,
  seriesVolumes: Pick<VolumeMetadata, 'volume_title'>[],
  totals?: SeriesTotals
): { unit: TrackingUnit; source: 'set' | 'detected' } {
  if (meta?.unit === 'volumes' || meta?.unit === 'chapters') {
    return { unit: meta.unit, source: 'set' };
  }
  return {
    unit: detectTrackingUnit(
      seriesVolumes.map((v) => v.volume_title),
      { total_volumes: totals?.volumes, total_chapters: totals?.chapters }
    ),
    source: 'detected'
  };
}
```

- [ ] **Step 5: Fetch the totals in the push request**

In `src/lib/metadata/progress-tracker.ts`:

```ts
const REMOTE_QUERY =
  'query ($id: Int) { Media(id: $id, type: MANGA) { volumes chapters mediaListEntry { status progress progressVolumes repeat } } }';
```

```ts
/** The list entry (or `null`) plus the series totals the same node carries. */
interface RemoteState {
  entry: RemoteEntry | null;
  totals: SeriesTotals;
}

async function fetchRemoteEntry(mediaId: number, token: string): Promise<RemoteState> {
  const data = await anilistRequest<{
    Media: {
      volumes: number | null;
      chapters: number | null;
      mediaListEntry: {
        status: string | null;
        progress: number | null;
        progressVolumes: number | null;
        repeat: number | null;
      } | null;
    } | null;
  }>(REMOTE_QUERY, { id: mediaId }, token);

  const media = data.Media;
  const totals: SeriesTotals = {};
  if (typeof media?.volumes === 'number' && media.volumes > 0) totals.volumes = media.volumes;
  if (typeof media?.chapters === 'number' && media.chapters > 0) totals.chapters = media.chapters;

  const entry = media?.mediaListEntry;
  return {
    totals,
    entry: entry
      ? {
          status: entry.status ?? null,
          progress: entry.progress ?? 0,
          progressVolumes: entry.progressVolumes ?? 0,
          repeat: entry.repeat ?? 0
        }
      : null
  };
}
```

`resolveUnitForPush` hands back the titles it collected, so the totals-aware re-resolve costs no second read:

```ts
async function resolveUnitForPush(
  seriesKey: string,
  meta: SeriesMetadata | undefined,
  localVolumes: VolumeMetadata[]
): Promise<{ unit: TrackingUnit; titles: Pick<VolumeMetadata, 'volume_title'>[] }> {
  if (meta?.unit === 'volumes' || meta?.unit === 'chapters') {
    return { unit: meta.unit, titles: [] };
  }

  const byUuid = new Map<string, { volume_title: string }>();
  for (const volume of localVolumes) {
    byUuid.set(volume.volume_uuid, { volume_title: volume.volume_title });
  }
  try {
    const index = await getSeriesIndex(seriesKey);
    for (const entry of index?.file?.volumes ?? []) {
      if (!byUuid.has(entry.volume_uuid)) byUuid.set(entry.volume_uuid, entry);
    }
  } catch (error) {
    console.warn('[progress-tracker] could not read the cached series index:', error);
  }
  const titles = [...byUuid.values()];
  return { unit: resolveTrackingUnit(meta, titles).unit, titles };
}
```

And `runPush` re-resolves once the totals are in hand:

```ts
  const seriesVolumes = await getSeriesVolumesByKey(seriesKey);
  const state = getSeriesReadingState(seriesKey);
  // Volumes or chapters is a property of the archives, either stated on the
  // record (someone corrected it) or read off their titles.
  const { unit: detectedUnit, titles } = await resolveUnitForPush(seriesKey, meta, seriesVolumes);
  // Without totals a pass is never "complete" — deliberately conservative: this
  // pre-fetch state only feeds the completion debounce, where a false "nothing
  // could have changed" would SKIP a real push and a false "something changed"
  // costs one read.
  const localBeforeFetch = computeLocalPassState(seriesVolumes, get(volumes), state, detectedUnit);

  if (event === 'completion') {
    if (alreadySettled(seriesKey, localBeforeFetch, state, detectedUnit)) return 'nothing';
    recentCompletions.set(seriesKey, {
      signature: passSignature(localBeforeFetch),
      at: Date.now()
    });
  }

  if (Date.now() < rateLimitedUntil) {
    markPending(seriesKey, event);
    return 'queued';
  }

  try {
    const { entry: remote, totals } = await fetchRemoteEntry(mediaId, token);
    // The totals arrived with the entry: they are what makes the overshoot
    // tie-break usable, and what decides whether this pass is COMPLETED.
    const unit =
      titles.length > 0 ? resolveTrackingUnit(meta, titles, totals).unit : detectedUnit;
    const local = computeLocalPassState(seriesVolumes, get(volumes), state, unit, totals);
    const plan = planProgressPush(local, remote, unit, event);
    …
```

Finally, `computeLocalPassState` takes the totals:

```ts
export function computeLocalPassState(
  seriesVolumes: VolumeMetadata[],
  volumesData: Record<string, Pick<VolumeData, 'completed'> | undefined>,
  state: SeriesReadingState | undefined,
  unit: TrackingUnit,
  totals?: SeriesTotals
): LocalPassState {
  …
  const total = unit === 'chapters' ? totals?.chapters : totals?.volumes;
  const passComplete = typeof total === 'number' && total > 0 && passProgress >= total;
  …
}
```

- [ ] **Step 6: Sweep the leftovers**

- `src/lib/metadata/display-title.ts:33` — the comment already says title language is global-only; drop the "`meta.title_preference`" clause so it does not name a field that no longer exists.
- `display-title.test.ts`: delete any fixture setting `title_preference` (the assertions themselves are about the global preference and stay).
- `store.test.ts`: delete the assertions that `unlinkSeries` clears `total_volumes`/`cover_url` and the `toSeriesMetadataPatch` round-trip's display fields.

- [ ] **Step 7: Run everything**

Run: `npx vitest run && npm run check`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(metadata): stop storing AniList display data; fetch totals with the push"
```

---

### Task 8: `profiles.json` gets the automatic treatment

**Files:**

- Modify: `src/lib/util/sync/unified-sync-service.ts` (`SyncOptions`, `syncProvider`)
- Modify: `src/lib/views/CloudView.svelte:298-320`
- Test: `src/lib/util/sync/unified-sync-service.test.ts`

**Interfaces:**

- Consumes: the existing `mergeProfiles` (per-profile newest-wins on `lastUpdated`, tombstones by `deletedOn`), `purgeProfileTombstones`, `migrateProfiles`.
- Produces: `interface SyncOptions { silent?: boolean }` — the `syncProfiles` flag is gone; every provider sync reads, merges and pushes `profiles.json` the way it already does `volume-data.json`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/util/sync/unified-sync-service.test.ts`:

```ts
describe('profiles.json', () => {
  it('is read, merged and pushed on every provider sync — no flag to ask for it', async () => {
    const profilesMeta = { ...fileMeta('profiles'), path: 'profiles.json' };
    getCache.mockReturnValue({
      getAll: vi.fn(() => []),
      get: vi.fn((name: string) => (name === 'profiles.json' ? profilesMeta : null)),
      fetch: vi.fn(async () => {})
    });

    const provider = {
      type: 'mega',
      name: 'MEGA',
      isAuthenticated: () => true,
      downloadFile: vi.fn(async () =>
        jsonBlob({ Desktop: { lastUpdated: '2026-08-20T00:00:00.000Z', charCount: 3 } })
      ),
      uploadFile: vi.fn(async () => {})
    } as unknown as SyncProvider;

    const result = await unifiedSyncService.syncProvider(provider);

    expect(result.success).toBe(true);
    expect(provider.downloadFile).toHaveBeenCalledWith(profilesMeta);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/util/sync/unified-sync-service.test.ts -t 'profiles.json'`
Expected: FAIL — `downloadFile` was never called with the profiles file (profile sync is opt-in).

- [ ] **Step 3: Make it unconditional**

In `src/lib/util/sync/unified-sync-service.ts`:

```ts
export interface SyncOptions {
  /** If true, suppress snackbar notifications */
  silent?: boolean;
}
```

```ts
// Sync volume data (read progress + series-level reading state)
console.log('🔄 Syncing volume data...');
await this.syncVolumeData(provider);
console.log('✅ Volume data synced');

// Profiles get the same treatment: read → merge (newest `lastUpdated` per
// profile, tombstones honoured) → push. It used to be a button nobody
// pressed, which is how devices ended up with divergent settings.
console.log('🔄 Syncing profiles...');
await this.syncProfiles(provider);
console.log('✅ Profiles synced');
```

and update the class doc comment: "Syncs read progress, series reading state and settings profiles across all authenticated cloud providers."

In `src/lib/views/CloudView.svelte`, the manual button keeps working and simply stops passing the flag:

```svelte
const result = await unifiedSyncService.syncProvider(provider);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/util/sync/ && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/util/sync/unified-sync-service.ts src/lib/util/sync/unified-sync-service.test.ts src/lib/views/CloudView.svelte
git commit -m "feat(sync): sync profiles.json automatically, like volume-data.json"
```

---

### Task 9: Documentation sweep

**Files:**

- Modify: `CLAUDE.md:316-322`
- Modify: `docs/superpowers/plans/2026-08-23-catalog-distribution-client.md` (Global Constraints line naming the dead file)
- Modify: `docs/superpowers/specs/2026-08-23-catalog-distribution-design.md` (two "next to `series-metadata.json`" phrasings)
- Modify: `docs/superpowers/plans/2026-08-23-catalog-distribution-bunko.md:9` (contract §1)

**Interfaces:**

- Consumes: nothing.
- Produces: no document still describes `series-metadata.json` as a live file.

- [ ] **Step 1: CLAUDE.md**

Replace the opening of the "Root `catalog.json`" section:

```markdown
### Root `catalog.json`

The library's name/mapping/search data in one root file. It joins the same
root-config allowlist as `volume-data.json`/`profiles.json` (`isRootConfigFile`
in `syncable-file.ts`) — every provider lists, caches and syncs it the same
way — but for writes it is one of the two best-effort compiled files, along
with `series.json` (see Best-effort writes below).
```

and add a short section after it:

```markdown
### What syncs where

| Data                                                        | File                                      | Merge key                            |
| ----------------------------------------------------------- | ----------------------------------------- | ------------------------------------ |
| Read progress, per-volume settings                          | `volume-data.json` (volume uuid keys)     | `lastProgressUpdate` per volume      |
| Series reading state (`read_count`, re-read mute, tracking) | `volume-data.json` → `series` section     | `lastUpdated` per `series_key`       |
| Settings profiles                                           | `profiles.json`                           | `lastUpdated` per profile            |
| Series facts (link, titles, synonyms, tag, unit)            | `<Series>/series.json` (+ `catalog.json`) | `updated_at` = the facts stamp       |
| Shelf alignment (`spine_offset`, per-volume `offset`)       | `<Series>/series.json` (index fields)     | local wins, else the published value |

`series-metadata.json` was retired on 2026-08-23 before it ever shipped. A stale
copy in an existing cloud folder is inert junk — never listed, never read.
```

- [ ] **Step 2: The two sibling plans and the spec**

- `docs/superpowers/plans/2026-08-23-catalog-distribution-client.md`, Global Constraints: `- **`catalog.json` shape** — root file:` (drop "next to `series-metadata.json`"), and add one line at the end of that list:

```markdown
- **Superseded in part** — the spec's `series-metadata.json` references are superseded by its own 2026-08-23 amendment; see `docs/superpowers/plans/2026-08-23-series-metadata-retirement.md`.
```

- `docs/superpowers/specs/2026-08-23-catalog-distribution-design.md`: change the `catalog.json` heading to `### \`catalog.json\` (root)`and the "Files" preamble sentence that places it "next to`series-metadata.json`" to "at the root of the library folder". Leave the amendment section untouched — it is the authority.
- `docs/superpowers/plans/2026-08-23-catalog-distribution-bunko.md`, contract §1:

```markdown
1. **Partitioning** (owed): `<Series>/series.json` and root `catalog.json` are metadata files — never treated as user progress `.json`. (Root `series-metadata.json` no longer exists; a stale one may be ignored outright.)
```

- [ ] **Step 3: Verify no live reference survives**

Run:

```bash
rg -n 'series-metadata\.json' --glob '!CHANGELOG.md' --glob '!docs/superpowers/specs/**'
```

Expected: only the deliberate "retired / inert junk" notes in `syncable-file.ts`, `CLAUDE.md`, the bunko plan and this plan. `CHANGELOG.md` is history and is left alone.

- [ ] **Step 4: Format and commit**

```bash
npm run format
git add -A
git commit -m "docs: series-metadata.json is retired; record where each kind of data syncs"
```

---

### Task 10: In-app verification (Playwright, port 5199)

**Files:**

- Create: `e2e/series-metadata-retirement.spec.ts`

**Interfaces:**

- Consumes, through the Vite dev server inside `page.evaluate`: `/src/lib/metadata/series-file.ts` (`buildSeriesFile`, `parseSeriesFile`, `stringifySeriesFile`), `/src/lib/metadata/store.ts` (`updateSeriesMetadata`, `upsertFromSeriesFile`, `registerIndexChangeListener`), `/src/lib/metadata/spine-offsets.ts` (`scheduleSpineOffsetWrite`, `flushSpineOffsetWrites`), `/src/lib/settings/series-data.ts`, `/src/lib/settings/volume-data.ts` (`parseVolumesFromJson`), `/src/lib/util/sync/syncable-file.ts` (`isRootConfigFile`), `/src/lib/catalog/db.ts`.
- Produces: no app code.

- [ ] **Step 1: Write the spec**

Create `e2e/series-metadata-retirement.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';

/**
 * E2E for the `series-metadata.json` retirement (spec:
 * docs/superpowers/specs/2026-08-23-catalog-distribution-design.md, amendment
 * 2026-08-23; plan: docs/superpowers/plans/2026-08-23-series-metadata-retirement.md).
 *
 * Module drive-through, the technique `e2e/zoom.spec.ts` and
 * `e2e/catalog-distribution.spec.ts` already use: `await import('/src/lib/…')`
 * inside `page.evaluate`, so every assertion runs against the production
 * modules the browser actually loaded, in the real app, with the real Dexie
 * database and the real localStorage.
 */

/**
 * Boot the app and wait until it has finished taking over the URL — SvelteKit
 * `replaceState`s the bare origin during hydration and only then defaults the
 * hash, so anything written before that lands is silently reverted.
 */
async function boot(page: Page) {
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => window.location.hash), {
      timeout: 20000,
      message: 'the app never claimed the URL'
    })
    .toBe('#/catalog');
  await page.evaluate(async () => {
    const { db } = await import('/src/lib/catalog/db.ts');
    await db.open();
    await db.series_metadata.clear();
  });
}

test.describe('series-metadata.json retirement', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
  });

  test('the shelf alignment rides series.json and never moves the facts stamp', async ({
    page
  }) => {
    const result = await page.evaluate(async () => {
      const { buildSeriesFile, parseSeriesFile, stringifySeriesFile } = await import(
        '/src/lib/metadata/series-file.ts'
      );
      const { updateSeriesMetadata, upsertFromSeriesFile } = await import(
        '/src/lib/metadata/store.ts'
      );
      const { db } = await import('/src/lib/catalog/db.ts');

      // A library that linked the series AND nudged its shelf.
      await updateSeriesMetadata('Dr Stone', { external_ids: { anilist: 98416 } });
      const linked = await db.series_metadata.get('dr stone');
      await updateSeriesMetadata('Dr Stone', {
        spine_offset: 12,
        volume_offsets: { 'vol-1': -30 }
      });
      const nudged = await db.series_metadata.get('dr stone');

      const file = buildSeriesFile({
        seriesTitle: 'Dr Stone',
        meta: nudged,
        localVolumes: [
          {
            volume_uuid: 'vol-1',
            series_uuid: 's',
            series_title: 'Dr Stone',
            volume_title: 'Vol 1',
            mokuro_version: '0.4.11',
            page_count: 10,
            character_count: 100,
            page_char_counts: [10]
          }
        ]
      });

      // A second library, which has never seen this series, inherits it.
      await db.series_metadata.delete('dr stone');
      await upsertFromSeriesFile(
        'Dr Stone',
        parseSeriesFile(JSON.parse(stringifySeriesFile(file)))
      );
      const inherited = await db.series_metadata.get('dr stone');

      return {
        publishedSpine: file.spine_offset,
        publishedVolume: file.volumes[0].offset,
        factsStampUnchanged: linked.facts_updated_at === nudged.facts_updated_at,
        inheritedSpine: inherited.spine_offset,
        inheritedVolume: inherited.volume_offsets?.['vol-1'],
        inheritedFactsStamp: inherited.facts_updated_at
      };
    });

    expect(result.publishedSpine).toBe(12);
    expect(result.publishedVolume).toBe(-30);
    expect(result.factsStampUnchanged).toBe(true);
    expect(result.inheritedSpine).toBe(12);
    expect(result.inheritedVolume).toBe(-30);
    // The file carried a real link, so the facts stamp is the link's — not the
    // offsets', which have none.
    expect(result.inheritedFactsStamp).toBeTruthy();
  });

  test('a spine nudge schedules a sidecar write through the non-facts trigger', async ({
    page
  }) => {
    const fired = await page.evaluate(async () => {
      const { registerIndexChangeListener } = await import('/src/lib/metadata/store.ts');
      const { scheduleSpineOffsetWrite, flushSpineOffsetWrites } = await import(
        '/src/lib/metadata/spine-offsets.ts'
      );

      const seen: string[] = [];
      const off = registerIndexChangeListener((title: string) => seen.push(title));
      try {
        scheduleSpineOffsetWrite('Dr Stone', { spineOffset: 7 });
        await flushSpineOffsetWrites();
        return seen;
      } finally {
        off();
      }
    });

    expect(fired).toEqual(['Dr Stone']);
  });

  test('series reading state lives in the volume-data section and survives a reload', async ({
    page
  }) => {
    await page.evaluate(async () => {
      const { updateSeriesReadingState } = await import('/src/lib/settings/series-data.ts');
      updateSeriesReadingState('dr stone', { read_count: 3, reread_prompt_suppressed: true });
    });

    await page.reload();
    await expect
      .poll(() => page.evaluate(() => window.location.hash), { timeout: 20000 })
      .toBe('#/catalog');

    const after = await page.evaluate(async () => {
      const { getSeriesReadingState, SERIES_SECTION_KEY } = await import(
        '/src/lib/settings/series-data.ts'
      );
      const { parseVolumesFromJson } = await import('/src/lib/settings/volume-data.ts');
      const state = getSeriesReadingState('dr stone');
      // The section must never read back as a volume.
      const volumes = parseVolumesFromJson(
        JSON.stringify({ 'vol-1': { progress: 2 }, [SERIES_SECTION_KEY]: { 'dr stone': state } })
      );
      return { state, volumeKeys: Object.keys(volumes) };
    });

    expect(after.state.read_count).toBe(3);
    expect(after.state.reread_prompt_suppressed).toBe(true);
    expect(after.volumeKeys).toEqual(['vol-1']);
  });

  test('the record no longer carries reading state or AniList display data', async ({ page }) => {
    const keys = await page.evaluate(async () => {
      const { updateSeriesMetadata } = await import('/src/lib/metadata/store.ts');
      const { toSeriesMetadataPatch } = await import('/src/lib/metadata/providers/anilist.ts');
      const written = await updateSeriesMetadata('Dr Stone', {
        ...toSeriesMetadataPatch({
          id: 98416,
          idMal: 103897,
          titles: { native: 'Dr.STONE', romaji: 'Dr. STONE', english: 'Dr. STONE' },
          synonyms: [],
          format: 'MANGA',
          status: 'FINISHED',
          volumes: 26,
          chapters: 232,
          coverUrl: 'https://example.invalid/cover.jpg',
          year: 2017
        })
      });
      return Object.keys(written).sort();
    });

    for (const dead of [
      'read_count',
      'reread_prompt_suppressed',
      'tracking',
      'format',
      'status',
      'total_volumes',
      'total_chapters',
      'cover_url',
      'title_preference'
    ]) {
      expect(keys).not.toContain(dead);
    }
    expect(keys).toContain('external_ids');
    expect(keys).toContain('titles');
  });

  test('series-metadata.json is not a syncable root file any more', async ({ page }) => {
    const verdict = await page.evaluate(async () => {
      const { isRootConfigFile, isSyncableFile } = await import(
        '/src/lib/util/sync/syncable-file.ts'
      );
      let mergeModuleGone = false;
      try {
        await import('/src/lib/metadata/merge.ts');
      } catch {
        mergeModuleGone = true;
      }
      return {
        root: isRootConfigFile('series-metadata.json'),
        syncable: isSyncableFile('series-metadata.json'),
        volumeData: isRootConfigFile('volume-data.json'),
        profiles: isRootConfigFile('profiles.json'),
        mergeModuleGone
      };
    });

    expect(verdict.root).toBe(false);
    expect(verdict.syncable).toBe(false);
    // The files that DO sync are untouched.
    expect(verdict.volumeData).toBe(true);
    expect(verdict.profiles).toBe(true);
    expect(verdict.mergeModuleGone).toBe(true);
  });
});
```

- [ ] **Step 2: Run it on port 5199**

Run:

```bash
E2E_PORT=5199 E2E_CHROMIUM="$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)" npx playwright test e2e/series-metadata-retirement.spec.ts --reporter=list
```

Expected: 5 passed. Never use port 5173 — it belongs to the user's own dev server.

- [ ] **Step 3: Run the existing e2e suite for regressions**

Run:

```bash
E2E_PORT=5199 E2E_CHROMIUM="$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)" npx playwright test e2e/catalog-distribution.spec.ts --reporter=list
```

Expected: PASS. A failure here means the redistribution broke the catalog-distribution client work — fix it before finishing, do not adjust the older spec's expectations to match new behaviour without checking the spec first.

- [ ] **Step 4: Final gate**

Run: `npx vitest run && npm run check && npm run lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e/series-metadata-retirement.spec.ts
git commit -m "test(e2e): verify the series-metadata.json retirement in the real app"
```

---

## Self-Review

**1. Spec coverage** — every bullet of the amendment maps to a task:

| Amendment requirement                                                                                             | Task                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Writer/reader/merge machinery and the allowlist entry go; stale files inert                                       | 5                                                                    |
| Local `series_metadata` table stays                                                                               | 5, 6, 7                                                              |
| Facts transported only by `series.json` (+ `catalog.json`), stamps unchanged                                      | 5 (nothing to change — already true), verified in 10                 |
| `spine_offset` top-level + per-volume offsets as index fields                                                     | 1                                                                    |
| Bunko contract records the accepted index fields                                                                  | 1 (§2), 9 (§1)                                                       |
| Bunko users inherit the uploader's alignment                                                                      | 1 (`upsertFromSeriesFile` fill), 10                                  |
| Offsets never bump the facts stamp, but still schedule a write                                                    | 2                                                                    |
| `read_count` / `reread_prompt_suppressed` / `tracking` → `volume-data.json` `series` section, per-key newest-wins | 3, 4, 6                                                              |
| Never in shared files                                                                                             | 3 (store lives in `settings/`, nothing writes it into `series.json`) |
| `format`/`status`/totals/`cover_url` not stored; transient in the link picker                                     | 7                                                                    |
| `fetchRemoteEntry` gains `media { volumes chapters }`; `passComplete` from fetched totals                         | 7                                                                    |
| `detectTrackingUnit` overshoot only where totals exist                                                            | 7                                                                    |
| `title_preference` deleted                                                                                        | 7                                                                    |
| `profiles.json` gets `volume-data.json`'s automatic treatment                                                     | 8                                                                    |
| Docs                                                                                                              | 9                                                                    |
| In-app verification, port 5199                                                                                    | 10                                                                   |

**2. Placeholder scan** — every code step carries the actual code. Three steps are edit-sweeps over existing test files rather than literal diffs (Task 6 Step 7, Task 7 Step 6, Task 4 Step 1); each names the exact file, the exact call shape before and after, and the exact assertion to write, because those files build their fixtures with `vi.hoisted` factories whose surrounding lines the implementer must read anyway. Task 7 Step 1's two AniList tests say to reuse the helpers already defined at the top of `progress-tracker.test.ts` (`anilistResponse` and the mutation capture) rather than inventing names — that is a deliberate instruction to read, not a gap in the plan.

**3. Type consistency** — checked across tasks:

- `sanitizeVolumeOffset` (scalar, Task 1) vs the deleted `sanitizeVolumeOffsets` (map, Task 5): the map form has no callers left once `merge.ts` is gone. ✅
- `SeriesFileVolume.offset` (px) and `SeriesFile.spine_offset` (percent) are named differently on purpose — two units, two names — and both are used with those exact names in Tasks 1, 9 (bunko §2) and 10. ✅
- `SeriesReadingState` is defined once (Task 3) and consumed with that name in Tasks 4, 6, 7, 10. `readingStateFor` (map + key → state) and `getSeriesReadingState` (key → state) are distinct on purpose: components hold the store value, modules do not. ✅
- `computeLocalPassState` reaches its final shape in Task 7 — `(seriesVolumes, volumesData, state, unit, totals?)`. Task 6 leaves it at four required parameters and hard-codes `passComplete: false`, which is exactly what Task 7 replaces; no call site is left passing a `SeriesMetadata` where a `SeriesReadingState` is expected. ✅
- `volumeNumberFor(volume, sorted, tracking, unit)` — `tracking`, not the record, from Task 6 onward, including inside `computeLocalPassState`. ✅
- `fetchRemoteEntry` returns `RemoteState` (`{ entry, totals }`) from Task 7; every caller (`runPush` only) is updated in the same task, and `alreadySettled` keeps taking a `RemoteEntry`-shaped `assumedRemote` it builds itself. ✅
- `downloadVolumeDataFile` returns `CloudVolumeDataFile` from Task 4; its only callers are `syncVolumeData` and the tests, both updated in that task. ✅
- `SyncOptions` loses `syncProfiles` in Task 8; the only caller passing it (`CloudView.svelte`) is updated in the same step. ✅
