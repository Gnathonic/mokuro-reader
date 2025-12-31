<script lang="ts">
  import { toggleFullScreen, zoomFitToScreen } from '$lib/panzoom';
  import { settings, volumes } from '$lib/settings';
  import {
    ArrowLeftOutline,
    ArrowRightOutline,
    CompressOutline,
    ImageOutline,
    ZoomOutOutline,
    PlusOutline
  } from 'flowbite-svelte-icons';
  import { imageToWebp, showCropper, sendToAnki, type VolumeMetadata } from '$lib/anki-connect';
  import { promptConfirmation } from '$lib/util';
  import type { Page } from '$lib/types';

  interface Props {
    left: (_e: any, ingoreTimeOut?: boolean) => void;
    right: (_e: any, ingoreTimeOut?: boolean) => void;
    src1: File | undefined;
    src2: File | undefined;
    volumeUuid: string;
    page1?: Page; // First page data for Anki card creation
    page2?: Page; // Second page data (when in dual mode)
  }

  let { left, right, src1, src2, volumeUuid, page1, page2 }: Props = $props();

  let ankiTags = $derived($settings.ankiConnectSettings.tags);
  let volumeMetadata = $derived<VolumeMetadata>({
    seriesTitle: $volumes[volumeUuid]?.series_title,
    volumeTitle: $volumes[volumeUuid]?.volume_title
  });

  let open = $state(false);

  function handleZoom() {
    zoomFitToScreen();
    open = false;
  }

  function handleLeft(_e: Event) {
    left(_e, true);
    open = false;
  }

  function handleRight(_e: Event) {
    right(_e, true);
    open = false;
  }

  async function onUpdateCard(src: File | undefined, page?: Page) {
    if ($settings.ankiConnectSettings.enabled && src) {
      // QuickActions doesn't have text selection, so pass empty strings
      // The modal will show clickable text zones from the page for selection
      showCropper(URL.createObjectURL(src), '', '', ankiTags, volumeMetadata, page ? [page] : []);
    }
    open = false;
  }

  function toggleMenu() {
    open = !open;
  }
</script>

{#if $settings.quickActions}
  <div class="fixed end-3 bottom-3 z-50 flex flex-col items-center">
    <!-- Action buttons (shown when open) -->
    {#if open}
      <div class="mb-2 flex flex-col items-center gap-2">
        {#if $settings.ankiConnectSettings.enabled}
          <button
            onclick={() => onUpdateCard(src1, page1)}
            class="relative flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            aria-label="Add image to Anki"
          >
            <ImageOutline size="xl" />
            {#if src2}
              <span
                class="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-xs text-white"
                >1</span
              >
            {/if}
          </button>
        {/if}
        {#if $settings.ankiConnectSettings.enabled && src2}
          <button
            onclick={() => onUpdateCard(src2, page2)}
            class="relative flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            aria-label="Add image 2 to Anki"
          >
            <ImageOutline size="xl" />
            <span
              class="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-xs text-white"
              >2</span
            >
          </button>
        {/if}
        <button
          onclick={toggleFullScreen}
          class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          aria-label="Toggle fullscreen"
        >
          <CompressOutline size="xl" />
        </button>
        <button
          onclick={handleZoom}
          class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          aria-label="Zoom to fit"
        >
          <ZoomOutOutline size="xl" />
        </button>
        <button
          onclick={handleRight}
          class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          aria-label="Next page"
        >
          <ArrowRightOutline size="xl" />
        </button>
        <button
          onclick={handleLeft}
          class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          aria-label="Previous page"
        >
          <ArrowLeftOutline size="xl" />
        </button>
      </div>
    {/if}

    <!-- Main toggle button -->
    <button
      onclick={toggleMenu}
      class="flex h-12 w-12 items-center justify-center rounded-full text-white focus:ring-2 focus:ring-blue-500 focus:outline-none"
      aria-label="Quick actions menu"
      style="transition: transform 0.3s ease; transform: rotate({open ? 45 : 0}deg);"
    >
      <PlusOutline size="xl" />
    </button>
  </div>
{/if}
