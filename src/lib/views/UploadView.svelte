<script lang="ts">
  import Loader from '$lib/components/Loader.svelte';
  import { getItems } from '$lib/upload';
  import { importFiles, IMAGE_EXTENSIONS } from '$lib/import';
  import { normalizeFilename, promptConfirmation, showSnackbar } from '$lib/util';
  import { nav } from '$lib/util/hash-router';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import { onMount } from 'svelte';

  // Use window.location.search for query params (works alongside hash routing)
  const searchParams = new window.URLSearchParams(window.location.search);
  const BASE_URL = searchParams.get('source') || 'https://mokuro.moe/manga';
  const manga = searchParams.get('manga');
  const volume = searchParams.get('volume');
  const url = `${BASE_URL}/${manga}/${volume}`;

  async function onImport() {
    const normalizedVolume = normalizeFilename(volume || '');
    const processId = `cross-site-import-${Date.now()}`;
    const displayName = decodeURIComponent(volume || normalizedVolume);

    // Navigate to catalog immediately
    nav.toCatalog({ replaceState: true });

    // Add to progress tracker
    progressTrackerStore.addProcess({
      id: processId,
      description: `Importing ${displayName}`,
      status: 'Fetching mokuro file...',
      progress: 0
    });

    try {
      const files: File[] = [];

      // Fetch mokuro file
      const mokuroRes = await fetch(url + '.mokuro', { cache: 'no-store' });
      if (!mokuroRes.ok) {
        throw new Error(`Failed to fetch mokuro file: ${mokuroRes.status}`);
      }
      const mokuroBlob = await mokuroRes.blob();
      const mokuroFile = new File([mokuroBlob], normalizedVolume + '.mokuro', {
        type: mokuroBlob.type
      });

      Object.defineProperty(mokuroFile, 'webkitRelativePath', {
        value: '/' + normalizedVolume + '.mokuro'
      });

      progressTrackerStore.updateProcess(processId, {
        status: 'Fetching image list...',
        progress: 5
      });

      // Fetch directory listing
      const res = await fetch(url + '/');
      if (!res.ok) {
        throw new Error(`Failed to fetch directory: ${res.status}`);
      }
      const html = await res.text();

      const items = getItems(html);

      // Filter to just images using shared IMAGE_EXTENSIONS
      const imageItems = items.filter((item) => {
        const ext = (item.pathname.split('.').at(-1) || '').toLowerCase();
        return IMAGE_EXTENSIONS.has(ext);
      });

      const totalImages = imageItems.length;
      let completed = 0;

      progressTrackerStore.updateProcess(processId, {
        status: `Downloading images (0/${totalImages})...`,
        progress: 10
      });

      // Download images
      for (const item of imageItems) {
        const image = await fetch(url + item.pathname);
        if (!image.ok) {
          console.warn(`Failed to fetch image: ${item.pathname}`);
          completed++;
          continue;
        }
        const blob = await image.blob();
        const normalizedPath = normalizeFilename(item.pathname);
        const file = new File([blob], normalizedPath.substring(1));
        Object.defineProperty(file, 'webkitRelativePath', {
          value: '/' + normalizedVolume + normalizedPath
        });

        files.push(file);
        completed++;

        // Update progress (10-90% range for downloads)
        const downloadProgress = 10 + Math.floor((completed / totalImages) * 80);
        progressTrackerStore.updateProcess(processId, {
          status: `Downloading images (${completed}/${totalImages})...`,
          progress: downloadProgress
        });
      }

      files.push(mokuroFile);

      progressTrackerStore.updateProcess(processId, {
        status: 'Adding to catalog...',
        progress: 95
      });

      // Process files using unified import
      await importFiles(files);

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
    if (!manga || !volume) {
      showSnackbar('Invalid import URL - missing manga or volume parameter');
      onCancel();
    } else {
      const displayName = decodeURIComponent(volume || '');
      promptConfirmation(`Import ${displayName} into catalog?`, onImport, onCancel);
    }
  });
</script>

<!-- This view redirects immediately, so minimal UI needed -->
<div class="flex h-[90svh] items-center justify-center">
  <p class="text-gray-500 dark:text-gray-400">Preparing import...</p>
</div>
