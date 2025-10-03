<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { Frame, ListgroupItem, Button, Spinner } from 'flowbite-svelte';
  import { DownloadOutline } from 'flowbite-svelte-icons';
  import { progressTrackerStore } from '$lib/util/progress-tracker';

  interface Props {
    volume: VolumeMetadata;
  }

  let { volume }: Props = $props();

  const volName = $derived(decodeURI(volume.volume_title));
  const fileSizeDisplay = $derived(
    volume.driveSize ? `${(volume.driveSize / 1024 / 1024).toFixed(1)} MB` : 'Unknown size'
  );

  let isDownloading = $state(false);
  let downloadProgress = $state(0);
  let downloadStatus = $state('');

  // Track download progress from progress tracker
  let progressState = $state($progressTrackerStore);
  $effect(() => {
    return progressTrackerStore.subscribe(value => {
      progressState = value;
      const processId = `download-${volume.volume_uuid}`;
      const process = value.processes.find(p => p.id === processId);
      if (process) {
        isDownloading = true;
        downloadProgress = process.progress || 0;
        downloadStatus = process.status || '';
      } else {
        isDownloading = false;
      }
    });
  });

  async function handleDownload(e: MouseEvent) {
    e.stopPropagation();

    if (!volume.driveFileId) {
      console.error('No Drive file ID for placeholder volume');
      return;
    }

    // Import download function dynamically
    const { downloadVolumeFromDrive } = await import('$lib/util/download-from-drive');

    try {
      await downloadVolumeFromDrive(volume);
    } catch (error) {
      console.error('Download failed:', error);
    }
  }
</script>

<Frame rounded border class="divide-y divide-gray-200 dark:divide-gray-600">
  <ListgroupItem normalClass="py-4 opacity-60">
    <!-- Placeholder icon instead of thumbnail -->
    <div
      class="w-[50px] h-[70px] bg-gray-700 border-gray-600 border flex items-center justify-center"
      style="margin-right:10px;"
    >
      <DownloadOutline class="w-6 h-6 text-gray-400" />
    </div>

    <div class="flex flex-row gap-5 items-center justify-between w-full">
      <div>
        <p class="font-semibold text-gray-400">{volName}</p>
        <p class="text-sm text-gray-500">
          {#if isDownloading}
            Downloading... {downloadProgress}%
          {:else}
            Available in Drive • {fileSizeDisplay}
          {/if}
        </p>
      </div>

      <div class="flex gap-2 items-center">
        <Button
          color="light"
          size="xs"
          on:click={handleDownload}
          disabled={isDownloading}
        >
          {#if isDownloading}
            <Spinner size="4" class="me-2" />
            {downloadStatus || 'Downloading...'}
          {:else}
            <DownloadOutline class="w-4 h-4 me-2" />
            Download
          {/if}
        </Button>
      </div>
    </div>
  </ListgroupItem>
</Frame>
