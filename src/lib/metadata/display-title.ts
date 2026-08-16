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
