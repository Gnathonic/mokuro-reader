<script lang="ts">
  /** The edit-mode toolbar, fixed to the viewport (never scrolls with the page). */
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import {
    CloseOutline,
    GridPlusOutline,
    ObjectsColumnOutline,
    RedoOutline,
    RefreshOutline,
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
  }
  let { session, pageIndex, hasOriginal, onExit, onRevert }: Props = $props();

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
  class="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-gray-900/90 px-3 py-2 shadow-lg"
  data-edit-toolbar
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
  <span class="mx-1 h-6 w-px bg-gray-600"></span>
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
  <button
    class={btn}
    aria-label="Revert page"
    title={`Restore page ${pageIndex + 1}'s original OCR`}
    disabled={!hasOriginal}
    onclick={onRevert}
  >
    <RefreshOutline />
  </button>
  <span class="mx-1 h-6 w-px bg-gray-600"></span>
  <button class={btn} aria-label="Exit edit mode" title="Exit edit mode (Esc)" onclick={onExit}>
    <CloseOutline />
  </button>
</div>
