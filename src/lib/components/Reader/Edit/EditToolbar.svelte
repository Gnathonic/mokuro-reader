<script lang="ts">
  /** The edit-mode toolbar, fixed to the viewport (never scrolls with the
   * page), dockable to any edge so it never sits over what is being edited. */
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import { editCommandState } from '$lib/reader/edit/edit-commands';
  import { nextLayerId, prevLayerId, type LayerSummary } from '$lib/reader/edit/layer-list';
  import type { EditToolbarDock } from '$lib/settings/misc';
  import { keyHints } from '$lib/keys/live';
  import {
    ChevronDownOutline,
    ChevronLeftOutline,
    ChevronRightOutline,
    ChevronUpOutline,
    CloseOutline,
    GridPlusOutline,
    ObjectsColumnOutline,
    RedoOutline,
    RefreshOutline,
    RestoreWindowOutline,
    TextSizeOutline,
    TrashBinOutline,
    UndoOutline
  } from 'flowbite-svelte-icons';

  /** "Label (key)" with the live binding, or just the label when unbound. */
  function withKey(label: string, key: string): string {
    return key ? `${label} (${key})` : label;
  }

  interface Props {
    session: EditSession;
    pageIndex: number;
    hasOriginal: boolean;
    onExit: () => void;
    onRevert: () => void;
    /** Quick layer swapping: the volume's layers, the displayed one, and the
     * primary row's name. Omitted → no layer strip. */
    layers?: LayerSummary[];
    currentLayer?: string | null;
    primaryName?: string;
    onSelectLayer?: (layerId: string | null) => void;
    /** Dock edge; the toolbar's own button cycles it through `onDockChange`. */
    dock?: EditToolbarDock;
    onDockChange?: (dock: EditToolbarDock) => void;
  }
  let {
    session,
    pageIndex,
    hasOriginal,
    onExit,
    onRevert,
    layers = [],
    currentLayer = null,
    primaryName = 'Primary',
    onSelectLayer,
    dock = 'top',
    onDockChange
  }: Props = $props();

  // Top and left only for now; a stored value outside that set reads as top.
  let effectiveDock = $derived<EditToolbarDock>(dock === 'left' ? 'left' : 'top');
  let nextDock = $derived<EditToolbarDock>(effectiveDock === 'top' ? 'left' : 'top');
  let vertical = $derived(effectiveDock === 'left');
  // Full class strings per edge (Tailwind scans literals, never templates).
  const DOCK_CLASS: Record<EditToolbarDock, string> = {
    top: 'top-3 left-1/2 -translate-x-1/2 flex-row rounded-full',
    left: 'left-3 top-1/2 -translate-y-1/2 flex-col rounded-3xl'
  };
  let divider = $derived(vertical ? 'my-1 h-px w-6 bg-gray-600' : 'mx-1 h-6 w-px bg-gray-600');

  let hasLayers = $derived(!!onSelectLayer && layers.length > 0);
  let currentLayerName = $derived(
    currentLayer === null
      ? primaryName
      : (layers.find((l) => l.layer_id === currentLayer)?.name ?? currentLayer)
  );

  // The same enablement the keys bound to these commands apply
  // (`edit-commands.ts`): a button and its key can never disagree.
  let commands = $derived(editCommandState(session, hasOriginal));

  const btn =
    'flex h-10 w-10 items-center justify-center rounded-full bg-gray-700 text-gray-200 shadow hover:bg-gray-600 focus:outline-none disabled:opacity-40 disabled:hover:bg-gray-700';
</script>

<div
  class={`fixed z-50 flex items-center gap-2 bg-gray-900/90 shadow-lg ${vertical ? 'px-2 py-3' : 'px-3 py-2'} ${DOCK_CLASS[effectiveDock]}`}
  data-edit-toolbar
  data-dock={effectiveDock}
  role="toolbar"
  aria-label="OCR edit tools"
>
  <button
    class={btn}
    class:ring-2={session.tool === 'draw'}
    class:ring-blue-400={session.tool === 'draw'}
    aria-label="Draw new box"
    aria-pressed={session.tool === 'draw'}
    title="Draw a new text box"
    onclick={() => (session.tool = session.tool === 'draw' ? 'select' : 'draw')}
  >
    <GridPlusOutline />
  </button>
  <button
    class={btn}
    aria-label="Delete"
    title={withKey('Delete selected', $keyHints('edit.delete'))}
    disabled={!commands.delete.enabled}
    onclick={() => session.deleteSelected()}
  >
    <TrashBinOutline />
  </button>
  <button
    class={btn}
    aria-label="Merge"
    title="Merge selected boxes"
    disabled={!commands.merge.enabled}
    onclick={() => session.mergeSelected()}
  >
    <ObjectsColumnOutline />
  </button>
  <button
    class={btn}
    aria-label="Split"
    title="Split the box before the selected line (click a line inside the selected box first)"
    disabled={!commands.split.enabled}
    onclick={() => commands.splitLine !== null && session.splitSelected(commands.splitLine)}
  >
    <span class="text-xs font-bold">S</span>
  </button>
  <button
    class={btn}
    aria-label="Place lines"
    title="Give this box one positionable line per OCR line"
    disabled={!commands['place-lines'].enabled}
    onclick={() =>
      commands.single && session.placeLines(commands.single.pageIndex, commands.single.blockIndex)}
  >
    <span class="text-xs font-bold">≡</span>
  </button>
  <button
    class={btn}
    aria-label="Flip writing mode"
    title="Toggle vertical / horizontal"
    disabled={!commands.flip.enabled}
    onclick={() => session.flipSelected()}
  >
    <TextSizeOutline />
  </button>
  <span class={divider}></span>
  <button
    class={btn}
    aria-label="Undo"
    title={withKey('Undo', $keyHints('edit.undo'))}
    disabled={!session.canUndo(pageIndex)}
    onclick={() => session.undo(pageIndex)}
  >
    <UndoOutline />
  </button>
  <button
    class={btn}
    aria-label="Redo"
    title={withKey('Redo', $keyHints('edit.redo'))}
    disabled={!session.canRedo(pageIndex)}
    onclick={() => session.redo(pageIndex)}
  >
    <RedoOutline />
  </button>
  {#if onSelectLayer}
    <span class={divider}></span>
    <!-- Quick layer swap: previous / current name / next, same cycle as the L key. -->
    <button
      class={btn}
      aria-label="Previous layer"
      title="Previous OCR layer"
      disabled={!hasLayers}
      onclick={() => onSelectLayer?.(prevLayerId(currentLayer, layers))}
    >
      {#if vertical}<ChevronUpOutline />{:else}<ChevronLeftOutline />{/if}
    </button>
    <span
      class={`truncate text-center text-xs text-gray-200 ${vertical ? 'max-w-10' : 'max-w-28'}`}
      title={`OCR layer: ${currentLayerName}`}
      data-edit-toolbar-layer>{currentLayerName}</span
    >
    <button
      class={btn}
      aria-label="Next layer"
      title={withKey('Next OCR layer', $keyHints('reader.ocr-layer'))}
      disabled={!hasLayers}
      onclick={() => onSelectLayer?.(nextLayerId(currentLayer, layers))}
    >
      {#if vertical}<ChevronDownOutline />{:else}<ChevronRightOutline />{/if}
    </button>
  {/if}
  <button
    class={btn}
    aria-label="Revert page"
    title={`Restore page ${pageIndex + 1}'s original OCR`}
    disabled={!commands['revert-page'].enabled}
    onclick={onRevert}
  >
    <RefreshOutline />
  </button>
  <span class={divider}></span>
  {#if onDockChange}
    <button
      class={btn}
      aria-label="Move toolbar"
      title={`Dock the toolbar to the ${nextDock} (now: ${effectiveDock})`}
      onclick={() => onDockChange?.(nextDock)}
    >
      <RestoreWindowOutline />
    </button>
  {/if}
  <button
    class={btn}
    aria-label="Exit edit mode"
    title={withKey('Exit edit mode', $keyHints('edit.back'))}
    onclick={onExit}
  >
    <CloseOutline />
  </button>
</div>
