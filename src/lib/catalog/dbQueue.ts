import { db } from './db';
import type { Volume } from '$lib/types';

interface QueuedVolume {
  volume: Volume;
  mangaId: string;
}

class DatabaseQueue {
  private queue: QueuedVolume[] = [];
  private isProcessing = false;
  private batchTimeout: number | null = null;
  private readonly BATCH_DELAY = 100; // Wait 100ms to collect more updates

  async enqueue(volume: Volume, mangaId: string) {
    this.queue.push({ volume, mangaId });
    this.scheduleBatchProcessing();
  }

  private scheduleBatchProcessing() {
    if (this.batchTimeout !== null) {
      // Reset the timeout to wait for more potential updates
      clearTimeout(this.batchTimeout);
    }

    this.batchTimeout = window.setTimeout(() => {
      this.processQueue();
    }, this.BATCH_DELAY);
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    this.batchTimeout = null;

    try {
      // Group volumes by manga ID for batch processing
      const volumesByManga = new Map<string, Volume[]>();
      
      for (const { volume, mangaId } of this.queue) {
        if (!volumesByManga.has(mangaId)) {
          volumesByManga.set(mangaId, []);
        }
        volumesByManga.get(mangaId)!.push(volume);
      }

      // Process all updates in a single transaction
      await db.transaction('rw', db.catalog, async () => {
        const updates = Array.from(volumesByManga.entries()).map(async ([mangaId, volumes]) => {
          const existingCatalog = await db.catalog.get(mangaId);

          if (existingCatalog) {
            // Filter out any volumes that already exist
            const newVolumes = volumes.filter(vol => 
              !existingCatalog.manga.some(existing => 
                existing.mokuroData.volume_uuid === vol.mokuroData.volume_uuid
              )
            );

            if (newVolumes.length > 0) {
              await db.catalog.update(mangaId, {
                manga: [...existingCatalog.manga, ...newVolumes]
              });
            }
          } else {
            await db.catalog.add({
              id: mangaId,
              manga: volumes
            });
          }
        });

        await Promise.all(updates);
      });

      // Clear the processed items
      this.queue = [];
    } catch (error) {
      console.error('Error processing database queue:', error);
      throw error;
    } finally {
      this.isProcessing = false;
      
      // If new items were added while processing, schedule another batch
      if (this.queue.length > 0) {
        this.scheduleBatchProcessing();
      }
    }
  }
}

// Export a singleton instance
export const dbQueue = new DatabaseQueue();