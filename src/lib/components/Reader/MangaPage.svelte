<script lang="ts">
  import type { Page } from '$lib/types';
  import TextBoxes from './TextBoxes.svelte';

  interface ContextMenuData {
    x: number;
    y: number;
    lines: string[];
    imgElement: HTMLElement | null;
    textBox?: [number, number, number, number]; // [xmin, ymin, xmax, ymax] for initial crop
  }

  interface Props {
    page: Page;
    src: File;
    cachedUrl?: string | null;
    volumeUuid: string;
    /** Force text visibility (for placeholder/missing pages) */
    forceVisible?: boolean;
    /** Callback when context menu should be shown */
    onContextMenu?: (data: ContextMenuData) => void;
  }

  let { page, src, cachedUrl, volumeUuid, forceVisible = false, onContextMenu }: Props = $props();

  let url = $state('');

  // Use cached URL if available, otherwise create blob URL
  $effect(() => {
    let currentBlobUrl: string | null = null;

    if (cachedUrl) {
      // Use pre-decoded cached URL (no cleanup needed, managed by cache)
      url = `url(${cachedUrl})`;
    } else if (src) {
      // Fallback: create new blob URL
      currentBlobUrl = URL.createObjectURL(src);
      url = `url(${currentBlobUrl})`;
    } else {
      url = '';
    }

    // Cleanup function runs on effect re-run or component unmount
    return () => {
      // Only revoke if we created it (not from cache)
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
    };
  });
</script>

<div
  draggable="false"
  style:width={`${page.img_width}px`}
  style:height={`${page.img_height}px`}
  style:background-image={url}
  style:background-size="contain"
  style:background-repeat="no-repeat"
  style:background-position="center"
  class="relative"
>
  <TextBoxes {page} {src} {volumeUuid} {forceVisible} {onContextMenu} />
</div>
