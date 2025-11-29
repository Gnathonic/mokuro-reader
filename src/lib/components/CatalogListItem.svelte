<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { ListgroupItem, Spinner } from 'flowbite-svelte';
  import { progress } from '$lib/settings';
  import { DownloadSolid } from 'flowbite-svelte-icons';
  import { showSnackbar } from '$lib/util';
  import { downloadQueue, queueSeriesVolumes } from '$lib/util/download-queue';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { nav } from '$lib/util/hash-router';

  interface Props {
    series_uuid: string;
    volumes: VolumeMetadata[]; // Pre-computed by parent - avoids O(N) re-filtering
    providerName?: string; // Shared across all items - avoids repeated lookups
  }

  let { series_uuid, volumes, providerName = 'Cloud' }: Props = $props();

  // Volumes pre-filtered by parent, sort once
  let sortedVolumes = $derived(
    [...volumes].sort((a, b) => a.volume_title.localeCompare(b.volume_title))
  );

  let localVolumes = $derived(sortedVolumes.filter((v) => !v.isPlaceholder));

  let firstUnreadVolume = $derived(
    localVolumes.find((v) => ($progress?.[v.volume_uuid] || 1) < v.page_count - 1)
  );

  let firstVolume = $derived(sortedVolumes[0]);

  let volume = $derived(firstUnreadVolume ?? firstVolume);
  let isComplete = $derived(!firstUnreadVolume);
  let isPlaceholderOnly = $derived(volume?.isPlaceholder === true);

  // Track queue state
  let queueState = $state($downloadQueue);
  $effect(() => {
    return downloadQueue.subscribe((value) => {
      queueState = value;
    });
  });

  // Check if this series is downloading or queued
  let isDownloading = $derived.by(() => {
    if (!volume || !isPlaceholderOnly) return false;

    const status = downloadQueue.getSeriesQueueStatus(volume.series_title);
    return status.hasQueued || status.hasDownloading;
  });

  // Create blob URL from inline thumbnail
  let thumbnailUrl = $state<string | undefined>(undefined);
  $effect(() => {
    if (!volume?.thumbnail) {
      thumbnailUrl = undefined;
      return;
    }
    const url = URL.createObjectURL(volume.thumbnail);
    thumbnailUrl = url;
    return () => URL.revokeObjectURL(url);
  });

  async function handleClick(e: MouseEvent) {
    if (isPlaceholderOnly) {
      e.preventDefault();

      // Prevent re-clicking during download
      if (isDownloading) {
        return;
      }

      // Check if any cloud provider is authenticated
      const hasProvider = unifiedCloudManager.getActiveProvider() !== null;
      if (!hasProvider) {
        showSnackbar('Please sign in to a cloud storage provider first');
        return;
      }

      // Queue all series volumes for download
      queueSeriesVolumes(sortedVolumes);
    } else {
      e.preventDefault();
      nav.toSeries(series_uuid);
    }
  }
</script>

{#if volume}
  <div class:opacity-70={isPlaceholderOnly}>
    <ListgroupItem>
      <a href="#/series/{series_uuid}" class="h-full w-full" onclick={handleClick}>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <p class:text-green-400={isComplete} class="font-semibold">{volume.series_title}</p>
            {#if isPlaceholderOnly}
              <span class="text-xs text-blue-400">In {providerName}</span>
            {/if}
          </div>
          {#if isPlaceholderOnly}
            <div class="flex h-[70px] w-[50px] items-center justify-center">
              {#if isDownloading}
                <Spinner size="12" color="blue" />
              {:else}
                <DownloadSolid class="h-[70px] w-[50px] text-blue-400" />
              {/if}
            </div>
          {:else if thumbnailUrl}
            <img
              src={thumbnailUrl}
              alt="img"
              class="h-[70px] w-[50px] border border-gray-900 bg-black object-contain"
            />
          {/if}
        </div>
      </a>
    </ListgroupItem>
  </div>
{/if}
