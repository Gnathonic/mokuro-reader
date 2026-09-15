<script lang="ts">
  /**
   * The reader's layer switcher: Primary plus every layer of the volume with
   * its kind badge, each with its actions. Selecting writes the volume's
   * `ocrLayer` setting through the reader (`onSelect`); actions go to the
   * shared orchestrator (`onAction`).
   */
  import type { LayerSummary } from '$lib/reader/edit/layer-list';
  import { LAYER_KIND_LABEL } from '$lib/reader/edit/layers';
  import { ORIGINAL_LAYER_ID } from '$lib/reader/edit/edit-persist';
  import type { LayerAction } from './layer-actions';
  import {
    ArrowUpOutline,
    CloseOutline,
    DownloadOutline,
    EditOutline,
    PlusOutline,
    TrashBinOutline
  } from 'flowbite-svelte-icons';

  interface Props {
    layers: LayerSummary[];
    current: string | null;
    onSelect: (layerId: string | null) => void;
    onAction: (action: LayerAction, layerId: string | null) => void;
    onClose: () => void;
  }
  let { layers, current, onSelect, onAction, onClose }: Props = $props();

  const row =
    'flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-gray-600 aria-checked:bg-gray-600';
  const icon = 'rounded p-1 text-gray-300 hover:bg-gray-500 hover:text-white';
</script>

<div
  role="dialog"
  aria-label="OCR layers"
  class="fixed end-3 bottom-20 z-50 w-72 rounded-lg bg-gray-700 p-2 text-gray-100 shadow-xl"
>
  <div class="mb-1 flex items-center justify-between px-1">
    <span class="text-xs font-semibold tracking-wide text-gray-300 uppercase">OCR layers</span>
    <button class={icon} aria-label="Close layers" onclick={onClose}
      ><CloseOutline size="sm" /></button
    >
  </div>
  <div class="flex items-center">
    <button role="radio" aria-checked={current === null} class={row} onclick={() => onSelect(null)}>
      <span class="flex-1 truncate">Primary</span>
      <span class="rounded bg-gray-800 px-1 text-[10px]">Primary</span>
    </button>
  </div>
  {#each layers as layer (layer.layer_id)}
    <div class="flex items-center">
      <button
        role="radio"
        aria-checked={current === layer.layer_id}
        class={row}
        onclick={() => onSelect(layer.layer_id)}
      >
        <span class="flex-1 truncate">{layer.name}</span>
        <span class="rounded bg-gray-800 px-1 text-[10px]">{LAYER_KIND_LABEL[layer.kind]}</span>
      </button>
      <div class="flex shrink-0">
        {#if layer.layer_id !== ORIGINAL_LAYER_ID}
          <button
            class={icon}
            aria-label={`Rename layer ${layer.name}`}
            title="Rename"
            onclick={() => onAction('rename', layer.layer_id)}><EditOutline size="sm" /></button
          >
          <button
            class={icon}
            aria-label={`Promote layer ${layer.name}`}
            title="Promote to primary"
            onclick={() => onAction('promote', layer.layer_id)}><ArrowUpOutline size="sm" /></button
          >
        {/if}
        <button
          class={icon}
          aria-label={`Export layer ${layer.name}`}
          title="Export as .mokuro"
          onclick={() => onAction('export', layer.layer_id)}><DownloadOutline size="sm" /></button
        >
        {#if layer.layer_id !== ORIGINAL_LAYER_ID}
          <button
            class={icon}
            aria-label={`Delete layer ${layer.name}`}
            title="Delete"
            onclick={() => onAction('delete', layer.layer_id)}><TrashBinOutline size="sm" /></button
          >
        {/if}
      </div>
    </div>
  {/each}
  <button
    class="mt-1 flex w-full items-center gap-2 rounded border-t border-gray-600 px-2 py-2 text-left text-sm hover:bg-gray-600"
    aria-label="New layer"
    onclick={() => onAction('new', null)}
  >
    <PlusOutline size="sm" /><span>New layer…</span>
  </button>
</div>
