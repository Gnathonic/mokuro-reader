// Web worker for downloading files from Google Drive
// This file will be bundled by Vite as a web worker
import { BlobReader, ZipReader, Entry, BlobWriter, getMimeType } from '@zip.js/zip.js';

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
  data: ArrayBuffer; // Empty buffer since we're sending the decompressed entries
  entries: DecompressedEntry[];
}

interface ErrorMessage {
  type: 'error';
  fileId: string;
  error: string;
}

interface DecompressedEntry {
  filename: string;
  data: ArrayBuffer;
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

            console.log(`Worker: Decompressing ${fileName}...`);
            
            // Create a blob from the array buffer
            const blob = new Blob([arrayBuffer]);
            
            // Create a zip reader
            const zipReader = new ZipReader(new BlobReader(blob));
            
            // Get all entries from the zip file
            const entries = await zipReader.getEntries();
            
            // Process each entry
            const decompressedEntries: DecompressedEntry[] = [];
            
            for (const entry of entries) {
              // Skip directories
              if (entry.directory) continue;

              try {
                const mime = getMimeType(entry.filename)
                const blob:Blob = await entry.getData(new BlobWriter(mime));
                // Get the entry data as an array buffer
                const buffer = await blob.arrayBuffer();
                
                // Add the entry to the decompressed entries
                decompressedEntries.push({
                  filename: entry.filename,
                  data: buffer
                });
              } catch (entryError) {
                console.error(`Worker: Error extracting entry ${entry.filename}:`, entryError);
              }
            }
            
            // Close the zip reader
            await zipReader.close();
            
            console.log(`Worker: Decompressed ${decompressedEntries.length} files from ${fileName}`);
            
            // Create a message with the decompressed entries
            const completeMessage: CompleteMessage = {
              type: 'complete',
              fileId,
              fileName,
              data: new ArrayBuffer(0), // Empty buffer since we're sending the decompressed entries
              entries: decompressedEntries
            };
            
            console.log(`Worker: Sending complete message for ${fileName} with ${decompressedEntries.length} decompressed entries`);
            
            // Create an array of transferable objects (the entry data array buffers)
            const transferables = decompressedEntries.map(entry => entry.data);
            
            console.log(`Worker: Sending ${transferables.length} transferable objects`);
            
            // Post the message with the transferable objects
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
