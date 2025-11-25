/**
 * Shared File Processing Pool
 *
 * Provides a singleton worker pool for ALL file operations:
 * - Downloads (Google Drive, WebDAV, MEGA)
 * - Uploads (Google Drive, WebDAV, MEGA)
 * - Exports (local browser downloads)
 * - Compression/Decompression
 *
 * Follows Android ThreadPoolExecutor pattern:
 * - One shared pool for all task types
 * - Workers can handle any operation
 * - Better resource utilization than separate pools
 * - Reference counting prevents premature termination
 */

import { WorkerPool } from './worker-pool';
import UnifiedFileWorker from '$lib/workers/unified-file-worker.ts?worker';
import { miscSettings } from '$lib/settings/misc';
import { sharedMemoryManager } from './shared-memory-manager';

// Singleton state
let sharedPool: WorkerPool | null = null;
let poolInitPromise: Promise<WorkerPool> | null = null;
let poolUserCount = 0; // Reference counting for safe termination

// Subscribe to settings changes to update memory limit dynamically
miscSettings.subscribe((value) => {
  const turboMode = value.turboMode ?? false;

  // Turbo mode: use normal RAM-based limit (for impatient users with fast internet)
  // Non-turbo: use 1MB limit to force single-operation mode (patient users)
  const memoryLimitMB = turboMode
    ? ((value.deviceRamGB ?? 4) * 1024) / 8 // Turbo: RAM-based
    : 1; // Non-turbo: 1MB (forces single operation)

  // Update shared memory manager limit
  sharedMemoryManager.setMemoryLimit(memoryLimitMB);
});

/**
 * Get or create the shared file processing pool
 * Uses promise-based mutex to prevent race conditions with concurrent calls
 *
 * Worker count calculation:
 * - Base: 1.5x RAM in GB (e.g., 4GB = 6 workers, 16GB = 24 workers)
 * - Cap: Hardware concurrency (CPU cores) to avoid oversubscription
 * - Min: 2 workers
 *
 * Memory limit:
 * - 1/8th of configured RAM (e.g., 16GB = 2048MB limit)
 * - Shared across ALL operations (downloads + uploads + exports)
 * - Managed by SharedMemoryManager
 *
 * @returns Promise<WorkerPool> The shared worker pool instance
 */
export async function getFileProcessingPool(): Promise<WorkerPool> {
  // Return existing pool if already created
  if (sharedPool) {
    return sharedPool;
  }

  // If already initializing, wait for that to complete
  if (poolInitPromise) {
    return poolInitPromise;
  }

  // Start initialization and store the promise
  poolInitPromise = (async () => {
    // Get user's current settings
    let deviceRamGB = 4; // Default
    let turboMode = false; // Default
    miscSettings.subscribe((value) => {
      deviceRamGB = value.deviceRamGB ?? 4;
      turboMode = value.turboMode ?? false;
    })();

    // Memory limit calculation (same logic as the subscription above)
    // Turbo mode: use normal RAM-based limit (for impatient users with fast internet)
    // Non-turbo: use 1MB limit to force single-operation mode (patient users)
    const memoryLimitMB = turboMode
      ? (deviceRamGB * 1024) / 8 // Turbo: RAM-based
      : 1; // Non-turbo: 1MB (forces single operation)

    // Worker count: scale with CPU cores
    // Use 1.5x RAM in GB as base (e.g., 4GB = 6 workers, 16GB = 24 workers)
    // Cap at hardware concurrency to avoid oversubscription
    const calculatedWorkers = Math.max(2, Math.floor(deviceRamGB * 1.5));
    const maxWorkers = Math.min(calculatedWorkers, navigator.hardwareConcurrency || 4);

    console.log(
      `[File Processing Pool] Initializing: ${maxWorkers} workers, ${memoryLimitMB}MB shared limit ` +
        `(turbo: ${turboMode ? 'ON' : 'OFF'}, ${deviceRamGB}GB RAM, ${navigator.hardwareConcurrency || 4} CPU cores)`
    );

    // Create the shared pool with unified worker
    sharedPool = new WorkerPool('file-processing', UnifiedFileWorker, maxWorkers, memoryLimitMB);

    return sharedPool;
  })();

  try {
    return await poolInitPromise;
  } finally {
    // Clear the promise after completion (success or failure)
    poolInitPromise = null;
  }
}

/**
 * Increment pool user count
 * Called when a queue starts processing tasks
 *
 * Example:
 * - Download queue has 5 items → incrementPoolUsers()
 * - Backup queue has 3 items → incrementPoolUsers()
 * - Pool user count: 2 (pool stays alive)
 *
 * @returns void
 */
export function incrementPoolUsers(): void {
  poolUserCount++;
  console.log(`[File Processing Pool] Users: ${poolUserCount} (pool active)`);
}

/**
 * Decrement pool user count and terminate if no users remain
 * Called when a queue completes all tasks (queue becomes empty)
 *
 * Uses reference counting to prevent premature termination:
 * - If download queue finishes but backup queue still has tasks → pool stays alive
 * - If both queues finish → pool terminates to free resources
 *
 * Example:
 * - Download queue finishes → decrementPoolUsers() → count: 1 (pool stays alive)
 * - Backup queue finishes → decrementPoolUsers() → count: 0 (pool terminates)
 *
 * @returns void
 */
export function decrementPoolUsers(): void {
  poolUserCount = Math.max(0, poolUserCount - 1);
  console.log(`[File Processing Pool] Users: ${poolUserCount}`);

  if (poolUserCount === 0 && sharedPool) {
    console.log(`[File Processing Pool] No users remaining, terminating pool`);
    sharedPool.terminate();
    sharedPool = null;
  }
}

/**
 * Get current pool stats for debugging/monitoring
 * Returns null if pool doesn't exist
 *
 * @returns Pool stats or null
 */
export function getPoolStats(): {
  activeTaskCount: number;
  queuedTaskCount: number;
  totalPendingTasks: number;
  maxWorkers: number;
  userCount: number;
} | null {
  if (!sharedPool) {
    return null;
  }

  return {
    activeTaskCount: sharedPool.activeTaskCount,
    queuedTaskCount: sharedPool.queuedTaskCount,
    totalPendingTasks: sharedPool.totalPendingTasks,
    maxWorkers: sharedPool.maxConcurrentWorkers,
    userCount: poolUserCount
  };
}
