import { sortVolumes } from '$lib/catalog/sort-volumes';
import { isVolumeInstalled } from '$lib/catalog/volume-state';
import type { VolumeMetadata } from '$lib/types';
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
}

/**
 * `<Series Title>/series.json` — the shareable series facts plus an
 * unauthoritative index of the series' volumes.
 *
 * The content is advisory: local IndexedDB always wins for installed volumes,
 * the index only fills gaps for volumes this device does not have. `updated_at`
 * is the merge key for the *facts* only (see `upsertFromSeriesFile`); volume
 * entries merge by `volume_uuid` with the local copy winning.
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

/** `sortVolumes` only reads `volume_title`, which every index entry carries. */
function compareEntries(a: SeriesFileVolume, b: SeriesFileVolume): number {
  return sortVolumes(a as unknown as VolumeMetadata, b as unknown as VolumeMetadata);
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
 * Volumes are the union of the existing index and the local rows, keyed by
 * `volume_uuid` — a device only ever knows about its own volumes, so it must not
 * delete entries written by another device. Local rows rank by how much they
 * prove:
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
 * Returns `undefined` when there is nothing worth uploading (no facts, no volumes).
 */
export function buildSeriesFile(args: {
  seriesTitle: string;
  meta: SeriesMetadata | undefined;
  localVolumes: VolumeMetadata[];
  existing?: SeriesFile;
  cloudVolumeTitles?: Set<string>;
}): SeriesFile | undefined {
  const { seriesTitle, meta, localVolumes, existing, cloudVolumeTitles } = args;

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

  const byUuid = new Map<string, SeriesFileVolume>();
  for (const entry of existing?.volumes ?? []) byUuid.set(entry.volume_uuid, entry);
  // Non-installed rows FILL a missing entry only: they never override the
  // published copy (which may describe a re-OCR this device has not seen), and
  // they are absent from `localUuids`, so they never exempt an entry from the
  // listing prune — a volume deleted from the cloud must not be re-added by a
  // device that merely kept its history row.
  for (const volume of localVolumes) {
    if (volume.isPlaceholder || isVolumeInstalled(volume)) continue;
    if (!byUuid.has(volume.volume_uuid)) byUuid.set(volume.volume_uuid, volumeToIndexEntry(volume));
  }
  for (const volume of installed) {
    const entry = volumeToIndexEntry(volume);
    // The one field an installed row can legitimately NOT know: a volume
    // imported from disk was never uploaded or downloaded here, so nothing ever
    // measured its archive. That is a gap in this device's knowledge, not a
    // correction of what the device that DID upload it published, so the
    // published size rides through instead of being erased. Everything else the
    // installed row says still wins — it measured those itself.
    const publishedSize = byUuid.get(volume.volume_uuid)?.archive_size;
    if (entry.archive_size === undefined && publishedSize !== undefined) {
      entry.archive_size = publishedSize;
    }
    byUuid.set(volume.volume_uuid, entry);
  }

  let volumes = [...byUuid.values()];
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
 * device already cached: the volume entries are unioned by uuid with the
 * arriving file winning, so caching an import can never shrink an index fetched
 * from the cloud, and the facts follow the same newest-`updated_at`-wins rule as
 * `upsertFromSeriesFile`. `series_title` is stamped with the title the record is
 * filed under, keeping the file's own name and its key in step.
 */
export function mergeSeriesFileForCache(
  seriesTitle: string,
  file: SeriesFile,
  cached: SeriesFile | undefined
): SeriesFile {
  if (!cached) return { ...file, series_title: seriesTitle };

  const byUuid = new Map<string, SeriesFileVolume>();
  for (const entry of cached.volumes) byUuid.set(entry.volume_uuid, entry);
  for (const entry of file.volumes) byUuid.set(entry.volume_uuid, entry);

  const base = file.updated_at >= cached.updated_at ? file : cached;
  const volumes = [...byUuid.values()].sort(compareEntries);
  const merged: SeriesFile = { ...base, series_title: seriesTitle, volumes };
  if (!base.tag) delete merged.tag;
  if (!base.unit) delete merged.unit;
  // The alignment does NOT follow the facts clock — it is index data, and index
  // data merges by "absent = no opinion = inherit" everywhere else. So the
  // winner's value wins where it has one, and otherwise the loser's rides
  // through instead of being dropped on a stamp it has nothing to do with.
  //
  // The two LEVELS behave differently here, deliberately — do not "fix" one to
  // match the other. A volume entry is the merge unit: the union above replaces
  // a whole entry by uuid, so an arriving entry that lists the volume WITHOUT an
  // offset is a positive statement ("this is the volume, it has no nudge") and
  // clears the cached one. `spine_offset` has no such unit — the file either
  // mentions it or does not — so its absence is silence, and silence inherits.
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
  const spine = value.spine_width;
  if (typeof spine === 'number' && Number.isFinite(spine) && spine > 0) entry.spine_width = spine;
  if (isArchiveSize(value.archive_size)) entry.archive_size = value.archive_size;
  const offset = sanitizeVolumeOffset(value.offset);
  if (offset) entry.offset = offset;
  return entry;
}

/**
 * Validate an untrusted `series.json`.
 *
 * Everything here is foreign data — anyone with write access to the cloud folder
 * (or a text editor) can change it — so every field is re-validated with the
 * same helpers the `series-metadata.json` merge uses, bad volume entries are
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
  if (!isRecord(value)) return undefined;
  if (value.version !== 1 && value.version !== 2) return undefined;

  const series_title = value.series_title;
  if (typeof series_title !== 'string' || !series_title.trim()) return undefined;

  const updated_at = normalizeUpdatedAt(value.updated_at);
  if (!updated_at) return undefined;

  const volumes: SeriesFileVolume[] = [];
  if (Array.isArray(value.volumes)) {
    const seen = new Set<string>();
    for (const raw of value.volumes) {
      const entry = parseVolumeEntry(raw);
      if (!entry || seen.has(entry.volume_uuid)) continue;
      seen.add(entry.volume_uuid);
      volumes.push(entry);
    }
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
  return file;
}

/** True when `path` points at a series sidecar (basename match, case-insensitive). */
export function isSeriesFilePath(path: string): boolean {
  const basename = path.split(/[\\/]/).pop() ?? '';
  return basename.toLowerCase() === SERIES_FILE_NAME;
}
