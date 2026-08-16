import { isDisplayTitleLanguage } from './sanitize';
import type { DisplayTitleLanguage, SeriesMetadata, SeriesTitles } from './types';

/** Fallback order when the requested language is missing (spec: english → romaji → native → folder). */
const FALLBACK_ORDER: Array<keyof SeriesTitles> = ['english', 'romaji', 'native'];

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The resolved title WITHOUT the tag — i.e. the language choice on its own.
 *
 * Callers that need to say "these are the OTHER titles" (the alt-title subtitle in
 * `SeriesMetadataBar`) compare against this, not against `resolveDisplayTitle`, whose
 * trailing tag would never match a stored language title.
 *
 *   pref = meta.title_preference ?? globalPref   (an unknown stored value = no override)
 *   'imported'  → seriesTitle
 *   otherwise   → titles[pref], falling back english → romaji → native → seriesTitle
 */
export function resolveDisplayBase(
  seriesTitle: string,
  meta: SeriesMetadata | undefined,
  globalPref: DisplayTitleLanguage
): string {
  // A `title_preference` that survived an old build or a hand-edited/foreign
  // series-metadata.json must not silently mean "some language" — fall back to the
  // global preference exactly as if the series had no override at all.
  const override = isDisplayTitleLanguage(meta?.title_preference)
    ? meta?.title_preference
    : undefined;
  const pref: DisplayTitleLanguage = override ?? globalPref;

  if (pref === 'imported' || !meta) return seriesTitle;

  const requested = nonBlank(meta.titles?.[pref]);
  if (requested) return requested;

  for (const lang of FALLBACK_ORDER) {
    const candidate = nonBlank(meta.titles?.[lang]);
    if (candidate) return candidate;
  }
  return seriesTitle;
}

/**
 * Resolve the human-facing title for a series: `resolveDisplayBase` + the tag.
 *
 * Never changes the stored `series_title` (folder name / grouping key / route key):
 * this is a pure presentation overlay.
 */
export function resolveDisplayTitle(
  seriesTitle: string,
  meta: SeriesMetadata | undefined,
  globalPref: DisplayTitleLanguage
): string {
  const base = resolveDisplayBase(seriesTitle, meta, globalPref);
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
