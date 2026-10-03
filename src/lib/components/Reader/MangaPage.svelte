<script lang="ts">
  import type { Page } from '$lib/types';
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import TextBoxes from './TextBoxes.svelte';
  import EditOverlay from './Edit/EditOverlay.svelte';
  import { acquireBlobUrl, blobForUrl, releaseBlobUrl } from '$lib/reader/blob-urls';
  import { pageInkSetting } from '$lib/settings';
  import {
    INK_PALETTE,
    PAPER_TINT_OPACITY,
    inkColorFor,
    pageNeedsInk
  } from '$lib/reader/ink-color';

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

  // Ink color (#256): is this page black and white? Sampled once per image
  // (cached in ink-color.ts), never while the setting is off, and never in the
  // way of the first paint — the ink layer appears when the verdict arrives.
  // A page in continuous mode is only mounted near the viewport, so only those
  // pages are ever sampled.
  let inkVerdict = $state<{ image: Blob; ink: boolean } | null>(null);

  // The image's identity is its Blob: the File when the parent passes one,
  // else the Blob behind the preloaded URL (paged mode renders with
  // `cachedUrl` before the image cache can hand over the File).
  let inkImage = $derived(file ?? (cached ? blobForUrl(cached) : null));

  $effect(() => {
    const image = inkImage;
    if ($pageInkSetting === 'off' || !image) return;
    let live = true;
    pageNeedsInk(image).then((ink) => {
      if (live) inkVerdict = { image, ink };
    });
    return () => {
      live = false;
    };
  });

  let ink = $derived.by(() => {
    if (!inkImage || inkVerdict?.image !== inkImage || !inkVerdict.ink) return null;
    const name = inkColorFor($pageInkSetting, volumeUuid, pageIndex);
    return name ? { name, ...INK_PALETTE[name] } : null;
  });
</script>

<div
  draggable="false"
  data-page-index={pageIndex}
  style:width={`${page.img_width}px`}
  style:height={`${page.img_height}px`}
  class="relative"
  data-ink={ink?.name}
  style:--page-ink-text={ink?.text}
>
  <!-- The image is its own layer, not this div's background, so the page
       brightness/contrast filter (#256, `--page-filter` from the reader) reaches
       the image and never the text boxes or edit overlay beside it. First child
       and positioned: it paints under them (both are positioned, later in tree
       order). Pointer events pass through to this div, as with a background.
       `.pageArt` holds the image and, on a black-and-white page with ink color
       on, the two ink blend layers above it. -->
  <div
    class="pageArt"
    class:inked={ink !== null}
    aria-hidden="true"
    style:--ink={ink?.ink}
    style:--ink-paper={ink?.paper}
    style:--ink-paper-opacity={ink ? PAPER_TINT_OPACITY : undefined}
  >
    <div class="pageImage" style:background-image={url}></div>
  </div>
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
  .pageArt,
  .pageImage {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  /* Ink color (#256). The two layers blend with what is painted under them in
     their stacking context; `isolation` makes this wrapper that context, so the
     backdrop is this page's (brightness/contrast-filtered) image and nothing
     else — not the reader background, not the other page of a spread. Only an
     inked page pays for the group. The wrapper is positioned with z-index auto
     and comes first, so the text boxes and the edit overlay (z-index 11) still
     paint above it, untouched by either blend. Plain colours, no per-layer
     filter: the palette is the userscript's filtered red, pre-measured. */
  .pageArt.inked {
    isolation: isolate;
  }

  .pageArt.inked::before,
  .pageArt.inked::after {
    content: '';
    position: absolute;
    inset: 0;
    /* above .pageImage (z-index auto) inside the group; ::after above ::before */
    z-index: 1;
  }

  /* Screen: white stays white, black becomes the ink. */
  .pageArt.inked::before {
    background: var(--ink);
    mix-blend-mode: screen;
  }

  /* Multiply, faint: the paper takes a trace of the same hue. */
  .pageArt.inked::after {
    background: var(--ink-paper);
    opacity: var(--ink-paper-opacity);
    mix-blend-mode: multiply;
  }

  .pageImage {
    background-size: contain;
    background-repeat: no-repeat;
    background-position: center;
    /* `none` unless the reader sets brightness/contrast: no stacking context
       and no compositing cost at the defaults. */
    filter: var(--page-filter, none);
  }
</style>
