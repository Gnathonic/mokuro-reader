import type { DisplayTitleLanguage, SeriesMetadata, SeriesTitles } from './types';

/** Fallback order when the requested language is missing (spec: english → romaji → native → folder). */
const FALLBACK_ORDER: Array<keyof SeriesTitles> = ['english', 'romaji', 'native'];

/** Matching bracket pairs stripped from a tag before it is wrapped in `(…)` for display. */
const BRACKET_PAIRS: Array<[string, string]> = [
  ['(', ')'],
  ['[', ']'],
  ['（', '）'],
  ['【', '】']
];

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Strip a single pair of surrounding brackets (`()`, `[]`, `（）`, `【】`) from a tag
 * before it is wrapped for display, so `[color]`, `(color)` and `color` all render the
 * same way. Only ever affects the DISPLAY string — the stored/embedded tag stays raw.
 */
function stripOuterBracketPair(value: string): string {
  for (const [open, close] of BRACKET_PAIRS) {
    if (value.startsWith(open) && value.endsWith(close) && value.length > open.length) {
      return value.slice(open.length, value.length - close.length).trim();
    }
  }
  return value;
}

/**
 * The resolved title WITHOUT the tag — i.e. the language choice on its own.
 *
 * Callers that need to say "these are the OTHER titles" (the alt-title subtitle in
 * `SeriesMetadataBar`) compare against this, not against `resolveDisplayTitle`, whose
 * trailing tag would never match a stored language title.
 *
 * Title language is a GLOBAL-ONLY setting (Catalog settings): `meta.title_preference`
 * is a legacy/synced field kept for compat and is intentionally never consulted here —
 * a series can no longer override the language on its own.
 *
 *   'imported'  → seriesTitle
 *   otherwise   → titles[globalPref], falling back english → romaji → native → seriesTitle
 */
export function resolveDisplayBase(
  seriesTitle: string,
  meta: SeriesMetadata | undefined,
  globalPref: DisplayTitleLanguage
): string {
  if (globalPref === 'imported' || !meta) return seriesTitle;

  const requested = nonBlank(meta.titles?.[globalPref]);
  if (requested) return requested;

  for (const lang of FALLBACK_ORDER) {
    const candidate = nonBlank(meta.titles?.[lang]);
    if (candidate) return candidate;
  }
  return seriesTitle;
}

/**
 * Resolve the human-facing title for a series: `resolveDisplayBase` + the tag, wrapped
 * in parentheses — e.g. `Title (color)`. A raw tag of `[color]`, `(color)` or `color`
 * all render identically: one surrounding pair of `()`/`[]`/`（）`/`【】` is stripped
 * before wrapping. The STORED/embedded tag (`meta.tag`) is never rewritten — this is a
 * pure presentation overlay, same as the title language above.
 *
 * The tag is only appended when the display base actually resolved to an alt title
 * (native/romaji/english) — i.e. `base !== seriesTitle`. When the base IS the folder
 * name (`globalPref === 'imported'`, or the alt-title fallback when a series has no
 * alt titles at all), the tag is withheld: folder names already carry the tag to
 * prevent collisions, so appending it again would duplicate it.
 *
 * Never changes the stored `series_title` (folder name / grouping key / route key).
 */
export function resolveDisplayTitle(
  seriesTitle: string,
  meta: SeriesMetadata | undefined,
  globalPref: DisplayTitleLanguage
): string {
  const base = resolveDisplayBase(seriesTitle, meta, globalPref);
  if (base === seriesTitle) return base;
  const rawTag = nonBlank(meta?.tag);
  if (!rawTag) return base;
  const tag = stripOuterBracketPair(rawTag);
  return tag ? `${base} (${tag})` : base;
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
