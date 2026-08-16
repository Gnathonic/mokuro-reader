import type {
  EmbeddedSeriesMetadata,
  SeriesExternalIds,
  SeriesMetadata,
  SeriesTitles
} from './types';

const TITLE_KEYS = ['native', 'romaji', 'english'] as const;
const ID_KEYS = ['anilist', 'mal'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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

/** Validate an untrusted `series_metadata` block from a .mokuro file. */
export function fromEmbedded(value: unknown): EmbeddedSeriesMetadata | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.updated_at !== 'string' || Number.isNaN(Date.parse(value.updated_at))) {
    return undefined;
  }

  const rawIds = isRecord(value.external_ids) ? value.external_ids : {};
  const external_ids: SeriesExternalIds = {};
  for (const k of ID_KEYS) {
    const v = rawIds[k];
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) external_ids[k] = v;
  }

  const rawTitles = isRecord(value.titles) ? value.titles : {};
  const titles: SeriesTitles = {};
  for (const k of TITLE_KEYS) {
    const v = rawTitles[k];
    if (typeof v === 'string' && v.trim()) titles[k] = v;
  }

  const synonyms = Array.isArray(value.synonyms)
    ? value.synonyms.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    : [];

  const out: EmbeddedSeriesMetadata = {
    external_ids,
    titles,
    synonyms,
    updated_at: value.updated_at
  };
  if (typeof value.tag === 'string' && value.tag.trim()) out.tag = value.tag.trim();
  return out;
}
