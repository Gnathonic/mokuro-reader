<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { ListgroupItem, Spinner } from 'flowbite-svelte';
  import { progress } from '$lib/settings';
  import { volumes as catalogVolumes } from '$lib/catalog';
  import { DownloadSolid } from 'flowbite-svelte-icons';
  import { downloadQueue } from '$lib/util/download-queue';
  import { nav } from '$lib/util/hash-router';
  import { promptSeriesEditor } from '$lib/util/modals';
  import { shouldOpenSeriesEditor } from '$lib/util/series-editor-shortcut';
  import { anyModalOpen, shouldTriggerDelete } from '$lib/util/delete-shortcut';
  import { promptSeriesRemoval } from '$lib/catalog/series-delete';
  import { needsDownload } from '$lib/catalog/volume-state';
  import DownloadBadge from './DownloadBadge.svelte';
  import { onDestroy } from 'svelte';
  const CATALOG_SCROLL_Y_KEY = 'mokuro:catalog:scroll-y';

  interface Props {
    volumes: VolumeMetadata[]; // Pre-computed by parent - avoids O(N) re-filtering
    providerName?: string; // Shared across all items - avoids repeated lookups
    displayTitle?: string; // Pre-resolved by the catalog store; falls back to series_title
  }

  let { volumes, providerName = 'Cloud', displayTitle }: Props = $props();

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

  // Not one page of this series is on the device — cloud-only placeholders, rows whose
  // files were removed, or both (see $lib/catalog/volume-state).
  let seriesNeedsDownload = $derived(
    sortedVolumes.length > 0 && sortedVolumes.every(needsDownload)
  );

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
    const y = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    sessionStorage.setItem(CATALOG_SCROLL_Y_KEY, String(y));
  }

  async function handleClick(e: MouseEvent) {
    e.preventDefault();
    persistCatalogScrollPosition();
    nav.toSeries(navId);
  }

  // Hover + "e" opens the series editor for this card (mirrors CatalogItem / VolumeItem).
  let isHovered = $state(false);

  function handleKeydown(e: KeyboardEvent) {
    if (shouldOpenSeriesEditor(e, isHovered, document.activeElement)) {
      e.preventDefault();
      if (volume) promptSeriesEditor(volume.series_title);
      return;
    }
    // Hover + Delete raises the series page's own "Remove manga" dialog (see CatalogItem).
    if (!e.shiftKey && shouldTriggerDelete(e, isHovered, document.activeElement, anyModalOpen())) {
      e.preventDefault();
      void promptSeriesRemoval(sortedVolumes);
    }
  }

  $effect(() => {
    if (!isHovered) return;
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });
</script>

{#if volume}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class:opacity-70={isPlaceholderOnly}
    onmouseenter={() => (isHovered = true)}
    onmouseleave={() => (isHovered = false)}
  >
    <ListgroupItem>
      <a href="#/series/{encodeURIComponent(navId)}" class="h-full w-full" onclick={handleClick}>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <p class:text-green-400={isComplete} class="font-semibold">
              {displayTitle ?? volume.series_title}
            </p>
            {#if isPlaceholderOnly}
              <span class="text-xs text-blue-400">In {providerName}</span>
            {/if}
          </div>
          <!-- Wrapper exists only to anchor the badge; the cover keeps its own box. -->
          <div class="relative flex-shrink-0">
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
                class="h-[70px] w-[50px] border border-gray-300 bg-gray-100 object-contain dark:border-gray-900 dark:bg-black"
              />
            {:else}
              <div
                class="flex h-[70px] w-[50px] items-center justify-center border border-gray-300 bg-gray-200 text-[10px] text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
              >
                Cover
              </div>
            {/if}
            {#if seriesNeedsDownload && !isDownloading}
              <DownloadBadge size="sm" class="right-0.5 bottom-0.5" label="Not on this device" />
            {/if}
          </div>
        </div>
      </a>
    </ListgroupItem>
  </div>
{/if}
