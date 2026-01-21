<script lang="ts">
  import { scanFiles } from '$lib/upload';
  import { importFiles } from '$lib/import';
  import { showSnackbar } from '$lib/util/snackbar';
  import {
    showImportPreparing,
    updateImportPreparing,
    closeImportPreparing
  } from '$lib/util/modals';

  let isDragging = $state(false);
  let dragCounter = 0; // Track enter/leave for nested elements
  let isImporting = false; // Prevent concurrent imports

  function handleDragEnter(event: DragEvent) {
    event.preventDefault();
    dragCounter++;

    // Check if dragging files
    if (event.dataTransfer?.types.includes('Files')) {
      isDragging = true;
    }
  }

  function handleDragLeave(event: DragEvent) {
    event.preventDefault();
    dragCounter--;

    if (dragCounter === 0) {
      isDragging = false;
    }
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDragging = false;
    dragCounter = 0;

    if (!event.dataTransfer?.items) {
      return;
    }

    // Prevent concurrent imports - ignore drops while one is in progress
    if (isImporting) {
      showSnackbar('Import already in progress', 2000);
      return;
    }

    isImporting = true;

    // Show preparing modal immediately
    showImportPreparing('scanning');

    // Collect all entries synchronously - DataTransfer is only valid during the event
    // Once we await, subsequent items may become inaccessible
    const directoryEntries: FileSystemEntry[] = [];
    const directFiles: File[] = [];

    for (const item of [...event.dataTransfer.items]) {
      if (item.kind !== 'file') continue;

      const entry = item.webkitGetAsEntry();
      if (!entry) continue;

      if (entry.isDirectory) {
        directoryEntries.push(entry);
      } else {
        const file = item.getAsFile();
        if (file) {
          directFiles.push(file);
        }
      }
    }

    // Update with direct files count
    if (directFiles.length > 0) {
      updateImportPreparing({ filesScanned: directFiles.length });
    }

    // Now process directories asynchronously (safe since we already have the entries)
    const filePromises: Promise<File | undefined>[] = [];
    for (const entry of directoryEntries) {
      await scanFiles(entry, filePromises);
      // Update count as we scan
      updateImportPreparing({ filesScanned: directFiles.length + filePromises.length });
    }

    // Combine direct files with scanned files
    const files: File[] = [...directFiles];
    if (filePromises.length > 0) {
      const scannedFiles = await Promise.all(filePromises);
      for (const file of scannedFiles) {
        if (file) files.push(file);
      }
    }

    if (files.length === 0) {
      closeImportPreparing();
      isImporting = false;
      showSnackbar('No supported files found', 3000);
      return;
    }

    // Move to analyzing phase
    updateImportPreparing({ phase: 'analyzing', totalFiles: files.length });

    try {
      // Import files with preparation callback
      await importFiles(files, {
        onPreparing: (volumesFound) => {
          updateImportPreparing({ phase: 'preparing', volumesFound });
        }
      });
    } catch (error) {
      console.error('Error processing dropped files:', error);
      showSnackbar('Failed to import files', 3000);
    } finally {
      closeImportPreparing();
      isImporting = false;
    }
  }
</script>

<svelte:document
  ondragenter={handleDragEnter}
  ondragleave={handleDragLeave}
  ondragover={handleDragOver}
  ondrop={handleDrop}
/>

{#if isDragging}
  <div
    class="fixed inset-0 z-[9999] flex items-center justify-center bg-gray-900/80 backdrop-blur-sm"
  >
    <div
      class="flex flex-col items-center gap-4 rounded-2xl border-4 border-dashed border-primary-500 bg-gray-800/90 p-12"
    >
      <svg class="h-16 w-16 text-primary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
        />
      </svg>
      <p class="text-xl font-semibold text-white">Drop files to import</p>
      <p class="text-sm text-gray-400">.cbz, .zip, or folders with manga</p>
    </div>
  </div>
{/if}
