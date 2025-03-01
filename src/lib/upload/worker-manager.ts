// Worker manager for file uploads - now uses the unified worker pool
import { processFilesWithWorker as processWithUnifiedWorker } from '$lib/util/unified-worker-pool';

// Export the function that uses the unified worker pool
export const processFilesWithWorker = processWithUnifiedWorker;