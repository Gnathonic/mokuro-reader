<script lang="ts">
  import { thumbnailCache, type CacheEntry } from '$lib/catalog/thumbnail-cache';

  interface Props {
    volumeUuid: string;
    file: File | undefined;
    width: number;
    height: number;
    class?: string;
    style?: string;
  }

  let {
    volumeUuid,
    file,
    width,
    height,
    class: className = '',
    style: styleStr = ''
  }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let isVisible = $state(false);
  let renderedUuid = $state<string | null>(null);

  /**
   * Draw bitmap right-aligned (RTL/manga style - spine on right)
   * Fills canvas height, crops left side if needed (spine stays visible)
   */
  function drawRightAligned(
    ctx: CanvasRenderingContext2D,
    entry: CacheEntry,
    canvasWidth: number,
    canvasHeight: number
  ) {
    // Scale to fill canvas height (cover behavior, not contain)
    const scale = canvasHeight / entry.height;

    const drawWidth = entry.width * scale;
    const drawHeight = canvasHeight;

    // Right-align: anchor to right edge (spine side for manga)
    // If image is wider than canvas after scaling, left side gets cropped
    const x = canvasWidth - drawWidth;
    const y = 0;

    ctx.drawImage(entry.bitmap, x, y, drawWidth, drawHeight);
  }

  // Set up IntersectionObserver for visibility-based loading
  $effect(() => {
    if (!canvas) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisible = entry.isIntersecting;
      },
      { rootMargin: '100px', threshold: 0 }
    );

    observer.observe(canvas);
    return () => observer.disconnect();
  });

  // Load and render when visible
  $effect(() => {
    if (!isVisible || !canvas || !file) return;

    // Skip if already rendered this volume
    if (renderedUuid === volumeUuid) return;

    const currentCanvas = canvas;
    const currentUuid = volumeUuid;
    const currentFile = file;

    thumbnailCache.get(currentUuid, currentFile).then((entry) => {
      // Check we haven't switched volumes while loading
      if (renderedUuid === currentUuid) return;

      const ctx = currentCanvas.getContext('2d');
      if (!ctx) return;

      // Set canvas dimensions and draw right-aligned
      currentCanvas.width = width;
      currentCanvas.height = height;
      drawRightAligned(ctx, entry, width, height);

      renderedUuid = currentUuid;
    });
  });

  // Re-render if dimensions change after initial render
  $effect(() => {
    if (!canvas || renderedUuid !== volumeUuid) return;

    // Dimensions changed, need to redraw
    const entry = thumbnailCache.getSync(volumeUuid);
    if (!entry) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = width;
    canvas.height = height;
    drawRightAligned(ctx, entry, width, height);
  });

  // Reset when volume changes
  $effect(() => {
    // Track volumeUuid changes
    volumeUuid;

    // If uuid changed from what we rendered, reset
    if (renderedUuid !== null && renderedUuid !== volumeUuid) {
      renderedUuid = null;
    }
  });
</script>

<canvas
  bind:this={canvas}
  class={className}
  style="{styleStr}; width: {width}px; height: {height}px;"
></canvas>
