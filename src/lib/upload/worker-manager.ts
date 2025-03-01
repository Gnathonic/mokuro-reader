// Worker pool manager for file uploads
import { WorkerPool } from '$lib/util/worker-pool';
import { saveToDatabase } from './db-helper';
import UploadWorker from '$lib/workers/upload-worker.ts?worker';

// Create a worker pool for file uploads
let workerPool: WorkerPool | null = null;

// Initialize the worker pool
function initWorkerPool() {
  if (!workerPool) {
    // Use navigator.hardwareConcurrency to determine optimal number of workers
    // but limit to a reasonable number to avoid overwhelming the browser
    const maxWorkers = Math.min(navigator.hardwareConcurrency || 4, 6);
    
    // Set memory threshold to 500MB to prevent excessive memory usage on mobile devices
    const memoryLimitMB = 500; // 500 MB memory threshold
    
    console.log(`Creating upload worker pool with ${maxWorkers} workers and ${memoryLimitMB}MB memory threshold`);
    
    // Create a custom worker pool for uploads
    workerPool = new WorkerPool(UploadWorker, maxWorkers, memoryLimitMB);
  }
  return workerPool;
}

// Process files using the worker pool
export async function processFilesWithWorker(files: File[]): Promise<void> {
  // Initialize the worker pool
  const pool = initWorkerPool();
  
  // Estimate memory requirement based on total file size
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const memoryRequirement = Math.max(
    // Estimate memory needed: file size + processing overhead
    totalSize * 3, // 3x file size for processing overhead
    50 * 1024 * 1024 // Minimum 50MB
  );
  
  console.log(`Adding upload task with estimated memory requirement: ${(memoryRequirement / (1024 * 1024)).toFixed(2)}MB`);
  
  // Create a promise that resolves when the processing is complete
  return new Promise((resolve, reject) => {
    // Add the task to the worker pool
    pool.addTask({
      id: `upload-${Date.now()}`,
      memoryRequirement,
      data: { files },
      async onComplete(data) {
        try {
          console.log(`Received complete message for file upload`, {
            hasProcessedData: !!data.processedData
          });
          
          // Files were processed in the worker, now save to database
          console.log(`Files were processed in the worker, saving to database`);
          
          // Save the processed data to the database
          if (data.processedData) {
            await saveToDatabase(
              data.processedData.volumesByPath,
              data.processedData.volumesDataByPath
            );
          }
          
          // Resolve the promise
          resolve();
        } catch (error) {
          console.error(`Error saving to database:`, error);
          reject(error);
        }
      },
      onError(data) {
        console.error(`Error processing files:`, data.error);
        reject(new Error(data.error));
      }
    });
  });
}