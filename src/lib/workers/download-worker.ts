// Web worker for downloading files from Google Drive and extracting zip/cbz files
// This file will be bundled by Vite as a web worker

// Import zip.js for decompression
import { ZipReader } from '@zip.js/zip.js';

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

interface ExtractedFile {
  name: string;
  data: ArrayBuffer;
}

interface CompleteMessage {
  type: 'complete';
  fileId: string;
  fileName: string;
  extractedFiles: ExtractedFile[];
}

interface ErrorMessage {
  type: 'error';
  fileId: string;
  error: string;
}

// All files from Google Drive are zip or cbz, so we don't need to check

// Function to extract files from a zip/cbz
async function extractZipFiles(arrayBuffer: ArrayBuffer): Promise<ExtractedFile[]> {
  console.log('Worker: Starting zip extraction');
  
  try {
    // Create a blob from the array buffer
    const blob = new Blob([arrayBuffer]);
    
    // Create a zip reader
    const zipReader = new ZipReader(new Response(blob).body);
    
    // Extract all entries
    const extractedFiles: ExtractedFile[] = [];
    
    // Process file entries
    for await (const entry of zipReader) {
      // Skip directories
      if (entry.directory) continue;
      
      // Extract the file data
      if (entry.readable) {
        try {
          // Convert readable stream to blob
          const blob = await new Response(entry.readable).blob();
          
          // Convert blob to ArrayBuffer
          const buffer = await blob.arrayBuffer();
          
          // Add to extracted files
          extractedFiles.push({
            name: entry.filename,
            data: buffer
          });
        } catch (error) {
          console.error(`Worker: Error extracting file ${entry.filename}:`, error);
        }
      }
    }
    
    // Close the zip reader
    await zipReader.close();
    
    console.log(`Worker: Extracted ${extractedFiles.length} files from zip`);
    return extractedFiles;
  } catch (error) {
    console.error('Worker: Error extracting zip:', error);
    throw new Error(`Error extracting zip: ${error.toString()}`);
  }
}

// Function to download a file from Google Drive
async function downloadFile(fileId: string, fileName: string, accessToken: string) {
  try {
    // First get the file size
    const sizeResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

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

            // Extract the contents (all files from Drive are zip/cbz)
            let extractedFiles: ExtractedFile[] = [];
            let transferables: ArrayBuffer[] = [];
            
            try {
              console.log(`Worker: Starting extraction for ${fileName}`);
              extractedFiles = await extractZipFiles(arrayBuffer);
              
              // Add all extracted file buffers to transferables
              extractedFiles.forEach(file => {
                transferables.push(file.data);
              });
              
              console.log(`Worker: Extraction complete for ${fileName}, found ${extractedFiles.length} files`);
            } catch (error) {
              console.error(`Worker: Error extracting ${fileName}:`, error);
              // Send an error message if extraction fails
              const errorMessage: ErrorMessage = {
                type: 'error',
                fileId,
                error: `Error extracting file: ${error.toString()}`
              };
              ctx.postMessage(errorMessage);
              reject(error);
              return;
            }

            // Create a message with the extracted files
            const completeMessage: CompleteMessage = {
              type: 'complete',
              fileId,
              fileName,
              extractedFiles
            };

            console.log(`Worker: Sending complete message for ${fileName}`, {
              messageType: 'complete',
              extractedFiles: extractedFiles.length
            });

            // Post the message with all ArrayBuffers as transferable objects
            ctx.postMessage(completeMessage, transferables);
            console.log(`Worker: Message posted for ${fileName}`);
            resolve();
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
