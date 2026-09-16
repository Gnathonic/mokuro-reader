<script lang="ts">
  /** The edit-mode toolbar, fixed to the viewport (never scrolls with the
   * page), dockable to any edge so it never sits over what is being edited. */
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import { nextLayerId, prevLayerId, type LayerSummary } from '$lib/reader/edit/layer-list';
  import type { EditToolbarDock } from '$lib/settings/misc';
  import {
    ChevronDownOutline,
    ChevronLeftOutline,
    ChevronRightOutline,
    ChevronUpOutline,
    CloseOutline,
    GridPlusOutline,
    ObjectsColumnOutline,
    LanguageOutline,
    RedoOutline,
    RefreshOutline,
    RestoreWindowOutline,
    SearchOutline,
    TextSizeOutline,
    TrashBinOutline,
    UndoOutline
  } from 'flowbite-svelte-icons';

  interface Props {
    session: EditSession;
    pageIndex: number;
    hasOriginal: boolean;
    onExit: () => void;
    onRevert: () => void;
    /** Engine entry points — given only when the matching key is configured. */
    onOcrPage?: () => void;
    onTranslatePage?: () => void;
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
    onOcrPage,
    onTranslatePage,
    layers = [],
    currentLayer = null,
    primaryName = 'Primary',
    onSelectLayer,
    dock = 'top',
    onDockChange
  }: Props = $props();

  const DOCK_ORDER: EditToolbarDock[] = ['top', 'right', 'bottom', 'left'];
  const nextDock = $derived(DOCK_ORDER[(DOCK_ORDER.indexOf(dock) + 1) % DOCK_ORDER.length]);
  let vertical = $derived(dock === 'left' || dock === 'right');
  // Full class strings per edge (Tailwind scans literals, never templates).
  const DOCK_CLASS: Record<EditToolbarDock, string> = {
    top: 'top-3 left-1/2 -translate-x-1/2 flex-row rounded-full',
    bottom: 'bottom-3 left-1/2 -translate-x-1/2 flex-row rounded-full',
    left: 'left-3 top-1/2 -translate-y-1/2 flex-col rounded-3xl',
    right: 'right-3 top-1/2 -translate-y-1/2 flex-col rounded-3xl'
  };
  let divider = $derived(vertical ? 'my-1 h-px w-6 bg-gray-600' : 'mx-1 h-6 w-px bg-gray-600');

  let hasLayers = $derived(!!onSelectLayer && layers.length > 0);
  let currentLayerName = $derived(
    currentLayer === null
      ? primaryName
      : (layers.find((l) => l.layer_id === currentLayer)?.name ?? currentLayer)
  );

  let selected = $derived(session.selection);
  let single = $derived(
    selected.length === 1
      ? session.pageFor(selected[0].pageIndex).blocks[selected[0].blockIndex]
      : null
  );
  // Split happens BEFORE the selected line, so it needs a single block with a
  // line chosen inside it that is not the first one.
  let splitLine = $derived(
    single && selected.length === 1 && session.selectedLine
      ? session.selectedLine.pageIndex === selected[0].pageIndex &&
        session.selectedLine.blockIndex === selected[0].blockIndex
        ? session.selectedLine.lineIndex
        : null
      : null
  );
  let canSplit = $derived(
    !!single && single.lines.length >= 2 && splitLine !== null && splitLine >= 1
  );
  let canPlaceLines = $derived(
    !!single && !(single.lines_coords && single.lines_coords.length === single.lines.length)
  );

  const btn =
    'flex h-10 w-10 items-center justify-center rounded-full bg-gray-700 text-gray-200 shadow hover:bg-gray-600 focus:outline-none disabled:opacity-40 disabled:hover:bg-gray-700';
</script>

<div
  class={`fixed z-50 flex items-center gap-2 bg-gray-900/90 shadow-lg ${vertical ? 'px-2 py-3' : 'px-3 py-2'} ${DOCK_CLASS[dock]}`}
  data-edit-toolbar
  data-dock={dock}
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
    title="Delete selected (Del)"
    disabled={selected.length === 0}
    onclick={() => session.deleteSelected()}
  >
    <TrashBinOutline />
  </button>
  <button
    class={btn}
    aria-label="Merge"
    title="Merge selected boxes"
    disabled={selected.length < 2}
    onclick={() => session.mergeSelected()}
  >
    <ObjectsColumnOutline />
  </button>
  <button
    class={btn}
    aria-label="Split"
    title="Split the box before the selected line (click a line inside the selected box first)"
    disabled={!canSplit}
    onclick={() => splitLine !== null && session.splitSelected(splitLine)}
  >
    <span class="text-xs font-bold">S</span>
  </button>
  <button
    class={btn}
    aria-label="Place lines"
    title="Give this box one positionable line per OCR line"
    disabled={!canPlaceLines}
    onclick={() => selected[0] && session.placeLines(selected[0].pageIndex, selected[0].blockIndex)}
  >
    <span class="text-xs font-bold">≡</span>
  </button>
  <button
    class={btn}
    aria-label="Flip writing mode"
    title="Toggle vertical / horizontal"
    disabled={selected.length === 0}
    onclick={() => session.flipSelected()}
  >
    <TextSizeOutline />
  </button>
  <span class={divider}></span>
  <button
    class={btn}
    aria-label="Undo"
    title="Undo (Ctrl+Z)"
    disabled={!session.canUndo(pageIndex)}
    onclick={() => session.undo(pageIndex)}
  >
    <UndoOutline />
  </button>
  <button
    class={btn}
    aria-label="Redo"
    title="Redo (Ctrl+Shift+Z)"
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
      title="Next OCR layer (L)"
      disabled={!hasLayers}
      onclick={() => onSelectLayer?.(nextLayerId(currentLayer, layers))}
    >
      {#if vertical}<ChevronDownOutline />{:else}<ChevronRightOutline />{/if}
    </button>
  {/if}
  {#if onOcrPage || onTranslatePage}
    <span class={divider}></span>
    {#if onOcrPage}
      <button
        class={btn}
        aria-label="OCR this page"
        title="Re-OCR this page with Google Cloud Vision (experimental) → 'Cloud Vision' layer"
        onclick={onOcrPage}
      >
        <SearchOutline />
      </button>
    {/if}
    {#if onTranslatePage}
      <button
        class={btn}
        aria-label="Translate this page"
        title="Translate this page (experimental) → 'Translation' layer"
        onclick={onTranslatePage}
      >
        <LanguageOutline />
      </button>
    {/if}
  {/if}
  <button
    class={btn}
    aria-label="Revert page"
    title={`Restore page ${pageIndex + 1}'s original OCR`}
    disabled={!hasOriginal}
    onclick={onRevert}
  >
    <RefreshOutline />
  </button>
  <span class={divider}></span>
  {#if onDockChange}
    <button
      class={btn}
      aria-label="Move toolbar"
      title={`Dock the toolbar to the ${nextDock} (now: ${dock})`}
      onclick={() => onDockChange?.(nextDock)}
    >
      <RestoreWindowOutline />
    </button>
  {/if}
  <button class={btn} aria-label="Exit edit mode" title="Exit edit mode (Esc)" onclick={onExit}>
    <CloseOutline />
  </button>
</div>
