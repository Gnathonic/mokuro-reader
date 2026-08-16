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
import type {
  EmbeddedSeriesMetadata,
  SeriesExternalIds,
  SeriesMetadata,
  SeriesTitles
} from './types';

/** Facts + tag only. Returns undefined when there is nothing worth writing. */
export function toEmbedded(
  meta: SeriesMetadata | undefined | null
): EmbeddedSeriesMetadata | undefined {
  if (!meta) return undefined;
  const external_ids: SeriesExternalIds = {};
  for (const k of ID_KEYS)
    if (meta.external_ids?.[k] != null) external_ids[k] = meta.external_ids[k];
  const titles: SeriesTitles = {};
  for (const k of TITLE_KEYS) if (meta.titles?.[k]) titles[k] = meta.titles[k];
  const synonyms = [...(meta.synonyms ?? [])];
  const tag = meta.tag?.trim();

  const hasIds = Object.keys(external_ids).length > 0;
  const hasTitles = Object.keys(titles).length > 0;
  if (!hasIds && !hasTitles && !tag) return undefined;

  const out: EmbeddedSeriesMetadata = {
    external_ids,
    titles,
    synonyms,
    updated_at: meta.updated_at
  };
  if (tag) out.tag = tag;
  return out;
}

/**
 * Validate an untrusted `series_metadata` block from a .mokuro file.
 *
 * `updated_at` is normalized to ISO (and clamped when far in the future) before
 * it is stored: it is the merge key, compared lexicographically, so a hand-edited
 * "Aug 16 2020" or a year-3000 timestamp would otherwise win forever.
 */
export function fromEmbedded(value: unknown): EmbeddedSeriesMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const updated_at = normalizeUpdatedAt(value.updated_at);
  if (!updated_at) return undefined;

  const out: EmbeddedSeriesMetadata = {
    external_ids: sanitizeExternalIds(value.external_ids),
    titles: sanitizeTitles(value.titles),
    synonyms: sanitizeSynonyms(value.synonyms),
    updated_at
  };
  const tag = sanitizeTag(value.tag);
  if (tag) out.tag = tag;
  return out;
}
