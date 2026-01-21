/**
 * File scanning utilities for the upload/import system.
 *
 * NOTE: The main import logic has been moved to $lib/import.
 * This module only contains utilities for scanning files from the filesystem
 * and parsing web import HTML.
 */

export * from './web-import';

async function getFile(fileEntry: FileSystemFileEntry) {
  try {
    return new Promise<File>((resolve, reject) =>
      fileEntry.file((file) => {
        if (!file.webkitRelativePath) {
          Object.defineProperty(file, 'webkitRelativePath', {
            value: fileEntry.fullPath.substring(1)
          });
        }
        resolve(file);
      }, reject)
    );
  } catch (err) {
    console.log(err);
  }
}

/**
 * Recursively scans a FileSystemEntry (directory or file) and collects all files.
 * Used by GlobalDropZone and UploadModal for drag-and-drop and directory selection.
 */
export async function scanFiles(item: FileSystemEntry, files: Promise<File | undefined>[]) {
  if (item.isDirectory) {
    const directoryReader = (item as FileSystemDirectoryEntry).createReader();
    await new Promise<void>((resolve) => {
      function readEntries() {
        directoryReader.readEntries(async (entries) => {
          if (entries.length > 0) {
            for (const entry of entries) {
              if (entry.isFile) {
                files.push(getFile(entry as FileSystemFileEntry));
              } else {
                await scanFiles(entry, files);
              }
            }
            readEntries();
          } else {
            resolve();
          }
        });
      }

      readEntries();
    });
  }
}
