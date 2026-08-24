import type { VolumeMetadata } from '$lib/types';
import type { DisplayTitleLanguage, SeriesMetadata } from '$lib/metadata/types';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { resolveDisplayTitle, seriesSearchTerms } from '$lib/metadata/display-title';
import { sortVolumes } from './sort-volumes';
import { isVolumeInstalled, needsDownload } from './volume-state';
import type { NotOnDeviceDisplay } from '$lib/settings/settings';

export interface Series {
  /** Raw `series_title` — grouping key, route key and cloud folder name. Never derived. */
  title: string;
  /** Human-facing title: preferred-language title (or folder title) + tag. */
  displayTitle: string;
  /** Lowercased search terms: folder title, language titles, synonyms, tag, displayTitle. */
  searchTerms: string[];
  series_uuid: string;
  volumes: VolumeMetadata[];
}

function sortByDisplayTitle(a: Series, b: Series) {
  return a.displayTitle.localeCompare(b.displayTitle, undefined, { sensitivity: 'base' });
}

/**
 * The presentation half of a card: the human-facing title and the lowercased
 * terms the search box matches it by, the display title included (it may be a
 * language title plus a tag, which no single stored field carries).
 *
 * Shared by both derivations so a series is titled and found identically whether
 * its volumes are here or it is still just a name in the root catalog.
 */
function resolveCardTitles(
  seriesTitle: string,
  meta: SeriesMetadata | undefined,
  pref: DisplayTitleLanguage
): { displayTitle: string; searchTerms: string[] } {
  const displayTitle = resolveDisplayTitle(seriesTitle, meta, pref);
  const searchTerms = seriesSearchTerms(seriesTitle, meta);
  const displayLower = displayTitle.toLowerCase();
  if (!searchTerms.includes(displayLower)) searchTerms.push(displayLower);
  return { displayTitle, searchTerms };
}

/**
 * Group volumes into series (by normalized folder title) and attach display
 * titles. Display titles are computed HERE, once per recompute — never in
 * per-card `$derived` (see CLAUDE.md "Svelte 5 Reactive Performance").
 */
export function deriveSeriesFromVolumes(
  volumeEntries: Array<VolumeMetadata>,
  metaMap?: Map<string, SeriesMetadata>,
  pref: DisplayTitleLanguage = 'imported'
): Series[] {
  // Group volumes by normalized series title (user-visible identity)
  const titleMap = new Map<string, Series>();

  for (const entry of volumeEntries) {
    const key = normalizeSeriesKey(entry.series_title);
    let series = titleMap.get(key);
    if (series === undefined) {
      const { displayTitle, searchTerms } = resolveCardTitles(
        entry.series_title,
        metaMap?.get(key),
        pref
      );

      series = {
        title: entry.series_title,
        displayTitle,
        searchTerms,
        series_uuid: entry.series_uuid,
        volumes: []
      };
      titleMap.set(key, series);
    }
    series.volumes.push(entry);
  }

  // Convert map to array and sort everything
  const titles = Array.from(titleMap.values());

  // Sort series by display title, and volumes within each series
  titles.sort(sortByDisplayTitle);
  for (const series of titles) {
    series.volumes.sort(sortVolumes);
  }

  return titles;
}

export interface CatalogSections {
  /** The library proper: series with something to read on this device. */
  localSeries: Series[];
  /** The "Available in <provider>" region: series with nothing readable here. */
  cloudSeries: Series[];
}

/**
 * Split the catalog into the two regions the gallery draws.
 *
 * `mode` only decides where a series with NO pages on this device goes: mixed leaves it
 * in the library (where its covers and read history have always been), cloud-section
 * groups it with the cloud-only ones. A series with even one installed volume is library
 * either way — it has something to open.
 *
 * Computed once per recompute for the whole catalog, never per card (see CLAUDE.md
 * "Svelte 5 Reactive Performance"), and order-preserving so the caller's sort survives.
 */
export function partitionCatalogSeries(
  series: Series[],
  mode: NotOnDeviceDisplay
): CatalogSections {
  const sections: CatalogSections = { localSeries: [], cloudSeries: [] };

  for (const entry of series) {
    if (entry.volumes.length === 0) continue;

    const allAbsent = entry.volumes.every(needsDownload);
    const cloudOnly = entry.volumes.every((vol) => vol.isPlaceholder);
    if (cloudOnly || (mode === 'cloud-section' && allAbsent)) {
      sections.cloudSeries.push(entry);
    } else {
      sections.localSeries.push(entry);
    }
  }

  return sections;
}

/**
 * Split ONE series' rows (placeholders already removed) into the main volume list and the
 * ones the cloud section takes over. In mixed mode the section takes nothing: absent rows
 * stay in place, exactly as before.
 *
 * The absent rows are still real rows wherever they are drawn — same component, same
 * progress, same download and delete actions.
 */
export function partitionSeriesVolumes(
  volumes: VolumeMetadata[],
  mode: NotOnDeviceDisplay
): { listed: VolumeMetadata[]; absent: VolumeMetadata[] } {
  if (mode !== 'cloud-section') return { listed: volumes, absent: [] };
  return {
    listed: volumes.filter(isVolumeInstalled),
    absent: volumes.filter(needsDownload)
  };
}
