<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { ListgroupItem, Spinner } from 'flowbite-svelte';
  import { progress } from '$lib/settings';
  import { volumes as catalogVolumes } from '$lib/catalog';
  import { DownloadSolid } from 'flowbite-svelte-icons';
  import { downloadQueue } from '$lib/util/download-queue';
  import { nav } from '$lib/util/hash-router';
  import { onDestroy } from 'svelte';
  const CATALOG_SCROLL_Y_KEY = 'mokuro:catalog:scroll-y';

  interface Props {
    volumes: VolumeMetadata[]; // Pre-computed by parent - avoids O(N) re-filtering
    providerName?: string; // Shared across all items - avoids repeated lookups
  }

  let { volumes, providerName = 'Cloud' }: Props = $props();

  // Volumes are pre-sorted by catalog store (natural sort)
  let sortedVolumes = $derived(volumes);

  let localVolumes = $derived(sortedVolumes.filter((v) => !v.isPlaceholder));

  let firstUnreadVolume = $derived(
    localVolumes.find((v) => ($progress?.[v.volume_uuid] || 1) < v.page_count - 1)
  );

  let firstVolume = $derived(sortedVolumes[0]);

  let volume = $derived(firstUnreadVolume ?? firstVolume);
  let liveVolume = $derived(volume ? ($catalogVolumes?.[volume.volume_uuid] ?? volume) : undefined);
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
  let thumbnailKey = $state<string | undefined>(undefined);

  function getThumbnailKey(volumeUuid: string, thumbnail?: File): string | undefined {
    if (!thumbnail) return undefined;
    return `${volumeUuid}:${thumbnail.name}:${thumbnail.size}:${thumbnail.lastModified}:${thumbnail.type}`;
  }

  $effect(() => {
    const nextKey = liveVolume
      ? getThumbnailKey(liveVolume.volume_uuid, liveVolume.thumbnail)
      : undefined;
    if (nextKey === thumbnailKey) {
      return;
    }

    if (thumbnailUrl) {
      URL.revokeObjectURL(thumbnailUrl);
      thumbnailUrl = undefined;
    }

    thumbnailKey = nextKey;
    if (!liveVolume?.thumbnail) return;
    thumbnailUrl = URL.createObjectURL(liveVolume.thumbnail);
  });

  onDestroy(() => {
    if (thumbnailUrl) {
      URL.revokeObjectURL(thumbnailUrl);
    }
  });

  // Use series title for navigation so grouping and routing align with user-visible identity.
  let navId = $derived(volume?.series_title || '');

  function persistCatalogScrollPosition() {
    const y =
      window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    sessionStorage.setItem(CATALOG_SCROLL_Y_KEY, String(y));
  }

  async function handleClick(e: MouseEvent) {
    e.preventDefault();
    persistCatalogScrollPosition();
    nav.toSeries(navId);
  }
</script>

{#if volume}
  <div class:opacity-70={isPlaceholderOnly}>
    <ListgroupItem>
      <a href="#/series/{encodeURIComponent(navId)}" class="h-full w-full" onclick={handleClick}>
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
          {:else}
            <div
              class="flex h-[70px] w-[50px] items-center justify-center border border-gray-300 bg-gray-200 text-[10px] text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
            >
              Cover
            </div>
          {/if}
        </div>
      </a>
    </ListgroupItem>
  </div>
{/if}
