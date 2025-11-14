<script lang="ts">
  import { progress } from '$lib/settings';
  import { DownloadSolid } from 'flowbite-svelte-icons';
  import { Spinner } from 'flowbite-svelte';
  import { showSnackbar } from '$lib/util';
  import { downloadQueue, queueSeriesVolumes } from '$lib/util/download-queue';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import type { VolumeMetadata } from '$lib/types';
  import { db } from '$lib/catalog/db';

  interface Props {
    series_uuid: string;
    volumes: VolumeMetadata[]; // Already sorted from parent
  }

  let { series_uuid, volumes }: Props = $props();

  // Get active provider's display name
  let providerDisplayName = $derived.by(() => {
    const provider = unifiedCloudManager.getActiveProvider();
    return provider?.name || 'Cloud';
  });

  // Sort volumes once alphabetically (reused by all derived)
  let sortedVolumes = $derived(
    volumes
      .slice()
      .sort((a, b) => a.volume_title.localeCompare(b.volume_title, undefined, { numeric: true, sensitivity: 'base' }))
  );

  let allSeriesVolumes = $derived(sortedVolumes);

  // Get local volumes (non-placeholders)
  let localVolumes = $derived(sortedVolumes.filter(v => !v.isPlaceholder));

  // Get unread volumes
  let unreadVolumes = $derived(
    localVolumes.filter(v =>
      ($progress?.[v.volume_uuid] || 1) < v.page_count - 1
    )
  );

  // Use unread if available, otherwise all local volumes
  let volumesToShow = $derived(unreadVolumes.length > 0 ? unreadVolumes : localVolumes);

  // Get up to 3 volumes for stacked thumbnail
  let stackedVolumes = $derived(volumesToShow.slice(0, 3));

  // First volume to display
  let volume = $derived(volumesToShow[0] ?? sortedVolumes[0]);

  // Check if series is complete (no unread volumes)
  let isComplete = $derived(unreadVolumes.length === 0);
  let isPlaceholderOnly = $derived(volume?.isPlaceholder === true);

  // Track queue state
  let queueState = $state($downloadQueue);
  $effect(() => {
    return downloadQueue.subscribe(value => {
      queueState = value;
    });
  });

  // Check if this series is downloading or queued
  let isDownloading = $derived.by(() => {
    if (!volume || !isPlaceholderOnly) return false;

    const seriesItems = queueState.filter(item => item.seriesTitle === volume.series_title);
    return seriesItems.length > 0;
  });

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

  // Store thumbnail dimensions and thumbnails themselves
  let thumbnailDimensions = $state<Map<string, { width: number; height: number }>>(new Map());
  let thumbnails = $state<Map<string, File>>(new Map());

  // Load thumbnails and dimensions from volumes_covers table
  $effect(() => {
    // Load all thumbnails asynchronously, updating state as each one loads
    const loadThumbnails = async () => {
      for (const vol of stackedVolumes) {
        // Load thumbnail from volumes_covers table
        const coverData = await db.volumes_covers.get(vol.volume_uuid);
        if (!coverData?.thumbnail) continue;

        // Create image to get dimensions
        const img = new Image();
        const imageUrl = URL.createObjectURL(coverData.thumbnail);

        // Wait for image to load to get dimensions
        await new Promise<void>((resolve) => {
          img.onload = () => {
            // Update state immediately for this thumbnail
            thumbnails = new Map(thumbnails).set(vol.volume_uuid, coverData.thumbnail);
            thumbnailDimensions = new Map(thumbnailDimensions).set(vol.volume_uuid, {
              width: img.naturalWidth,
              height: img.naturalHeight
            });
            URL.revokeObjectURL(imageUrl);
            resolve();
          };
          img.onerror = () => {
            URL.revokeObjectURL(imageUrl);
            resolve(); // Continue even if image fails to load
          };
          img.src = imageUrl;
        });
      }
    };

    loadThumbnails();
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
      .map(vol => {
        const dims = thumbnailDimensions.get(vol.volume_uuid);
        if (!dims) return null;

        const rendered = calculateRenderedDimensions(dims.width, dims.height);
        return {
          height: rendered.height,
          width: rendered.width,
          aspectRatio: rendered.width / rendered.height
        };
      })
      .filter(d => d !== null);

    if (renderedData.length === 0) {
      return {
        horizontal: horizontalStep,
        vertical: containerHeight * 0.11,
        topOffset: 0
      };
    }

    // Use the tallest rendered height
    const maxRenderedHeight = Math.max(...renderedData.map(d => d.height));

    // Calculate average aspect ratio
    const avgAspectRatio = renderedData.reduce((sum, d) => sum + d.aspectRatio, 0) / renderedData.length;

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
    const verticalStep = numVolumes > 1
      ? Math.max(0, (effectiveHeight - maxRenderedHeight) / (numVolumes - 1))
      : 0;

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
      class="flex flex-col gap-[5px] text-center items-center bg-slate-900 pb-1 bg-opacity-50 border border-slate-950 relative"
      class:cursor-pointer={isPlaceholderOnly}
    >
      {#if isPlaceholderOnly}
        <div class="sm:w-[325px] sm:h-[385px] bg-black border-gray-900 border flex items-center justify-center">
          <div class="w-24 h-24 flex items-center justify-center">
            {#if isDownloading}
              <Spinner size="16" color="blue" />
            {:else}
              <DownloadSolid class="w-24 h-24 text-blue-400" />
            {/if}
          </div>
        </div>
      {:else if stackedVolumes.length > 0}
        <!-- Stacked diagonal layout: dynamic stepping based on image aspect ratios -->
        <div class="relative sm:w-[325px] sm:h-[410px] sm:pt-4 sm:pb-6">
          <div class="relative sm:w-full sm:h-[385px] overflow-hidden">
            {#each stackedVolumes as vol, i (vol.volume_uuid)}
              {@const thumbnail = thumbnails.get(vol.volume_uuid)}
              {#if thumbnail}
                <img
                  src={URL.createObjectURL(thumbnail)}
                  alt={vol.volume_title}
                  class="absolute sm:max-w-[250px] sm:max-h-[360px] h-auto bg-black border-gray-900 border"
                  style="left: {i * stepSizes.horizontal}px; top: {stepSizes.topOffset + (i * stepSizes.vertical)}px; z-index: {stackedVolumes.length - i}; filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.5));"
                />
              {/if}
            {/each}
          </div>
        </div>
      {/if}
      <p class="font-semibold sm:w-[325px] line-clamp-1">
        {volume.series_title}
      </p>
      {#if isPlaceholderOnly}
        <p class="text-xs text-blue-400">In {providerDisplayName}</p>
      {/if}
    </div>
  </a>
{/if}
