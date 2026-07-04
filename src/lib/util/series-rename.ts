/**
 * Series rename functionality for changing series titles
 */

import { db } from '$lib/catalog/db';
import { volumes as volumeDataStore } from '$lib/settings/volume-data';
import { unifiedCloudManager, type SeriesRenameResult } from '$lib/util/sync/unified-cloud-manager';
import { ProviderError } from '$lib/util/sync/provider-interface';
import { sanitizeTitleSegment } from '$lib/util/sanitize-title';
import { get } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';

export interface SeriesInfo {
  seriesTitle: string;
  seriesUuid: string;
  volumeCount: number;
  volumes: VolumeMetadata[];
}

export interface RenameSeriesPreview {
  indexedDbChanges: Array<{
    table: 'volumes';
    volumeUuid: string;
    volumeTitle: string;
    field: 'series_title';
    oldValue: string;
    newValue: string;
  }>;
  localStorageChanges: Array<{
    volumeUuid: string;
    field: 'series_title';
    oldValue: string;
    newValue: string;
  }>;
}

export interface RenameSeriesResult {
  /** The sanitized title that was actually committed. */
  finalTitle: string;
  /** Volumes fully renamed (cloud + local). */
  renamedCount: number;
  /** Volumes that keep the old title everywhere because their cloud rename
   * failed. Retrying the same rename converges: it picks up just these. */
  failures: Array<{ volumeUuid: string; volumeTitle: string }>;
}

/**
 * Get all unique series from the database
 * @returns Array of series info, sorted by series title
 */
export async function getAllSeries(): Promise<SeriesInfo[]> {
  try {
    const allVolumes = await db.volumes.toArray();

    if (allVolumes.length === 0) {
      return [];
    }

    // Group volumes by series_title + series_uuid combination
    const seriesMap = new Map<string, SeriesInfo>();

    for (const volume of allVolumes) {
      if (!volume.series_title) continue;

      const key = `${volume.series_title}::${volume.series_uuid}`;

      if (!seriesMap.has(key)) {
        seriesMap.set(key, {
          seriesTitle: volume.series_title,
          seriesUuid: volume.series_uuid,
          volumeCount: 0,
          volumes: []
        });
      }

      const series = seriesMap.get(key)!;
      series.volumeCount++;
      series.volumes.push(volume);
    }

    // Convert to array and sort by series title
    const seriesList = Array.from(seriesMap.values());
    seriesList.sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle));

    return seriesList;
  } catch (error) {
    console.error('Error getting all series:', error);
    throw new Error('Failed to get series list');
  }
}

/**
 * Generate a preview of changes that would be made when renaming a series
 * @param oldTitle The current series title
 * @param newTitle The new series title
 * @param seriesUuid Optional: only rename volumes with this specific series UUID
 * @returns Preview of all changes that would be made
 */
export async function generateRenameSeriesPreview(
  oldTitle: string,
  newTitle: string,
  seriesUuid?: string
): Promise<RenameSeriesPreview> {
  try {
    const preview: RenameSeriesPreview = {
      indexedDbChanges: [],
      localStorageChanges: []
    };

    // Find volumes in IndexedDB that would be updated
    let volumesToUpdate: VolumeMetadata[];
    if (seriesUuid) {
      volumesToUpdate = await db.volumes
        .where({ series_title: oldTitle, series_uuid: seriesUuid })
        .toArray();
    } else {
      volumesToUpdate = await db.volumes.where({ series_title: oldTitle }).toArray();
    }

    for (const volume of volumesToUpdate) {
      preview.indexedDbChanges.push({
        table: 'volumes',
        volumeUuid: volume.volume_uuid,
        volumeTitle: volume.volume_title,
        field: 'series_title',
        oldValue: oldTitle,
        newValue: newTitle
      });
    }

    // Check LocalStorage for matching volumes
    const currentVolumeData = get(volumeDataStore);

    for (const [volumeUuid, volumeData] of Object.entries(currentVolumeData)) {
      if (
        volumeData &&
        typeof volumeData === 'object' &&
        'series_title' in volumeData &&
        volumeData.series_title === oldTitle
      ) {
        // If seriesUuid is specified, only include volumes with matching UUID
        if (seriesUuid && 'series_uuid' in volumeData && volumeData.series_uuid !== seriesUuid) {
          continue;
        }

        preview.localStorageChanges.push({
          volumeUuid,
          field: 'series_title',
          oldValue: oldTitle,
          newValue: newTitle
        });
      }
    }

    return preview;
  } catch (error) {
    console.error('Error generating rename series preview:', error);
    throw new Error('Failed to generate rename series preview');
  }
}

/**
 * Execute the series rename operation
 * @param oldTitle The current series title
 * @param newTitle The new series title
 * @param seriesUuid Optional: only rename volumes with this specific series UUID
 * @returns Preview of changes made
 */
export async function executeRenameSeries(
  oldTitle: string,
  newTitle: string,
  seriesUuid?: string
): Promise<RenameSeriesResult> {
  // Sanitize the user-supplied title so the stored title is a legal name on every
  // sink (cloud + filesystem + OneDrive + export). title === path going forward.
  newTitle = sanitizeTitleSegment(newTitle);
  if (!newTitle) {
    throw new Error('Series not renamed: the name has no usable characters.');
  }

  // Generate preview of changes
  const preview = await generateRenameSeriesPreview(oldTitle, newTitle, seriesUuid);
  if (preview.indexedDbChanges.length === 0 && preview.localStorageChanges.length === 0) {
    return { finalTitle: newTitle, renamedCount: 0, failures: [] };
  }

  // The cloud rename runs FIRST, one volume at a time, and each volume's cloud
  // rename gates THAT volume's local commit — cloud and local stay consistent
  // per volume even when some volumes fail. A throw here is pre-flight
  // (read-only provider, cloud-only volumes): nothing changed anywhere.
  let cloud: SeriesRenameResult;
  try {
    cloud = await unifiedCloudManager.renameSeries(
      oldTitle,
      newTitle,
      preview.indexedDbChanges.map((c) => ({
        volumeUuid: c.volumeUuid,
        volumeTitle: c.volumeTitle
      }))
    );
  } catch (error) {
    console.error('Error renaming series in cloud:', error);
    if (
      error instanceof ProviderError &&
      (error.code === 'CLOUD_ONLY_VOLUMES' || error.code === 'READ_ONLY')
    ) {
      // Pre-flight gates carry a user-facing explanation already.
      throw new Error(error.message);
    }
    throw new Error(
      "Series not renamed: the cloud couldn't be checked before making changes, so nothing was renamed. Check your connection and try again."
    );
  }

  const renamedSet = new Set(cloud.renamedVolumeUuids);
  const dbUuids = new Set(preview.indexedDbChanges.map((c) => c.volumeUuid));

  try {
    // Commit ONLY the volumes whose cloud files are fully at the new path.
    await db.transaction('rw', [db.volumes], async () => {
      for (const change of preview.indexedDbChanges) {
        if (!renamedSet.has(change.volumeUuid)) continue;
        await db.volumes.update(change.volumeUuid, {
          series_title: change.newValue
        });
      }
    });

    // LocalStorage stats: commit for renamed volumes, and for stats-only
    // entries with no DB row (volumes deleted locally AND absent from the
    // cloud — the cloud-only gate already rejected everything else).
    if (preview.localStorageChanges.length > 0) {
      const { updateVolumeSeriesTitle } = await import('$lib/settings/volume-data');

      for (const change of preview.localStorageChanges) {
        if (!renamedSet.has(change.volumeUuid) && dbUuids.has(change.volumeUuid)) continue;
        updateVolumeSeriesTitle(change.volumeUuid, change.newValue);
      }
    }

    return {
      finalTitle: newTitle,
      renamedCount: cloud.renamedVolumeUuids.length,
      failures: cloud.failures.map(({ volumeUuid, volumeTitle }) => ({ volumeUuid, volumeTitle }))
    };
  } catch (error) {
    console.error('Error executing series rename:', error);
    throw new Error('Failed to execute series rename');
  }
}
