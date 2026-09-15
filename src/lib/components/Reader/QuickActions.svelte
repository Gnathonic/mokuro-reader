<script lang="ts">
  import { toggleFullScreen } from '$lib/util/fullscreen';
  import { pagedZoom } from '$lib/reader/paged-zoom';
  import { settings, volumes, updateSetting } from '$lib/settings';
  import {
    ArrowLeftOutline,
    ArrowRightOutline,
    CompressOutline,
    EditOutline,
    ImageOutline,
    LanguageOutline,
    LayersOutline,
    SearchOutline,
    ZoomOutOutline,
    PlusOutline
  } from 'flowbite-svelte-icons';
  import LayerPicker from './Layers/LayerPicker.svelte';
  import type { LayerSummary } from '$lib/reader/edit/layer-list';
  import type { LayerAction } from './Layers/layer-actions';
  import type { VolumeMetadata } from '$lib/anki-connect';
  import { showTextBoxPicker } from './text-box-picker';
  import type { Page } from '$lib/types';

  interface Props {
    left: (_e: any, ingoreTimeOut?: boolean) => void;
    right: (_e: any, ingoreTimeOut?: boolean) => void;
    src1: File | undefined;
    src2: File | undefined;
    volumeUuid: string;
    page1?: Page; // First page data for Anki card creation
    page2?: Page; // Second page data (when in dual mode)
    page1Number?: number; // 1-indexed page number for src1/page1
    page2Number?: number; // 1-indexed page number for src2/page2
    visible?: boolean;
    /** OCR edit mode toggle (paged mode only — disabled otherwise). */
    onEdit?: () => void;
    editEnabled?: boolean;
    /** Why Edit is disabled, when it is for a reason other than the view mode. */
    editBlockedReason?: string;
    editing?: boolean;
    /** OCR layers of the volume; the picker shows when there are any, or in edit mode. */
    layers?: LayerSummary[];
    currentLayer?: string | null;
    onSelectLayer?: (layerId: string | null) => void;
    onLayerAction?: (action: LayerAction, layerId: string | null) => void;
    /** Engine entry points (experimental) — given only when the key is configured. */
    onOcrPage?: () => void;
    onTranslatePage?: () => void;
    onOcrVolume?: () => void;
    onTranslateVolume?: () => void;
  }

  let {
    left,
    right,
    src1,
    src2,
    volumeUuid,
    page1,
    page2,
    page1Number,
    page2Number,
    visible = true,
    onEdit,
    editEnabled = false,
    editBlockedReason,
    editing = false,
    layers = [],
    currentLayer = null,
    onSelectLayer,
    onLayerAction,
    onOcrPage,
    onTranslatePage,
    onOcrVolume,
    onTranslateVolume
  }: Props = $props();

  let layersOpen = $state(false);

  let ankiTags = $derived($settings.ankiConnectSettings.tags);
  let volumeMetadata = $derived<VolumeMetadata>({
    seriesTitle: $volumes[volumeUuid]?.series_title,
    volumeTitle: $volumes[volumeUuid]?.volume_title
  });

  let open = $state(false);

  function handleZoom() {
    if ($pagedZoom) {
      // Paged mode: transient whole-page view (the mode setting is untouched).
      $pagedZoom.zoomFitToScreen();
    } else {
      // Continuous mode has no transient equivalent — pages lay out from the
      // mode setting, so "fit" means switching it (the Z-key path).
      updateSetting('continuousZoomDefault', 'zoomFitToScreen');
    }
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

  async function onUpdateCard(src: File | undefined, page?: Page, pageNumber?: number) {
    if ($settings.ankiConnectSettings.enabled && src && page) {
      // Show text box picker first, then dispatch to create/update based on cardMode
      showTextBoxPicker(URL.createObjectURL(src), page, ankiTags, volumeMetadata, pageNumber);
    }
    open = false;
  }

  function toggleMenu() {
    open = !open;
  }
</script>

{#if $settings.quickActions && visible}
  <div class="fixed end-3 bottom-3 z-50 flex flex-col items-center">
    <!-- Action buttons (shown when open) -->
    {#if open}
      <div class="mb-2 flex flex-col items-center gap-2">
        {#if !editing && onOcrPage}
          <button
            onclick={() => {
              onOcrPage?.();
              open = false;
            }}
            class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            aria-label="OCR this page"
            title="OCR this page with Google Cloud Vision (experimental)"
          >
            <SearchOutline size="xl" />
          </button>
        {/if}
        {#if !editing && onTranslatePage}
          <button
            onclick={() => {
              onTranslatePage?.();
              open = false;
            }}
            class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            aria-label="Translate this page"
            title="Translate this page (experimental)"
          >
            <LanguageOutline size="xl" />
          </button>
        {/if}
        {#if layers.length > 0 || editing || onOcrVolume || onTranslateVolume}
          <button
            onclick={() => {
              layersOpen = !layersOpen;
              open = false;
            }}
            class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            aria-label="OCR layers"
            title="OCR layers"
          >
            <LayersOutline size="xl" />
          </button>
        {/if}
        <button
          onclick={() => {
            onEdit?.();
            open = false;
          }}
          disabled={!editEnabled}
          title={editEnabled
            ? undefined
            : (editBlockedReason ?? 'Edit is available in paged mode only')}
          class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none disabled:opacity-40 disabled:hover:bg-gray-700 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          aria-label={editing ? 'Exit edit mode' : 'Edit OCR'}
        >
          <EditOutline size="xl" />
        </button>
        {#if $settings.ankiConnectSettings.enabled}
          <button
            onclick={() => onUpdateCard(src1, page1, page1Number)}
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
            onclick={() => onUpdateCard(src2, page2, page2Number)}
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
          onclick={() => {
            toggleFullScreen();
            open = false;
          }}
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

    {#if layersOpen}
      <LayerPicker
        {layers}
        current={currentLayer}
        onSelect={(id) => {
          onSelectLayer?.(id);
          layersOpen = false;
        }}
        onAction={(a, id) => {
          onLayerAction?.(a, id);
          layersOpen = false;
        }}
        onClose={() => (layersOpen = false)}
        onOcrVolume={onOcrVolume
          ? () => {
              onOcrVolume?.();
              layersOpen = false;
            }
          : undefined}
        onTranslateVolume={onTranslateVolume
          ? () => {
              onTranslateVolume?.();
              layersOpen = false;
            }
          : undefined}
      />
    {/if}

    <!-- Main toggle button -->
    <button
      onclick={toggleMenu}
      class="flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:ring-2 focus:ring-blue-500 focus:outline-none dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
      aria-label="Quick actions menu"
      style="transition: transform 0.3s ease; transform: rotate({open ? 45 : 0}deg);"
    >
      <PlusOutline size="xl" />
    </button>
  </div>
{/if}
