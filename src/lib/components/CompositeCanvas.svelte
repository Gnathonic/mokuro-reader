<script lang="ts">
  import { thumbnailCache, type CacheEntry } from '$lib/catalog/thumbnail-cache';
  import type { VolumeMetadata } from '$lib/types';

  /**
   * Shared identity for "this canvas was handed no covers", so a caller that has none can
   * hand the same object every render instead of a fresh empty Map that would invalidate
   * the draw effect on every re-render.
   */
  const NO_COVERS: Map<string, File> = new Map();

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
    /**
     * The 1px edge around each thumbnail. Defaults to `dropShadow` (the catalog card ships
     * both together), but the spine shelf wants the edges WITHOUT the shadow: the edges are
     * what makes the spacing between two spines judgeable, while the shadow only muddies it.
     */
    border?: boolean;
    volumeOffsets?: Map<number, number>;
    highlightIndex?: number | null;
    /**
     * Cover blobs handed to this canvas rather than read off the row: the CLOUD covers a
     * card resolved by path through `cover-resolver.ts`, which a cloud-only volume has no
     * `thumbnail` field to carry (its row either doesn't exist or was never written one).
     *
     * Keyed by `volume_uuid` — the SAME key `thumbnailCache` decodes under — so one volume
     * has one bitmap however its bytes arrived, and a cover that lands while the card is
     * mounted reuses the cache instead of re-decoding.
     *
     * A row's own `thumbnail` always wins: the local path is untouched by this prop.
     */
    covers?: Map<string, File>;
  }

  let {
    volumes,
    canvasWidth,
    canvasHeight,
    getCanvasDimensions,
    stepSizes,
    dropShadow = true,
    border,
    volumeOffsets = new Map(),
    highlightIndex = null,
    covers = NO_COVERS
  }: Props = $props();

  let showBorder = $derived(border ?? dropShadow);

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
      // The row's own cover first — an installed volume, or one with reading history,
      // carries its bytes here and must never depend on the cloud resolver. Only when
      // there is none does the card's resolved cloud cover stand in.
      const coverFile = vol.thumbnail ?? covers.get(vol.volume_uuid);
      if (!coverFile) continue;

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
          .get(vol.volume_uuid, coverFile, i, visibilityElement)
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

        if (showBorder) {
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

  /**
   * Repaint when a bitmap this canvas is waiting for lands in the cache.
   *
   * `draw()` reads the cache SYNCHRONOUSLY, so a miss can only be recovered by drawing
   * again. Its own `thumbnailCache.get(...)` covers the load it started itself, but not a
   * commit that came from anywhere else — another card sharing the volume, a cover
   * install, a re-decode after an invalidate. Those used to reach this canvas only if
   * something happened to re-render it, which is why a cover could arrive and the card
   * stay blank until it was remounted.
   *
   * Subscribed once, for the component's life: the listener re-reads `volumes` when it
   * fires rather than being torn down and rebuilt on every data change.
   */
  $effect(() => {
    return thumbnailCache.subscribeCommits((volumeUuid) => {
      if (volumes.some((vol) => vol.volume_uuid === volumeUuid)) drawTrigger++;
    });
  });

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
    // `draw()` reads this, but inside a `requestAnimationFrame` callback where nothing is
    // tracked, so THIS is the only tracked read of the covers map — remove it and a cover
    // landing can no longer repaint on its own. Pinned by "redraws on a covers change
    // alone" in `CompositeCanvas.test.ts`, which drives `covers` through a host component
    // so it is genuinely the only prop that moves.
    void covers;
    void dropShadow;
    void showBorder;

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
