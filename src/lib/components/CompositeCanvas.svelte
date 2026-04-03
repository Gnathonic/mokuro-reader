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
    dropShadow?: boolean;
    volumeOffsets?: Map<number, number>;
    highlightIndex?: number | null;
  }

  let {
    volumes,
    canvasWidth,
    canvasHeight,
    getCanvasDimensions,
    stepSizes,
    dropShadow = true,
    volumeOffsets = new Map(),
    highlightIndex = null
  }: Props = $props();

  // Hardware limits for canvas segments
  const MAX_SEGMENT_SIZE = 1024;

  // Track in-flight loads to prevent duplicates
  let loadingUuids = $state<Set<string>>(new Set());
  let isVisible = $state(false);
  let visibilityElement = $state<HTMLElement | null>(null);
  // Counter to trigger redraws when loads complete
  let drawTrigger = $state(0);

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

    visibilityElement = node;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Keep this dynamic: offscreen canvases should stop drawing/loading.
        isVisible = entry.isIntersecting;
      },
      { rootMargin: '200px', threshold: 0 }
    );

    observer.observe(node);

    return {
      destroy() {
        visibilityElement = null;
        observer.disconnect();
      }
    };
  }

  // Draw function - fetches from cache on-demand, triggers loads for missing
  function draw() {
    if (!isVisible) return;

    // Pre-calculate all volume positions, fetching from cache
    const volumePositions: {
      entry: CacheEntry;
      dims: { width: number; height: number };
      x: number;
      y: number;
      index: number;
    }[] = [];

    // Pre-compute cascading left positions: each volume's offset shifts all volumes after it
    const leftPositions: number[] = [];
    let cumOffset = 0;
    for (let i = 0; i < volumes.length; i++) {
      leftPositions[i] = i * stepSizes.horizontal + cumOffset;
      cumOffset += volumeOffsets.get(i) ?? 0;
    }
    // Align rightmost volume's right edge to canvasWidth
    const lastDims =
      volumes.length > 0 ? getCanvasDimensions(volumes[volumes.length - 1].volume_uuid) : null;
    const lastWidth = lastDims?.width ?? 0;
    const rightEdge = (leftPositions[volumes.length - 1] ?? 0) + lastWidth;
    const alignShift = canvasWidth - rightEdge;

    for (let i = 0; i < volumes.length; i++) {
      const vol = volumes[i];
      if (!vol.thumbnail) continue;

      const dims = getCanvasDimensions(vol.volume_uuid);
      if (!dims) continue;

      // Try to get from cache synchronously
      const entry = thumbnailCache.getSync(vol.volume_uuid);

      if (entry) {
        const x = leftPositions[i] + alignShift;
        const y = stepSizes.topOffset + i * stepSizes.vertical;
        volumePositions.push({ entry, dims, x, y, index: i });
      } else if (!loadingUuids.has(vol.volume_uuid)) {
        // Not in cache and not loading - trigger async load
        loadingUuids.add(vol.volume_uuid);
        loadingUuids = new Set(loadingUuids);

        thumbnailCache
          .get(vol.volume_uuid, vol.thumbnail, i, visibilityElement)
          .then(() => {
            // Trigger redraw when load completes
            drawTrigger++;
          })
          .catch(() => {})
          .finally(() => {
            loadingUuids.delete(vol.volume_uuid);
            loadingUuids = new Set(loadingUuids);
          });
      }
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
        const { entry, dims, x, y, index } = volumePositions[i];

        // Check if volume intersects this segment (both X and Y)
        const volRight = x + dims.width;
        const volBottom = y + dims.height;

        if (volRight < segment.startX || x > segRight) continue;
        if (volBottom < segment.startY || y > segBottom) continue;

        // Translate to segment-local coordinates
        const localX = x - segment.startX;
        const localY = y - segment.startY;

        ctx.save();

        if (dropShadow) {
          ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
          ctx.shadowBlur = 6;
          ctx.shadowOffsetX = 2;
          ctx.shadowOffsetY = 4;
        }

        // Draw the thumbnail
        ctx.drawImage(entry.bitmap, localX, localY, dims.width, dims.height);

        if (dropShadow) {
          // Draw border
          ctx.strokeStyle = '#111827'; // gray-900
          ctx.lineWidth = 1;
          ctx.strokeRect(localX, localY, dims.width, dims.height);
        }

        // Highlight individual volume when targeted
        if (highlightIndex === index) {
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
          ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)'; // blue-500
          ctx.lineWidth = 2;
          ctx.strokeRect(localX, localY, dims.width, dims.height);
        }

        ctx.restore();
      }
    }
  }

  // Draw effect - reacts to data changes
  $effect(() => {
    // Dependencies - access to track
    void drawTrigger;
    void segments;
    void canvasWidth;
    void canvasHeight;
    void stepSizes;
    void volumes;
    void isVisible;
    void highlightIndex;
    void volumeOffsets;

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
