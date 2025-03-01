// Web worker for processing uploaded files
// This file will be bundled by Vite as a web worker

// Import the helper for processing files in the worker
import { processFilesInWorker } from './process-helper';

// Define the worker context
const ctx: Worker = self as any;

interface UploadMessage {
  files: File[];
}

interface CompleteMessage {
  type: 'complete';
  processedData: any;
}

interface ErrorMessage {
  type: 'error';
  error: string;
}

// Listen for messages from the main thread
ctx.addEventListener('message', async (event) => {
  console.log('Worker: Received message from main thread', event.data);
  
  try {
    const { files } = event.data as UploadMessage;
    console.log(`Worker: Starting to process ${files.length} files`);
    
    // Process the files in the worker
    const processedData = await processFilesInWorker(files);
    
    console.log(`Worker: Files processed successfully`);
    
    // Create a message with the processed data
    const completeMessage: CompleteMessage = {
      type: 'complete',
      processedData
    };
    
    console.log(`Worker: Sending complete message`);
    
    // Post the message back to the main thread
    ctx.postMessage(completeMessage);
    console.log(`Worker: Message posted`);
  } catch (error) {
    console.error('Worker: Error in message handler:', error);
    
    // Create an error message
    const errorMessage: ErrorMessage = {
      type: 'error',
      error: error.toString()
    };
    
    ctx.postMessage(errorMessage);
  }
});