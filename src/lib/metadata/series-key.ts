/**
 * The identity of a series for metadata purposes: the catalog's grouping key.
 * MUST stay identical to how the catalog groups volumes (trim / collapse
 * whitespace / lowercase) — series_uuid is deliberately NOT used because it is
 * fragmented across cloud placeholders and merges.
 */
export function normalizeSeriesKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The identity of a VOLUME title when matching across sources that spell it
 * differently: a cloud `.cbz` filename, an index entry written by another
 * device, and a local row all describe the same volume in their own hand.
 *
 * `normalizeSeriesKey`'s fold (trim / collapse whitespace / lowercase) plus
 * unicode composition, because a filename that made the round trip through a
 * filesystem can come back decomposed (NFD) while the JSON beside it stays
 * composed (NFC) — byte-different, same title. Every site that decides "is this
 * entry the volume the cloud is showing me" MUST use this one function:
 * `materializeSeriesVolumes` and `buildSeriesFile`'s listing prune are two ends
 * of the same question, and a fold that disagrees between them means one side
 * creates rows the other deletes.
 */
export function normalizeVolumeTitleKey(title: string): string {
  return normalizeSeriesKey(title.normalize('NFC'));
}
