<script lang="ts">
  import type { Page } from '$lib/types';
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import TextBoxes from './TextBoxes.svelte';
  import EditOverlay from './Edit/EditOverlay.svelte';
  import { acquireBlobUrl, releaseBlobUrl } from '$lib/reader/blob-urls';

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

  // Use cached URL if available, otherwise the file's shared object URL — the
  // same URL the preload cache and any earlier mount of this page used, so
  // the browser paints the image it already decoded (see blob-urls.ts).
  $effect(() => {
    const held = cached ? null : file;

    if (cached) {
      // Use pre-decoded cached URL (no cleanup needed, managed by cache)
      url = `url(${cached})`;
    } else if (held) {
      url = `url(${acquireBlobUrl(held)})`;
    } else {
      url = '';
    }

    // Cleanup function runs on effect re-run or component unmount
    return () => {
      if (held) releaseBlobUrl(held);
    };
  });
</script>

<div
  draggable="false"
  data-page-index={pageIndex}
  style:width={`${page.img_width}px`}
  style:height={`${page.img_height}px`}
  class="relative"
>
  <!-- The image is its own layer, not this div's background, so the page
       brightness/contrast filter (#256, `--page-filter` from the reader) reaches
       the image and never the text boxes or edit overlay beside it. First child
       and positioned: it paints under them (both are positioned, later in tree
       order). Pointer events pass through to this div, as with a background. -->
  <div class="pageImage" aria-hidden="true" style:background-image={url}></div>
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

<style>
  .pageImage {
    position: absolute;
    inset: 0;
    background-size: contain;
    background-repeat: no-repeat;
    background-position: center;
    pointer-events: none;
    /* `none` unless the reader sets brightness/contrast: no stacking context
       and no compositing cost at the defaults. */
    filter: var(--page-filter, none);
  }
</style>
