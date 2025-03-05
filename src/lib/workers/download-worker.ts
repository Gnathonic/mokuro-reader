// Web worker for downloading files from Google Drive
// This file will be bundled by Vite as a web worker

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
  data: ArrayBuffer;
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

            // Create a message with the ArrayBuffer
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
