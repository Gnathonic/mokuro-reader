import { db } from './db';
import type { VolumeMetadata } from '$lib/types';

/**
 * Every row belonging to one series, found without a full-table scan.
 *
 * `series_title` is indexed, but a byte-wise match on it is not enough: two
 * rows for the same series can be filed under different literal spellings — a
 * decomposed (NFD) cloud folder name next to a composed (NFC) local title, or
 * a whitespace/case variant left over from an older import. Callers group
 * those as ONE series (see `series-file-sync.ts`'s `hasBackedUpVolume` and
 * `stranded-rows.ts`'s whitespace-variant test), so the match has to be made
 * on the FOLDED key, never the literal one.
 *
 * What keeps this cheap: `orderBy('series_title').uniqueKeys()` is an
 * INDEX-ONLY read — it walks the b-tree's distinct key values and never
 * deserializes a row, let alone a thumbnail blob. Folding that (one entry per
 * series, not per row) list finds every literal spelling that matches this
 * series, and only THOSE are fetched — through the index
 * (`where('series_title').anyOf(...)`), never a table scan. A series with no
 * local rows at all — the overwhelmingly common case during a reconcile pass
 * over a large cloud library — costs one index-only read and returns `[]`
 * before a single row is ever touched.
 *
 * Both reads run inside ONE `db.transaction('r', ...)` rather than as two
 * independent awaits: a sibling row minted (by a concurrent
 * `materializeSeriesVolumes`) under a literal spelling not yet in the index,
 * landing between the `uniqueKeys()` read and the `anyOf()` read, would
 * otherwise be missed by this call permanently — for
 * `stranded-rows.ts`'s `dropStrandedMetadataOnlyRow`, that means the
 * duplicate "Not on this device" card this function exists to prevent. A
 * single read transaction gives both queries the same consistent snapshot.
 */
export async function volumesForFoldedSeriesTitle(
  seriesTitle: string,
  fold: (title: string) => string
): Promise<VolumeMetadata[]> {
  const key = fold(seriesTitle);
  return db.transaction('r', db.volumes, async () => {
    const literalTitles = (await db.volumes.orderBy('series_title').uniqueKeys()) as string[];
    const matchingLiterals = literalTitles.filter((title) => fold(title) === key);
    if (matchingLiterals.length === 0) return [];

    return (await db.volumes
      .where('series_title')
      .anyOf(matchingLiterals)
      .toArray()) as VolumeMetadata[];
  });
}
