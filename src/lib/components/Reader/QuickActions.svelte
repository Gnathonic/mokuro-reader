<script lang="ts">
  import { toggleFullScreen } from '$lib/util/fullscreen';
  import { settings } from '$lib/settings';
  import {
    ArrowLeftOutline,
    ArrowRightOutline,
    CompressOutline,
    EditOutline,
    ImageOutline,
    LayersOutline,
    ZoomOutOutline,
    PlusOutline
  } from 'flowbite-svelte-icons';
  import LayerPicker from './Layers/LayerPicker.svelte';
  import type { LayerSummary } from '$lib/reader/edit/layer-list';
  import type { LayerAction } from './Layers/layer-actions';
  import { onDestroy } from 'svelte';

  interface Props {
    left: (_e: any, ingoreTimeOut?: boolean) => void;
    right: (_e: any, ingoreTimeOut?: boolean) => void;
    /** A second page is on screen: "Add image 2 to Anki" has something to add. */
    hasSecondPage?: boolean;
    /** "Add image to Anki" for the first or second page — the reader's handler, the keys' too. */
    onAnkiImage?: (which: 1 | 2) => void;
    /** "Zoom to fit" — the reader's handler, the key's too. */
    onZoomFit?: () => void;
    visible?: boolean;
    /** OCR edit mode toggle (paged mode only — disabled otherwise). */
    onEdit?: () => void;
    editEnabled?: boolean;
    /** Why Edit is disabled, when it is for a reason other than the view mode. */
    editBlockedReason?: string;
    editing?: boolean;
    /** OCR layers of the volume; the picker's button shows when there are any, or in edit mode. */
    layers?: LayerSummary[];
    currentLayer?: string | null;
    primaryLayerName?: string;
    /** Passed to the picker: may the account publish this volume's shared corrections? */
    canPublishLayers?: boolean;
    /** Passed to the picker: the connected provider's status (`forksOnEdit`). */
    layerStatus?: { serverCompilesMetadata?: boolean } | null;
    onSelectLayer?: (layerId: string | null) => void;
    onLayerAction?: (action: LayerAction, layerId: string | null) => void;
    /**
     * Whether the layer picker is up. Bindable so the reader — whose window
     * keydown handler runs before the picker's and cannot see it through the
     * event target — can stand its shortcuts down and close it on Escape, and
     * so a key can open it (`reader.ocr-layers`, #55).
     */
    layersOpen?: boolean;
    /** Whether the menu itself is open. Bindable so a key can open it (`reader.quick-menu`). */
    open?: boolean;
  }

  let {
    left,
    right,
    hasSecondPage = false,
    onAnkiImage,
    onZoomFit,
    visible = true,
    onEdit,
    editEnabled = false,
    editBlockedReason,
    editing = false,
    layers = [],
    currentLayer = null,
    primaryLayerName = 'Primary',
    canPublishLayers = false,
    layerStatus = null,
    onSelectLayer,
    onLayerAction,
    layersOpen = $bindable(false),
    open = $bindable(false)
  }: Props = $props();

  // The menu's button shows with the reader controls, when the setting has it.
  let buttonShown = $derived($settings.quickActions && visible);

  // Hiding the controls (a tap on the page, the setting switched off) puts
  // the menu and the picker away with them, as it always has — so the reader
  // never keeps swallowing its shortcuts for a picker that just went. Only the
  // TRANSITION closes: a key may open either while the button is hidden
  // (#55), and both then render until they are closed.
  let wasShown = false;
  $effect(() => {
    const shown = buttonShown;
    if (wasShown && !shown) {
      layersOpen = false;
      open = false;
    }
    wasShown = shown;
  });
  onDestroy(() => {
    layersOpen = false;
    open = false;
  });

  function handleZoom() {
    onZoomFit?.();
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

  function handleAnki(which: 1 | 2) {
    onAnkiImage?.(which);
    open = false;
  }

  function toggleMenu() {
    open = !open;
  }
</script>

<!-- The picker renders whenever it is open — opened by the menu's button or
     by a key — not only while the menu's button shows. It positions itself. -->
{#if layersOpen}
  <LayerPicker
    {layers}
    current={currentLayer}
    primaryName={primaryLayerName}
    canPublish={canPublishLayers}
    status={layerStatus}
    onSelect={(id) => {
      onSelectLayer?.(id);
      layersOpen = false;
    }}
    onAction={(a, id) => {
      onLayerAction?.(a, id);
      layersOpen = false;
    }}
    onClose={() => (layersOpen = false)}
  />
{/if}

<!-- Open by key (`reader.quick-menu`) shows the menu even with its button
     hidden; the button then comes with it, as the way to close it by touch. -->
{#if buttonShown || open}
  <div class="fixed end-3 bottom-3 z-50 flex flex-col items-center" data-quick-actions>
    <!-- Action buttons (shown when open) -->
    {#if open}
      <div class="mb-2 flex flex-col items-center gap-2">
        {#if layers.length > 0 || editing}
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
            onclick={() => handleAnki(1)}
            class="relative flex h-12 w-12 items-center justify-center rounded-full bg-gray-700 text-gray-300 shadow-lg hover:bg-gray-600 focus:outline-none dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            aria-label="Add image to Anki"
          >
            <ImageOutline size="xl" />
            {#if hasSecondPage}
              <span
                class="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-xs text-white"
                >1</span
              >
            {/if}
          </button>
        {/if}
        {#if $settings.ankiConnectSettings.enabled && hasSecondPage}
          <button
            onclick={() => handleAnki(2)}
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
