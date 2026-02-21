<script lang="ts">
  import type { VolumeMetadata } from '$lib/types';
  import { progress, catalogSettings } from '$lib/settings';
  import { downloadQueue } from '$lib/util/download-queue';
  import { nav } from '$lib/util/hash-router';
  import { Spinner } from 'flowbite-svelte';
  import { DownloadSolid } from 'flowbite-svelte-icons';
  import CompositeCanvas from './CompositeCanvas.svelte';
  import {
    fetchCloudThumbnail,
    getCachedCloudThumbnail,
    type CloudThumbnailResult
  } from '$lib/catalog/cloud-thumbnails';
  const CATALOG_SCROLL_Y_KEY = 'mokuro:catalog:scroll-y';

  interface Props {
    series_uuid: string;
    volumes: VolumeMetadata[]; // Pre-computed by parent - avoids O(N) re-filtering
    providerName?: string; // Shared across all items - avoids repeated lookups
  }

  let { series_uuid, volumes, providerName = 'Cloud' }: Props = $props();

  // Volumes are pre-sorted by catalog store (natural sort)
  let seriesVolumes = $derived(volumes);

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

  // Enrich cloud placeholders with fetched thumbnail data so they render via CompositeCanvas.
  // Includes ALL target volumes (not just those with loaded thumbnails) so that
  // stackedVolumes.length is stable. CompositeCanvas skips volumes without thumbnail,
  // so positions are pre-allocated: each thumbnail pops into its fixed slot without
  // shifting existing ones.
  let enrichedPlaceholders = $derived.by(() => {
    if (!isPlaceholderOnly) return [];
    return seriesVolumes.map((vol) => {
      const ct = cloudThumbnailData[vol.volume_uuid];
      if (ct) {
        return {
          ...vol,
          thumbnail: ct.file,
          thumbnail_width: ct.width,
          thumbnail_height: ct.height
        };
      }
      return vol;
    });
  });

  // Cap for cloud thumbnail stacks to limit memory and network usage.
  // Each decoded bitmap uses ~360KB (250×360×4 RGBA). The cache limit is 100MB.
  // Without a cap, large series (100+ volumes) cause constant cache eviction/re-decode loops.
  const MAX_CLOUD_STACK = 25;

  // Get volumes for stacked thumbnail based on settings
  let stackedVolumes = $derived.by(() => {
    const hideRead = $catalogSettings?.hideReadVolumes ?? true;
    const stackCount = $catalogSettings?.stackCount ?? 3;

    if (hasLocalVolumes) {
      // Local path: existing behavior
      const sourceVolumes = hideRead && unreadVolumes.length > 0 ? unreadVolumes : localVolumes;
      return stackCount === 0 ? sourceVolumes : sourceVolumes.slice(0, stackCount);
    }

    // Cloud path: use enriched placeholders, capped to prevent cache thrashing
    if (useCompactForCloud) {
      return enrichedPlaceholders.slice(0, 1);
    }
    const limit = stackCount === 0 ? MAX_CLOUD_STACK : Math.min(stackCount, MAX_CLOUD_STACK);
    return enrichedPlaceholders.slice(0, limit);
  });

  // Key for CompositeCanvas - forces fresh component on settings change
  let compositeKey = $derived(
    `${$catalogSettings?.stackCount ?? 3}-${$catalogSettings?.horizontalStep ?? 11}-${$catalogSettings?.verticalStep ?? 5}-${($catalogSettings?.compactCloudSeries ?? false) ? 'compact' : 'full'}`
  );

  // Check if this series is downloading or queued
  let isDownloading = $derived(
    isPlaceholderOnly && volume
      ? $downloadQueue.some((item) => item.seriesTitle === volume.series_title)
      : false
  );

  // Cloud thumbnail data keyed by volume_uuid (File objects, no blob URLs needed)
  let cloudThumbnailData: Record<string, CloudThumbnailResult> = $state({});

  // Base thumbnail dimensions
  const BASE_WIDTH = 250;
  const BASE_HEIGHT = 360;
  const OUTER_PADDING = 25; // pt-4 pb-6 ≈ 25px

  // Get dimensions from volume metadata, with fallback to defaults
  let thumbnailDimensions = $derived.by(() => {
    const dims = new Map<string, { width: number; height: number }>();
    for (const vol of stackedVolumes) {
      if (vol.thumbnail_width && vol.thumbnail_height) {
        dims.set(vol.volume_uuid, {
          width: vol.thumbnail_width,
          height: vol.thumbnail_height
        });
      } else if (vol.thumbnail) {
        // Fallback to default aspect ratio for volumes without stored dimensions
        dims.set(vol.volume_uuid, {
          width: BASE_WIDTH,
          height: BASE_HEIGHT
        });
      }
    }
    return dims;
  });

  // Local series can briefly have no usable thumbnail while generation catches up.
  // In that window, render a stable placeholder stack instead of a blank canvas.
  let hasRenderableThumbnails = $derived(thumbnailDimensions.size > 0);

  // Check if cloud series should use compact layout
  let useCompactForCloud = $derived(
    isPlaceholderOnly && ($catalogSettings?.compactCloudSeries ?? false)
  );

  // Calculate rendered dimensions for an image given max constraints
  function getRenderedDimensions(naturalWidth: number, naturalHeight: number) {
    const scaleW = BASE_WIDTH / naturalWidth;
    const scaleH = BASE_HEIGHT / naturalHeight;
    const scale = Math.min(scaleW, scaleH, 1);
    return {
      width: naturalWidth * scale,
      height: naturalHeight * scale
    };
  }

  // Calculate uniform height when vertical offset is 0 or stack count is 0 (spine mode)
  let uniformHeight = $derived.by(() => {
    const vOffsetPercent = $catalogSettings?.verticalStep ?? 5;
    const stackCountSetting = $catalogSettings?.stackCount ?? 3;
    // Force uniform height when stack count is 0 (all volumes) or v.offset is 0
    if ((vOffsetPercent !== 0 && stackCountSetting !== 0) || thumbnailDimensions.size === 0)
      return null;

    // Calculate average rendered height
    let totalHeight = 0;
    let count = 0;
    for (const vol of stackedVolumes) {
      const dims = thumbnailDimensions.get(vol.volume_uuid);
      if (dims) {
        const rendered = getRenderedDimensions(dims.width, dims.height);
        totalHeight += rendered.height;
        count++;
      }
    }

    return count > 0 ? totalHeight / count : BASE_HEIGHT;
  });

  // Get the rendered width of the top (first) volume - defines the left edge of the stack
  // Wider volumes underneath will be clipped by overflow-hidden
  let topVolumeWidth = $derived.by(() => {
    if (stackedVolumes.length === 0) return BASE_WIDTH;

    const topVol = stackedVolumes[0];
    const dims = thumbnailDimensions.get(topVol.volume_uuid);
    if (!dims) return BASE_WIDTH;

    if (uniformHeight !== null) {
      // Uniform height mode: width from aspect ratio (capped at BASE_WIDTH)
      const aspectRatio = dims.width / dims.height;
      return Math.min(uniformHeight * aspectRatio, BASE_WIDTH);
    } else {
      // Normal mode: contain within max bounds
      return getRenderedDimensions(dims.width, dims.height).width;
    }
  });

  // Calculate container dimensions based on settings
  let containerDimensions = $derived.by(() => {
    // Use compact settings for cloud series if enabled
    if (useCompactForCloud) {
      return {
        innerWidth: BASE_WIDTH,
        innerHeight: BASE_HEIGHT,
        outerWidth: BASE_WIDTH,
        outerHeight: BASE_HEIGHT + OUTER_PADDING
      };
    }

    const stackCountSetting = $catalogSettings?.stackCount ?? 3;
    const hOffsetPercent = ($catalogSettings?.horizontalStep ?? 11) / 100;
    // Force vertical offset to 0 when stack count is 0 (all volumes / spine mode)
    const vOffsetPercent =
      stackCountSetting === 0 ? 0 : ($catalogSettings?.verticalStep ?? 5) / 100;

    // stackedVolumes.length is now always the target count (stable for both local and cloud)
    const volumeCount = stackedVolumes.length;
    const effectiveStackCount = stackCountSetting === 0 ? volumeCount : stackCountSetting;

    // topVolumeWidth falls back to BASE_WIDTH when no thumbnail dimensions are available yet
    const baseWidth = topVolumeWidth;

    // Extra space needed for stacking: offset% × base × (count - 1)
    const extraWidth = BASE_WIDTH * hOffsetPercent * (effectiveStackCount - 1);
    const extraHeight = BASE_HEIGHT * vOffsetPercent * (effectiveStackCount - 1);

    // Inner container (thumbnail area)
    const innerWidth = Math.round(baseWidth + extraWidth);
    const innerHeight = Math.round(BASE_HEIGHT + extraHeight);

    // Outer container (with padding)
    const outerWidth = innerWidth;
    const outerHeight = innerHeight + OUTER_PADDING;

    return {
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight
    };
  });

  // Calculate canvas dimensions for a volume thumbnail
  function getCanvasDimensions(volumeUuid: string): { width: number; height: number } | null {
    const dims = thumbnailDimensions.get(volumeUuid);
    if (!dims) return null;

    if (uniformHeight !== null) {
      // Uniform height mode: fixed height, width from aspect ratio (capped)
      const aspectRatio = dims.width / dims.height;
      const width = Math.min(uniformHeight * aspectRatio, BASE_WIDTH);
      return { width, height: uniformHeight };
    } else {
      // Normal mode: contain within max bounds
      return getRenderedDimensions(dims.width, dims.height);
    }
  }

  // Calculate step sizes and centering/spreading offsets
  let stepSizes = $derived.by(() => {
    const stackCountSetting = $catalogSettings?.stackCount ?? 3;
    const hOffsetPercent = ($catalogSettings?.horizontalStep ?? 11) / 100;
    // Force vertical offset to 0 when stack count is 0 (all volumes / spine mode)
    const vOffsetPercent =
      stackCountSetting === 0 ? 0 : ($catalogSettings?.verticalStep ?? 5) / 100;
    const centerHorizontal = $catalogSettings?.centerHorizontal ?? true;
    const centerVertical = $catalogSettings?.centerVertical ?? false;

    // Default step in pixels based on base thumbnail size
    let horizontalStep = BASE_WIDTH * hOffsetPercent;
    let verticalStep = BASE_HEIGHT * vOffsetPercent;

    const actualCount = stackedVolumes.length;
    // Use actual count when stackCount is 0 (all volumes)
    const effectiveStackCount = stackCountSetting === 0 ? actualCount : stackCountSetting;
    const { innerWidth, innerHeight } = containerDimensions;

    // Calculate horizontal layout
    let leftOffset = 0;
    if (actualCount < effectiveStackCount && actualCount > 1) {
      if (centerHorizontal) {
        // Center: keep step size, add offset
        const actualStackWidth = BASE_WIDTH + horizontalStep * (actualCount - 1);
        leftOffset = (innerWidth - actualStackWidth) / 2;
      } else {
        // Spread: recalculate step to fill width evenly
        horizontalStep = (innerWidth - BASE_WIDTH) / (actualCount - 1);
      }
    }

    // Get max rendered height from actual thumbnails (or uniform height if in spine mode)
    let maxRenderedHeight = uniformHeight ?? BASE_HEIGHT;
    if (uniformHeight === null && thumbnailDimensions.size > 0) {
      // Start at 0 to find actual max, not clamped to BASE_HEIGHT
      let actualMaxHeight = 0;
      for (const vol of stackedVolumes) {
        const dims = thumbnailDimensions.get(vol.volume_uuid);
        if (dims) {
          const rendered = getRenderedDimensions(dims.width, dims.height);
          actualMaxHeight = Math.max(actualMaxHeight, rendered.height);
        }
      }
      // Use actual max if we found dimensions, otherwise keep BASE_HEIGHT default
      if (actualMaxHeight > 0) {
        maxRenderedHeight = actualMaxHeight;
      }
    }

    // Calculate vertical layout
    let topOffset = 0;
    const actualStackHeight = maxRenderedHeight + verticalStep * (actualCount - 1);
    const extraVerticalSpace = innerHeight - actualStackHeight;

    if (actualCount > 0 && extraVerticalSpace > 0) {
      // Spreading only works with 2+ volumes and v.offset > 0
      const canSpread = !centerVertical && vOffsetPercent > 0 && actualCount > 1;

      if (canSpread) {
        // Spread: recalculate step to fill height evenly
        verticalStep = (innerHeight - maxRenderedHeight) / (actualCount - 1);
      } else {
        // Center: for single volumes, v.offset = 0, or when centering enabled
        topOffset = extraVerticalSpace / 2;
      }
    }

    return {
      horizontal: horizontalStep,
      vertical: verticalStep,
      leftOffset,
      topOffset
    };
  });

  // Calculate step sizes for placeholder thumbnails (same logic but uses all series volumes)
  let placeholderStepSizes = $derived.by(() => {
    // Use compact settings for cloud series if enabled
    if (useCompactForCloud) {
      return {
        count: 1,
        horizontal: 0,
        vertical: 0,
        leftOffset: 0,
        topOffset: 0
      };
    }

    const stackCountSetting = $catalogSettings?.stackCount ?? 3;
    const hOffsetPercent = ($catalogSettings?.horizontalStep ?? 11) / 100;
    const vOffsetPercent =
      stackCountSetting === 0 ? 0 : ($catalogSettings?.verticalStep ?? 5) / 100;
    const centerHorizontal = $catalogSettings?.centerHorizontal ?? true;
    const centerVertical = $catalogSettings?.centerVertical ?? false;

    let horizontalStep = BASE_WIDTH * hOffsetPercent;
    let verticalStep = BASE_HEIGHT * vOffsetPercent;

    // For placeholders, use capped count to match stackedVolumes sizing
    const maxCount = isPlaceholderOnly
      ? (stackCountSetting === 0 ? MAX_CLOUD_STACK : Math.min(stackCountSetting, MAX_CLOUD_STACK))
      : stackCountSetting;
    const actualCount = Math.min(seriesVolumes.length, maxCount);
    const effectiveStackCount = maxCount;
    const { innerWidth, innerHeight } = containerDimensions;

    // Calculate horizontal layout
    let leftOffset = 0;
    if (actualCount < effectiveStackCount && actualCount > 1) {
      if (centerHorizontal) {
        const actualStackWidth = BASE_WIDTH + horizontalStep * (actualCount - 1);
        leftOffset = (innerWidth - actualStackWidth) / 2;
      } else {
        horizontalStep = (innerWidth - BASE_WIDTH) / (actualCount - 1);
      }
    }

    // For placeholders, height is always BASE_HEIGHT (uniform boxes)
    const maxRenderedHeight = BASE_HEIGHT;
    let topOffset = 0;
    const actualStackHeight = maxRenderedHeight + verticalStep * (actualCount - 1);
    const extraVerticalSpace = innerHeight - actualStackHeight;

    if (actualCount > 0 && extraVerticalSpace > 0) {
      const canSpread = !centerVertical && vOffsetPercent > 0 && actualCount > 1;
      if (canSpread) {
        verticalStep = (innerHeight - maxRenderedHeight) / (actualCount - 1);
      } else {
        topOffset = extraVerticalSpace / 2;
      }
    }

    return {
      count: actualCount,
      horizontal: horizontalStep,
      vertical: verticalStep,
      leftOffset,
      topOffset
    };
  });

  // Fetch cloud thumbnails for visible placeholder volumes
  // Fetch targets are computed from stable inputs only (seriesVolumes, catalogSettings)
  // to avoid a reactive cycle: thumbnails loaded → containerDimensions changed →
  // placeholderStepSizes recomputed → effect re-triggered → cleanup resets data → loop
  $effect(() => {
    if (!isPlaceholderOnly) return;

    const stackCount = $catalogSettings?.stackCount ?? 3;
    const maxCount = stackCount === 0 ? MAX_CLOUD_STACK : Math.min(stackCount, MAX_CLOUD_STACK);
    const count = useCompactForCloud ? 1 : Math.min(seriesVolumes.length, maxCount);
    const vols = seriesVolumes.slice(0, count);
    let cancelled = false;

    for (const vol of vols) {
      if (!vol.cloudThumbnailFileId) continue;

      // Check synchronous cache first
      const cached = getCachedCloudThumbnail(vol.volume_uuid);
      if (cached) {
        cloudThumbnailData[vol.volume_uuid] = cached;
        continue;
      }

      // Fetch async
      fetchCloudThumbnail(vol).then((result) => {
        if (cancelled || !result) return;
        console.log(`[CatalogItem] Cloud thumbnail loaded: ${vol.volume_title} ${result.width}x${result.height}`);
        cloudThumbnailData[vol.volume_uuid] = result;
      });
    }

    return () => {
      cancelled = true;
      // Don't reset cloudThumbnailData - File objects don't need cleanup (unlike blob URLs),
      // and resetting triggers expensive enrichedPlaceholders → template flip-flop when the
      // parent re-renders (e.g., from local thumbnail processing updating the catalog store)
    };
  });

  // Use title for placeholder-only (handles transition when first volume downloads)
  // Use UUID for local series (handles edge case of same-name series)
  let navId = $derived(isPlaceholderOnly ? volume?.series_title || '' : series_uuid);

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
  <a href="#/series/{encodeURIComponent(navId)}" onclick={handleClick}>
    <div
      class:text-green-400={isComplete}
      class:opacity-70={isPlaceholderOnly}
      class="relative flex flex-col items-center gap-[5px] rounded-lg border-2 border-transparent p-3 text-center transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
      class:cursor-pointer={isPlaceholderOnly}
    >
      {#if stackedVolumes.length > 0 && hasRenderableThumbnails}
        <!-- CompositeCanvas - unified for BOTH local and cloud thumbnails -->
        <div
          class="relative pt-4 pb-6"
          style="width: {containerDimensions.outerWidth}px; height: {containerDimensions.outerHeight}px;"
        >
          <div
            class="relative overflow-hidden"
            style="width: {containerDimensions.innerWidth}px; height: {containerDimensions.innerHeight}px;"
          >
            {#key compositeKey}
              <CompositeCanvas
                volumes={stackedVolumes}
                canvasWidth={containerDimensions.innerWidth}
                canvasHeight={containerDimensions.innerHeight}
                {getCanvasDimensions}
                {stepSizes}
              />
            {/key}
          </div>
          {#if isPlaceholderOnly}
            <!-- Download overlay for cloud series -->
            <div class="absolute right-2 bottom-8 z-10 rounded-full bg-black/60 p-1.5">
              {#if isDownloading}
                <Spinner size="4" color="blue" />
              {:else}
                <DownloadSolid class="h-4 w-4 text-blue-400" />
              {/if}
            </div>
          {/if}
        </div>
      {:else if isPlaceholderOnly}
        <!-- Placeholder boxes (cloud thumbnails loading or unavailable) -->
        <div
          class="relative pt-4 pb-6"
          style="width: {containerDimensions.outerWidth}px; height: {containerDimensions.outerHeight}px;"
        >
          <div
            class="relative overflow-hidden"
            style="width: {containerDimensions.innerWidth}px; height: {containerDimensions.innerHeight}px;"
          >
            {#each Array(placeholderStepSizes.count) as _, i}
              <div
                class="absolute flex items-center justify-center border border-gray-300 bg-gray-200 dark:border-gray-600 dark:bg-gray-800"
                style="width: {BASE_WIDTH}px; height: {BASE_HEIGHT}px; left: {placeholderStepSizes.leftOffset +
                  i * placeholderStepSizes.horizontal}px; top: {placeholderStepSizes.topOffset +
                  i * placeholderStepSizes.vertical}px; z-index: {placeholderStepSizes.count -
                  i}; filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.5));"
              >
                {#if i === 0}
                  <div class="flex flex-col items-center gap-3">
                    {#if isDownloading}
                      <Spinner size="16" color="blue" />
                      <span class="text-sm text-gray-300">Downloading...</span>
                    {:else}
                      <DownloadSolid class="h-16 w-16 text-blue-400" />
                      <span class="text-sm text-gray-300">Click to download</span>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {:else if stackedVolumes.length > 0}
        <!-- Local volumes exist, but thumbnails are not ready yet -->
        <div
          class="relative pt-4 pb-6"
          style="width: {containerDimensions.outerWidth}px; height: {containerDimensions.outerHeight}px;"
        >
          <div
            class="relative overflow-hidden"
            style="width: {containerDimensions.innerWidth}px; height: {containerDimensions.innerHeight}px;"
          >
            {#each Array(Math.max(stackedVolumes.length, 1)) as _, i}
              <div
                class="absolute flex items-center justify-center border border-gray-300 bg-gray-200 dark:border-gray-600 dark:bg-gray-800"
                style="width: {BASE_WIDTH}px; height: {BASE_HEIGHT}px; left: {stepSizes.leftOffset +
                  i * stepSizes.horizontal}px; top: {stepSizes.topOffset +
                  i * stepSizes.vertical}px; z-index: {Math.max(stackedVolumes.length, 1) -
                  i}; filter: drop-shadow(2px 4px 6px rgba(0, 0, 0, 0.5));"
              >
                {#if i === 0}
                  <span class="text-sm text-gray-500 dark:text-gray-400">Generating...</span>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
      <p class="line-clamp-2 font-semibold" style="width: {containerDimensions.outerWidth}px;">
        {volume.series_title}
      </p>
      {#if isPlaceholderOnly}
        <p class="text-xs text-blue-400">
          {seriesVolumes.length} volume{seriesVolumes.length !== 1 ? 's' : ''} in {providerName}
        </p>
      {/if}
    </div>
  </a>
{/if}
