// Unified worker pool manager for both uploads and downloads
import { WorkerPool } from './worker-pool';
import { saveToDatabase } from '../upload/db-helper';
import UnifiedWorker from '../workers/unified-worker.ts?worker';

// Singleton worker pool instance
let workerPool: WorkerPool | null = null;

// Initialize the worker pool
function getWorkerPool() {
  if (!workerPool) {
    // Use navigator.hardwareConcurrency to determine optimal number of workers
    // but limit to a reasonable number to avoid overwhelming the browser
    const maxWorkers = Math.min(navigator.hardwareConcurrency || 4, 6);
    
    // Set memory threshold to 500MB to prevent excessive memory usage on mobile devices
    const memoryLimitMB = 500; // 500 MB memory threshold
    
    console.log(`Creating unified worker pool with ${maxWorkers} workers and ${memoryLimitMB}MB memory threshold`);
    
    // Create a worker pool with the unified worker
    workerPool = new WorkerPool(UnifiedWorker, maxWorkers, memoryLimitMB);
  }
  return workerPool;
}

// Process uploaded files using the worker pool
export async function processFilesWithWorker(files: File[]): Promise<void> {
  // Get the worker pool
  const pool = getWorkerPool();
  
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
    // Generate a unique task ID
    const taskId = `upload-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    // Add the task to the worker pool
    pool.addTask({
      id: taskId,
      memoryRequirement,
      data: { 
        taskType: 'upload',
        taskId,
        files 
      },
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

// Download and process a file from Google Drive
export async function downloadAndProcessFile(
  fileId: string, 
  fileName: string, 
  accessToken: string, 
  fileSize: number,
  onProgress?: (loaded: number) => void
): Promise<void> {
  // Get the worker pool
  const pool = getWorkerPool();
  
  // Estimate memory requirement based on file size
  const memoryRequirement = Math.max(
    // Estimate memory needed: file size + processing overhead
    fileSize * 3, // 3x file size for processing overhead
    50 * 1024 * 1024 // Minimum 50MB
  );
  
  console.log(`Adding download task for ${fileName} with estimated memory requirement: ${(memoryRequirement / (1024 * 1024)).toFixed(2)}MB`);
  
  // Create a promise that resolves when the processing is complete
  return new Promise((resolve, reject) => {
    // Generate a unique task ID
    const taskId = `download-${fileId}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    
    // Add the task to the worker pool
    pool.addTask({
      id: taskId,
      memoryRequirement,
      data: { 
        taskType: 'download',
        taskId,
        fileId, 
        fileName, 
        accessToken 
      },
      onProgress(data) {
        // Call the progress callback if provided
        if (onProgress) {
          onProgress(data.loaded);
        }
      },
      async onComplete(data) {
        try {
          console.log(`Received complete message for ${data.fileName}`, {
            hasProcessedData: !!data.processedData
          });
          
          // File was processed in the worker, now save to database
          console.log(`File ${data.fileName} was processed in the worker, saving to database`);
          
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
          console.error(`Error saving ${data.fileName} to database:`, error);
          reject(error);
        }
      },
      onError(data) {
        console.error(`Error with file:`, data.error);
        reject(new Error(data.error));
      }
    });
  });
}

// Get memory usage information from the worker pool
export function getMemoryUsage() {
  const pool = getWorkerPool();
  return pool.memoryUsage;
}