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
  private readonly BATCH_DELAY = 500;
  private readonly BATCH_SIZE = 25; // Reduced batch size for better memory management
  private readonly MAX_QUEUE_SIZE = 1000; // Limit queue size to prevent memory issues

  async enqueue(volume: Volume, mangaId: string) {
    // If queue is too large, process it immediately
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      if (this.batchTimeout !== null) {
        clearTimeout(this.batchTimeout);
        this.batchTimeout = null;
      }
      await this.processQueue();
    }
    
    this.queue.push({ volume, mangaId });
    this.scheduleBatchProcessing();
  }

  private scheduleBatchProcessing() {
    if (this.batchTimeout !== null) {
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
      // Process queue in chunks to avoid memory issues
      while (this.queue.length > 0) {
        // Take a small batch from the queue
        const currentBatch = this.queue.splice(0, this.BATCH_SIZE);
        
        // Group volumes by manga ID for this batch only
        const volumesByManga = new Map<string, Volume[]>();
        
        for (const { volume, mangaId } of currentBatch) {
          if (!volumesByManga.has(mangaId)) {
            volumesByManga.set(mangaId, []);
          }
          volumesByManga.get(mangaId)!.push(volume);
        }

        // Process each manga in the current batch
        for (const [mangaId, volumes] of volumesByManga) {
          try {
            await db.transaction('rw', db.catalog, async () => {
              const existingCatalog = await db.catalog.get(mangaId);

              if (existingCatalog) {
                // Filter out any volumes that already exist
                const newVolumes = volumes.filter(vol =>
                  !existingCatalog.manga.some(existing =>
                    existing.mokuroData.volume_uuid === vol.mokuroData.volume_uuid
                  )
                );

                if (newVolumes.length > 0) {
                  // Update with only the new volumes to minimize memory usage
                  await db.catalog.update(mangaId, {
                    manga: [...existingCatalog.manga, ...newVolumes]
                  });
                  console.log(`Added ${newVolumes.length} new volumes to existing manga ${mangaId}`);
                } else {
                  console.log(`Skipping ${volumes.length} volumes for manga ${mangaId} as they already exist`);
                }
              } else {
                await db.catalog.add({
                  id: mangaId,
                  manga: volumes
                });
                console.log(`Created new manga ${mangaId} with ${volumes.length} volumes`);
              }
            });

            // Clear references to help garbage collection
            volumes.length = 0;
          } catch (error) {
            console.error(`Error processing manga ${mangaId}:`, error);
            // Don't throw here - continue processing other manga entries
          }
        }

        // Clear references to help garbage collection
        volumesByManga.clear();
        
        // Add a small delay between batches to prevent database overload
        await new Promise(resolve => setTimeout(resolve, 50));
      }
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