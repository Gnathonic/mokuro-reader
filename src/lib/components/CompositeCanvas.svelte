<script lang="ts">
  import { thumbnailCache, type CacheEntry } from '$lib/catalog/thumbnail-cache';
  import type { VolumeMetadata } from '$lib/types';

  interface Props {
    volumes: VolumeMetadata[];
    canvasWidth: number;
    canvasHeight: number;
    getCanvasDimensions: (volumeUuid: string) => { width: number; height: number } | null;
    stepSizes: {
      horizontal: number;
      vertical: number;
      leftOffset: number;
      topOffset: number;
    };
  }

  let { volumes, canvasWidth, canvasHeight, getCanvasDimensions, stepSizes }: Props = $props();

  // Hardware limits for canvas segments
  const MAX_SEGMENT_SIZE = 1024;

  // Track loaded thumbnails and visibility
  let loadedThumbnails = $state<Map<string, CacheEntry>>(new Map());
  let loadingUuids = $state<Set<string>>(new Set()); // Track in-flight loads
  let isVisible = $state(false);


  // Calculate segments based on canvas dimensions (split by width or height as needed)
  let segments = $derived.by(() => {
    const segs: { startX: number; startY: number; width: number; height: number }[] = [];

    // Determine if we need to split horizontally, vertically, or both
    const needsHorizontalSplit = canvasWidth > MAX_SEGMENT_SIZE;
    const needsVerticalSplit = canvasHeight > MAX_SEGMENT_SIZE;

    if (!needsHorizontalSplit && !needsVerticalSplit) {
      return [{ startX: 0, startY: 0, width: canvasWidth, height: canvasHeight }];
    }

    // Calculate segment counts
    const hSegments = needsHorizontalSplit ? Math.ceil(canvasWidth / MAX_SEGMENT_SIZE) : 1;
    const vSegments = needsVerticalSplit ? Math.ceil(canvasHeight / MAX_SEGMENT_SIZE) : 1;

    for (let row = 0; row < vSegments; row++) {
      for (let col = 0; col < hSegments; col++) {
        const startX = col * MAX_SEGMENT_SIZE;
        const startY = row * MAX_SEGMENT_SIZE;
        const width = Math.min(MAX_SEGMENT_SIZE, canvasWidth - startX);
        const height = Math.min(MAX_SEGMENT_SIZE, canvasHeight - startY);
        segs.push({ startX, startY, width, height });
      }
    }

    return segs;
  });

  // Canvas refs for each segment
  let canvasRefs: (HTMLCanvasElement | undefined)[] = $state([]);

  // Set up IntersectionObserver for lazy loading
  function canvasAction(node: HTMLCanvasElement, isFirst: boolean) {
    if (!isFirst) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          isVisible = true;
          observer.disconnect();
        }
      },
      { rootMargin: '200px', threshold: 0 }
    );

    observer.observe(node);

    return {
      destroy() {
        observer.disconnect();
      }
    };
  }

  // Load thumbnails when visible - reacts to volume list changes
  $effect(() => {
    if (!isVisible) return;

    const volumeList = volumes;

    for (let i = 0; i < volumeList.length; i++) {
      const vol = volumeList[i];
      if (!vol.thumbnail) continue;

      // Skip if already loaded or loading
      if (loadedThumbnails.has(vol.volume_uuid) || loadingUuids.has(vol.volume_uuid)) continue;

      // Check sync cache first
      const cached = thumbnailCache.getSync(vol.volume_uuid);
      if (cached) {
        loadedThumbnails.set(vol.volume_uuid, cached);
        loadedThumbnails = new Map(loadedThumbnails);
        continue;
      }

      // Mark as loading
      loadingUuids.add(vol.volume_uuid);
      loadingUuids = new Set(loadingUuids);

      thumbnailCache
        .get(vol.volume_uuid, vol.thumbnail, i, null)
        .then((entry) => {
          loadedThumbnails.set(vol.volume_uuid, entry);
          loadedThumbnails = new Map(loadedThumbnails);
        })
        .catch(() => {})
        .finally(() => {
          loadingUuids.delete(vol.volume_uuid);
          loadingUuids = new Set(loadingUuids);
        });
    }
  });

  // Draw function - separated so we can call it manually
  function draw() {
    // Pre-calculate all volume positions
    const volumePositions: {
      entry: CacheEntry;
      dims: { width: number; height: number };
      x: number;
      y: number;
    }[] = [];

    for (let i = 0; i < volumes.length; i++) {
      const vol = volumes[i];
      const entry = loadedThumbnails.get(vol.volume_uuid);
      if (!entry) continue;

      const dims = getCanvasDimensions(vol.volume_uuid);
      if (!dims) continue;

      const rightOffset = (volumes.length - 1 - i) * stepSizes.horizontal;
      const x = canvasWidth - rightOffset - dims.width;
      const y = stepSizes.topOffset + i * stepSizes.vertical;

      volumePositions.push({ entry, dims, x, y });
    }

    // Draw each segment
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const canvas = canvasRefs[segIdx];
      if (!canvas) continue;

      const segment = segments[segIdx];
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      // Set canvas size
      canvas.width = segment.width;
      canvas.height = segment.height;

      // Clear canvas
      ctx.clearRect(0, 0, segment.width, segment.height);

      // Segment bounds
      const segRight = segment.startX + segment.width;
      const segBottom = segment.startY + segment.height;

      // Draw volumes that intersect this segment (back to front)
      for (let i = volumePositions.length - 1; i >= 0; i--) {
        const { entry, dims, x, y } = volumePositions[i];

        // Check if volume intersects this segment (both X and Y)
        const volRight = x + dims.width;
        const volBottom = y + dims.height;

        if (volRight < segment.startX || x > segRight) continue;
        if (volBottom < segment.startY || y > segBottom) continue;

        // Translate to segment-local coordinates
        const localX = x - segment.startX;
        const localY = y - segment.startY;

        // Draw drop shadow
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 4;

        // Draw the thumbnail
        ctx.drawImage(entry.bitmap, localX, localY, dims.width, dims.height);

        // Draw border
        ctx.strokeStyle = '#111827'; // gray-900
        ctx.lineWidth = 1;
        ctx.strokeRect(localX, localY, dims.width, dims.height);

        ctx.restore();
      }
    }
  }

  // Draw effect - reacts to data changes
  $effect(() => {
    // Dependencies - access to track
    void loadedThumbnails;
    void segments;
    void canvasWidth;
    void canvasHeight;
    void stepSizes;
    void volumes;

    // Use rAF to ensure DOM is ready
    requestAnimationFrame(draw);
  });
</script>

{#each segments as segment, i}
  <canvas
    bind:this={canvasRefs[i]}
    use:canvasAction={i === 0}
    class="absolute"
    style="left: {segment.startX}px; top: {segment.startY}px; width: {segment.width}px; height: {segment.height}px;"
  ></canvas>
{/each}
