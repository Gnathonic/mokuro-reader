import { sortVolumes } from '$lib/catalog/sort-volumes';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import type { VolumeMetadata } from '$lib/types';
import { generateDeterministicUUID } from '$lib/util/series-extraction';
import { normalizeSeriesKey, normalizeVolumeTitleKey } from './series-key';
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
import type { SeriesExternalIds, SeriesMetadata, SeriesTitles, TrackingUnit } from './types';

/** Basename of the per-series sidecar, stored at `<Series Title>/series.json`. */
export const SERIES_FILE_NAME = 'series.json';

/**
 * The `updated_at` of a file whose facts come from nowhere: this library has no
 * facts clock for the series and nothing is published yet, so the file carries
 * an index and no opinion.
 *
 * It must never be `new Date()`. `upsertFromSeriesFile` applies the newest facts
 * stamp, so a freshly-stamped empty file would beat every real link: a device
 * that never linked the series would unlink it everywhere just by backing a
 * volume up. The epoch loses every comparison, which is exactly right for "no
 * opinion" — and a deliberate unlink still publishes the record's own (real)
 * facts clock, so it still wins.
 */
export const FACTLESS_UPDATED_AT = '1970-01-01T00:00:00.000Z';

/**
 * One volume in the series index. Enough to show a cloud-only volume in the
 * catalog and attach synced progress to it without downloading its `.mokuro`.
 * Never per-user state (progress, read counts) and never page/OCR data — the
 * spine `offset` is here because it describes the archive's cover geometry, not
 * the reader.
 */
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
  /**
   * Bytes of the `.mokuro`/`.mokuro.gz` sidecar this entry's counts were built
   * from, per the CLOUD LISTING'S record of that file — never a local stat,
   * never `Date.now()`. Paired with {@link mokuro_modified} so a later reader
   * (this device or another) can tell whether the sidecar has moved since this
   * entry was built without downloading it again. Absent when the entry was
   * never built from a listed sidecar (a fact edit's own build, an image-only
   * archive with no sidecar at all, or a file written before this field
   * existed).
   */
  mokuro_size?: number;
  /**
   * Epoch SECONDS (truncated, never rounded) of the sidecar's listing
   * `modifiedTime` at the moment this entry was built. Same provenance rule as
   * {@link mokuro_size}: the listing's stamp, captured once, at the decision to
   * pull — never a fresher re-read, and never local wall-clock time.
   */
  mokuro_modified?: number;
  /** Bytes of this volume's cover sidecar, per the listing at build time. */
  cover_size?: number;
  /** Epoch SECONDS (truncated) of the cover sidecar's listing `modifiedTime`. */
  cover_modified?: number;
}

/**
 * `<Series Title>/series.json` — the shareable series facts plus an
 * unauthoritative index of the series' volumes.
 *
 * The content is advisory: local IndexedDB always wins for installed volumes,
 * the index only fills gaps for volumes this device does not have. `updated_at`
 * is the merge key for the *facts* only (see `upsertFromSeriesFile`); volume
 * entries merge by `volume_uuid` OR `volume_title` — either key is the same
 * volume (see `createVolumeEntryMerger`) — with the local copy winning.
 */
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

/** A usable spine width: a positive finite number of pixels. */
function isSpineWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * A usable archive size: a positive whole number of bytes.
 *
 * The one definition every writer and the parser share, so a junk or zero size
 * is "no size" on both sides and build → JSON → parse stays an identity. An
 * empty `.cbz` is not a thing, so 0 is a gap rather than a measurement.
 */
export function isArchiveSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * A usable epoch-seconds stamp: a non-negative integer. Shared by every
 * `*_modified` field's parser AND writer, so build → JSON → parse stays an
 * identity the same way `isArchiveSize` keeps it for the size fields.
 */
export function isEpochSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Project a local volume onto its index entry (index fields only). */
export function volumeToIndexEntry(volume: VolumeMetadata): SeriesFileVolume {
  const entry: SeriesFileVolume = {
    volume_uuid: volume.volume_uuid,
    volume_title: volume.volume_title,
    page_count: volume.page_count,
    character_count: volume.character_count,
    mokuro_version: volume.mokuro_version
  };
  // Same rule as the parser, so build → JSON → parse is an identity: a 0 or junk
  // width is "no width", not a width of zero.
  if (isSpineWidth(volume.spine_width)) entry.spine_width = volume.spine_width;
  if (isArchiveSize(volume.archive_size)) entry.archive_size = volume.archive_size;
  return entry;
}

/**
 * The current cloud listing's sizes/mtimes for one volume's sidecars, keyed
 * elsewhere by folded `volume_title`. Epoch seconds, truncated — the exact
 * shape `SeriesFileVolume`'s `mokuro_*`/`cover_*` fields carry, built by
 * `cloud-sidecar-stamps.ts` from `CloudFileMetadata.size`/`modifiedTime` and
 * consumed by `buildSeriesFile` to stamp an INSTALLED row's own entry.
 */
export interface CloudSidecarStamp {
  mokuro_size?: number;
  mokuro_modified?: number;
  cover_size?: number;
  cover_modified?: number;
}

/**
 * Reassemble a `SeriesFileVolume` in the CANONICAL wire order — see
 * `parseVolumeEntry`'s note by the same name. A caller that patches
 * size/stamp fields onto an entry which might already carry `offset` (which
 * must stay LAST) should rebuild through here rather than mutate in place, so
 * the result re-serializes byte-for-byte in the pinned order no matter which
 * fields happened to already be set or in what order they were assigned.
 */
export function orderVolumeEntryFields(entry: SeriesFileVolume): SeriesFileVolume {
  const ordered: SeriesFileVolume = {
    volume_uuid: entry.volume_uuid,
    volume_title: entry.volume_title,
    page_count: entry.page_count,
    character_count: entry.character_count,
    mokuro_version: entry.mokuro_version
  };
  if (entry.spine_width !== undefined) ordered.spine_width = entry.spine_width;
  if (entry.archive_size !== undefined) ordered.archive_size = entry.archive_size;
  if (entry.mokuro_size !== undefined) ordered.mokuro_size = entry.mokuro_size;
  if (entry.mokuro_modified !== undefined) ordered.mokuro_modified = entry.mokuro_modified;
  if (entry.cover_size !== undefined) ordered.cover_size = entry.cover_size;
  if (entry.cover_modified !== undefined) ordered.cover_modified = entry.cover_modified;
  if (entry.offset !== undefined) ordered.offset = entry.offset;
  return ordered;
}

/** `sortVolumes` only reads `volume_title`, which every index entry carries. */
function compareEntries(a: SeriesFileVolume, b: SeriesFileVolume): number {
  return sortVolumes(a as unknown as VolumeMetadata, b as unknown as VolumeMetadata);
}

// ---------------------------------------------------------------------------
// Volume-entry identity and the ONE merge rule every producer shares
// ---------------------------------------------------------------------------

/**
 * Does this entry carry anything only a read of the volume's `.mokuro` (or a
 * local install) could have measured? The negative space is exactly what a
 * no-metadata entry is minted with (`buildNoMetadataEntry`): zero pages, zero
 * characters, no mokuro version.
 *
 * Exported for {@link seriesFileHealDifference}'s material-difference terms,
 * which must read "0/0 superseded by measured" with exactly the same eyes the
 * merger's winner rules use — a private copy would drift.
 */
export function hasMeasuredContent(entry: SeriesFileVolume): boolean {
  return entry.page_count > 0 || entry.character_count > 0 || entry.mokuro_version !== '';
}

/**
 * The `mokuro_version` a CONSUMER may claim from this entry — THE rule that
 * keeps "no sidecars" from being read as "image-only".
 *
 * An entry with measured content answers its real version, where `''` is a
 * genuine image-only claim: its publisher counted real pages and found no
 * mokuro, embedded or otherwise.
 *
 * An entry with NO measured content ({@link hasMeasuredContent} false — the
 * shape `buildNoMetadataEntry` mints when the listing shows no `.mokuro`
 * sidecar) is decided by the COVER sidecar, whose listing stamps ride the
 * entry:
 *
 * - cover stamps present → a modern backup wrote this archive's sidecars and
 *   still produced no mokuro; it would have written one had OCR existed, so
 *   the volume is genuinely image-only (`''`);
 * - no cover stamps → the archive is missing ALL sidecars, which is
 *   indistinguishable from a legacy backup whose mokuro is EMBEDDED in the
 *   `.cbz` — so it must surface as `'unknown'` (the "filled in after
 *   download" sentinel `createPlaceholder` already uses), NEVER as `''`,
 *   which is what the catalog's "Image Only" badge keys on.
 *
 * (A cover the sidecar backfill uploaded THIS session is stamped
 * provisionally and carries no listing stamp yet — such an entry reads
 * 'unknown' until the next real listing, which only delays the badge, never
 * fakes it.)
 *
 * SEMANTICS OF THE CLAIM, stated for the one edge where it matters: this
 * function describes the BEST-KNOWN OCR STATE of the volume, not the bytes
 * of the cloud archive. A locally image-only volume can backfill just a
 * cover next to a same-titled archive that secretly embeds a mokuro (only
 * producible by out-of-band file placement — the app's own import extracts
 * embedded mokuro before install). The entry then honestly reports the
 * uploader's state (`''`), and "measured beats no-metadata" in the merger
 * supersedes it the moment any device imports the real archive. Display-only
 * and self-healing; do not "fix" it by sniffing archive contents here.
 *
 * Every consumer that copies an entry's version onto a `VolumeMetadata`
 * shape (`createPlaceholder`, `materializeSeriesVolumes`) must go through
 * here; reading `entry.mokuro_version` raw is how the false badge came back.
 */
export function entryMokuroVersion(entry: SeriesFileVolume): string {
  if (hasMeasuredContent(entry)) return entry.mokuro_version;
  const coverSidecarSeen = entry.cover_size !== undefined || entry.cover_modified !== undefined;
  return coverSidecarSeen ? '' : 'unknown';
}

/**
 * Is this a NO-METADATA entry — one minted without ever reading the volume's
 * `.mokuro`? Two signals, BOTH required:
 *
 * - its `volume_uuid` is the DERIVED one — `generateDeterministicUUID(
 *   '<series>/<volume>')`, the convention every placeholder minter uses
 *   (`buildNoMetadataEntry`, `placeholders.ts`, `download-queue.ts`) —
 *   recomputed from the entry's own titles; and
 * - it carries no measured content at all ({@link hasMeasuredContent}).
 *
 * The conjunction is deliberate. The uuid signal alone would misclassify a
 * genuinely installed IMAGE-ONLY volume, whose uuid is also derived (it has no
 * mokuro to name it) but whose `page_count` was measured from real pages. The
 * content signal alone would misclassify a real `.mokuro` that happens to
 * carry no pages and no version string. And an entry whose derived uuid no
 * longer recomputes (the series was renamed since minting, or NFC/NFD drift in
 * the title) degrades safely: it fails this test but still has zero content,
 * so `pickWinner`'s second rule — measured content beats none — decides the
 * same way.
 */
export function isMetadataLessEntry(seriesTitle: string, entry: SeriesFileVolume): boolean {
  if (hasMeasuredContent(entry)) return false;
  return entry.volume_uuid === generateDeterministicUUID(`${seriesTitle}/${entry.volume_title}`);
}

/** How {@link VolumeEntryMerger.add} resolves a pure tie (same class, same content rank). */
export type VolumeEntryMergeMode =
  /** The incoming entry wins ties — an override pass (a pulled sidecar, an installed row, an arriving file). */
  | 'replace'
  /** The held entry wins ties — a fill pass (metadata-only rows, healing one file's own entries in order). */
  | 'fill';

export interface VolumeEntryMerger {
  /** Merge one entry in under the shared identity and winner rules. */
  add(entry: SeriesFileVolume, mode: VolumeEntryMergeMode): void;
  /** Every surviving entry — unique on `volume_uuid` AND on the title key, by construction. */
  values(): SeriesFileVolume[];
}

/**
 * The fields a collapse must never destroy: they describe the FILES that sit
 * beside the entry in the cloud folder — the archive's byte size, the
 * `.mokuro`/cover sidecar stamps, the shelf nudge for the cover's geometry —
 * not the mokuro content whose measurements decide a merge. The archive
 * outlives a re-OCR and a rename, so these facts follow it onto the winning
 * entry instead of dying with the entry that happened to carry them (see the
 * INHERITANCE rule on `createVolumeEntryMerger`). `spine_width` stays out
 * deliberately: no pre-merger rescue ever carried it across, and the
 * thumbnail pipeline re-measures it locally, so inheriting it would only
 * paper over a regeneration.
 */
const INHERITED_FILE_FACTS = [
  'archive_size',
  'mokuro_size',
  'mokuro_modified',
  'cover_size',
  'cover_modified',
  'offset'
] as const;

/**
 * THE one merge rule for `SeriesFileVolume` entries. Every site that combines
 * them — `parseSeriesFile` (healing a file on read), `buildSeriesFile` (the
 * write), `mergeSeriesFileForCache` (caching an import), and
 * `scheduleSeriesFileWrite`'s cloudMeasured accumulator — goes through this
 * one factory, so the identity and winner rules cannot drift between sites.
 * (They did once: every site keyed by `volume_uuid` alone, so the no-metadata
 * entry's derived uuid never matched the real mokuro's uuid for the same file
 * and the two entries DOUBLED instead of replacing.)
 *
 * IDENTITY — an incoming entry matches an existing one when EITHER key
 * matches:
 *
 * - same title key — by default the folded `volume_title`
 *   ({@link normalizeVolumeTitleKey}): the title maps to the archive
 *   FILENAME, unique per folder on every provider, so it is the reliable
 *   join. The uuid legitimately CHANGES under one title — a no-metadata
 *   entry's derived uuid is superseded by the real mokuro's, and a re-OCR
 *   mints a fresh one. `titleKeyOf` narrows the join for the one site that
 *   must be stricter: `parseSeriesFile` matches on the EXACT title string,
 *   because case-distinct filenames (`Vol 1` vs `VOL 1`) genuinely coexist
 *   on case-sensitive providers and a parse-time healer has no listing to
 *   ask — folding there would delete the entry of a file that still exists.
 *   The build sites keep the fold: they run under a listing (or a caller)
 *   that knows which files are real, and their output is pruned against it;
 * - same `volume_uuid`: the filename legitimately changes under one uuid too
 *   — a user renames the archive, and the uuid (from the mokuro inside it)
 *   rides along unchanged.
 *
 * A single incoming entry can therefore match TWO existing entries at once —
 * one by uuid (the pre-rename entry) and one by title (whatever sat on the
 * new name, typically a no-metadata placeholder). ALL matches collapse into
 * ONE winner, so the invariant — no two entries share a uuid or a title
 * key — holds on `values()` by construction, and a violated input (an
 * already-doubled published file) collapses deterministically instead of
 * throwing: this code runs against real user data.
 *
 * WINNER, decided pairwise per match:
 *
 * 1. a real entry beats a no-metadata one ({@link isMetadataLessEntry}),
 *    whichever side it arrives on — "the no-metadata entry is REPLACED when
 *    the mokuro is read", and a later no-metadata rebuild never claws back a
 *    real entry;
 * 2. an entry with measured content beats one with none — the safety net for
 *    a no-metadata entry whose derived uuid no longer recomputes (see
 *    {@link isMetadataLessEntry});
 * 3. otherwise the `mode` decides: `'replace'` keeps the incoming entry,
 *    `'fill'` keeps the held one. The schema carries no per-entry clock, so
 *    "local/installed beats published, newer beats older" is expressed by
 *    application ORDER at the call sites (existing file → pulled sidecars →
 *    metadata-only fills → installed rows), not by a timestamp.
 *
 * INHERITANCE — a collapse is field-aware, never a plain deletion: the
 * winner takes each {@link INHERITED_FILE_FACTS} field from the entry it
 * displaces, wherever the winner itself lacks the field. Those fields
 * describe the files beside the entry, not the content that decided the
 * winner, so they survive the collapse the way the archive survives a
 * re-OCR. The read path is why this lives HERE and not at the call sites:
 * `parseSeriesFile` heals a doubled published file before `buildSeriesFile`
 * ever sees it as `existing`, so a field the heal dropped would already be
 * gone by the time a write-site rescue went looking for it — the published
 * file would lose `archive_size`, the shelf `offset` and the sidecar stamps
 * for good. Losing a stamp is the expensive direction: a stampless entry is
 * never stale (`isSidecarStale`), so staleness detection for it never fires
 * again on any device, while an inherited stamp that turns out to be behind
 * the listing just triggers one self-correcting re-verify. One field is not
 * unconditionally covered by this rescue: `buildSeriesFile` applies the
 * local shelf alignment — including an explicit zero, a deliberate reset —
 * to `offset` AFTER this merge runs, so a device holding a local zero for a
 * volume can still drop the `offset` its OWN merge just inherited onto that
 * volume's entry (a stable, one-time drop this device's own build keeps
 * making, not a ping-pong with another device — see the reset's own comment
 * there).
 *
 * DEVICE-LOCAL ALTERNATION — the trade rule 3 makes. When two devices hold
 * DIFFERENT real entries for the same archive (device A still has the
 * original `vol-1-old` installed; device B re-OCR'd the same file into
 * `vol-1-new`), the pair is a pure tie — same class, same content rank — so
 * each device's installed pass wins with its OWN uuid, and the published
 * entry flips uuid whenever the other device next writes. Under the old
 * by-uuid-only merge the two coexisted as exactly the doubled index this
 * rule exists to collapse, so the flip is the accepted cost of the fix. It
 * is bounded: parse healing is deterministic on every device ('fill', first
 * entry wins), the flip requires BOTH devices to keep writing the same
 * series while holding divergent re-OCRs, and it settles the moment either
 * device re-downloads the other's upload. A device-independent tiebreak
 * (lexicographic uuid, say) was considered and REJECTED: the merger cannot
 * tell an installed-row tie (where it would converge the devices) from a
 * pulled-sidecar tie — a `cloudMeasuredVolumes` entry also collides
 * real-on-real after a re-OCR, and THERE the pulled sidecar IS the cloud's
 * current content and must win no matter how the uuids sort. Splitting
 * those apart would take a third merge mode; a transient, self-limiting
 * flip does not buy that.
 */
export function createVolumeEntryMerger(
  seriesTitle: string,
  options?: {
    /** Title-identity override — see IDENTITY above. Default: {@link normalizeVolumeTitleKey}. */
    titleKeyOf?: (title: string) => string;
  }
): VolumeEntryMerger {
  const titleKeyOf = options?.titleKeyOf ?? normalizeVolumeTitleKey;
  const byUuid = new Map<string, SeriesFileVolume>();
  const byTitle = new Map<string, SeriesFileVolume>();

  function matchesFor(
    entry: Pick<SeriesFileVolume, 'volume_uuid' | 'volume_title'>
  ): SeriesFileVolume[] {
    const matches: SeriesFileVolume[] = [];
    const uuidMatch = byUuid.get(entry.volume_uuid);
    if (uuidMatch) matches.push(uuidMatch);
    const titleKey = titleKeyOf(entry.volume_title);
    const titleMatch = titleKey ? byTitle.get(titleKey) : undefined;
    if (titleMatch && titleMatch !== uuidMatch) matches.push(titleMatch);
    return matches;
  }

  /** The winner enriched with the loser's file facts — the INHERITANCE rule. */
  function inheritFileFacts(winner: SeriesFileVolume, loser: SeriesFileVolume): SeriesFileVolume {
    let enriched: SeriesFileVolume | undefined;
    for (const key of INHERITED_FILE_FACTS) {
      if (winner[key] === undefined && loser[key] !== undefined) {
        (enriched ??= { ...winner })[key] = loser[key];
      }
    }
    // Rebuild in the pinned wire order: an inherited field would otherwise
    // land AFTER whatever the winner already carried (`offset` must stay
    // last), and a healed entry must re-serialize in the canonical order.
    return enriched ? orderVolumeEntryFields(enriched) : winner;
  }

  /** `b` is the preferred side: it wins when rules 1 and 2 do not decide. */
  function pickWinner(a: SeriesFileVolume, b: SeriesFileVolume): SeriesFileVolume {
    const aLess = isMetadataLessEntry(seriesTitle, a);
    const bLess = isMetadataLessEntry(seriesTitle, b);
    if (aLess !== bLess) return aLess ? inheritFileFacts(b, a) : inheritFileFacts(a, b);
    const aContent = hasMeasuredContent(a);
    const bContent = hasMeasuredContent(b);
    if (aContent !== bContent) return aContent ? inheritFileFacts(a, b) : inheritFileFacts(b, a);
    return inheritFileFacts(b, a);
  }

  return {
    add(entry, mode) {
      const matches = matchesFor(entry);
      let winner = entry;
      for (const match of matches) {
        winner = mode === 'replace' ? pickWinner(match, winner) : pickWinner(winner, match);
      }
      // The held entry won its only collision unchanged (nothing inherited
      // either): keep it in place rather than re-inserting it at the back.
      if (matches.length === 1 && winner === matches[0]) return;
      const winnerTitleKey = titleKeyOf(winner.volume_title);
      // Drop the losers' keys — except a key the winner is about to reuse,
      // where `set` on the live key updates the entry IN PLACE and keeps the
      // healed file's entry order stable.
      for (const match of matches) {
        if (match.volume_uuid !== winner.volume_uuid && byUuid.get(match.volume_uuid) === match) {
          byUuid.delete(match.volume_uuid);
        }
        const titleKey = titleKeyOf(match.volume_title);
        if (titleKey !== winnerTitleKey && byTitle.get(titleKey) === match) {
          byTitle.delete(titleKey);
        }
      }
      byUuid.set(winner.volume_uuid, winner);
      if (winnerTitleKey) byTitle.set(winnerTitleKey, winner);
    },
    values() {
      return [...byUuid.values()];
    }
  };
}

/**
 * Would publishing `built` MATERIALLY repair what `published` currently says —
 * the heal-by-overwrite decision, and nothing else.
 *
 * The read side has healed quietly for a while (`parseSeriesFile` collapses
 * doubles, `buildSeriesFile`'s winner rules replace 0/0 entries) — but only a
 * WRITE publishes the healed content, and until this predicate existed nothing
 * scheduled one, so a damaged published file stayed damaged for every reader
 * that does not heal (and kept re-materializing 0/0 placeholders). This
 * decides, from one already-run read+build cycle, whether that write is worth
 * scheduling.
 *
 * Entries are matched pairwise — `volume_uuid` first, else folded
 * `volume_title` — the merger's own identity rule, because "the same archive"
 * is what a material difference must be judged per. MATERIAL means:
 *
 * - COLLAPSE: two published entries land on one built entry (the doubled-index
 *   shape that survives parse healing: case-drift titles folding together
 *   under the listing);
 * - SUPERSEDE: a published no-metadata entry ({@link hasMeasuredContent}
 *   false — the 0/0 shape `buildNoMetadataEntry` mints) whose built
 *   counterpart is measured. This is the user-visible bug this predicate was
 *   built for: install the volume, the measured counts land in Dexie, the
 *   published 0/0 entry stands forever;
 * - ENRICHMENT: a built entry carries one of {@link INHERITED_FILE_FACTS}
 *   where its published counterpart has none. EXACTLY that field list, not
 *   one more: those are the fields the merger's INHERITANCE rule guarantees
 *   survive any later device's replace-mode collapse, which is what makes
 *   absent→present convergent across devices. A field outside the list
 *   (`spine_width`, deliberately uninherited) can be DROPPED by another
 *   device's installed-row win, and counting it would have two devices
 *   add-and-drop it at each other forever;
 * - LISTING-BACKED ADDITION: a built entry with no published counterpart
 *   whose folded title the cloud listing shows as an archive. Cloud-backed
 *   only, because every other device's prune KEEPS a listed entry — an
 *   addition the listing does not vouch for (a local-only install) would be
 *   pruned by the next device's ordinary write and re-added here, forever.
 *
 * Everything else is deliberately NOT material:
 *
 * - a matched pair whose `volume_uuid` differs while BOTH sides are measured.
 *   That is the device-local alternation `createVolumeEntryMerger` documents
 *   (device A holds `vol-1-old` installed, device B re-OCR'd into
 *   `vol-1-new`; each build prefers its own) — an accepted trade precisely
 *   BECAUSE nothing schedules writes off it. Counting uuid flips would have
 *   two live devices ping-pong the published file forever;
 * - value changes in fields both sides carry (counts, versions, stamp
 *   values): same alternation logic one level down, and staleness detection
 *   (`isSidecarStale`) already owns stamp movement;
 * - published entries with no built counterpart (the listing prune at work):
 *   a device holding the volume locally re-adds what a device without it
 *   removes, so removals as a trigger would alternate the same way;
 * - entry order, facts, `updated_at`, `spine_offset`, serialization: the
 *   comparison never reads them.
 *
 * CONVERGENCE, the property the whole feature hangs on: after the heal-write
 * publishes `built`, the next cycle's `published` IS this `built` (modulo a
 * wire round trip, which `stringifySeriesFile`/`parseSeriesFile` keep an
 * identity), every pair matches itself, no term fires, and no further write
 * is scheduled — one write per damaged file per device, ever. Pinned by the
 * two-cycle tests in `series-file.test.ts` / `series-backfill.test.ts`.
 */
export function seriesFileHealDifference(
  published: SeriesFile,
  built: SeriesFile,
  cloudTitleKeys: Set<string>
): boolean {
  const builtByUuid = new Map<string, SeriesFileVolume>();
  const builtByTitle = new Map<string, SeriesFileVolume>();
  for (const entry of built.volumes) {
    builtByUuid.set(entry.volume_uuid, entry);
    const key = normalizeVolumeTitleKey(entry.volume_title);
    if (key) builtByTitle.set(key, entry);
  }

  const claimed = new Set<SeriesFileVolume>();
  for (const entry of published.volumes) {
    const match =
      builtByUuid.get(entry.volume_uuid) ??
      builtByTitle.get(normalizeVolumeTitleKey(entry.volume_title));
    if (!match) continue; // removal/prune: never material
    if (claimed.has(match)) return true; // COLLAPSE
    claimed.add(match);
    if (!hasMeasuredContent(entry) && hasMeasuredContent(match)) return true; // SUPERSEDE
    for (const field of INHERITED_FILE_FACTS) {
      if (entry[field] === undefined && match[field] !== undefined) return true; // ENRICHMENT
    }
  }

  for (const entry of built.volumes) {
    if (claimed.has(entry)) continue;
    const key = normalizeVolumeTitleKey(entry.volume_title);
    if (key && cloudTitleKeys.has(key)) return true; // LISTING-BACKED ADDITION
  }

  return false;
}

/** The shareable half of a series record (or of the file already in the cloud). */
interface SeriesFacts {
  external_ids?: SeriesExternalIds;
  titles?: SeriesTitles;
  synonyms?: string[];
  tag?: string;
  unit?: TrackingUnit;
  /**
   * The facts clock — NOT a record's general `updated_at`. `undefined` means this
   * record has never carried facts and has never had a fact edit, so it has no
   * opinion about them at all.
   */
  updated_at?: string;
}

/** Does this record/file say anything shareable about the series? */
export function hasSeriesFacts(facts: SeriesFacts): boolean {
  return (
    Object.keys(facts.external_ids ?? {}).length > 0 ||
    Object.keys(facts.titles ?? {}).length > 0 ||
    (facts.synonyms ?? []).some((s) => s.trim() !== '') ||
    !!facts.tag?.trim() ||
    !!facts.unit
  );
}

/**
 * The facts clock of a series record: the explicit stamp once a fact edit has
 * happened (including an unlink, which clears the facts on purpose), else the
 * record's own stamp for legacy records that still carry facts, else `undefined`
 * — "this library has never had an opinion about this series".
 */
export function seriesFactsStamp(meta: SeriesMetadata): string | undefined {
  return meta.facts_updated_at ?? (hasSeriesFacts(meta) ? meta.updated_at : undefined);
}

/** Facts of a local record, stamped with its (normalized) facts clock. */
function localFacts(meta: SeriesMetadata): SeriesFacts {
  const stamp = seriesFactsStamp(meta);
  return {
    external_ids: meta.external_ids ?? {},
    titles: meta.titles ?? {},
    synonyms: meta.synonyms ?? [],
    tag: meta.tag,
    unit: meta.unit,
    updated_at:
      stamp === undefined ? undefined : (normalizeUpdatedAt(stamp) ?? new Date().toISOString())
  };
}

/**
 * Build the file to upload for one series.
 *
 * Facts come from the local record, stamped with its *facts* clock — never with
 * `updated_at` itself, which every per-user write (spine offsets, rereads,
 * tracking pushes) bumps. Which side wins:
 *
 * - local record carries facts → newest facts clock wins, ties keep local (that
 *   is the same link round-tripping back through `upsertFromSeriesFile`);
 * - local record is factless but HAS a facts clock (someone unlinked here) → the
 *   unlink is published, but only when it is strictly newer than the file;
 * - local record is factless with NO facts clock (this library never had an
 *   opinion; its `updated_at` only ever tracked per-user state) → whatever is
 *   already published is carried through untouched, and with nothing published
 *   either the file is index-only and stamped `FACTLESS_UPDATED_AT`.
 *
 * Volumes are the union of the existing index and the local rows, merged
 * through `createVolumeEntryMerger` — matched by `volume_uuid` OR folded
 * `volume_title`, since either key identifies the same archive — because a
 * device only ever knows about its own volumes, so it must not delete entries
 * written by another device. Local rows rank by how much they prove:
 *
 * - INSTALLED — measured here, archive present: overrides the published entry,
 *   and its uuid is exempt from the listing prune (a volume not backed up yet is
 *   local-only, not deleted).
 * - metadata-only (including rows materialized from an index) — a copy of
 *   somebody else's claim: FILLS an entry the file is missing, but never
 *   overrides the published one (which may describe a re-OCR this device has
 *   never seen) and never exempts it from the prune (keeping a history row is
 *   not evidence the archive still exists).
 * - placeholder — the cloud's own volumes reflected back, uuids and counts
 *   derived rather than measured: excluded entirely.
 *
 * Passing `cloudVolumeTitles` (the titles the current cloud listing shows for
 * this series) prunes entries whose volume is neither in the cloud nor installed
 * here, which is how a deleted volume eventually leaves the index.
 *
 * `cloudMeasuredVolumes` — entries the sidecar-backfill pass (`series-backfill.ts`)
 * built by pulling a volume's `.mokuro`/`.mokuro.gz` straight from the cloud
 * folder — rank ABOVE the published copy (the pulled sidecar IS the cloud's
 * current content: it self-heals a stale published entry after a re-OCR
 * upload) but BELOW an installed row, which is still measured on this device.
 * Applied by folded `volume_title`, not just uuid: a re-OCR can mint a new
 * `volume_uuid` for the same archive, so the stale published entry under the
 * OLD uuid is retired rather than left beside the fresh one under the new.
 *
 * `cloudSidecarStamps` — the current listing's `.mokuro`/cover file sizes and
 * mtimes (epoch seconds), keyed by folded volume title. When an INSTALLED row
 * builds its own entry below, this is where it picks up `mokuro_size` /
 * `mokuro_modified` / `cover_size` / `cover_modified` when the listing shows
 * that volume's sidecar right now — the freshest stat an installed row can
 * carry. Absent (or missing an entry for a title), the stamps the displaced
 * published entry already carried ride through instead, via the merger's
 * field inheritance (see `createVolumeEntryMerger`): a possibly-behind stamp
 * re-triggers staleness verification when the sidecar moves, where a
 * stripped one never would (`isSidecarStale` treats stampless as never
 * stale).
 *
 * Returns `undefined` when there is nothing worth uploading (no facts, no volumes).
 */
export function buildSeriesFile(args: {
  seriesTitle: string;
  meta: SeriesMetadata | undefined;
  localVolumes: VolumeMetadata[];
  existing?: SeriesFile;
  cloudVolumeTitles?: Set<string>;
  cloudMeasuredVolumes?: SeriesFileVolume[];
  cloudSidecarStamps?: Map<string, CloudSidecarStamp>;
}): SeriesFile | undefined {
  const {
    seriesTitle,
    meta,
    localVolumes,
    existing,
    cloudVolumeTitles,
    cloudMeasuredVolumes,
    cloudSidecarStamps
  } = args;

  const local = meta ? localFacts(meta) : undefined;
  const localStamp = local?.updated_at;
  const existingHasFacts = !!existing && hasSeriesFacts(existing);

  let source: SeriesFacts | undefined;
  if (!local || localStamp === undefined) {
    source = existing;
  } else if (!existingHasFacts) {
    // Nothing published, or something published factless. Belt and braces for
    // the unlink relay: `local` must not LOWER the stamp already on the file. A
    // factless file carrying a newer stamp is somebody's deliberate unlink, and
    // republishing our older stamp over it would strand that unlink — every
    // device still holding the link compares stamps and would reject it.
    source = existing === undefined || localStamp >= existing.updated_at ? local : existing;
  } else if (hasSeriesFacts(local)) {
    source = localStamp >= existing!.updated_at ? local : existing;
  } else {
    source = localStamp > existing!.updated_at ? local : existing;
  }

  const external_ids: SeriesExternalIds = {};
  const titles: SeriesTitles = {};
  let synonyms: string[] = [];
  let tag: string | undefined;
  let unit: TrackingUnit | undefined;

  if (source) {
    for (const k of ID_KEYS)
      if (source.external_ids?.[k] != null) external_ids[k] = source.external_ids[k];
    for (const k of TITLE_KEYS) if (source.titles?.[k]) titles[k] = source.titles[k];
    synonyms = [...(source.synonyms ?? [])];
    tag = source.tag?.trim() || undefined;
    unit = sanitizeTrackingUnit(source.unit);
  }
  // No source at all = no facts clock here and nothing published: the file is
  // index-only and must not be able to outrank anybody's facts.
  const updated_at = source?.updated_at ?? FACTLESS_UPDATED_AT;

  // Only an INSTALLED volume is evidence: its counts were measured here and its
  // archive is on this device. A metadata-only row (including one this device
  // materialized from an index) is a copy of somebody else's claim, so it ranks
  // below both the installed set and whatever is already published.
  const installed = localVolumes.filter(isVolumeInstalled);
  const localUuids = new Set(installed.map((v) => v.volume_uuid));

  // Every pass below merges through the ONE shared rule (see
  // `createVolumeEntryMerger`): an incoming entry matches an existing one by
  // uuid OR by folded title, and a real entry always beats a no-metadata one.
  // Seeding the existing file through it is what HEALS a published (or stale
  // cached) copy that already carries doubled entries — the no-metadata entry
  // beside the real one, or a pre-rename entry beside the post-rename one —
  // so the very next write repairs the file in the cloud.
  const merger = createVolumeEntryMerger(seriesTitle);
  for (const entry of existing?.volumes ?? []) merger.add(entry, 'fill');

  // The sidecar-backfill's own entries: the pulled sidecar IS the cloud's
  // current content, so it overrides whatever is published for that VOLUME —
  // not just that uuid. A re-OCR mints a new `volume_uuid` for the same
  // archive and a rename keeps the uuid under a new filename; either way the
  // stale published entry is retired rather than left beside the fresh one.
  // Applied before the installed loop below, which — being measured on this
  // device — still gets the last word for any of these same volumes. The one
  // thing a pulled entry does NOT displace is a REAL published entry when the
  // pull itself came back metadata-less (an image-only rebuild for an archive
  // whose sidecar vanished): winner rule 1 keeps the measured counts.
  for (const entry of cloudMeasuredVolumes ?? []) merger.add(entry, 'replace');

  // Non-installed rows FILL a missing entry only: they never override a real
  // published copy (which may describe a re-OCR this device has not seen), and
  // they are absent from `localUuids`, so they never exempt an entry from the
  // listing prune — a volume deleted from the cloud must not be re-added by a
  // device that merely kept its history row. The one published thing they DO
  // replace is a no-metadata entry for the same file (winner rule 1): the row
  // was measured from a real mokuro once, the placeholder never was.
  for (const volume of localVolumes) {
    if (volume.isPlaceholder || isVolumeInstalled(volume)) continue;
    merger.add(volumeToIndexEntry(volume), 'fill');
  }
  for (const volume of installed) {
    const entry = volumeToIndexEntry(volume);
    // What an installed row legitimately does NOT know — `archive_size` for a
    // volume imported from disk (nothing here ever measured its archive), and
    // the stamps below when no listing was passed — it inherits from the
    // published entry it supersedes, inside the merger itself (matched by
    // uuid OR title, so the fact survives the uuid changing under a
    // superseded no-metadata entry — see `createVolumeEntryMerger`'s
    // INHERITANCE rule). Everything the row DID measure still wins.
    //
    // An installed row has no local way to know a CLOUD file's stat — the only
    // source is the listing itself, passed in by the caller that already read
    // it. Set when the listing shows that sidecar right now; otherwise the
    // displaced entry's own stamps ride through as above.
    const stamps = cloudSidecarStamps?.get(normalizeVolumeTitleKey(volume.volume_title));
    if (stamps?.mokuro_size !== undefined) entry.mokuro_size = stamps.mokuro_size;
    if (stamps?.mokuro_modified !== undefined) entry.mokuro_modified = stamps.mokuro_modified;
    if (stamps?.cover_size !== undefined) entry.cover_size = stamps.cover_size;
    if (stamps?.cover_modified !== undefined) entry.cover_modified = stamps.cover_modified;
    merger.add(entry, 'replace');
  }

  let volumes = merger.values();
  if (cloudVolumeTitles) {
    // Folded on both sides: the listing's titles are cloud filenames, the
    // entries' are whatever wrote the file, and case/whitespace/unicode-form
    // drift between them must not read as "deleted from the cloud".
    const cloudKeys = new Set([...cloudVolumeTitles].map(normalizeVolumeTitleKey));
    volumes = volumes.filter(
      (entry) =>
        cloudKeys.has(normalizeVolumeTitleKey(entry.volume_title)) ||
        localUuids.has(entry.volume_uuid)
    );
  }

  // ---- index data: the shelf alignment ----
  // Same rules as `archive_size`: this library's value wins where it has one,
  // and the published value rides through where it does not — the entry's own
  // `offset` already IS the published value at this point, carried through
  // the merger (and, where the publishing entry was displaced by a uuid
  // change or a rename, inherited onto its successor — see
  // `createVolumeEntryMerger`'s INHERITANCE rule). Neither ever moves the
  // facts stamp. A device that never linked the series still publishes the
  // alignment it measured, and a bunko user inherits the uploader's shelf. A
  // local ZERO is a deliberate reset, so it suppresses the carried value
  // instead of inheriting it back — and is then omitted from the file, which
  // is what keeps build → parse an identity.
  const localOffsets = meta?.volume_offsets ?? {};
  volumes = volumes.map((entry) => {
    const hasLocal = Object.prototype.hasOwnProperty.call(localOffsets, entry.volume_uuid);
    const local = hasLocal ? sanitizeVolumeOffset(localOffsets[entry.volume_uuid]) : undefined;
    const offset = local ?? entry.offset;
    if (!offset) {
      if (entry.offset === undefined) return entry;
      const cleared = { ...entry };
      delete cleared.offset;
      return cleared;
    }
    return entry.offset === offset ? entry : { ...entry, offset };
  });

  volumes.sort(compareEntries);

  if (!hasSeriesFacts({ external_ids, titles, synonyms, tag, unit }) && volumes.length === 0) {
    return undefined;
  }

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
}

/**
 * `buildSeriesFile` for callers holding the WHOLE volumes table: selects this
 * series' volumes by normalized key (the same grouping the catalog uses) and
 * builds the file.
 *
 * Pure, so both readers of the table share it — the main thread
 * (`volume-sidecars.ts`) and the export Worker (`compress-volume.ts`), which
 * has its own Dexie handle and cannot import the app's.
 */
export function buildSeriesFileFrom(args: {
  seriesTitle: string;
  meta: SeriesMetadata | undefined;
  /** Every installed volume; entries of other series are ignored. */
  volumes: VolumeMetadata[];
  existing?: SeriesFile;
}): SeriesFile | undefined {
  const { seriesTitle, meta, volumes, existing } = args;
  const key = normalizeSeriesKey(seriesTitle);
  if (!key) return undefined;

  const localVolumes = volumes.filter((v) => normalizeSeriesKey(v.series_title) === key);
  return buildSeriesFile({ seriesTitle, meta, localVolumes, existing });
}

/**
 * Merge a `series.json` that arrived out of band (an import) over the copy this
 * device already cached: the volume entries are unioned through the shared
 * merge rule (`createVolumeEntryMerger` — matched by uuid OR folded title)
 * with the arriving file winning ties, so caching an import can never shrink
 * an index fetched from the cloud — except by collapsing two entries that
 * describe the SAME file (a no-metadata entry and the real one, or a pre- and
 * post-rename pair), which the shared rule heals here the same as everywhere
 * else. The facts follow the same newest-`updated_at`-wins rule as
 * `upsertFromSeriesFile`. `series_title` is stamped with the title the record
 * is filed under, keeping the file's own name and its key in step.
 */
export function mergeSeriesFileForCache(
  seriesTitle: string,
  file: SeriesFile,
  cached: SeriesFile | undefined
): SeriesFile {
  if (!cached) return { ...file, series_title: seriesTitle };

  const merger = createVolumeEntryMerger(seriesTitle);
  for (const entry of cached.volumes) merger.add(entry, 'fill');
  for (const entry of file.volumes) merger.add(entry, 'replace');

  const base = file.updated_at >= cached.updated_at ? file : cached;
  const volumes = merger.values().sort(compareEntries);
  const merged: SeriesFile = { ...base, series_title: seriesTitle, volumes };
  if (!base.tag) delete merged.tag;
  if (!base.unit) delete merged.unit;
  // The alignment does NOT follow the facts clock — it is index data, and index
  // data merges by "absent = no opinion = inherit" everywhere. So the winner's
  // value wins where it has one, and otherwise the loser's rides through
  // instead of being dropped on a stamp it has nothing to do with.
  //
  // The per-VOLUME nudge follows the same principle one level down, inside
  // the union above: an arriving entry that collapses with a cached one keeps
  // its own `offset` where it carries one and inherits the cached nudge where
  // it does not — the arriving writer may simply never have known the nudge
  // (see `createVolumeEntryMerger`'s INHERITANCE rule; a deliberate local
  // reset still propagates through the next listing-driven build, which
  // applies `volume_offsets` after the merge). `spine_offset` has no
  // per-entry unit — the file either mentions it or does not — so its absence
  // is silence here too.
  const loser = base === file ? cached : file;
  if (merged.spine_offset === undefined && loser.spine_offset !== undefined) {
    merged.spine_offset = loser.spine_offset;
  }
  return merged;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseVolumeEntry(value: unknown): SeriesFileVolume | undefined {
  if (!isRecord(value)) return undefined;
  const { volume_uuid, volume_title, page_count, character_count, mokuro_version } = value;

  if (typeof volume_uuid !== 'string' || !volume_uuid.trim()) return undefined;
  if (typeof volume_title !== 'string' || !volume_title.trim()) return undefined;
  if (!isNonNegativeInt(page_count) || !isNonNegativeInt(character_count)) return undefined;
  if (typeof mokuro_version !== 'string') return undefined;

  // Older files carried a per-page cumulative `page_char_counts` array; it is
  // ignored on read (dropped: it made the file huge and nothing needs it —
  // `VolumeData.chars` already holds what was read of a not-installed volume).
  const entry: SeriesFileVolume = {
    volume_uuid,
    volume_title,
    page_count,
    character_count,
    mokuro_version
  };
  // Field insertion order here is the WIRE order (`JSON.stringify` walks
  // key-insertion order): volume_uuid..mokuro_version above, then
  // spine_width?, archive_size?, mokuro_size?, mokuro_modified?, cover_size?,
  // cover_modified?, and `offset` LAST — the one INDEX field among the
  // per-volume facts. The server compiler emits exactly this order and an
  // entry carried through unchanged from a parsed file must re-serialize
  // byte-for-byte the same way, so this order is a contract, not a style
  // choice — see docs/superpowers/plans/2026-08-23-catalog-distribution-bunko.md §2.
  const spine = value.spine_width;
  if (typeof spine === 'number' && Number.isFinite(spine) && spine > 0) entry.spine_width = spine;
  if (isArchiveSize(value.archive_size)) entry.archive_size = value.archive_size;
  if (isArchiveSize(value.mokuro_size)) entry.mokuro_size = value.mokuro_size;
  if (isEpochSeconds(value.mokuro_modified)) entry.mokuro_modified = value.mokuro_modified;
  if (isArchiveSize(value.cover_size)) entry.cover_size = value.cover_size;
  if (isEpochSeconds(value.cover_modified)) entry.cover_modified = value.cover_modified;
  const offset = sanitizeVolumeOffset(value.offset);
  if (offset) entry.offset = offset;
  return entry;
}

/**
 * Validate an untrusted `series.json`.
 *
 * Everything here is foreign data — anyone with write access to the cloud folder
 * (or a text editor) can change it — so every field is re-validated with the
 * shared helpers in `sanitize.ts`, bad volume entries are
 * dropped individually rather than failing the file, and unknown keys are never
 * carried through (they would let per-user state ride along). `updated_at` is
 * normalised and clamped because it decides the facts merge by lexicographic
 * comparison: a non-ISO or far-future value would otherwise win forever.
 *
 * `version: 1` (facts only, no index) is accepted and yields an empty index.
 */
/**
 * The one serializer every writer uses (cloud upload, series ZIP, single-volume
 * CBZ, worker download path). Compact on purpose: the file is read by machines
 * (this app, mokuro-bunko), and pretty-printing cost ~25% for nothing.
 */
export function stringifySeriesFile(file: SeriesFile): string {
  return JSON.stringify(file);
}

export function parseSeriesFile(value: unknown): SeriesFile | undefined {
  return parseSeriesFileWithReport(value).file;
}

/**
 * {@link parseSeriesFile}, additionally reporting whether the RAW file carried
 * doubled entries that the read-time healing collapsed.
 *
 * The healed shape is all any reader ever sees — which is exactly why the
 * cloud-download call sites (`readCloudSeriesFile`,
 * `series-index-sync.ts`'s `refreshOne`) need this signal: once the parsed
 * copy is cached, nothing downstream can tell the published bytes are still
 * doubled, so "this file needs a heal-write" would be unknowable. They persist
 * it as `SeriesIndexRecord.raw_entry_collapse`, and the heal seam
 * (`series-backfill.ts`'s `maybeScheduleSeriesHealWrite`) schedules the
 * overwrite that repairs the file in the cloud. `entryCollapse` is exact, not
 * a heuristic: the merger only ever collapses (never invents), so fewer
 * entries out than valid entries in means the raw file genuinely held two
 * entries for one volume.
 */
export function parseSeriesFileWithReport(value: unknown): {
  file: SeriesFile | undefined;
  entryCollapse: boolean;
} {
  if (!isRecord(value)) return { file: undefined, entryCollapse: false };
  if (value.version !== 1 && value.version !== 2) return { file: undefined, entryCollapse: false };

  const series_title = value.series_title;
  if (typeof series_title !== 'string' || !series_title.trim()) {
    return { file: undefined, entryCollapse: false };
  }

  const updated_at = normalizeUpdatedAt(value.updated_at);
  if (!updated_at) return { file: undefined, entryCollapse: false };

  // Healed on read, not just validated: files already published with doubled
  // entries (the same volume under its no-metadata derived uuid AND its real
  // one, or twice under one exact title) collapse through the shared merge
  // rule here — field-aware, so the survivor inherits the archive size, the
  // shelf nudge and the sidecar stamps of the entry it retires — and every
  // reader sees one entry per volume while the next write repairs the
  // published file. 'fill' keeps the earlier entry on pure ties, preserving
  // the old first-wins behavior for exact-uuid duplicates. The title join is
  // EXACT here, not folded: a parse-time healer has no cloud listing to ask,
  // and case-distinct filenames genuinely coexist on case-sensitive
  // providers, so it only merges what is provably the same volume.
  // Case/whitespace drift between two entries for one file is left to
  // `buildSeriesFile`, which folds under a real listing.
  const volumes: SeriesFileVolume[] = [];
  let validEntries = 0;
  if (Array.isArray(value.volumes)) {
    const merger = createVolumeEntryMerger(series_title, { titleKeyOf: (title) => title });
    for (const raw of value.volumes) {
      const entry = parseVolumeEntry(raw);
      if (entry) {
        validEntries += 1;
        merger.add(entry, 'fill');
      }
    }
    volumes.push(...merger.values());
  }

  const file: SeriesFile = {
    version: 2,
    series_title,
    external_ids: sanitizeExternalIds(value.external_ids),
    titles: sanitizeTitles(value.titles),
    synonyms: sanitizeSynonyms(value.synonyms),
    updated_at,
    volumes
  };
  const tag = sanitizeTag(value.tag);
  if (tag) file.tag = tag;
  const unit = sanitizeTrackingUnit(value.unit);
  if (unit) file.unit = unit;
  const spineOffset = sanitizeSpineOffset(value.spine_offset);
  if (spineOffset) file.spine_offset = spineOffset;
  return { file, entryCollapse: volumes.length < validEntries };
}

/** True when `path` points at a series sidecar (basename match, case-insensitive). */
export function isSeriesFilePath(path: string): boolean {
  const basename = path.split(/[\\/]/).pop() ?? '';
  return basename.toLowerCase() === SERIES_FILE_NAME;
}
