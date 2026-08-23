import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { liveQuery } from 'dexie';
import { derived, readable, type Readable } from 'svelte/store';
import { deriveNameOnlySeries, deriveSeriesFromVolumes } from '$lib/catalog/catalog';
import {
  unifiedCloudManager,
  type CloudVolumeWithProvider
} from '$lib/util/sync/unified-cloud-manager';
import { activeProviderType } from '$lib/util/sync/provider-manager';
import {
  cloudFieldsForRemovedVolume,
  generatePlaceholders,
  indexCloudFilesByPath
} from '$lib/catalog/placeholders';
import { routeParams } from '$lib/util/hash-router';
import { getLegacyImageOnlyVolumeUuid } from '$lib/util/download-volume-repair';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { catalogIndexMap } from '$lib/metadata/catalog-index';
import { seriesIndexMap, type SeriesIndexRecord } from '$lib/metadata/series-index';
import { seriesMetadataMap } from '$lib/metadata/store';
import { preferredTitleLanguage } from '$lib/settings/settings';
import { isMetadataOnly } from '$lib/catalog/volume-state';

async function loadCurrentVolumeData(volume: VolumeMetadata): Promise<VolumeData | undefined> {
  let [ocr, files] = await Promise.all([
    db.volume_ocr.get(volume.volume_uuid),
    db.volume_files.get(volume.volume_uuid)
  ]);

  if (!ocr || !files) {
    const legacyUuid = getLegacyImageOnlyVolumeUuid(volume);
    if (legacyUuid) {
      const [legacyMetadata, legacyOcr, legacyFiles] = await Promise.all([
        db.volumes.get(legacyUuid),
        db.volume_ocr.get(legacyUuid),
        db.volume_files.get(legacyUuid)
      ]);

      // Repair legacy cloud image-only downloads that stored OCR/files under the
      // old deterministic UUID instead of the canonical placeholder UUID.
      if (!legacyMetadata && (legacyOcr || legacyFiles)) {
        await db.transaction('rw', [db.volume_ocr, db.volume_files], async () => {
          if (!ocr && legacyOcr) {
            ocr = { ...legacyOcr, volume_uuid: volume.volume_uuid };
            await db.volume_ocr.put(ocr);
            await db.volume_ocr.delete(legacyUuid);
          }

          if (!files && legacyFiles) {
            files = { ...legacyFiles, volume_uuid: volume.volume_uuid };
            await db.volume_files.put(files);
            await db.volume_files.delete(legacyUuid);
          }
        });
      }
    }
  }

  if (!ocr) {
    return undefined;
  }

  return {
    volume_uuid: volume.volume_uuid,
    pages: ocr.pages,
    files: files?.files
  };
}

// Single source of truth from the database
export const volumes = readable<Record<string, VolumeMetadata>>({}, (set) => {
  const subscription = liveQuery(async () => {
    const volumesArray = await db.volumes.toArray();

    return volumesArray.reduce(
      (acc, vol) => {
        acc[vol.volume_uuid] = vol;
        return acc;
      },
      {} as Record<string, VolumeMetadata>
    );
  }).subscribe({
    next: (value) => set(value),
    error: (err) => console.error(err)
  });

  return () => subscription.unsubscribe();
});

/**
 * What the placeholder pass actually consumes from the cached indexes: which
 * series have one, and whether it has been re-fetched since (`fetched_at` is
 * bumped by every `putSeriesIndex`). `seriesIndexMap` is a Dexie liveQuery, so
 * it re-emits a brand-new Map of brand-new row objects on ANY write to the
 * table — reference comparison would never hold, and rebuilding the placeholder
 * set per write would re-run the whole cloud scan (plus its OCR-upgrade side
 * effects) for a series the user is not even looking at.
 */
function seriesIndexSignature(map: Map<string, SeriesIndexRecord>): string {
  const parts: string[] = [];
  for (const [key, record] of map) parts.push(`${key}\u0000${record.fetched_at}`);
  parts.sort();
  return parts.join('');
}

let lastPlaceholderInputs: {
  volumes: unknown;
  cloudFiles: unknown;
  indexSignature: string;
} | null = null;
let lastPlaceholders: VolumeMetadata[] = [];

/**
 * The listing's archives by path, rebuilt only when the listing itself changes.
 * The catalog re-derives on every settings-adjacent emission; re-indexing a
 * few thousand cloud files each time would be pure waste.
 */
let lastCloudFiles: unknown = null;
let lastCloudIndex = new Map<string, CloudVolumeWithProvider>();

// Merge local volumes with cloud placeholders
export const volumesWithPlaceholders = derived(
  [volumes, unifiedCloudManager.cloudFiles, seriesIndexMap],
  ([$volumes, $cloudFiles, $seriesIndexMap]) => {
    const combined = { ...$volumes };
    const localVolumes = Object.values($volumes);

    // Generate cloud provider placeholders
    if ($cloudFiles.size > 0) {
      const indexSignature = seriesIndexSignature($seriesIndexMap);
      if (
        !lastPlaceholderInputs ||
        lastPlaceholderInputs.volumes !== $volumes ||
        lastPlaceholderInputs.cloudFiles !== $cloudFiles ||
        lastPlaceholderInputs.indexSignature !== indexSignature
      ) {
        lastPlaceholders = generatePlaceholders($cloudFiles, localVolumes, $seriesIndexMap);
        lastPlaceholderInputs = { volumes: $volumes, cloudFiles: $cloudFiles, indexSignature };
      }

      for (const placeholder of lastPlaceholders) {
        combined[placeholder.volume_uuid] = placeholder;
      }

      // A metadata-only row shadows the placeholder its cloud file would have
      // produced (a path with a local row is not "cloud only"), so it has to be
      // given the same cloud fields here or there would be nothing to download
      // it from. Decorating the copy in the catalog, never the stored row: the
      // fileId belongs to the current listing, not to the volume.
      if (localVolumes.some(isMetadataOnly)) {
        if (lastCloudFiles !== $cloudFiles) {
          lastCloudIndex = indexCloudFilesByPath($cloudFiles);
          lastCloudFiles = $cloudFiles;
        }
        for (const vol of localVolumes) {
          if (!isMetadataOnly(vol)) continue;
          const cloudFields = cloudFieldsForRemovedVolume(lastCloudIndex, vol);
          if (cloudFields) combined[vol.volume_uuid] = { ...vol, ...cloudFields };
        }
      }
    }

    return combined;
  },
  {} as Record<string, VolumeMetadata>
);

// Each derived store needs to be passed as an array if using multiple inputs.
// Display titles are resolved here (once per recompute) from series metadata +
// the synced preferredTitleLanguage setting; grouping/routing still use series_title.
// Join on the PRIMITIVE language store, never on `catalogSettings`: that object store
// emits a new object on every settings write (per-wheel-tick `pagedGap` included), which
// would re-group, re-resolve and re-sort the whole library each time.
export const catalog = derived(
  [
    volumesWithPlaceholders,
    seriesMetadataMap,
    preferredTitleLanguage,
    catalogIndexMap,
    activeProviderType
  ],
  ([
    $volumesWithPlaceholders,
    $seriesMetadataMap,
    $preferredTitleLanguage,
    $catalogIndexMap,
    $activeProviderType
  ]) => {
    // Return null while loading (before first data emission)
    if ($volumesWithPlaceholders === undefined) {
      return null;
    }
    const withVolumes = deriveSeriesFromVolumes(
      Object.values($volumesWithPlaceholders),
      $seriesMetadataMap,
      $preferredTitleLanguage
    );
    if ($catalogIndexMap.size === 0 || !$activeProviderType) return withVolumes;

    // Rows are cached PER PROVIDER and deliberately survive a switch, so
    // reconnecting an account does not re-download its whole catalog. But only
    // one provider is ever connected: another account's rows would list series
    // this device cannot fetch, under the connected provider's heading. Show
    // only the active provider's names.
    const rows = [...$catalogIndexMap.values()].filter(
      (row) => row.source.provider === $activeProviderType
    );
    if (rows.length === 0) return withVolumes;

    // Catalog-only series: known by name from the root catalog.json, with
    // nothing local yet. Opening one fetches its series.json (see series-open.ts).
    const knownKeys = new Set(withVolumes.map((series) => normalizeSeriesKey(series.title)));
    return [
      ...withVolumes,
      ...deriveNameOnlySeries(rows, knownKeys, $seriesMetadataMap, $preferredTitleLanguage)
    ];
  }
);

export const currentSeries = derived([routeParams, catalog], ([$routeParams, $catalog]) => {
  if (!$catalog || !$routeParams.manga) return [];

  const routeKey = normalizeSeriesKey($routeParams.manga);
  // Primary: match by title (folder name) - handles placeholder→local transition
  let series = $catalog.find((s) => normalizeSeriesKey(s.title) === routeKey);

  // Fallback: match by UUID (for legacy URLs)
  if (!series) {
    series = $catalog.find((s) => s.series_uuid === $routeParams.manga);
  }

  return series?.volumes || [];
});

export const currentVolume = derived([routeParams, volumes], ([$routeParams, $volumes]) => {
  if ($routeParams && $volumes && $routeParams.volume) {
    return $volumes[$routeParams.volume]; // Direct lookup instead of find()
  }
  return undefined;
});

export const currentVolumeData: Readable<VolumeData | undefined> = derived(
  [currentVolume],
  ([$currentVolume], set: (value: VolumeData | undefined) => void) => {
    // Track the last volume UUID to avoid unnecessary clears
    // This prevents flash when unrelated volumes are added to the database
    const newUuid = $currentVolume?.volume_uuid;

    // Only clear data when actually navigating to a different volume
    // Don't clear if the store just emitted a new object reference for the same volume
    if (newUuid !== currentVolumeDataLastUuid) {
      currentVolumeDataLastUuid = newUuid;
      // Clear old data synchronously to prevent state leaks between volumes
      set(undefined);
    }

    if ($currentVolume) {
      loadCurrentVolumeData($currentVolume)
        .then((volumeData) => {
          if (volumeData) {
            set(volumeData);
          }
        })
        .catch((error) => {
          console.error('Failed to load current volume data:', error);
        });
    }
  },
  undefined // Initial value
);

// Track last volume UUID to prevent unnecessary data clears
let currentVolumeDataLastUuid: string | undefined;

/**
 * Japanese character count for current volume.
 * Uses page_char_counts from metadata for O(1) lookup when available.
 */
export const currentVolumeCharacterCount = derived(
  [currentVolume, currentVolumeData],
  ([$currentVolume, $currentVolumeData]) => {
    if (!$currentVolume) return 0;

    // Use pre-calculated cumulative char counts from metadata (v3)
    if ($currentVolume.page_char_counts && $currentVolume.page_char_counts.length > 0) {
      // Last element of cumulative array is the total
      return $currentVolume.page_char_counts[$currentVolume.page_char_counts.length - 1];
    }

    // Fallback: calculate from pages if page_char_counts not available
    if ($currentVolumeData && $currentVolumeData.pages) {
      const japaneseRegex =
        /[○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

      let totalChars = 0;
      for (const page of $currentVolumeData.pages) {
        for (const block of page.blocks) {
          for (const line of block.lines) {
            totalChars += Array.from(line).filter((char) => japaneseRegex.test(char)).length;
          }
        }
      }
      return totalChars;
    }

    return 0;
  }
);
