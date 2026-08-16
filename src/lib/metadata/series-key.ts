/**
 * The identity of a series for metadata purposes: the catalog's grouping key.
 * MUST stay identical to how the catalog groups volumes (trim / collapse
 * whitespace / lowercase) — series_uuid is deliberately NOT used because it is
 * fragmented across cloud placeholders and merges.
 */
export function normalizeSeriesKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}
