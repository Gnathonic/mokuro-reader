<script lang="ts">
  /**
   * One OCR block in edit mode. Class `editBlock` (never `.textBox`) — the
   * gesture role 'editor' — so the surface never pans, taps or Anki-captures
   * from a press here; the block captures its own pointers instead.
   *
   * Body drag = move, handle drag = resize, click = select (shift adds),
   * double click = inline line editor (Enter inserts a line, Backspace on an
   * empty line removes it, Escape / focus loss commits).
   */
  import type { Block } from '$lib/types';
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import { layoutLines, getDefaultMeasurer } from '$lib/reader/line-coords-layout';
  import { settings } from '$lib/settings';
  import { tick } from 'svelte';

  interface Props {
    block: Block;
    index: number;
    pageIndex: number;
    selected: boolean;
    session: EditSession;
    /** Screen px per image px, read at drag time (zoom-aware). */
    scale: () => number;
  }
  let { block, index, pageIndex, selected, session, scale }: Props = $props();

  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
  type Handle = (typeof HANDLES)[number];

  interface DraftLine {
    id: number;
    text: string;
  }
  let editing = $state(false);
  let draft = $state<DraftLine[]>([]);
  let nextId = 0;
  let root: HTMLDivElement | undefined = $state();

  let left = $derived(block.box[0]);
  let top = $derived(block.box[1]);
  let width = $derived(block.box[2] - block.box[0]);
  let height = $derived(block.box[3] - block.box[1]);
  let writingMode = $derived(block.vertical ? 'vertical-rl' : 'horizontal-tb');
  let fontSize = $derived(
    $settings.fontSize === 'auto' || $settings.fontSize === 'original'
      ? `${block.font_size}px`
      : `${$settings.fontSize}pt`
  );
  // Per-line quads → absolute positions. Edit mode needs no Yomitan
  // continuity, so plain absolute placement is fine here.
  let lineLayouts = $derived(
    $settings.fontSize === 'auto' && !editing
      ? layoutLines(block, block.lines, getDefaultMeasurer())
      : null
  );

  // ---- pointer: click/select, drag-move, handle-resize ----
  interface Drag {
    id: number;
    kind: 'move' | Handle;
    startX: number;
    startY: number;
    box: number[];
    moved: boolean;
    key: string;
  }
  let drag: Drag | null = null;

  function onPointerDown(e: PointerEvent, kind: 'move' | Handle) {
    if (e.button !== 0 || editing) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    drag = {
      id: e.pointerId,
      kind,
      startX: e.clientX,
      startY: e.clientY,
      box: block.box.slice(),
      moved: false,
      key: `${kind}:${pageIndex}:${index}:${e.pointerId}`
    };
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const s = scale() || 1;
    const dx = (e.clientX - drag.startX) / s;
    const dy = (e.clientY - drag.startY) / s;
    if (!drag.moved && Math.hypot(dx, dy) * s < 3) return;
    drag.moved = true;
    if (!selected) session.select(pageIndex, index);
    const [x0, y0, x1, y1] = drag.box;
    if (drag.kind === 'move') {
      const cur = session.pageFor(pageIndex).blocks[index].box;
      session.move(pageIndex, index, x0 + dx - cur[0], y0 + dy - cur[1], drag.key);
      return;
    }
    const k = drag.kind;
    const nx0 = k.includes('w') ? x0 + dx : x0;
    const nx1 = k.includes('e') ? x1 + dx : x1;
    const ny0 = k.includes('n') ? y0 + dy : y0;
    const ny1 = k.includes('s') ? y1 + dy : y1;
    session.resize(pageIndex, index, [nx0, ny0, nx1, ny1], drag.key);
  }

  function onPointerUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (!drag.moved) session.select(pageIndex, index, e.shiftKey);
    drag = null;
  }

  // ---- text editing ----
  async function openEditor(e: MouseEvent) {
    e.stopPropagation();
    if (editing) return;
    draft = block.lines.map((text) => ({ id: nextId++, text }));
    editing = true;
    session.select(pageIndex, index);
    await tick();
    focusLine(0);
  }

  function commitEditor() {
    if (!editing) return;
    editing = false;
    const lines = draft.map((l) => l.text.replace(/[\n\r]/g, ''));
    const changed =
      lines.length !== block.lines.length || lines.some((l, i) => l !== block.lines[i]);
    if (changed) session.setLines(pageIndex, index, lines);
  }

  /** Set the line's text once at mount — never re-rendered, so the caret is
   * never fought while the user types. */
  function initText(el: HTMLElement, text: string) {
    el.textContent = text;
  }

  function onLineInput(i: number, e: Event) {
    draft[i].text = (e.currentTarget as HTMLElement).textContent ?? '';
  }

  async function onLineKeyDown(i: number, e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      draft.splice(i + 1, 0, { id: nextId++, text: '' });
      await tick();
      focusLine(i + 1);
    } else if (e.key === 'Backspace' && draft[i].text === '' && draft.length > 1) {
      e.preventDefault();
      e.stopPropagation();
      draft.splice(i, 1);
      await tick();
      focusLine(Math.max(0, i - 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      commitEditor();
    } else {
      // Typing must never reach the reader's shortcuts.
      e.stopPropagation();
    }
  }

  function focusLine(i: number) {
    root?.querySelectorAll<HTMLElement>('[contenteditable]')[i]?.focus();
  }

  function onFocusOut(e: FocusEvent) {
    if (!editing) return;
    const next = e.relatedTarget as Node | null;
    if (next && root?.contains(next)) return;
    commitEditor();
  }
</script>

<div
  bind:this={root}
  class="editBlock"
  class:selected
  class:editing
  role="none"
  style:left={`${left}px`}
  style:top={`${top}px`}
  style:width={`${width}px`}
  style:height={`${height}px`}
  style:font-size={fontSize}
  style:writing-mode={writingMode}
  onpointerdown={(e) => onPointerDown(e, 'move')}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  ondblclick={openEditor}
  onfocusout={onFocusOut}
>
  {#if editing}
    <div class="lines">
      {#each draft as line, i (line.id)}
        <div
          class="line"
          contenteditable="true"
          role="textbox"
          tabindex="0"
          use:initText={line.text}
          oninput={(e) => onLineInput(i, e)}
          onkeydown={(e) => onLineKeyDown(i, e)}
        ></div>
      {/each}
    </div>
  {:else if lineLayouts}
    {#each block.lines as line, i (i)}
      {#if !lineLayouts[i].hidden}
        <span
          class="line positioned"
          style:left={`${lineLayouts[i].left}px`}
          style:top={`${lineLayouts[i].top}px`}
          style:font-size={`${lineLayouts[i].fontSize}px`}>{line}</span
        >
      {/if}
    {/each}
  {:else}
    <div class="lines">
      {#each block.lines as line, i (i)}<span class="line">{line}</span>{/each}
    </div>
  {/if}
  {#if selected && !editing}
    {#each HANDLES as h (h)}
      <span
        data-edit-handle={h}
        class={`handle handle-${h}`}
        role="none"
        onpointerdown={(e) => onPointerDown(e, h)}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      ></span>
    {/each}
  {/if}
</div>

<style>
  .editBlock {
    position: absolute;
    box-sizing: border-box;
    border: 1px dashed rgba(220, 38, 38, 0.8);
    background: rgba(255, 255, 255, 0.85);
    color: black;
    font-family: 'Noto Sans JP', sans-serif;
    line-height: 1.1em;
    z-index: 12;
    cursor: move;
    user-select: none;
    touch-action: none;
  }
  .editBlock.selected {
    border: 2px solid rgb(37, 99, 235);
    z-index: 13;
  }
  .editBlock.editing {
    cursor: text;
    user-select: text;
  }
  .lines {
    width: 100%;
    height: 100%;
    overflow: hidden;
    letter-spacing: 0.1em;
  }
  .line {
    display: block;
    white-space: nowrap;
    outline: none;
    min-width: 1em;
    min-height: 1em;
  }
  .line.positioned {
    position: absolute;
    line-height: 1;
    letter-spacing: 0;
  }
  .editing .line {
    border-bottom: 1px dotted rgba(37, 99, 235, 0.6);
  }
  .handle {
    position: absolute;
    width: 10px;
    height: 10px;
    background: rgb(37, 99, 235);
    border: 1px solid white;
    border-radius: 2px;
    z-index: 14;
    touch-action: none;
  }
  .handle-nw {
    left: -6px;
    top: -6px;
    cursor: nwse-resize;
  }
  .handle-n {
    left: calc(50% - 5px);
    top: -6px;
    cursor: ns-resize;
  }
  .handle-ne {
    right: -6px;
    top: -6px;
    cursor: nesw-resize;
  }
  .handle-e {
    right: -6px;
    top: calc(50% - 5px);
    cursor: ew-resize;
  }
  .handle-se {
    right: -6px;
    bottom: -6px;
    cursor: nwse-resize;
  }
  .handle-s {
    left: calc(50% - 5px);
    bottom: -6px;
    cursor: ns-resize;
  }
  .handle-sw {
    left: -6px;
    bottom: -6px;
    cursor: nesw-resize;
  }
  .handle-w {
    left: -6px;
    top: calc(50% - 5px);
    cursor: ew-resize;
  }
</style>
