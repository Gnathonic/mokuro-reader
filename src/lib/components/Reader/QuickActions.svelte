<script lang="ts">
  import { settings } from '$lib/settings';
  import { PlusOutline } from 'flowbite-svelte-icons';
  import { actionIcon } from '$lib/keys/icons';
  import type { QuickMenuItem } from '$lib/keys/quick-menu';
  import LayerPicker from './Layers/LayerPicker.svelte';
  import type { LayerSummary } from '$lib/reader/edit/layer-list';
  import type { LayerAction } from './Layers/layer-actions';
  import { onDestroy } from 'svelte';

  /**
   * The reader's quick menu (#55, spec 17.7). It draws what the registry and
   * the profile's selection give it and owns no action: every entry is an
   * action id the reader runs through the SAME resolver its keys use, so a
   * tap and a key are one handler. What is on the menu, in what order and in
   * what state is `quick-menu.ts` plus one `$derived` in Reader.svelte.
   */
  interface Props {
    /** The menu's entries, top to bottom. Read only while the menu is open. */
    items?: QuickMenuItem[];
    /** Run an action as its key would. */
    onRun?: (id: string) => void;
    visible?: boolean;
    /** OCR layers of the volume, for the picker. */
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
     * so an action can open it (`reader.ocr-layers`, by key or from this menu).
     */
    layersOpen?: boolean;
    /** Whether the menu itself is open. Bindable so a key can open it (`reader.quick-menu`). */
    open?: boolean;
  }

  let {
    items = [],
    onRun,
    visible = true,
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

  function run(item: QuickMenuItem) {
    if (item.disabled) return;
    // A step (brightness up, zoom in) keeps the menu up for the next tap.
    if (!item.keepOpen) open = false;
    onRun?.(item.id);
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
  <div class="fixed end-3 bottom-3 z-50 flex flex-col items-end" data-quick-actions>
    <!-- The entries, top to bottom. One column while it fits the screen; more
         than that wraps into further columns toward the centre of the screen,
         so the first column — the defaults — stays where it has always been. -->
    {#if open}
      <div class="quick-menu-items mb-2 flex flex-col flex-wrap-reverse justify-end gap-2">
        {#each items as item (item.id)}
          {@const Icon = actionIcon(item.icon)}
          <button
            onclick={() => run(item)}
            disabled={!!item.disabled}
            title={item.disabled ?? item.label}
            aria-label={item.label}
            aria-pressed={item.active}
            data-quick-action={item.id}
            class="relative flex h-12 w-12 items-center justify-center rounded-full text-gray-300 shadow-lg focus:outline-none disabled:opacity-40 {item.active
              ? 'bg-primary-700 hover:bg-primary-600 disabled:hover:bg-primary-700'
              : 'bg-gray-700 hover:bg-gray-600 disabled:hover:bg-gray-700'}"
          >
            <Icon size="xl" />
            {#if item.badge}
              <span
                class="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-600 px-1 text-xs leading-none text-white"
                data-quick-action-badge>{item.badge}</span
              >
            {/if}
          </button>
        {/each}
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

<style>
  /* One column as tall as the screen allows above the menu's own button
     (3rem + its 0.75rem inset + the gap, and a margin at the top). */
  .quick-menu-items {
    max-height: calc(100dvh - 5.5rem);
  }
</style>
