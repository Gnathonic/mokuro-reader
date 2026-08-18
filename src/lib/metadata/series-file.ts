import { sortVolumes } from '$lib/catalog/sort-volumes';
import type { VolumeMetadata } from '$lib/types';
import {
  ID_KEYS,
  TITLE_KEYS,
  isRecord,
  normalizeUpdatedAt,
  sanitizeExternalIds,
  sanitizeSynonyms,
  sanitizeTag,
  sanitizeTitles
} from './sanitize';
import type { SeriesExternalIds, SeriesMetadata, SeriesTitles } from './types';

/** Basename of the per-series sidecar, stored at `<Series Title>/series.json`. */
export const SERIES_FILE_NAME = 'series.json';

/**
 * One volume in the series index. Enough to show a cloud-only volume in the
 * catalog and attach synced progress to it without downloading its `.mokuro`.
 * Never per-user state (progress, offsets, read counts) and never page/OCR data.
 */
export interface SeriesFileVolume {
  volume_uuid: string;
  volume_title: string;
  page_count: number;
  character_count: number;
  /** Cumulative character count per page. */
  page_char_counts: number[];
  /** `''` for image-only volumes. */
  mokuro_version: string;
  spine_width?: number;
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
  updated_at: string;
  volumes: SeriesFileVolume[];
}

/** A usable spine width: a positive finite number of pixels. */
function isSpineWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Project a local volume onto its index entry (index fields only). */
export function volumeToIndexEntry(volume: VolumeMetadata): SeriesFileVolume {
  const entry: SeriesFileVolume = {
    volume_uuid: volume.volume_uuid,
    volume_title: volume.volume_title,
    page_count: volume.page_count,
    character_count: volume.character_count,
    page_char_counts: [...(volume.page_char_counts ?? [])],
    mokuro_version: volume.mokuro_version
  };
  // Same rule as the parser, so build → JSON → parse is an identity: a 0 or junk
  // width is "no width", not a width of zero.
  if (isSpineWidth(volume.spine_width)) entry.spine_width = volume.spine_width;
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
    !!facts.tag?.trim()
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
 *   already published is carried through untouched.
 *
 * Volumes are the union of the existing index and the installed volumes, keyed
 * by `volume_uuid` with local winning — a device only ever knows about its own
 * volumes, so it must not delete entries written by another device. Passing
 * `cloudVolumeTitles` (the titles the current cloud listing shows for this
 * series) additionally prunes entries whose volume is neither in the cloud nor
 * installed here, which is how a deleted volume eventually leaves the index.
 *
 * Placeholders are excluded: they are the cloud's own volumes reflected back,
 * and their uuids/counts are derived, not measured.
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
    source = local;
  } else if (hasSeriesFacts(local)) {
    source = localStamp >= existing!.updated_at ? local : existing;
  } else {
    source = localStamp > existing!.updated_at ? local : existing;
  }

  const external_ids: SeriesExternalIds = {};
  const titles: SeriesTitles = {};
  let synonyms: string[] = [];
  let tag: string | undefined;

  if (source) {
    for (const k of ID_KEYS)
      if (source.external_ids?.[k] != null) external_ids[k] = source.external_ids[k];
    for (const k of TITLE_KEYS) if (source.titles?.[k]) titles[k] = source.titles[k];
    synonyms = [...(source.synonyms ?? [])];
    tag = source.tag?.trim() || undefined;
  }
  const updated_at = source?.updated_at ?? new Date().toISOString();

  const installed = localVolumes.filter((v) => !v.isPlaceholder);
  const localUuids = new Set(installed.map((v) => v.volume_uuid));

  const byUuid = new Map<string, SeriesFileVolume>();
  for (const entry of existing?.volumes ?? []) byUuid.set(entry.volume_uuid, entry);
  for (const volume of installed) byUuid.set(volume.volume_uuid, volumeToIndexEntry(volume));

  let volumes = [...byUuid.values()];
  if (cloudVolumeTitles) {
    volumes = volumes.filter(
      (entry) => cloudVolumeTitles.has(entry.volume_title) || localUuids.has(entry.volume_uuid)
    );
  }
  volumes.sort(compareEntries);

  if (!hasSeriesFacts({ external_ids, titles, synonyms, tag }) && volumes.length === 0) {
    return undefined;
  }

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
  return file;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseVolumeEntry(value: unknown): SeriesFileVolume | undefined {
  if (!isRecord(value)) return undefined;
  const {
    volume_uuid,
    volume_title,
    page_count,
    character_count,
    page_char_counts,
    mokuro_version
  } = value;

  if (typeof volume_uuid !== 'string' || !volume_uuid.trim()) return undefined;
  if (typeof volume_title !== 'string' || !volume_title.trim()) return undefined;
  if (!isNonNegativeInt(page_count) || !isNonNegativeInt(character_count)) return undefined;
  if (!Array.isArray(page_char_counts) || !page_char_counts.every(isNonNegativeInt))
    return undefined;
  if (typeof mokuro_version !== 'string') return undefined;

  const entry: SeriesFileVolume = {
    volume_uuid,
    volume_title,
    page_count,
    character_count,
    page_char_counts: [...page_char_counts],
    mokuro_version
  };
  const spine = value.spine_width;
  if (typeof spine === 'number' && Number.isFinite(spine) && spine > 0) entry.spine_width = spine;
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
  return file;
}

/** True when `path` points at a series sidecar (basename match, case-insensitive). */
export function isSeriesFilePath(path: string): boolean {
  const basename = path.split(/[\\/]/).pop() ?? '';
  return basename.toLowerCase() === SERIES_FILE_NAME;
}
