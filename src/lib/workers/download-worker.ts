// Web worker for downloading files from Google Drive
// This file will be bundled by Vite as a web worker

// Define the worker context
const ctx: Worker = self as any;

// Check if the browser is Firefox
const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;
console.log(`Worker initialized in ${isFirefox ? 'Firefox' : 'non-Firefox'} browser`);

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
  data?: ArrayBuffer; // Optional now, as we'll use a different approach for Firefox
}

interface ChunkMessage {
  type: 'chunk';
  fileId: string;
  fileName: string;
  chunk: ArrayBuffer;
  chunkIndex: number;
  totalChunks: number;
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

            if (isFirefox) {
              // For Firefox, use a chunked approach to avoid memory issues
              // Firefox has issues with large ArrayBuffer transfers
              handleFirefoxDownload(arrayBuffer, fileId, fileName);
            } else {
              // For other browsers, use the standard approach with transferable objects
              const completeMessage: CompleteMessage = {
                type: 'complete',
                fileId,
                fileName,
                data: arrayBuffer
              };

              console.log(`Worker: Sending complete message for ${fileName}`, {
                messageType: 'complete',
                dataSize: arrayBuffer.byteLength
              });

              // Post the message with the ArrayBuffer as a transferable object
              ctx.postMessage(completeMessage, [arrayBuffer]);
            }
            
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

// Special handling for Firefox to avoid memory issues with large ArrayBuffers
function handleFirefoxDownload(arrayBuffer: ArrayBuffer, fileId: string, fileName: string) {
  // Use a smaller chunk size for Firefox to avoid memory issues
  // 4MB chunks should be safe for Firefox
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
  const totalSize = arrayBuffer.byteLength;
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
  
  console.log(`Worker: Processing ${fileName} in ${totalChunks} chunks of ${CHUNK_SIZE / (1024 * 1024)}MB each`);
  
  // First send a complete message with no data to signal the start of chunked transfer
  const completeMessage: CompleteMessage = {
    type: 'complete',
    fileId,
    fileName
    // No data field - this signals that we're using chunked transfer
  };
  
  ctx.postMessage(completeMessage);
  
  // Then send each chunk
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalSize);
    const chunk = arrayBuffer.slice(start, end);
    
    const chunkMessage: ChunkMessage = {
      type: 'chunk',
      fileId,
      fileName,
      chunk,
      chunkIndex: i,
      totalChunks
    };
    
    // Use transferable objects for each chunk
    ctx.postMessage(chunkMessage, [chunk]);
    
    console.log(`Worker: Sent chunk ${i + 1}/${totalChunks} for ${fileName}`);
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
