/**
 * Series merge functionality for consolidating volumes with different series UUIDs
 */

import { db } from '$lib/catalog/db';
import { volumes as volumeDataStore } from '$lib/settings/volume-data';
import { get } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';

export interface SeriesConflict {
  seriesTitle: string;
  conflictingUuids: Array<{
    seriesUuid: string;
    volumeCount: number;
    earliestVolumeUuid: string; // For ordering by creation time
    volumes: VolumeMetadata[];
  }>;
}

export interface MergeSeriesPreview {
  indexedDbChanges: Array<{
    table: 'volumes';
    volumeUuid: string;
    field: 'series_uuid';
    oldValue: string;
    newValue: string;
  }>;
  localStorageChanges: Array<{
    volumeUuid: string;
    field: 'series_uuid';
    oldValue: string;
    newValue: string;
  }>;
}

/**
 * Detect series that have conflicting UUIDs
 * Uses case-insensitive matching to find series with the same name but different casing
 * @returns Array of series conflicts, each containing multiple UUIDs for the same series title
 */
export async function detectSeriesConflicts(): Promise<SeriesConflict[]> {
  try {
    // Get all volumes from IndexedDB
    const allVolumes = await db.volumes.toArray();

    if (allVolumes.length === 0) {
      return [];
    }

    // Group volumes by series_title (case-insensitive)
    // Map: normalized title -> { displayTitle, volumes }
    const seriesGroups = new Map<string, { displayTitle: string; volumes: VolumeMetadata[] }>();

    for (const volume of allVolumes) {
      if (!volume.series_title) continue; // Skip volumes without series title

      const normalizedTitle = volume.series_title.toLowerCase();

      if (!seriesGroups.has(normalizedTitle)) {
        // Use the first encountered title as the display title
        seriesGroups.set(normalizedTitle, { displayTitle: volume.series_title, volumes: [] });
      }
      seriesGroups.get(normalizedTitle)!.volumes.push(volume);
    }

    // Find series with multiple UUIDs
    const conflicts: SeriesConflict[] = [];

    for (const [, { displayTitle, volumes }] of seriesGroups) {
      // Extract unique series_uuid values for this series title
      const uniqueUuids = new Set(volumes.map((v) => v.series_uuid));

      if (uniqueUuids.size > 1) {
        // This series has conflicting UUIDs
        const conflictingUuids: SeriesConflict['conflictingUuids'] = [];

        for (const seriesUuid of uniqueUuids) {
          const volumesForUuid = volumes.filter((v) => v.series_uuid === seriesUuid);

          // Find earliest volume for this UUID (by volume_uuid order as proxy for creation time)
          const sortedVolumes = [...volumesForUuid].sort((a, b) =>
            a.volume_uuid.localeCompare(b.volume_uuid)
          );
          const earliestVolumeUuid = sortedVolumes[0].volume_uuid;

          conflictingUuids.push({
            seriesUuid,
            volumeCount: volumesForUuid.length,
            earliestVolumeUuid,
            volumes: volumesForUuid
          });
        }

        // Sort UUIDs by creation time (earliest volume UUID as proxy)
        conflictingUuids.sort((a, b) => a.earliestVolumeUuid.localeCompare(b.earliestVolumeUuid));

        conflicts.push({
          seriesTitle: displayTitle,
          conflictingUuids
        });
      }
    }

    // Sort conflicts by series title for consistent display
    conflicts.sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle));

    return conflicts;
  } catch (error) {
    console.error('Error detecting series conflicts:', error);
    throw new Error('Failed to detect series conflicts');
  }
}

/**
 * Generate a preview of changes that would be made when merging series
 * @param seriesTitle The series title being merged
 * @param oldUuid The UUID to change from
 * @param newUuid The UUID to change to
 * @returns Preview of all changes that would be made
 */
export async function generateMergeSeriesPreview(
  seriesTitle: string,
  oldUuid: string,
  newUuid: string
): Promise<MergeSeriesPreview> {
  try {
    const preview: MergeSeriesPreview = {
      indexedDbChanges: [],
      localStorageChanges: []
    };

    // Find volumes in IndexedDB that would be updated
    const volumesToUpdate = await db.volumes
      .where({ series_title: seriesTitle, series_uuid: oldUuid })
      .toArray();

    for (const volume of volumesToUpdate) {
      preview.indexedDbChanges.push({
        table: 'volumes',
        volumeUuid: volume.volume_uuid,
        field: 'series_uuid',
        oldValue: oldUuid,
        newValue: newUuid
      });
    }

    // Check LocalStorage for matching volumes
    const currentVolumeData = get(volumeDataStore);

    for (const [volumeUuid, volumeData] of Object.entries(currentVolumeData)) {
      // Check if this volume matches the series and UUID we're changing
      if (
        volumeData &&
        typeof volumeData === 'object' &&
        'series_title' in volumeData &&
        'series_uuid' in volumeData &&
        volumeData.series_title === seriesTitle &&
        volumeData.series_uuid === oldUuid
      ) {
        preview.localStorageChanges.push({
          volumeUuid,
          field: 'series_uuid',
          oldValue: oldUuid,
          newValue: newUuid
        });
      }
    }

    return preview;
  } catch (error) {
    console.error('Error generating merge series preview:', error);
    throw new Error('Failed to generate merge series preview');
  }
}

/**
 * Execute the series merge operation
 * @param seriesTitle The series title being merged
 * @param oldUuid The UUID to change from
 * @param newUuid The UUID to change to
 * @returns Preview of changes made (or would be made if dry run)
 */
export async function executeMergeSeries(
  seriesTitle: string,
  oldUuid: string,
  newUuid: string
): Promise<MergeSeriesPreview> {
  // Generate preview of changes
  const preview = await generateMergeSeriesPreview(seriesTitle, oldUuid, newUuid);

  try {
    // Execute IndexedDB updates in a transaction
    await db.transaction('rw', [db.volumes], async () => {
      for (const change of preview.indexedDbChanges) {
        await db.volumes.update(change.volumeUuid, {
          series_uuid: change.newValue
        });
      }
    });

    // Execute LocalStorage updates
    if (preview.localStorageChanges.length > 0) {
      // Import the update function we need
      const { updateVolumeMetadata } = await import('$lib/settings/volume-data');

      for (const change of preview.localStorageChanges) {
        updateVolumeMetadata(change.volumeUuid, change.newValue);
      }
    }

    return preview;
  } catch (error) {
    console.error('Error executing series merge:', error);
    throw new Error('Failed to execute series merge');
  }
}
