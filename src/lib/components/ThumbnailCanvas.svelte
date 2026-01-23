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

  function drawToCanvas(
    ctx: CanvasRenderingContext2D,
    entry: CacheEntry,
    canvasWidth: number,
    canvasHeight: number
  ) {
    ctx.drawImage(entry.bitmap, 0, 0, canvasWidth, canvasHeight);
  }

  function canvasAction(node: HTMLCanvasElement) {
    if (!file) return;

    const targetFile = file;
    let hasRendered = false;

    function render() {
      if (hasRendered) return;

      const targetUuid = volumeUuid;
      const targetWidth = width;
      const targetHeight = height;

      // Try sync cache first
      const cachedEntry = thumbnailCache.getSync(targetUuid);
      if (cachedEntry) {
        const ctx = node.getContext('2d');
        if (ctx) {
          node.width = targetWidth;
          node.height = targetHeight;
          drawToCanvas(ctx, cachedEntry, targetWidth, targetHeight);
          hasRendered = true;
        }
        return;
      }

      // Async load (throttled by cache)
      thumbnailCache
        .get(targetUuid, targetFile)
        .then((entry) => {
          if (hasRendered) return;
          const ctx = node.getContext('2d');
          if (!ctx) return;

          node.width = targetWidth;
          node.height = targetHeight;
          drawToCanvas(ctx, entry, targetWidth, targetHeight);
          hasRendered = true;
        })
        .catch(() => {});
    }

    // Set up IntersectionObserver for lazy loading
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          render();
          observer.disconnect(); // Only need to load once
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
</script>

<canvas use:canvasAction class={className} style="{styleStr}; width: {width}px; height: {height}px;"
></canvas>
