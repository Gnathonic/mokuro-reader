<script lang="ts">
  /**
   * Edit-mode replacement for `TextBoxes`: every RAW block of the page (no
   * dedupe — duplicates are exactly what a user may want to delete) as an
   * `EditableBlock`, plus the "draw new box" drag on the page background.
   * Mounted by `MangaPage` in the page's own coordinate space.
   */
  import type { Page } from '$lib/types';
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import { pageScaleOf } from '$lib/reader/edit/edit-context';
  import EditableBlock from './EditableBlock.svelte';

  interface Props {
    page: Page;
    pageIndex: number;
    session: EditSession;
  }
  let { page, pageIndex, session }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let working = $derived(session.pageFor(pageIndex));
  const scale = () => pageScaleOf(root, page);

  interface Draft {
    id: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }
  let draw = $state<Draft | null>(null);

  function toImage(e: PointerEvent): [number, number] {
    const rect = root!.getBoundingClientRect();
    const s = scale() || 1;
    return [(e.clientX - rect.left) / s, (e.clientY - rect.top) / s];
  }

  function onBackgroundDown(e: PointerEvent) {
    if (e.target !== root) return; // a block handled it
    if (session.tool !== 'draw' || e.button !== 0) {
      // A plain press on the background clears the selection; the press
      // itself still reaches the surface (pan / tap) — we do not stop it.
      session.clearSelection();
      return;
    }
    e.stopPropagation();
    root!.setPointerCapture?.(e.pointerId);
    const [x, y] = toImage(e);
    draw = { id: e.pointerId, x0: x, y0: y, x1: x, y1: y };
  }
  function onBackgroundMove(e: PointerEvent) {
    if (!draw || e.pointerId !== draw.id) return;
    const [x, y] = toImage(e);
    draw = { ...draw, x1: x, y1: y };
  }
  function onBackgroundUp(e: PointerEvent) {
    if (!draw || e.pointerId !== draw.id) return;
    e.stopPropagation();
    root!.releasePointerCapture?.(e.pointerId);
    const { x0, y0, x1, y1 } = draw;
    draw = null;
    if (Math.abs(x1 - x0) >= 8 && Math.abs(y1 - y0) >= 8) {
      session.add(pageIndex, [
        Math.min(x0, x1),
        Math.min(y0, y1),
        Math.max(x0, x1),
        Math.max(y0, y1)
      ]);
      session.tool = 'select';
    }
  }
</script>

<div
  bind:this={root}
  class="editOverlay"
  class:drawing={session.tool === 'draw'}
  data-edit-overlay
  role="none"
  onpointerdown={onBackgroundDown}
  onpointermove={onBackgroundMove}
  onpointerup={onBackgroundUp}
  onpointercancel={onBackgroundUp}
>
  {#each working.blocks as block, index (`${pageIndex}-${index}`)}
    <EditableBlock
      {block}
      {index}
      {pageIndex}
      {session}
      {scale}
      selected={session.isSelected(pageIndex, index)}
    />
  {/each}
  {#if draw}
    <div
      class="draft"
      style:left={`${Math.min(draw.x0, draw.x1)}px`}
      style:top={`${Math.min(draw.y0, draw.y1)}px`}
      style:width={`${Math.abs(draw.x1 - draw.x0)}px`}
      style:height={`${Math.abs(draw.y1 - draw.y0)}px`}
    ></div>
  {/if}
</div>

<style>
  .editOverlay {
    position: absolute;
    inset: 0;
    z-index: 11;
  }
  .editOverlay.drawing {
    cursor: crosshair;
  }
  .draft {
    position: absolute;
    border: 2px dashed rgb(37, 99, 235);
    background: rgba(37, 99, 235, 0.1);
    pointer-events: none;
  }
</style>
