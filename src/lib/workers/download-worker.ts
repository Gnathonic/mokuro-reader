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
  data: ArrayBuffer;
  extractedFiles?: ExtractedFile[];
  isExtracted: boolean;
}

interface ErrorMessage {
  type: 'error';
  fileId: string;
  error: string;
}

// Function to check if a file is a zip or cbz
function isZipFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext === 'zip' || ext === 'cbz';
}

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
      
      // Skip problematic paths (same logic as in upload/index.ts)
      if (isProblematicPath(entry.filename)) {
        console.log(`Worker: Skipping file in problematic directory: ${entry.filename}`);
        continue;
      }
      
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

// List of problematic directory patterns to exclude (copied from upload/index.ts)
const excludedDirPatterns = [
  // macOS system directories
  '__MACOSX',
  '.DS_Store',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  '.TemporaryItems',
  '.Trash',
  
  // Windows system directories
  'System Volume Information',
  '$RECYCLE.BIN',
  'Thumbs.db',
  'desktop.ini',
  'Desktop.ini',
  'RECYCLER',
  'RECYCLED',
  
  // Linux/Unix system directories
  '.Trash-1000',
  '.thumbnails',
  '.directory',
  
  // Cloud storage special folders
  '.dropbox',
  '.dropbox.cache',
  
  // Version control
  '.git',
  '.svn',
  
  // General backup/temp files
  '~$',
  '.bak',
  '.tmp',
  '.temp'
];

// Function to check if a path contains any problematic directory patterns (copied from upload/index.ts)
function isProblematicPath(path: string): boolean {
  if (!path) return false;
  
  // Check for macOS hidden files that start with "._"
  const pathParts = path.split('/');
  const fileName = pathParts[pathParts.length - 1];
  if (fileName.startsWith('._')) {
    return true;
  }
  
  return excludedDirPatterns.some(pattern => 
    path.includes('/' + pattern + '/') || 
    path.endsWith('/' + pattern) || 
    path === pattern
  );
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

            // Check if this is a zip/cbz file that needs extraction
            const shouldExtract = isZipFile(fileName);
            let extractedFiles: ExtractedFile[] | undefined;
            let transferables: ArrayBuffer[] = [];
            
            // If it's a zip/cbz file, extract its contents
            if (shouldExtract) {
              try {
                console.log(`Worker: Starting extraction for ${fileName}`);
                // Clone the array buffer since we'll be transferring the original
                const arrayBufferClone = arrayBuffer.slice(0);
                extractedFiles = await extractZipFiles(arrayBufferClone);
                
                // Add all extracted file buffers to transferables
                if (extractedFiles) {
                  extractedFiles.forEach(file => {
                    transferables.push(file.data);
                  });
                }
                
                console.log(`Worker: Extraction complete for ${fileName}, found ${extractedFiles.length} files`);
              } catch (error) {
                console.error(`Worker: Error extracting ${fileName}:`, error);
                // If extraction fails, we'll still send the original file
                extractedFiles = undefined;
              }
            }

            // Create a message with the ArrayBuffer and extracted files if available
            const completeMessage: CompleteMessage = {
              type: 'complete',
              fileId,
              fileName,
              data: arrayBuffer,
              extractedFiles,
              isExtracted: !!extractedFiles
            };

            console.log(`Worker: Sending complete message for ${fileName}`, {
              messageType: 'complete',
              dataSize: arrayBuffer.byteLength,
              extractedFiles: extractedFiles ? extractedFiles.length : 0
            });

            // Add the original array buffer to transferables
            transferables.push(arrayBuffer);

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
