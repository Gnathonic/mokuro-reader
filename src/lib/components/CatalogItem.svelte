<script lang="ts">
  import { volumesWithPlaceholders } from '$lib/catalog';
  import { progress } from '$lib/settings';
  import { DownloadSolid } from 'flowbite-svelte-icons';
  import { Spinner } from 'flowbite-svelte';
  import { showSnackbar } from '$lib/util';
  import { downloadQueue, queueSeriesVolumes } from '$lib/util/download-queue';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';

  interface Props {
    series_uuid: string;
  }

  let { series_uuid }: Props = $props();

  // Get active provider's display name
  let providerDisplayName = $derived.by(() => {
    const provider = unifiedCloudManager.getActiveProvider();
    return provider?.name || 'Cloud';
  });

  // ========================================
  // OPTIMIZED: Single source - filter to this series once, sort once
  // ========================================
  let seriesVolumes = $derived(
    Object.values($volumesWithPlaceholders)
      .filter((v) => v.series_uuid === series_uuid)
      .sort((a, b) => a.volume_title.localeCompare(b.volume_title))
  );

  // Split into local vs cloud placeholders
  let localVolumes = $derived(seriesVolumes.filter((v) => !v.isPlaceholder));
  let hasLocalVolumes = $derived(localVolumes.length > 0);

  // Find unread volumes (only among local volumes)
  let unreadVolumes = $derived(
    localVolumes.filter((v) => ($progress?.[v.volume_uuid] || 1) < v.page_count - 1)
  );

  // Display volume: first unread, or first local, or first placeholder
  let volume = $derived(unreadVolumes[0] ?? localVolumes[0] ?? seriesVolumes[0]);

  // UI state flags
  let isComplete = $derived(unreadVolumes.length === 0 && hasLocalVolumes);
  let isPlaceholderOnly = $derived(!hasLocalVolumes);

  // Get up to 3 volumes for stacked thumbnail (unread if any, otherwise all local)
  let stackedVolumes = $derived(
    (unreadVolumes.length > 0 ? unreadVolumes : localVolumes).slice(0, 3)
  );

  // Keep allSeriesVolumes for handleClick function
  let allSeriesVolumes = $derived(seriesVolumes);

  // Check if this series is downloading or queued
  let isDownloading = $derived(
    isPlaceholderOnly && volume
      ? $downloadQueue.some((item) => item.seriesTitle === volume.series_title)
      : false
  );

  // Calculate rendered dimensions for an image given max constraints
  function calculateRenderedDimensions(naturalWidth: number, naturalHeight: number) {
    const maxW = 250;
    const maxH = 360;

    // Calculate scale factors needed to fit within constraints
    const scaleW = maxW / naturalWidth;
    const scaleH = maxH / naturalHeight;

    // Use the smaller scale factor (more restrictive constraint)
    // Don't scale up (max scale = 1)
    const scale = Math.min(scaleW, scaleH, 1);

    return {
      width: naturalWidth * scale,
      height: naturalHeight * scale
    };
  }

  // Store thumbnail dimensions
  let thumbnailDimensions = $state<Map<string, { width: number; height: number }>>(new Map());

  // Load thumbnail dimensions
  $effect(() => {
    const newDimensions = new Map<string, { width: number; height: number }>();
    const urlsToRevoke: string[] = [];

    const promises = stackedVolumes.map((vol) => {
      if (!vol.thumbnail) return Promise.resolve();

      return new Promise<void>((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(vol.thumbnail!);
        urlsToRevoke.push(url);

        img.onload = () => {
          newDimensions.set(vol.volume_uuid, {
            width: img.naturalWidth,
            height: img.naturalHeight
          });
          resolve();
        };
        img.onerror = () => resolve(); // Skip on error
        img.src = url;
      });
    });

    Promise.all(promises).then(() => {
      thumbnailDimensions = newDimensions;
    });

    // Cleanup: revoke all blob URLs when effect is destroyed
    return () => {
      urlsToRevoke.forEach((url) => URL.revokeObjectURL(url));
    };
  });

  // Calculate dynamic step sizes based on actual image dimensions
  let stepSizes = $derived.by(() => {
    const containerWidth = 325;
    const containerHeight = 385;

    // Default horizontal step (11% of width)
    const horizontalStep = containerWidth * 0.11;

    // Calculate vertical step to fill height exactly
    if (stackedVolumes.length === 0 || thumbnailDimensions.size === 0) {
      // Fallback to default 11%
      return {
        horizontal: horizontalStep,
        vertical: containerHeight * 0.11,
        topOffset: 0
      };
    }

    // Calculate rendered dimensions and aspect ratios for all volumes
    const renderedData = stackedVolumes
      .map((vol) => {
        const dims = thumbnailDimensions.get(vol.volume_uuid);
        if (!dims) return null;

        const rendered = calculateRenderedDimensions(dims.width, dims.height);
        return {
          height: rendered.height,
          width: rendered.width,
          aspectRatio: rendered.width / rendered.height
        };
      })
      .filter((d) => d !== null);

    if (renderedData.length === 0) {
      return {
        horizontal: horizontalStep,
        vertical: containerHeight * 0.11,
        topOffset: 0
      };
    }

    // Use the tallest rendered height
    const maxRenderedHeight = Math.max(...renderedData.map((d) => d.height));

    // Calculate average aspect ratio
    const avgAspectRatio =
      renderedData.reduce((sum, d) => sum + d.aspectRatio, 0) / renderedData.length;

    // Preferred aspect ratio for manga (250:350)
    const preferredAspect = 250 / 350; // 0.714

    // Apply height penalty for squat images
    let effectiveHeight = containerHeight;
    if (avgAspectRatio > preferredAspect) {
      // How much squatter than preferred (0 = perfect, higher = more squat)
      const excessAspect = avgAspectRatio - preferredAspect;

      // Gentle penalty: ~100px per 1.0 excess aspect (so square gets ~28.6px penalty)
      // Capped at 60px to still favor filling
      const penalty = Math.min(excessAspect * 100, 60);

      effectiveHeight = containerHeight - penalty;
    }

    // Calculate step size using effective height: (effectiveHeight - maxHeight) / (numVolumes - 1)
    const numVolumes = stackedVolumes.length;
    const verticalStep =
      numVolumes > 1 ? Math.max(0, (effectiveHeight - maxRenderedHeight) / (numVolumes - 1)) : 0;

    // Center the stack: unused space is split equally top/bottom
    const unusedSpace = containerHeight - effectiveHeight;
    const topOffset = unusedSpace / 2;

    return {
      horizontal: horizontalStep,
      vertical: verticalStep,
      topOffset
    };
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
      queueSeriesVolumes(allSeriesVolumes);
    }
  }
</script>

{#if volume}
  <a href={series_uuid} onclick={handleClick}>
    <div
      class:text-green-400={isComplete}
      class:opacity-70={isPlaceholderOnly}
      class="bg-opacity-50 relative flex flex-col items-center gap-[5px] border border-slate-950 bg-slate-900 pb-1 text-center"
      class:cursor-pointer={isPlaceholderOnly}
    >
      {#if isPlaceholderOnly}
        <div
          class="flex items-center justify-center border border-gray-900 bg-black sm:h-[385px] sm:w-[325px]"
        >
          <div class="flex h-24 w-24 items-center justify-center">
            {#if isDownloading}
              <Spinner size="16" color="blue" />
            {:else}
              <DownloadSolid class="h-24 w-24 text-blue-400" />
            {/if}
          </div>
        </div>
      {:else if stackedVolumes.length > 0}
        <!-- Stacked diagonal layout: dynamic stepping based on image aspect ratios -->
        <div class="relative sm:h-[410px] sm:w-[325px] sm:pt-4 sm:pb-6">
          <div class="relative overflow-hidden sm:h-[385px] sm:w-full">
            {#each stackedVolumes as vol, i (vol.volume_uuid)}
              {#if vol.thumbnail}
                <img
                  src={URL.createObjectURL(vol.thumbnail)}
                  alt={vol.volume_title}
                  class="absolute h-auto border border-gray-900 bg-black sm:max-h-[360px] sm:max-w-[250px]"
                  style="left: {i * stepSizes.horizontal}px; top: {stepSizes.topOffset +
                    i * stepSizes.vertical}px; z-index: {stackedVolumes.length -
                    i}; filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.5));"
                />
              {/if}
            {/each}
          </div>
        </div>
      {/if}
      <p class="line-clamp-1 font-semibold sm:w-[325px]">
        {volume.series_title}
      </p>
      {#if isPlaceholderOnly}
        <p class="text-xs text-blue-400">In {providerDisplayName}</p>
      {/if}
    </div>
  </a>
{/if}
