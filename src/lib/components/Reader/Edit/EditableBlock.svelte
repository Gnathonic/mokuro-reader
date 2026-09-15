<script lang="ts">
  /**
   * One OCR block in edit mode. Class `editBlock` (never `.textBox`) — the
   * gesture role 'editor' — so the surface never pans, taps or Anki-captures
   * from a press here; the block captures its own pointers instead.
   *
   * LINE-CENTRIC: when the block has quads (`lines_coords`), every line is
   * rendered AT its quad, with its own orientation (taller than wide →
   * vertical) and its own font size (the quad's cross-axis extent) — whatever
   * the reader's font setting says, and whatever the block flag says (mokuro
   * mixes orientations inside one block). The contenteditable element IS the
   * positioned line, grows along its writing axis as text is typed and is
   * never clipped; typing in one line never moves another.
   *
   * Body drag = move block, corner/edge handle drag = resize block, click =
   * select block (shift adds). Inside the selected block a click on a line
   * selects THAT line, a drag on it moves its quad, and its two handles resize
   * it (end = length, side = thickness → font size). Double click opens the
   * line editor: Enter inserts a line (with an adjacent quad), Backspace on an
   * empty line removes it, Escape / focus loss commits.
   *
   * A block without quads renders its lines in flow at a size that fits them
   * all; the toolbar's "Place lines" gives it quads.
   */
  import type { Block } from '$lib/types';
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import { lineGeometry, rectQuad, type LineGeometry } from '$lib/reader/edit/block-geometry';
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

  let editing = $state(false);
  let root: HTMLDivElement | undefined = $state();

  let left = $derived(block.box[0]);
  let top = $derived(block.box[1]);
  let width = $derived(block.box[2] - block.box[0]);
  let height = $derived(block.box[3] - block.box[1]);

  /** Quads parallel to the lines → positioned rendering; otherwise flow. */
  // Sized by the FITTED size (text fills the quad's length, capped by its
  // thickness) — a mis-detected fat quad must not explode across the page.
  let geoms = $derived<LineGeometry[] | null>(
    block.lines_coords && block.lines_coords.length === block.lines.length
      ? block.lines_coords.map((q, i) => lineGeometry(q, block.lines[i]))
      : null
  );
  /** Flow blocks: a size at which every line fits the box. */
  let flowFontSize = $derived.by(() => {
    const n = Math.max(1, block.lines.length);
    const cross = block.vertical ? width : height;
    return Math.max(4, Math.min(block.font_size, Math.floor(cross / n)));
  });

  let selectedLineIndex = $derived(
    session.selectedLine &&
      session.selectedLine.pageIndex === pageIndex &&
      session.selectedLine.blockIndex === index
      ? session.selectedLine.lineIndex
      : null
  );

  // Stable identities for the line elements, so inserting/removing a line
  // never re-renders (and never resets the caret of) its neighbours.
  let nextId = 0;
  let lineIds = $state<number[]>([]);
  $effect(() => {
    const n = block.lines.length;
    if (lineIds.length === n) return;
    // Structural change made outside the editor (undo, revert): re-key all.
    lineIds = Array.from({ length: n }, () => nextId++);
  });
  let draft: string[] = [];

  // ---- pointer: block select / move / resize, line select / move / resize ----
  type LineKind = { line: number; part: 'move' | 'end' | 'side' };
  type Kind = 'move' | Handle | LineKind;
  interface Drag {
    id: number;
    kind: Kind;
    startX: number;
    startY: number;
    box: number[];
    moved: boolean;
    key: string;
  }
  let drag: Drag | null = null;

  function beginDrag(e: PointerEvent, kind: Kind, box: number[]) {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const keyKind = typeof kind === 'string' ? kind : `line${kind.line}:${kind.part}`;
    drag = {
      id: e.pointerId,
      kind,
      startX: e.clientX,
      startY: e.clientY,
      box,
      moved: false,
      key: `${keyKind}:${pageIndex}:${index}:${e.pointerId}`
    };
  }

  function onPointerDown(e: PointerEvent, kind: 'move' | Handle) {
    if (e.button !== 0 || editing) return;
    beginDrag(e, kind, block.box.slice());
  }

  function onLinePointerDown(e: PointerEvent, lineIndex: number, part: LineKind['part']) {
    if (e.button !== 0 || editing || !geoms) return;
    // A line is only its own object inside the selected block; otherwise the
    // press belongs to the block (select / move) and bubbles up to it.
    if (!selected || session.selection.length !== 1) return;
    const g = geoms[lineIndex];
    beginDrag(e, { line: lineIndex, part }, [g.left, g.top, g.left + g.width, g.top + g.height]);
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const s = scale() || 1;
    const dx = (e.clientX - drag.startX) / s;
    const dy = (e.clientY - drag.startY) / s;
    if (!drag.moved && Math.hypot(dx, dy) * s < 3) return;
    drag.moved = true;
    const [x0, y0, x1, y1] = drag.box;
    const k = drag.kind;
    if (typeof k !== 'string') {
      const cur = session.pageFor(pageIndex).blocks[index].lines_coords?.[k.line];
      if (!cur) return;
      const g = lineGeometry(cur);
      if (k.part === 'move') {
        session.moveLine(pageIndex, index, k.line, x0 + dx - g.left, y0 + dy - g.top, drag.key);
        return;
      }
      // end = length along the writing axis; side = thickness (→ font size)
      let nx0 = x0,
        ny0 = y0,
        nx1 = x1,
        ny1 = y1;
      if (g.vertical) {
        if (k.part === 'end') ny1 = y1 + dy;
        else nx0 = x0 + dx;
      } else if (k.part === 'end') nx1 = x1 + dx;
      else ny1 = y1 + dy;
      session.resizeLine(
        pageIndex,
        index,
        k.line,
        rectQuad(nx0, ny0, nx1 - nx0, ny1 - ny0),
        drag.key
      );
      return;
    }
    if (!selected) session.select(pageIndex, index);
    if (k === 'move') {
      const cur = session.pageFor(pageIndex).blocks[index].box;
      session.move(pageIndex, index, x0 + dx - cur[0], y0 + dy - cur[1], drag.key);
      return;
    }
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
    if (!drag.moved) {
      const k = drag.kind;
      if (typeof k !== 'string') session.selectLine(pageIndex, index, k.line);
      else session.select(pageIndex, index, e.shiftKey);
    }
    drag = null;
  }

  // ---- text editing ----
  async function openEditor(e?: MouseEvent, focusLineIndex = 0) {
    e?.stopPropagation();
    if (editing) return;
    draft = block.lines.slice();
    editing = true;
    session.select(pageIndex, index);
    await tick();
    focusLine(focusLineIndex);
  }

  /** Write the typed texts back (same line count → quads are kept). */
  function commitTexts() {
    const lines = draft.map((l) => l.replace(/[\n\r]/g, ''));
    const changed =
      lines.length !== block.lines.length || lines.some((l, i) => l !== block.lines[i]);
    if (changed) session.setLines(pageIndex, index, lines);
  }

  function closeEditor() {
    if (!editing) return;
    commitTexts();
    editing = false;
  }

  /** Own the line's text imperatively: written at mount and again whenever
   * the MODEL changes under a stable element (undo, redo, revert, a merge that
   * rewrites a neighbour). While the user types, the model only changes when
   * the draft is committed — to exactly what the element already holds — so
   * the equality guard keeps the caret from ever being fought mid-edit. */
  function initText(el: HTMLElement, text: string) {
    el.textContent = text;
    return {
      update(next: string) {
        if (el.textContent !== next) el.textContent = next;
      }
    };
  }

  function onLineInput(i: number, e: Event) {
    draft[i] = (e.currentTarget as HTMLElement).textContent ?? '';
  }

  async function onLineKeyDown(i: number, e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commitTexts();
      const at = session.insertLine(pageIndex, index, i);
      draft.splice(at, 0, '');
      lineIds.splice(at, 0, nextId++);
      await tick();
      focusLine(at);
    } else if (e.key === 'Backspace' && draft[i] === '' && draft.length > 1) {
      e.preventDefault();
      e.stopPropagation();
      commitTexts();
      session.removeLine(pageIndex, index, i);
      draft.splice(i, 1);
      lineIds.splice(i, 1);
      await tick();
      focusLine(Math.max(0, i - 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeEditor();
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
    closeEditor();
  }

  // The context menu's "Edit this text": open the editor on this block.
  $effect(() => {
    const f = session.pendingFocus;
    if (!f || f.pageIndex !== pageIndex || f.blockIndex !== index) return;
    session.pendingFocus = null;
    void openEditor(undefined, f.lineIndex);
  });
</script>

<div
  bind:this={root}
  class="editBlock"
  class:selected
  class:editing
  class:flow={!geoms}
  role="none"
  style:left={`${left}px`}
  style:top={`${top}px`}
  style:width={`${width}px`}
  style:height={`${height}px`}
  style:font-size={geoms ? undefined : `${flowFontSize}px`}
  style:writing-mode={geoms ? undefined : block.vertical ? 'vertical-rl' : 'horizontal-tb'}
  onpointerdown={(e) => onPointerDown(e, 'move')}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  ondblclick={(e) => openEditor(e)}
  onfocusout={onFocusOut}
>
  {#if geoms}
    {#each block.lines as line, i (lineIds[i] ?? `k${i}`)}
      {@const g = geoms[i]}
      <div
        class="line positioned"
        class:lineSelected={selectedLineIndex === i && !editing}
        role="textbox"
        aria-readonly={!editing}
        contenteditable={editing ? 'true' : undefined}
        tabindex={editing ? 0 : undefined}
        style:left={`${g.left - left}px`}
        style:top={`${g.top - top}px`}
        style:width={g.vertical ? `${g.width}px` : undefined}
        style:min-width={g.vertical ? undefined : `${g.width}px`}
        style:height={g.vertical ? undefined : `${g.height}px`}
        style:min-height={g.vertical ? `${g.height}px` : undefined}
        style:writing-mode={g.vertical ? 'vertical-rl' : 'horizontal-tb'}
        style:font-size={`${g.fontSize}px`}
        use:initText={line}
        onpointerdown={(e) => onLinePointerDown(e, i, 'move')}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        oninput={(e) => onLineInput(i, e)}
        onkeydown={(e) => onLineKeyDown(i, e)}
      ></div>
      {#if selectedLineIndex === i && !editing}
        <!-- end = length along the writing axis, side = thickness (font size) -->
        <span
          data-line-handle="end"
          class="lineHandle"
          role="none"
          style:left={`${g.left - left + (g.vertical ? g.width / 2 : g.width) - 5}px`}
          style:top={`${g.top - top + (g.vertical ? g.height : g.height / 2) - 5}px`}
          style:cursor={g.vertical ? 'ns-resize' : 'ew-resize'}
          onpointerdown={(e) => onLinePointerDown(e, i, 'end')}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
        ></span>
        <span
          data-line-handle="side"
          class="lineHandle"
          role="none"
          style:left={`${g.left - left + (g.vertical ? 0 : g.width / 2) - 5}px`}
          style:top={`${g.top - top + (g.vertical ? g.height / 2 : g.height) - 5}px`}
          style:cursor={g.vertical ? 'ew-resize' : 'ns-resize'}
          onpointerdown={(e) => onLinePointerDown(e, i, 'side')}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
        ></span>
      {/if}
    {/each}
  {:else}
    <div class="lines">
      {#each block.lines as line, i (lineIds[i] ?? `k${i}`)}
        <div
          class="line"
          role="textbox"
          aria-readonly={!editing}
          contenteditable={editing ? 'true' : undefined}
          tabindex={editing ? 0 : undefined}
          use:initText={line}
          oninput={(e) => onLineInput(i, e)}
          onkeydown={(e) => onLineKeyDown(i, e)}
        ></div>
      {/each}
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
    background: rgba(255, 255, 255, 0.6);
    color: black;
    font-family: 'Noto Sans JP', sans-serif;
    line-height: 1;
    z-index: 12;
    cursor: move;
    user-select: none;
    touch-action: none;
    overflow: visible;
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
    overflow: visible;
    letter-spacing: 0.1em;
    line-height: 1.1;
  }
  .line {
    display: block;
    white-space: nowrap;
    outline: none;
    overflow: visible;
    min-width: 1em;
    min-height: 1em;
    background: rgba(255, 255, 255, 0.85);
  }
  .line.positioned {
    position: absolute;
    box-sizing: border-box;
    line-height: 1;
    letter-spacing: 0;
    /* grows along its writing axis as text is typed; never clipped */
  }
  .line.lineSelected {
    outline: 2px solid rgb(234, 88, 12);
    z-index: 1;
  }
  .editing .line {
    border-bottom: 1px dotted rgba(37, 99, 235, 0.6);
    cursor: text;
  }
  .editing .line:focus {
    outline: 2px solid rgb(37, 99, 235);
    z-index: 2;
  }
  .handle,
  .lineHandle {
    position: absolute;
    width: 10px;
    height: 10px;
    border: 1px solid white;
    border-radius: 2px;
    z-index: 14;
    touch-action: none;
  }
  .handle {
    background: rgb(37, 99, 235);
  }
  .lineHandle {
    background: rgb(234, 88, 12);
    z-index: 15;
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
