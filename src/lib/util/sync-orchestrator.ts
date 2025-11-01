import { parseVolumesFromJson, volumes, enrichVolumeDataWithMetadata, mergeVolumeData } from '$lib/settings';

/**
 * Orchestrates syncing read progress with a cloud provider
 * Handles parsing, merging, and enriching volume data
 * Provider-agnostic business logic
 */
export class SyncOrchestrator {
  /**
   * Syncs volume data with remote JSON
   * @param remoteJsonArray Array of JSON strings from remote storage
   * @returns Merged and enriched volume data ready to upload
   */
  async syncVolumeData(remoteJsonArray: string[]): Promise<Record<string, any>> {
    // Step 1: Parse all remote JSON files and merge them
    let cloudVolumes: any = {};
    for (const jsonString of remoteJsonArray) {
      const fileVolumes = parseVolumesFromJson(jsonString);

      // Merge with newest-wins strategy
      Object.keys(fileVolumes).forEach(volumeId => {
        const existing = cloudVolumes[volumeId];
        const incoming = fileVolumes[volumeId];

        if (!existing) {
          cloudVolumes[volumeId] = incoming;
        } else {
          const existingDate = new Date(existing.lastProgressUpdate).getTime();
          const incomingDate = new Date(incoming.lastProgressUpdate).getTime();
          if (incomingDate > existingDate) {
            cloudVolumes[volumeId] = incoming;
          }
        }
      });
    }

    // Step 2: Get current local volumes
    let localVolumes: any = {};
    volumes.subscribe(vols => { localVolumes = vols; })();

    // Step 3: Merge local and cloud data
    const mergedVolumes = mergeVolumeData(localVolumes, cloudVolumes);

    // Step 4: Enrich with metadata from IndexedDB
    const enrichedVolumes: Record<string, any> = {};
    for (const [volumeUuid, volumeData] of Object.entries(mergedVolumes)) {
      enrichedVolumes[volumeUuid] = await enrichVolumeDataWithMetadata(volumeUuid, volumeData as any);
    }

    // Step 5: Update local storage with enriched data
    volumes.update(() => enrichedVolumes);

    return enrichedVolumes;
  }
}

export const syncOrchestrator = new SyncOrchestrator();
