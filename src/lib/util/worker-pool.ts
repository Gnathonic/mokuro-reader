// Worker pool for managing parallel downloads and decompression

import { sharedMemoryManager } from './shared-memory-manager';

export interface VolumeMetadata {
  volumeUuid: string;
  driveFileId: string;
  seriesTitle: string;
  volumeTitle: string;
  driveModifiedTime?: string;
  driveSize?: number;
}

export interface WorkerTask {
  id: string;
  data?: any; // Direct data to send to worker (if prepareData is not used)
  prepareData?: () => Promise<any>; // Lazy data preparation function (called just before worker starts)
  memoryRequirement?: number; // Memory requirement in bytes
  provider?: string; // Provider identifier for concurrency tracking (e.g., 'google-drive:upload', 'mega:download', 'export-for-download')
  providerConcurrencyLimit?: number; // Max concurrent operations for this provider:operation
  metadata?: VolumeMetadata; // Optional metadata for volume downloads
  onProgress?: (progress: any) => void;
  onComplete?: (result: any, completeTask: () => void) => void;
  onError?: (error: any) => void;
}

// Type for worker constructor
type WorkerConstructor = new () => Worker;

export class WorkerPool {
  private workers: Worker[] = [];
  private taskQueue: WorkerTask[] = [];
  private activeTasks: Map<string, WorkerTask> = new Map();
  private workerTaskMap: Map<Worker, string | null> = new Map();
  private maxConcurrent: number;
  private providerOperationCounts: Map<string, number> = new Map(); // Track concurrent operations per provider
  private workerConstructor: WorkerConstructor;
  private poolId: string; // Unique identifier for this pool

  constructor(poolId: string, workerConstructor: WorkerConstructor, maxConcurrent = 4, maxMemoryMB = 500) {
    this.poolId = poolId;
    this.workerConstructor = workerConstructor;
    this.maxConcurrent = Math.max(1, Math.min(maxConcurrent, navigator.hardwareConcurrency || 4));

    // Initialize shared memory manager limit (only needs to be set once, but multiple calls are safe)
    sharedMemoryManager.setMemoryLimit(maxMemoryMB);

    console.log(`Worker pool [${poolId}]: ${this.maxConcurrent} workers, ${maxMemoryMB}MB shared limit`);

    // Initialize workers
    for (let i = 0; i < this.maxConcurrent; i++) {
      this.addWorker();
    }
  }

  private addWorker() {
    // Create a new worker using the provided constructor
    const worker = new this.workerConstructor();

    worker.onmessage = (event) => {
      const taskId = this.workerTaskMap.get(worker);
      if (!taskId) {
        console.warn('Worker pool: Received message but no taskId found', event.data);
        return;
      }

      const task = this.activeTasks.get(taskId);
      if (!task) {
        console.warn(
          'Worker pool: Received message but no task found for taskId',
          taskId,
          event.data
        );
        return;
      }

      const data = event.data;

      if (data.type === 'progress' && task.onProgress) {
        task.onProgress(data);
      } else if (data.type === 'complete' && task.onComplete) {
        console.log(`Worker pool: Calling onComplete for task ${taskId}`, {
          hasData: !!data.data,
          dataType: typeof data.data,
          dataSize: data.data?.byteLength
        });

        task.onComplete(data, () => {
          this.completeTask(worker);
        });
      } else if (data.type === 'error' && task.onError) {
        console.error(`Worker pool: Error for task ${taskId}:`, data.error);
        task.onError(data);
        this.completeTask(worker);
      }
    };

    worker.onerror = (error) => {
      console.error('Worker pool: Worker error event:', error);

      const taskId = this.workerTaskMap.get(worker);
      if (!taskId) {
        console.warn('Worker pool: Error event but no taskId found');
        return;
      }

      const task = this.activeTasks.get(taskId);
      if (task && task.onError) {
        console.error(`Worker pool: Calling onError for task ${taskId}`, error.message);
        task.onError({ type: 'error', fileId: taskId, error: error.message });
      } else {
        console.warn(`Worker pool: No onError handler for task ${taskId}`);
      }

      this.completeTask(worker);
    };

    this.workers.push(worker);
    this.workerTaskMap.set(worker, null);
  }

  private completeTask(worker: Worker) {
    const taskId = this.workerTaskMap.get(worker);
    if (taskId) {
      const task = this.activeTasks.get(taskId);
      if (task) {
        // Release memory via shared memory manager
        if (task.memoryRequirement) {
          sharedMemoryManager.release(this.poolId, taskId);
        }

        // Decrement provider operation count
        if (task.provider) {
          const currentCount = this.providerOperationCounts.get(task.provider) || 0;
          const newCount = Math.max(0, currentCount - 1);
          this.providerOperationCounts.set(task.provider, newCount);
          console.log(
            `[${this.poolId}] Task ${taskId} completed. Provider ${task.provider} operations: ${newCount}/${task.providerConcurrencyLimit || 'unlimited'}`
          );
        }
      }
      this.activeTasks.delete(taskId);
      this.workerTaskMap.set(worker, null);
    }

    // Process the queue to assign next tasks
    this.processQueue();
  }

  private processQueue() {
    // Process as many tasks from the queue as possible based on memory and provider constraints
    // Multiple providers can run concurrently up to their individual limits

    while (this.taskQueue.length > 0) {
      // Find an available worker first
      const availableWorker = this.workers.find(
        (worker) => this.workerTaskMap.get(worker) === null
      );
      if (!availableWorker) {
        // No available workers, can't process more tasks right now
        break;
      }

      // Check memory constraint via shared memory manager
      // Only block if we're currently OVER the limit (not if adding would exceed)
      // This allows large single tasks to run even if they exceed the conservative limit
      if (!sharedMemoryManager.canStartNewTask(this.activeTasks.size > 0)) {
        const memoryStats = sharedMemoryManager.getStats();
        console.log(
          `[${this.poolId}] Currently over memory limit. Waiting for tasks to complete. Total: ${(memoryStats.current / (1024 * 1024)).toFixed(1)}MB / ${(memoryStats.max / (1024 * 1024)).toFixed(1)}MB (${memoryStats.percentUsed.toFixed(1)}%)`
        );
        break;
      }

      // Find the first task in queue whose provider is not at its limit
      let taskIndex = -1;
      let eligibleTask: WorkerTask | null = null;

      for (let i = 0; i < this.taskQueue.length; i++) {
        const task = this.taskQueue[i];

        // Check provider concurrency constraint
        if (task.provider && task.providerConcurrencyLimit !== undefined) {
          const currentProviderCount = this.providerOperationCounts.get(task.provider) || 0;
          if (currentProviderCount >= task.providerConcurrencyLimit) {
            // This provider is at limit, skip this task
            continue;
          }
        }

        // Found an eligible task!
        taskIndex = i;
        eligibleTask = task;
        break;
      }

      // No eligible tasks found (all providers at their limits)
      if (!eligibleTask || taskIndex === -1) {
        console.log('All providers at concurrency limits. Waiting for tasks to complete.');
        break;
      }

      // Remove the eligible task from queue
      this.taskQueue.splice(taskIndex, 1);

      const memoryRequired = eligibleTask.memoryRequirement || 0;

      // Reserve memory via shared memory manager (always succeeds - blocking is done earlier via canStartNewTask)
      sharedMemoryManager.reserve(this.poolId, eligibleTask.id, memoryRequired);

      // Update provider operation count
      if (eligibleTask.provider) {
        const currentCount = this.providerOperationCounts.get(eligibleTask.provider) || 0;
        this.providerOperationCounts.set(eligibleTask.provider, currentCount + 1);
        console.log(
          `[${this.poolId}] Starting task ${eligibleTask.id}. Provider: ${eligibleTask.provider} (${currentCount + 1}/${eligibleTask.providerConcurrencyLimit || 'unlimited'})`
        );
      } else {
        console.log(
          `[${this.poolId}] Starting task ${eligibleTask.id}`
        );
      }

      // Assign task to worker
      this.assignTaskToWorker(availableWorker, eligibleTask);
    }
  }

  private async assignTaskToWorker(worker: Worker, task: WorkerTask) {
    this.activeTasks.set(task.id, task);
    this.workerTaskMap.set(worker, task.id);

    try {
      // If task has prepareData function, call it to get the data just-in-time
      let data = task.data;
      if (task.prepareData) {
        console.log(`Worker pool: Preparing data for task ${task.id}...`);
        data = await task.prepareData();
      }

      if (!data) {
        throw new Error('No data provided for worker task');
      }

      worker.postMessage(data);
    } catch (error) {
      console.error(`Worker pool: Error preparing data for task ${task.id}:`, error);

      // Call onError if available
      if (task.onError) {
        task.onError({
          type: 'error',
          fileId: task.id,
          error: error instanceof Error ? error.message : 'Failed to prepare task data'
        });
      }

      // Clean up the failed task
      this.completeTask(worker);
    }
  }

  public addTask(task: WorkerTask) {
    // Add memory requirement if not specified
    if (task.memoryRequirement === undefined) {
      // Default to a conservative estimate if not provided
      task.memoryRequirement = 50 * 1024 * 1024; // 50 MB default
    }

    // Add task to queue
    this.taskQueue.push(task);

    // Try to process the queue immediately
    this.processQueue();
  }

  public terminate() {
    // Terminate all workers
    for (const worker of this.workers) {
      worker.terminate();
    }

    // Release all memory reservations for this pool
    for (const taskId of this.activeTasks.keys()) {
      sharedMemoryManager.release(this.poolId, taskId);
    }

    this.workers = [];
    this.taskQueue = [];
    this.activeTasks.clear();
    this.workerTaskMap.clear();
  }

  public get activeTaskCount() {
    return this.activeTasks.size;
  }

  public get queuedTaskCount() {
    return this.taskQueue.length;
  }

  public get totalPendingTasks() {
    return this.activeTaskCount + this.queuedTaskCount;
  }

  public get memoryUsage() {
    // Return shared memory stats (all pools combined)
    return sharedMemoryManager.getStats();
  }

  public get maxConcurrentWorkers() {
    return this.maxConcurrent;
  }
}
