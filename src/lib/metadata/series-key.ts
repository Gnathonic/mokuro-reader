import { seriesKey } from '#lib/util/names/fold.js';

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
 * The identity of a VOLUME title (and of a series folder) when matching across
 * sources that spell it differently: a cloud `.cbz` filename, an index entry
 * written by another device, and a local row all describe the same volume in
 * their own hand.
 *
 * It is the series key of fold v2 (`seriesKey`, `$lib/util/names/fold`): the
 * one name fold Bunko decides entries by (case folding, `Straße` = `STRASSE`;
 * canonical normalization, a decomposed name = the composed one; the
 * default-ignorable code points dropped), then trimmed, then every run of
 * whitespace one space — Bunko's `bunko_core::names::series_key`, which keys
 * its series owner records, so an owned `Straße` is the folder `STRASSE` here
 * too (`metadata-permissions`). A function of the fold, so never finer than it:
 * whatever two hosts make one entry is one key. Every site that decides "is
 * this entry the volume the cloud is showing me" MUST use this one function:
 * `materializeSeriesVolumes` and `buildSeriesFile`'s listing prune are two ends
 * of the same question, and a fold that disagrees between them means one side
 * creates rows the other deletes. `series_metadata.folded_key` stores it
 * (re-stamped by the Dexie v5 upgrade, `db-schema.ts`).
 */
export function normalizeVolumeTitleKey(title: string): string {
  return seriesKey(title);
}
