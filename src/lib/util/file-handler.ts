/**
 * File Handling API integration for PWA file associations
 * Allows the app to handle .cbz and .zip files opened from the OS file manager
 * when the app is installed as a PWA.
 *
 * @see https://developer.chrome.com/docs/capabilities/web-apis/file-handling
 */

/* eslint-disable no-undef */

import { processFiles } from '$lib/upload';
import { showSnackbar } from '$lib/util/snackbar';

// Extend the Window interface for the File Handling API
declare global {
  interface Window {
    launchQueue?: {
      setConsumer: (callback: (launchParams: LaunchParams) => void) => void;
    };
  }

  interface LaunchParams {
    files: FileSystemFileHandle[];
    targetURL?: string;
  }
}

const PROCESSED_KEY = 'mokuro_file_handler_processed';

/**
 * Generate a simple fingerprint for a set of files to detect duplicates
 */
function getFilesFingerprint(files: FileSystemFileHandle[]): string {
  return files
    .map((f) => f.name)
    .sort()
    .join('|');
}

/**
 * Check if we've already processed these files (survives refresh)
 */
function hasProcessedFiles(fingerprint: string): boolean {
  try {
    const processed = sessionStorage.getItem(PROCESSED_KEY);
    return processed === fingerprint;
  } catch {
    return false;
  }
}

/**
 * Mark files as processed
 */
function markFilesProcessed(fingerprint: string): void {
  try {
    sessionStorage.setItem(PROCESSED_KEY, fingerprint);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Initialize the file handler for PWA file associations.
 * This sets up a consumer for the launchQueue that processes
 * files passed to the app when opened via OS file associations.
 *
 * Should be called once on app initialization (e.g., in +layout.svelte onMount)
 */
export function initFileHandler(): void {
  if (!('launchQueue' in window)) {
    // File Handling API not supported (not a PWA or unsupported browser)
    return;
  }

  window.launchQueue?.setConsumer(async (launchParams) => {
    if (!launchParams.files || launchParams.files.length === 0) {
      return;
    }

    // Check if we've already processed these exact files (prevents re-import on refresh)
    const fingerprint = getFilesFingerprint(launchParams.files);
    if (hasProcessedFiles(fingerprint)) {
      return;
    }

    // Mark as processed immediately to prevent duplicates
    markFilesProcessed(fingerprint);

    // Small delay to ensure the app UI is ready
    await new Promise((resolve) => setTimeout(resolve, 100));

    showSnackbar(`Importing ${launchParams.files.length} file(s)...`, 3000);

    try {
      const files: File[] = [];

      for (const fileHandle of launchParams.files) {
        const file = await fileHandle.getFile();
        files.push(file);
      }

      if (files.length > 0) {
        await processFiles(files);
        showSnackbar('Import complete!', 3000);
      }
    } catch (error) {
      console.error('Error processing files from file handler:', error);
      showSnackbar('Failed to import file(s)', 3000);
    }
  });
}
