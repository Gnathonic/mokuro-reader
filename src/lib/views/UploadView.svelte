<script lang="ts">
  import {
    importFiles,
    importArchiveWithOptionalMokuro,
    htmlDownloadProvider,
    getUploadParamsFromLocation,
    parseHtmlDownloadRequest
  } from '$lib/import';
  import { db } from '$lib/catalog/db';
  import { thumbnailCache } from '$lib/catalog/thumbnail-cache';
  import { normalizeFilename, promptConfirmation, showSnackbar } from '$lib/util';
  import { nav } from '$lib/util/hash-router';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import { onMount } from 'svelte';

  const uploadParams = getUploadParamsFromLocation(window.location.search, window.location.hash);
  const request = parseHtmlDownloadRequest(uploadParams);

  function normalizeTitle(value: string): string {
    return normalizeFilename(value).trim().toLowerCase();
  }

  async function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = () => {
        const width = img.naturalWidth || 1;
        const height = img.naturalHeight || 1;
        URL.revokeObjectURL(url);
        resolve({ width, height });
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to decode sidecar thumbnail'));
      };

      img.src = url;
    });
  }

  async function applyDownloadedCoverSidecar(
    coverFile: File,
    existingUuids: Set<string>,
    requestVolume: string
  ): Promise<void> {
    const allVolumes = await db.volumes.toArray();
    const importedVolumes = allVolumes.filter((volume) => !existingUuids.has(volume.volume_uuid));

    if (importedVolumes.length === 0) {
      console.warn('[HTML Download] Cover sidecar downloaded but no newly imported volume was found');
      return;
    }

    const normalizedRequestVolume = normalizeTitle(requestVolume);
    const targetVolume =
      importedVolumes.find((volume) => normalizeTitle(volume.volume_title) === normalizedRequestVolume) ||
      importedVolumes.find((volume) => normalizeTitle(volume.volume_uuid) === normalizedRequestVolume) ||
      importedVolumes[0];

    let dims = { width: 1, height: 1 };
    try {
      dims = await getImageDimensions(coverFile);
    } catch (error) {
      console.warn('[HTML Download] Failed to read sidecar dimensions; using fallback dimensions', error);
    }

    await db.volumes.update(targetVolume.volume_uuid, {
      thumbnail: coverFile,
      thumbnail_width: dims.width,
      thumbnail_height: dims.height
    });
    thumbnailCache.invalidate(targetVolume.volume_uuid);

    console.log(
      '[HTML Download] Applied sidecar thumbnail to imported volume:',
      targetVolume.volume_title,
      targetVolume.volume_uuid
    );
  }

  async function onImport() {
    if (!request) return;

    const normalizedVolume = normalizeFilename(request.volume);
    const processId = `cross-site-import-${Date.now()}`;
    const displayName = decodeURIComponent(request.volume || normalizedVolume);

    // Navigate to catalog immediately
    nav.toCatalog({ replaceState: true });

    // Add to progress tracker
    progressTrackerStore.addProcess({
      id: processId,
      description: `Importing ${displayName}`,
      status: request.type === 'cbz' ? 'Fetching volume archive...' : 'Fetching source files...',
      progress: 0
    });

    try {
      const downloaded = await htmlDownloadProvider.download(request, (state) => {
        progressTrackerStore.updateProcess(processId, {
          status: state.status,
          progress: state.progress
        });
      });
      const files = downloaded.importFiles;

      if (files.length === 0) {
        throw new Error('No importable files found at source URL');
      }

      progressTrackerStore.updateProcess(processId, {
        status: 'Adding to catalog...',
        progress: 95
      });

      const existingUuids = new Set((await db.volumes.toArray()).map((volume) => volume.volume_uuid));

      // For CBZ deep links, queue a pre-paired archive item so we don't rely on generic
      // post-download pairing for archive+sidecar combinations.
      if (downloaded.archiveFile && request.type === 'cbz') {
        await importArchiveWithOptionalMokuro(downloaded.archiveFile, downloaded.mokuroFile);
      } else {
        // Directory mode and fallback paths still use generic import pairing.
        await importFiles(files);
      }

      if (downloaded.coverFile) {
        await applyDownloadedCoverSidecar(downloaded.coverFile, existingUuids, normalizedVolume);
      }

      progressTrackerStore.updateProcess(processId, {
        status: 'Complete',
        progress: 100
      });

      showSnackbar(`Imported ${displayName}`);

      // Remove from tracker after a short delay
      setTimeout(() => {
        progressTrackerStore.removeProcess(processId);
      }, 2000);
    } catch (error) {
      console.error('Cross-site import failed:', error);
      progressTrackerStore.updateProcess(processId, {
        status: `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        progress: 0
      });
      showSnackbar(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

      // Remove failed process after delay
      setTimeout(() => {
        progressTrackerStore.removeProcess(processId);
      }, 5000);
    }
  }

  function onCancel() {
    nav.toCatalog({ replaceState: true });
  }

  onMount(() => {
    if (!request) {
      showSnackbar('Invalid import URL - missing manga or volume parameter');
      onCancel();
    } else {
      const displayName = decodeURIComponent(request.volume || '');
      promptConfirmation(`Import ${displayName} into catalog?`, onImport, onCancel);
    }
  });
</script>

<!-- This view redirects immediately, so minimal UI needed -->
<div class="flex h-[90svh] items-center justify-center">
  <p class="text-gray-500 dark:text-gray-400">Preparing import...</p>
</div>
