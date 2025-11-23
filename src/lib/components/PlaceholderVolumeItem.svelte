<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { ListgroupItem, Button, Spinner, Badge } from 'flowbite-svelte';
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
    | 'gray'
    | 'red'
    | 'yellow'
    | 'primary'
    | 'pink'
    | 'indigo';

  function getProviderBadgeColor(provider: ProviderType): BadgeColor {
    switch (provider) {
      case 'google-drive':
        return 'blue';
      case 'mega':
        return 'purple';
      case 'webdav':
        return 'green';
      default:
        return 'gray';
    }
  }

  const providerName = cloudProvider ? getProviderDisplayName(cloudProvider) : 'Cloud';
  const badgeColor = cloudProvider ? getProviderBadgeColor(cloudProvider) : 'gray';

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
  <div
    class="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-600 dark:border-gray-700"
  >
    <ListgroupItem class="py-4 opacity-70">
      <DownloadSolid class="mr-3 h-[70px] w-[50px] text-blue-400" />
      <div class="flex w-full flex-row items-center justify-between gap-5">
        <div>
          <p class="font-semibold text-gray-400">{volName}</p>
          <div class="flex items-center gap-2">
            <p class="text-sm text-gray-500">In Cloud • {sizeDisplay}</p>
            <Badge color={badgeColor} class="text-xs">{providerName}</Badge>
          </div>
        </div>
        <div class="flex items-center gap-2">
          {#if isDownloading}
            <Button color="light" disabled={true}>
              <Spinner size="4" class="me-2" />
              {Math.round(downloadProgress)}%
            </Button>
          {:else}
            <Button color="blue" onclick={onDownloadClicked}>
              <DownloadSolid class="me-2 h-4 w-4" />
              Download
            </Button>
            <Button color="red" onclick={onDeleteClicked}>
              <TrashBinSolid class="me-2 h-4 w-4" />
              Delete
            </Button>
          {/if}
        </div>
      </div>
    </ListgroupItem>
  </div>
{:else}
  <!-- Grid view -->
  <button
    onclick={onDownloadClicked}
    disabled={isDownloading}
    class="flex flex-col gap-2 rounded-lg p-3 opacity-60 transition-colors hover:bg-gray-100 sm:w-[278px] dark:hover:bg-gray-800"
    class:cursor-not-allowed={isDownloading}
  >
    <div
      class="flex items-center justify-center border border-dashed border-gray-400 bg-gray-200 sm:h-[350px] sm:w-[250px] dark:border-gray-600 dark:bg-gray-700"
    >
      {#if isDownloading}
        <div class="flex flex-col items-center gap-2">
          <Spinner size="8" color="blue" />
          <span class="text-xs text-blue-400">{Math.round(downloadProgress)}%</span>
        </div>
      {:else}
        <DownloadSolid class="h-8 w-8 text-gray-400" />
      {/if}
    </div>
    <div class="truncate text-sm font-medium">{volName}</div>
    <div class="flex flex-col gap-0.5 text-xs text-gray-500 dark:text-gray-400">
      <div class="flex items-center gap-1">
        <span>In {providerName}</span>
        <Badge color={badgeColor} class="px-1 py-0 text-xs">{providerName}</Badge>
      </div>
      <span>{sizeDisplay}</span>
    </div>
  </button>
{/if}
