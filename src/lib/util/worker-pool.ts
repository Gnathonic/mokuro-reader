// Worker pool for managing parallel downloads

// Import the worker script using Vite's worker plugin
import DownloadWorker from '$lib/workers/download-worker.ts?worker';

export interface WorkerTask {
  id: string;
  data: any;
  memoryRequirement?: number; // Memory requirement in bytes
  onProgress?: (progress: any) => void;
  onComplete?: (result: any) => void;
  onError?: (error: any) => void;
}

export class WorkerPool {
  private workers: Worker[] = [];
  private taskQueue: WorkerTask[] = [];
  private activeTasks: Map<string, WorkerTask> = new Map();
  private workerTaskMap: Map<Worker, string | null> = new Map();
  private maxConcurrent: number;
  private currentMemoryUsage: number = 0;
  private maxMemoryUsage: number = 500 * 1024 * 1024; // 500 MB threshold (not a hard limit)

  constructor(workerUrl?: string, maxConcurrent = 4, maxMemoryMB = 500) {
    this.maxConcurrent = Math.max(1, Math.min(maxConcurrent, navigator.hardwareConcurrency || 4));
    this.maxMemoryUsage = maxMemoryMB * 1024 * 1024; // Convert MB to bytes - this is a threshold, not a hard limit
    
    // Initialize workers
    for (let i = 0; i < this.maxConcurrent; i++) {
      this.addWorker();
    }
  }

  private addWorker() {
    // Create a new worker using Vite's worker instantiation
    const worker = new DownloadWorker();
    
    worker.onmessage = (event) => {
      const taskId = this.workerTaskMap.get(worker);
      if (!taskId) {
        console.warn('Worker pool: Received message but no taskId found', event.data);
        return;
      }
      
      const task = this.activeTasks.get(taskId);
      if (!task) {
        console.warn('Worker pool: Received message but no task found for taskId', taskId, event.data);
        return;
      }
      
      const data = event.data;
      console.log(`Worker pool: Received message of type ${data.type} for task ${taskId}`, data);
      
      if (data.type === 'progress' && task.onProgress) {
        task.onProgress(data);
      } else if (data.type === 'complete' && task.onComplete) {
        console.log(`Worker pool: Calling onComplete for task ${taskId}`, {
          hasData: !!data.data,
          dataType: typeof data.data,
          dataSize: data.data?.byteLength
        });
        task.onComplete(data);
        this.completeTask(worker);
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

  // This map will track tasks that have completed the worker phase but are still processing in the main thread
  private pendingMemoryRelease: Map<string, number> = new Map();

  private completeTask(worker: Worker) {
    const taskId = this.workerTaskMap.get(worker);
    if (taskId) {
      const task = this.activeTasks.get(taskId);
      if (task && task.memoryRequirement) {
        // Instead of immediately reducing memory usage, we track it for later release
        // This is because the task will continue to use memory in the main thread for processing
        this.pendingMemoryRelease.set(taskId, task.memoryRequirement);
        console.log(`Task ${taskId} worker completed. Memory will be freed after main thread processing.`);
      }
      this.activeTasks.delete(taskId);
      this.workerTaskMap.set(worker, null);
    }
    
    // Process the queue to assign next tasks
    this.processQueue();
  }
  
  // New method to release memory after main thread processing is complete
  public releaseTaskMemory(taskId: string) {
    const memoryToRelease = this.pendingMemoryRelease.get(taskId);
    if (memoryToRelease) {
      this.currentMemoryUsage = Math.max(0, this.currentMemoryUsage - memoryToRelease);
      this.pendingMemoryRelease.delete(taskId);
      console.log(`Task ${taskId} fully completed. Memory freed: ${memoryToRelease / (1024 * 1024)} MB. Current usage: ${this.currentMemoryUsage / (1024 * 1024)} MB`);
      
      // Process the queue again in case we can now start more tasks
      this.processQueue();
    }
  }
  
  private processQueue() {
    // Process as many tasks from the queue as possible based on memory constraints
    while (this.taskQueue.length > 0) {
      // Find an available worker first
      const availableWorker = this.workers.find(worker => this.workerTaskMap.get(worker) === null);
      if (!availableWorker) {
        // No available workers, can't process more tasks right now
        break;
      }
      
      const nextTask = this.taskQueue[0];
      const memoryRequired = nextTask.memoryRequirement || 0;
      
      // Calculate total memory including pending releases
      let pendingMemory = 0;
      for (const memory of this.pendingMemoryRelease.values()) {
        pendingMemory += memory;
      }
      const totalMemoryUsage = this.currentMemoryUsage + pendingMemory;
      
      // Check if we're already over the memory limit AND this isn't the only task in the queue
      // We always allow at least one task to run, even if it exceeds the memory limit
      if (totalMemoryUsage > this.maxMemoryUsage && (this.activeTasks.size > 0 || this.pendingMemoryRelease.size > 0)) {
        console.log(`Memory usage already exceeds limit. Waiting for tasks to complete before starting new ones. Current: ${this.currentMemoryUsage / (1024 * 1024)} MB, Pending: ${pendingMemory / (1024 * 1024)} MB, Total: ${totalMemoryUsage / (1024 * 1024)} MB, Max: ${this.maxMemoryUsage / (1024 * 1024)} MB`);
        break;
      }
      
      // Remove task from queue
      this.taskQueue.shift();
      
      // Update memory usage
      this.currentMemoryUsage += memoryRequired;
      console.log(`Starting task ${nextTask.id}. Memory required: ${memoryRequired / (1024 * 1024)} MB. Current usage: ${this.currentMemoryUsage / (1024 * 1024)} MB, Total with pending: ${(this.currentMemoryUsage + pendingMemory) / (1024 * 1024)} MB`);
      
      // Assign task to worker
      this.assignTaskToWorker(availableWorker, nextTask);
    }
  }

  private assignTaskToWorker(worker: Worker, task: WorkerTask) {
    this.activeTasks.set(task.id, task);
    this.workerTaskMap.set(worker, task.id);
    worker.postMessage(task.data);
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
    
    this.workers = [];
    this.taskQueue = [];
    this.activeTasks.clear();
    this.workerTaskMap.clear();
    this.pendingMemoryRelease.clear();
    this.currentMemoryUsage = 0;
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
    // Calculate total memory including pending releases
    let pendingMemory = 0;
    for (const memory of this.pendingMemoryRelease.values()) {
      pendingMemory += memory;
    }
    
    const totalMemory = this.currentMemoryUsage + pendingMemory;
    
    return {
      current: this.currentMemoryUsage,
      pending: pendingMemory,
      total: totalMemory,
      max: this.maxMemoryUsage,
      percentUsed: (totalMemory / this.maxMemoryUsage) * 100
    };
  }
}