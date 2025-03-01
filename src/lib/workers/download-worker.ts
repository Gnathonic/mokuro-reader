// Web worker for downloading and processing files from Google Drive
// This file will be bundled by Vite as a web worker

// Import the necessary functions for processing files
import { processFiles } from '$lib/upload';

// Define the worker context
const ctx: Worker = self as any;

interface DownloadMessage {
  fileId: string;
  fileName: string;
  accessToken: string;
}

interface ProgressMessage {
  type: 'progress';
  fileId: string;
  loaded: number;
  total: number;
}

interface CompleteMessage {
  type: 'complete';
  fileId: string;
  fileName: string;
  processed: boolean; // Indicates if the file was processed successfully
}

interface ErrorMessage {
  type: 'error';
  fileId: string;
  error: string;
}

// Function to download a file from Google Drive
async function downloadFile(fileId: string, fileName: string, accessToken: string) {
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
        fileId,
        loaded: event.loaded,
        total: totalSize
      };
      ctx.postMessage(progressMessage);
    };
    
    xhr.onerror = () => {
      const errorMessage: ErrorMessage = {
        type: 'error',
        fileId,
        error: 'Network error during download'
      };
      ctx.postMessage(errorMessage);
    };
    
    xhr.ontimeout = () => {
      const errorMessage: ErrorMessage = {
        type: 'error',
        fileId,
        error: 'Download timed out'
      };
      ctx.postMessage(errorMessage);
    };
    
    xhr.onabort = () => {
      const errorMessage: ErrorMessage = {
        type: 'error',
        fileId,
        error: 'Download aborted'
      };
      ctx.postMessage(errorMessage);
    };
    
    return new Promise<void>((resolve, reject) => {
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            // Get the ArrayBuffer response
            const arrayBuffer = xhr.response;
            console.log(`Worker: Download complete for ${fileName}`, {
              responseType: xhr.responseType,
              responseSize: arrayBuffer.byteLength,
              status: xhr.status
            });
            
            // Process the file in an async function
            const processFile = async () => {
              try {
                // Create a File object from the ArrayBuffer
                const blob = new Blob([arrayBuffer]);
                const file = new File([blob], fileName);
                
                console.log(`Worker: Processing file ${fileName}`);
                
                // Process the file directly in the worker
                await processFiles([file]);
                
                console.log(`Worker: File ${fileName} processed successfully`);
                
                // Create a message indicating successful processing
                const completeMessage: CompleteMessage = {
                  type: 'complete',
                  fileId,
                  fileName,
                  processed: true
                };
                
                // Post the message back to the main thread
                ctx.postMessage(completeMessage);
                console.log(`Worker: Success message posted for ${fileName}`);
                resolve();
              } catch (processingError) {
                console.error(`Worker: Error processing file ${fileName}:`, processingError);
                
                // Create an error message for processing failure
                const errorMessage: ErrorMessage = {
                  type: 'error',
                  fileId,
                  error: `Error processing file: ${processingError.toString()}`
                };
                
                ctx.postMessage(errorMessage);
                reject(processingError);
              }
            };
            
            // Execute the async function
            processFile();
          } catch (error) {
            console.error('Worker: Error processing response:', error);
            const errorMessage: ErrorMessage = {
              type: 'error',
              fileId,
              error: `Error processing response: ${error.toString()}`
            };
            ctx.postMessage(errorMessage);
            reject(error);
          }
        } else {
          const errorMessage: ErrorMessage = {
            type: 'error',
            fileId,
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
      fileId,
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
    const { fileId, fileName, accessToken } = event.data as DownloadMessage;
    console.log(`Worker: Starting download for ${fileName} (${fileId})`);
    
    await downloadFile(fileId, fileName, accessToken);
    console.log(`Worker: Download function completed for ${fileName}`);
  } catch (error) {
    console.error('Worker: Error in message handler:', error);
  }
});