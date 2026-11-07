import type { Series } from './catalog';

/**
 * KEEP AN UNCHANGED SERIES THE SAME OBJECT ACROSS CATALOG EMISSIONS.
 *
 * Every catalog emission is built from a fresh `db.volumes.toArray()`: new row objects,
 * new `File`s, new `Series` objects and new `volumes` arrays for EVERY series, even when
 * one volume landed. Each catalog card takes its series' `volumes` as a prop, so every
 * mounted card re-ran all of its derivations on every emission — a download run costs one
 * emission per finished volume, times every card in the library.
 *
 * Svelte 5.57 made that fan-out expensive (measured on an 800-series catalog: 60
 * arriving series cost 5.6 s of long tasks, vs 0.12 s on 5.43, and the cost grew
 * faster than the library). The fix is to stop announcing changes that did not happen: a
 * series whose content is identical to the previous emission's is handed back as the
 * previous object, `volumes` array and rows included, so its card's props are
 * reference-equal and nothing downstream of them runs.
 *
 * "Identical" is the whole series serialised — title, display title, search terms, and
 * every row field including the decorations a cloud listing adds (`cloudPath`, …) — with a
 * Blob reduced to size, type and (for a `File`) `lastModified`, so a cover replaced by
 * another of the same byte size still reads as a change. Kept per instance: the memo
 * belongs to the one store that owns the emission sequence.
 */
export function createSeriesIdentityMemo(): (next: Series[]) => Series[] {
  let previous = new Map<string, { series: Series; signature: string }>();

  return (next) => {
    // Rebuilt from THIS emission only, so a series that left the list is forgotten and
    // can never be resurrected as a stale object later.
    const current = new Map<string, { series: Series; signature: string }>();
    const out = next.map((series) => {
      const signature = seriesSignature(series);
      const prior = previous.get(series.title);
      const kept = prior && prior.signature === signature ? prior.series : series;
      current.set(series.title, { series: kept, signature });
      return kept;
    });
    previous = current;
    return out;
  };
}

function seriesSignature(series: Series): string {
  return JSON.stringify(
    [series.title, series.displayTitle, series.series_uuid, series.searchTerms, series.volumes],
    (_key, value) =>
      value instanceof Blob
        ? `blob:${value.size}:${value.type}:${value instanceof File ? value.lastModified : ''}`
        : value
  );
}
