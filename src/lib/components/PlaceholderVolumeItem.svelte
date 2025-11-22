<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { Frame, ListgroupItem, Button, Spinner, Badge } from 'flowbite-svelte';
  import { DownloadSolid, TrashBinSolid } from 'flowbite-svelte-icons';
  import { downloadQueue } from '$lib/util/download-queue';
  import { progressTrackerStore } from '$lib/util/progress-tracker';
  import { showSnackbar, promptConfirmation } from '$lib/util';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import {
    getCloudFileId,
    getCloudProvider,
    getCloudSize,
    getCloudModifiedTime
  } from '$lib/util/cloud-fields';
  import type { ProviderType, CloudFileMetadata } from '$lib/util/sync/provider-interface';

  interface Props {
    volume: VolumeMetadata;
    variant?: 'list' | 'grid';
  }

  let { volume, variant = 'list' }: Props = $props();

  const volName = decodeURI(volume.volume_title);

  // Get cloud metadata using helpers
  const cloudFileId = getCloudFileId(volume);
  const cloudProvider = getCloudProvider(volume);
  const cloudSize = getCloudSize(volume);

  // Format file size
  let sizeDisplay = $derived.by(() => {
    if (!cloudSize) return 'Unknown size';
    const mb = (cloudSize / (1024 * 1024)).toFixed(1);
    return `${mb} MB`;
  });

  // Provider display helpers
  function getProviderDisplayName(provider: ProviderType): string {
    switch (provider) {
      case 'google-drive':
        return 'Drive';
      case 'mega':
        return 'MEGA';
      case 'webdav':
        return 'WebDAV';
      default:
        return 'Cloud';
    }
  }

  type BadgeColor =
    | 'blue'
    | 'purple'
    | 'green'
    | 'dark'
    | 'red'
    | 'yellow'
    | 'primary'
    | 'pink'
    | 'indigo'
    | 'none';

  function getProviderBadgeColor(provider: ProviderType): BadgeColor {
    switch (provider) {
      case 'google-drive':
        return 'blue';
      case 'mega':
        return 'purple';
      case 'webdav':
        return 'green';
      default:
        return 'dark';
    }
  }

  const providerName = cloudProvider ? getProviderDisplayName(cloudProvider) : 'Cloud';
  const badgeColor = cloudProvider ? getProviderBadgeColor(cloudProvider) : 'dark';

  // Track queue state
  let queueState = $state($downloadQueue);
  $effect(() => {
    return downloadQueue.subscribe((value) => {
      queueState = value;
    });
  });

  // Track progress from progress tracker (for active downloads)
  let progressState = $state($progressTrackerStore);
  $effect(() => {
    return progressTrackerStore.subscribe((value) => {
      progressState = value;
    });
  });

  let processId = $derived(`download-${cloudFileId}`);
  let downloadProcess = $derived.by(() => {
    return progressState.processes.find((p) => p.id === processId);
  });

  // Check both queue and active download states
  let isQueued = $derived(queueState.some((item) => item.volumeUuid === volume.volume_uuid));
  let isActivelyDownloading = $derived(!!downloadProcess);
  let isDownloading = $derived(isQueued || isActivelyDownloading);
  let downloadProgress = $derived(downloadProcess?.progress || 0);
  let downloadStatus = $derived(downloadProcess?.status || '');

  function onDownloadClicked(e: Event) {
    e.stopPropagation();
    downloadQueue.queueVolume(volume);
  }

  async function onDeleteClicked(e: Event) {
    e.stopPropagation();

    promptConfirmation(`Delete ${volName} from ${providerName}?`, async () => {
      try {
        if (!cloudFileId || !cloudProvider) {
          throw new Error('No cloud file metadata');
        }

        // Construct CloudFileMetadata object from volume fields
        const cloudFile: CloudFileMetadata = {
          provider: cloudProvider,
          fileId: cloudFileId,
          path: `${volume.series_title}/${volume.volume_title}`,
          modifiedTime: getCloudModifiedTime(volume) || new Date().toISOString(),
          size: cloudSize || 0
        };

        await unifiedCloudManager.deleteFile(cloudFile);
        showSnackbar(`Deleted ${volName} from ${providerName}`);
      } catch (error) {
        console.error(`Failed to delete from ${providerName}:`, error);
        showSnackbar(
          `Failed to delete: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });
  }
</script>

{#if variant === 'list'}
  <Frame rounded border class="divide-y divide-gray-200 dark:divide-gray-600">
    <ListgroupItem normalClass="py-4 opacity-70">
      <DownloadSolid class="w-[50px] h-[70px] text-blue-400 mr-3" />
      <div class="flex flex-row gap-5 items-center justify-between w-full">
        <div>
          <p class="font-semibold text-gray-400">{volName}</p>
          <div class="flex items-center gap-2">
            <p class="text-sm text-gray-500">In Cloud • {sizeDisplay}</p>
            <Badge color={badgeColor} class="text-xs">{providerName}</Badge>
          </div>
        </div>
        <div class="flex gap-2 items-center">
          {#if isDownloading}
            <Button color="light" disabled={true}>
              <Spinner size="4" class="me-2" />
              {Math.round(downloadProgress)}%
            </Button>
          {:else}
            <Button color="blue" onclick={onDownloadClicked}>
              <DownloadSolid class="w-4 h-4 me-2" />
              Download
            </Button>
            <Button color="red" onclick={onDeleteClicked}>
              <TrashBinSolid class="w-4 h-4 me-2" />
              Delete
            </Button>
          {/if}
        </div>
      </div>
    </ListgroupItem>
  </Frame>
{:else}
  <!-- Grid view -->
  <button
    onclick={onDownloadClicked}
    disabled={isDownloading}
    class="flex flex-col gap-2 p-3 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors opacity-60 sm:w-[278px]"
    class:cursor-not-allowed={isDownloading}
  >
    <div
      class="sm:w-[250px] sm:h-[350px] bg-gray-200 dark:bg-gray-700 border border-dashed border-gray-400 dark:border-gray-600 flex items-center justify-center"
    >
      {#if isDownloading}
        <div class="flex flex-col items-center gap-2">
          <Spinner size="8" color="blue" />
          <span class="text-xs text-blue-400">{Math.round(downloadProgress)}%</span>
        </div>
      {:else}
        <DownloadSolid class="w-8 h-8 text-gray-400" />
      {/if}
    </div>
    <div class="text-sm font-medium truncate">{volName}</div>
    <div class="text-xs text-gray-500 dark:text-gray-400 flex flex-col gap-0.5">
      <div class="flex items-center gap-1">
        <span>In {providerName}</span>
        <Badge color={badgeColor} class="text-xs px-1 py-0">{providerName}</Badge>
      </div>
      <span>{sizeDisplay}</span>
    </div>
  </button>
{/if}
