<script lang="ts">
  import type { Page } from '$lib/types';
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import TextBoxes from './TextBoxes.svelte';
  import EditOverlay from './Edit/EditOverlay.svelte';

  interface ContextMenuData {
    x: number;
    y: number;
    lines: string[];
    imgElement: HTMLElement | null;
    textBox?: [number, number, number, number]; // [xmin, ymin, xmax, ymax] for initial crop
    pageIndex?: number;
    blockIndex?: number;
  }

  interface Props {
    page: Page;
    src?: File | null;
    cachedUrl?: string | null;
    volumeUuid: string;
    /** 0-based page index within the volume */
    pageIndex?: number;
    /** Force text visibility (for placeholder/missing pages) */
    forceVisible?: boolean;
    /** Callback when context menu should be shown */
    onContextMenu?: (data: ContextMenuData) => void;
    /** Set while the reader is in OCR edit mode: the edit overlay replaces the text boxes. */
    editSession?: EditSession | null;
  }

  let {
    page,
    src,
    cachedUrl,
    volumeUuid,
    pageIndex,
    forceVisible = false,
    onContextMenu,
    editSession = null
  }: Props = $props();

  let url = $state('');

  // Read through deriveds: a prop like `src={indexedFiles[i]}` is re-read
  // whenever the parent rebuilds that array — an OCR layer swap does, with
  // the very same File objects — while a derived only notifies when the value
  // itself changes. So the page keeps its blob URL and decoded image instead
  // of swapping in an identical one (a visible flash to the reader bg).
  let cached = $derived(cachedUrl ?? null);
  let file = $derived(src ?? null);

  // Use cached URL if available, otherwise create blob URL
  $effect(() => {
    let currentBlobUrl: string | null = null;

    if (cached) {
      // Use pre-decoded cached URL (no cleanup needed, managed by cache)
      url = `url(${cached})`;
    } else if (file) {
      // Fallback: create new blob URL
      currentBlobUrl = URL.createObjectURL(file);
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
  data-page-index={pageIndex}
  style:width={`${page.img_width}px`}
  style:height={`${page.img_height}px`}
  style:background-image={url}
  style:background-size="contain"
  style:background-repeat="no-repeat"
  style:background-position="center"
  class="relative"
>
  {#if editSession && pageIndex !== undefined}
    <EditOverlay {page} {pageIndex} session={editSession} />
  {:else}
    <TextBoxes
      {page}
      src={src ?? undefined}
      {volumeUuid}
      {pageIndex}
      {forceVisible}
      {onContextMenu}
    />
  {/if}
</div>
