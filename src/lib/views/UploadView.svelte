<script lang="ts">
  import {
    describeImportOutcome,
    importFiles,
    htmlDownloadProvider,
    getUploadParamsFromLocation,
    parseHtmlDownloadRequest
  } from '$lib/import';
  import { db } from '$lib/catalog/db';
  import { installedUuids, pickCoverTarget } from '$lib/import/cover-sidecar';
  import { importDeepLinkedArchive, localSeriesKeys } from '$lib/import/deep-link-import';
  import { buildLinkImportPrompt, linkDisplayName } from '$lib/import/link-import-prompt';
  import { thumbnailCache } from '$lib/catalog/thumbnail-cache';
  import {
    confirmationPopupStore,
    normalizeFilename,
    promptConfirmationWith,
    showSnackbar
  } from '$lib/util';
  import { requestPersistentStorage } from '$lib/util/upload';
  import { nav } from '$lib/util/hash-router';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import { toRasterImageFile } from '$lib/util/raster-image';
  import { onDestroy, onMount } from 'svelte';

  const uploadParams = getUploadParamsFromLocation(window.location.search, window.location.hash);
  const request = parseHtmlDownloadRequest(uploadParams);

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
    installedBefore: Set<string>,
    requestVolume: string
  ): Promise<void> {
    const allVolumes = await db.volumes.toArray();
    const targetVolume = pickCoverTarget(allVolumes, installedBefore, requestVolume);

    if (!targetVolume) {
      console.warn(
        '[HTML Download] Cover sidecar downloaded but no newly imported volume was found'
      );
      return;
    }

    // Raster bytes only (SVG is unsupported: stored, it would run as the app
    // when opened in a new tab), typed by those bytes — never by the server.
    const cover = await toRasterImageFile(coverFile, coverFile.name);
    if (!cover) {
      console.warn('[HTML Download] Sidecar thumbnail is not a raster image; skipped');
      return;
    }

    // A file the browser cannot decode is no cover: leave the row without one,
    // so the thumbnail pass builds it from the first page instead.
    let dims: { width: number; height: number };
    try {
      dims = await getImageDimensions(cover);
    } catch (error) {
      console.warn('[HTML Download] Sidecar thumbnail is not a readable image; skipped', error);
      return;
    }

    await db.volumes.update(targetVolume.volume_uuid, {
      thumbnail: cover,
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

  /**
   * @param allowSeriesKey the existing series the user let this link's
   *   `series.json` update (the confirmation's box); none = no existing series.
   */
  async function onImport(allowSeriesKey?: string) {
    if (!request) return;

    // Request persistent storage now, within the confirmation click. The actual
    // import below runs only after an async network download, by which point the
    // user activation Firefox needs for its prompt is gone.
    void requestPersistentStorage();

    const normalizedVolume = normalizeFilename(request.volume);
    const processId = `cross-site-import-${Date.now()}`;
    const displayName = linkDisplayName(request) || normalizedVolume;

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

      // Installed uuids, not all uuids: an import that fills a metadata-only row
      // keeps that row's uuid, and it is one of this import's volumes.
      const installedBefore = installedUuids(await db.volumes.toArray());

      // For CBZ deep links, queue a pre-paired archive item so we don't rely on generic
      // post-download pairing for archive+sidecar combinations. A manifest's
      // series.json and OCR layers ride along (applied once the volume is saved).
      // What to report: "Complete" only for a volume that actually saved — an
      // image-only one may still be waiting for its review, or be skipped in it.
      let status: string;
      let message: string;
      if (downloaded.archiveFile && request.type === 'cbz') {
        // Resolves after the archive's own import, review included.
        const installed = await importDeepLinkedArchive(
          downloaded,
          normalizedVolume,
          installedBefore,
          { allowSeriesKey }
        );
        status = installed ? 'Complete' : 'Nothing imported';
        message = installed ? `Imported ${displayName}` : `Nothing imported from ${displayName}`;
      } else {
        // Directory mode and fallback paths still use generic import pairing.
        const result = await importFiles(files);
        const pending = result.awaitingReview > 0 || result.queued > 0;
        const done = !pending && result.success && result.imported > 0;
        status = done
          ? 'Complete'
          : result.awaitingReview > 0
            ? 'Waiting for review'
            : pending
              ? 'Queued'
              : 'Nothing imported';
        message = done ? `Imported ${displayName}` : describeImportOutcome(result);
      }

      if (downloaded.coverFile) {
        await applyDownloadedCoverSidecar(downloaded.coverFile, installedBefore, normalizedVolume);
      }

      progressTrackerStore.updateProcess(processId, { status, progress: 100 });

      showSnackbar(message);

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

  // Left the import page (another hash) with the question still open: the
  // question goes with it — an import nobody is looking at must not wait to be
  // confirmed over some other screen — and its "no" sends no one anywhere.
  let destroyed = false;
  // The existing series the prompt's box would let this link update, if it offered one.
  let seriesUpdateKey: string | undefined;
  const onConfirm = (allowSeriesUpdate?: boolean) =>
    onImport(seriesUpdateKey && allowSeriesUpdate ? seriesUpdateKey : undefined);

  function onCancel() {
    if (destroyed) return;
    nav.toCatalog({ replaceState: true });
  }

  onDestroy(() => {
    destroyed = true;
    confirmationPopupStore.update((popup) =>
      popup?.open && popup.onConfirm === onConfirm ? { ...popup, open: false } : popup
    );
  });

  onMount(async () => {
    if (!request) {
      showSnackbar('Invalid import URL - missing manga or volume parameter');
      onCancel();
      return;
    }
    // Nothing is fetched before the user answers: the prompt is built from the
    // link alone (and the library's own series names).
    let localSeries = new Set<string>();
    try {
      localSeries = await localSeriesKeys();
    } catch (error) {
      console.warn('[HTML Download] Could not read the library for the import prompt:', error);
    }
    if (destroyed) return;
    const prompt = buildLinkImportPrompt(request, localSeries);
    const { seriesUpdate, ...details } = prompt;
    seriesUpdateKey = seriesUpdate?.seriesKey;
    promptConfirmationWith({
      ...details,
      // Not remembered (no storageKey): every link is asked afresh, unticked.
      ...(seriesUpdate
        ? { checkboxOption: { label: seriesUpdate.label, defaultValue: false } }
        : {}),
      onConfirm,
      onCancel
    });
  });
</script>

<!-- This view redirects immediately, so minimal UI needed -->
<div class="flex h-[90svh] items-center justify-center">
  <p class="text-gray-500 dark:text-gray-400">Preparing import...</p>
</div>
