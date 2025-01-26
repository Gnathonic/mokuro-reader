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
  private readonly BATCH_DELAY = 500; // Increased to 500ms to allow more batching
  private readonly BATCH_SIZE = 50; // Process volumes in smaller batches

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
      // Take a snapshot of the current queue to process
      const currentQueue = [...this.queue];
      // Clear the main queue so new items can be added while processing
      this.queue = [];

      // Group volumes by manga ID for batch processing
      const volumesByManga = new Map<string, Volume[]>();

      for (const { volume, mangaId } of currentQueue) {
        if (!volumesByManga.has(mangaId)) {
          volumesByManga.set(mangaId, []);
        }
        volumesByManga.get(mangaId)!.push(volume);
      }

      // Process manga entries in chunks
      for (const [mangaId, volumes] of volumesByManga.entries()) {
        try {
          // Process volumes in smaller batches
          for (let i = 0; i < volumes.length; i += this.BATCH_SIZE) {
            const volumeBatch = volumes.slice(i, i + this.BATCH_SIZE);
            
            await db.transaction('rw', db.catalog, async () => {
              const existingCatalog = await db.catalog.get(mangaId);

              if (existingCatalog) {
                // Filter out any volumes that already exist
                const newVolumes = volumeBatch.filter(vol =>
                  !existingCatalog.manga.some(existing =>
                    existing.mokuroData.volume_uuid === vol.mokuroData.volume_uuid
                  )
                );

                if (newVolumes.length > 0) {
                  await db.catalog.update(mangaId, {
                    manga: [...existingCatalog.manga, ...newVolumes]
                  });
                  console.log(`Added ${newVolumes.length} new volumes to existing manga ${mangaId}`);
                } else {
                  console.log(`Skipping ${volumeBatch.length} volumes for manga ${mangaId} as they already exist`);
                }
              } else {
                await db.catalog.add({
                  id: mangaId,
                  manga: volumeBatch
                });
                console.log(`Created new manga ${mangaId} with ${volumeBatch.length} volumes`);
              }
            });
            
            // Add a small delay between batches to prevent database overload
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        } catch (error) {
          console.error(`Error processing manga ${mangaId}:`, error);
          // Don't throw here - continue processing other manga entries
        }
      }
    } catch (error) {
      console.error('Error processing database queue:', error);
      // Put failed items back in the queue for retry
      this.queue = [...this.queue, ...currentQueue];
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