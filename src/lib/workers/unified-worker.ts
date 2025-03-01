// Unified web worker for downloading and processing files
// This file will be bundled by Vite as a web worker

// Import the helper for processing files in the worker
import { processFilesInWorker } from './process-helper';

// Define the worker context
const ctx: Worker = self as any;

// Message types
type TaskType = 'download' | 'upload';

interface BaseMessage {
  taskType: TaskType;
  taskId: string;
}

interface DownloadMessage extends BaseMessage {
  taskType: 'download';
  fileId: string;
  fileName: string;
  accessToken: string;
}

interface UploadMessage extends BaseMessage {
  taskType: 'upload';
  files: File[];
}

type WorkerMessage = DownloadMessage | UploadMessage;

interface ProgressMessage {
  type: 'progress';
  taskId: string;
  loaded: number;
  total: number;
}

interface CompleteMessage {
  type: 'complete';
  taskId: string;
  fileName?: string;
  processedData: any;
}

interface ErrorMessage {
  type: 'error';
  taskId: string;
  error: string;
}

// Function to download a file from Google Drive
async function downloadFile(fileId: string, fileName: string, accessToken: string, taskId: string) {
  try {
    // First get the file size
    const sizeResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (!sizeResponse.ok) {
      throw new Error(`Failed to get file size: ${sizeResponse.statusText}`);
    }
    
    const sizeData = await sizeResponse.json();
    const totalSize = parseInt(sizeData.size, 10);
    
    // Now download the file with progress tracking
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    xhr.responseType = 'arraybuffer'; // Use arraybuffer instead of blob for better transferability
    
    xhr.onprogress = (event) => {
      const progressMessage: ProgressMessage = {
        type: 'progress',
        taskId,
        loaded: event.loaded,
        total: totalSize
      };
      ctx.postMessage(progressMessage);
    };
    
    xhr.onerror = () => {
      const errorMessage: ErrorMessage = {
        type: 'error',
        taskId,
        error: 'Network error during download'
      };
      ctx.postMessage(errorMessage);
    };
    
    xhr.ontimeout = () => {
      const errorMessage: ErrorMessage = {
        type: 'error',
        taskId,
        error: 'Download timed out'
      };
      ctx.postMessage(errorMessage);
    };
    
    xhr.onabort = () => {
      const errorMessage: ErrorMessage = {
        type: 'error',
        taskId,
        error: 'Download aborted'
      };
      ctx.postMessage(errorMessage);
    };
    
    return new Promise<void>((resolve, reject) => {
      xhr.onload = async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            // Get the ArrayBuffer response
            const arrayBuffer = xhr.response;
            console.log(`Worker: Download complete for ${fileName}`, {
              responseType: xhr.responseType,
              responseSize: arrayBuffer.byteLength,
              status: xhr.status
            });
            
            // Create a File object from the ArrayBuffer
            const blob = new Blob([arrayBuffer]);
            const file = new File([blob], fileName);
            
            console.log(`Worker: Processing file ${fileName}`);
            
            // Process the file in the worker
            const processedData = await processFilesInWorker([file]);
            
            console.log(`Worker: File ${fileName} processed successfully`);
            
            // Create a message with the processed data
            const completeMessage: CompleteMessage = {
              type: 'complete',
              taskId,
              fileName,
              processedData
            };
            
            console.log(`Worker: Sending complete message for ${fileName}`);
            
            // Post the message back to the main thread
            ctx.postMessage(completeMessage);
            console.log(`Worker: Message posted for ${fileName}`);
            resolve();
          } catch (error) {
            console.error('Worker: Error processing response:', error);
            const errorMessage: ErrorMessage = {
              type: 'error',
              taskId,
              error: `Error processing response: ${error.toString()}`
            };
            ctx.postMessage(errorMessage);
            reject(error);
          }
        } else {
          const errorMessage: ErrorMessage = {
            type: 'error',
            taskId,
            error: `HTTP error ${xhr.status}: ${xhr.statusText}`
          };
          ctx.postMessage(errorMessage);
          reject(new Error(`HTTP error ${xhr.status}: ${xhr.statusText}`));
        }
      };
      
      xhr.send();
    });
  } catch (error) {
    const errorMessage: ErrorMessage = {
      type: 'error',
      taskId,
      error: error.toString()
    };
    ctx.postMessage(errorMessage);
    throw error;
  }
}

// Function to process uploaded files
async function processUploadedFiles(files: File[], taskId: string) {
  try {
    console.log(`Worker: Processing ${files.length} uploaded files`);
    
    // Process the files in the worker
    const processedData = await processFilesInWorker(files);
    
    console.log(`Worker: Files processed successfully`);
    
    // Create a message with the processed data
    const completeMessage: CompleteMessage = {
      type: 'complete',
      taskId,
      processedData
    };
    
    console.log(`Worker: Sending complete message for uploads`);
    
    // Post the message back to the main thread
    ctx.postMessage(completeMessage);
    console.log(`Worker: Message posted for uploads`);
  } catch (error) {
    console.error('Worker: Error processing uploads:', error);
    
    // Create an error message
    const errorMessage: ErrorMessage = {
      type: 'error',
      taskId,
      error: error.toString()
    };
    
    ctx.postMessage(errorMessage);
    throw error;
  }
}

// Listen for messages from the main thread
ctx.addEventListener('message', async (event) => {
  console.log('Worker: Received message from main thread', event.data);
  
  try {
    const message = event.data as WorkerMessage;
    
    // Handle different task types
    switch (message.taskType) {
      case 'download':
        await downloadFile(message.fileId, message.fileName, message.accessToken, message.taskId);
        break;
        
      case 'upload':
        await processUploadedFiles(message.files, message.taskId);
        break;
        
      default:
        throw new Error(`Unknown task type: ${(message as any).taskType}`);
    }
  } catch (error) {
    console.error('Worker: Error in message handler:', error);
  }
});