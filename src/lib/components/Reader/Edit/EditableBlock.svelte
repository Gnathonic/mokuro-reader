<script module lang="ts">
  // "Pinch always wins" (docs/INPUT-CONTRACTS.md): editor presses bubble to the
  // surface's PointerGestureTracker, and the editor's own drag yields the
  // moment a second pointer lands. The press that made a drag yield is that
  // pinch's second finger — it must never begin a drag (or a drawn box) of its
  // own, wherever it landed; shared here so every block and the overlay's draw
  // tool agree on it.
  const yieldedPresses = new WeakSet<Event>();

  /** Record the press an in-flight editor drag / draw just yielded to. */
  export function markPinchPress(e: Event): void {
    yieldedPresses.add(e);
  }

  /** A press that belongs to a pinch: one a drag yielded to, or a non-primary
   * pointer (a second touch finger while the first is on the page itself). */
  export function isPinchPress(e: PointerEvent): boolean {
    return e.isPrimary === false || yieldedPresses.has(e);
  }
</script>

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
   *
   * A positioned line whose `char_offsets` entry is usable shows the same
   * per-character cells as the viewer (`lineCells`), so what is being corrected
   * sits where the reader will paint it — until the block's editor opens: from
   * then on EVERY line of the block is plain RAW text. Cell spans never live
   * inside a contenteditable (an IME composes into a text node, and a caret has
   * no sane home between inline-blocks), and the cells show the PROCESSED text
   * (`…`) while the model stores the raw one (`...`).
   */
  import type { Block, Page } from '$lib/types';
  import type { EditSession } from '$lib/reader/edit/edit-session.svelte';
  import { lineGeometry, rectQuad, type LineGeometry } from '$lib/reader/edit/block-geometry';
  import { parallelOffsets } from '$lib/reader/char-offsets';
  import { lineCells, processLine, type LineCells } from '$lib/reader/char-offsets-layout';
  import { quadExtents } from '$lib/reader/line-coords-layout';
  import { settings } from '$lib/settings';
  import { onDestroy, tick } from 'svelte';

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
  interface PlacedLine {
    cells: LineCells;
    fontSize: number;
  }
  /** What a line element shows: its RAW text, or cells when it has them. */
  interface LineContent {
    text: string;
    cells: LineCells | null;
  }

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
  /**
   * Per-line cells (null = that line renders as plain text, as it always has).
   * Same call as the viewer: `original` renders the file as-is, every other
   * font mode repairs zero-width cells on real characters. The main extent is
   * taken along the LINE's own orientation, the axis its element is written on.
   * Nothing is celled while the editor is open.
   */
  let repairCells = $derived($settings.fontSize !== 'original');
  let placed = $derived.by<(PlacedLine | null)[] | null>(() => {
    if (!geoms || editing) return null;
    const offsets = parallelOffsets(block);
    const quads = block.lines_coords;
    if (!offsets || !quads) return null;
    return geoms.map((g, i) => {
      const main = quadExtents(quads[i], g.vertical)?.main;
      const cells = main
        ? lineCells(block.lines[i], offsets[i], main, { repair: repairCells })
        : null;
      if (!cells) return null;
      // The viewer sizes a celled line min(cross, fitted) on the text it
      // renders — the processed one, which `...` → `…` makes shorter.
      const shown = processLine(block.lines[i]);
      const fontSize =
        shown === block.lines[i] ? g.fontSize : lineGeometry(quads[i], shown).fontSize;
      return { cells, fontSize };
    });
  });

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
    /** The element holding the pointer capture. */
    el: HTMLElement;
    /** Pre-drag state, for yielding to a pinch without leaving an edit. */
    before: Page;
    selection: EditSession['selection'];
    selectedLine: EditSession['selectedLine'];
  }
  let drag: Drag | null = null;

  // The press is NOT stopped: the surface's tracker must see every pointer, or
  // a pinch whose first finger landed on a block never zooms ("pinch always
  // wins"). Role 'editor' already keeps the surface from panning or tapping.
  function beginDrag(e: PointerEvent, kind: Kind, box: number[]) {
    // `drag`: a press on a line or handle bubbles on to the block's own
    // pointerdown — the innermost drag wins, the block must not start a second
    // one. A pinch's second finger never drags at all.
    if (drag || isPinchPress(e)) return;
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
      key: `${keyKind}:${pageIndex}:${index}:${e.pointerId}`,
      el,
      before: session.pageFor(pageIndex),
      selection: session.selection,
      selectedLine: session.selectedLine
    };
    watchWindow(true);
  }

  // While a drag is in flight the WINDOW is watched (capture phase, so it runs
  // before any block's own handler): a second press anywhere makes the drag
  // yield to the pinch, and a release that never reaches the capturing element
  // still ends it — a stale drag would be "yielded" (rolled back) by the next
  // unrelated press.
  function watchWindow(on: boolean) {
    if (on) {
      window.addEventListener('pointerdown', onWindowDown, true);
      window.addEventListener('pointerup', onWindowUp);
      window.addEventListener('pointercancel', onWindowUp);
    } else {
      window.removeEventListener('pointerdown', onWindowDown, true);
      window.removeEventListener('pointerup', onWindowUp);
      window.removeEventListener('pointercancel', onWindowUp);
    }
  }
  function onWindowDown(e: PointerEvent) {
    if (!drag || e.pointerId === drag.id) return;
    markPinchPress(e);
    yieldDrag();
  }
  function onWindowUp(e: PointerEvent) {
    // The element's own handler ran first when the release reached it.
    if (drag && e.pointerId === drag.id) endDrag();
  }
  function endDrag(): Drag | null {
    const d = drag;
    if (!d) return null;
    drag = null;
    watchWindow(false);
    try {
      d.el.releasePointerCapture?.(d.id);
    } catch {
      /* already released */
    }
    return d;
  }

  /** Two fingers zoom; they never drag. Whatever the drag already moved is
   * rolled back through the session's undo (a drag is one coalesced step, more
   * if the finger paused — hence the loop, which stops AT the pre-drag page),
   * and the selection undo cleared is put back. */
  function yieldDrag() {
    const d = endDrag();
    if (!d?.moved) return;
    while (session.pageFor(pageIndex) !== d.before && session.canUndo(pageIndex)) {
      session.undo(pageIndex);
    }
    session.selection = d.selection;
    session.selectedLine = d.selectedLine;
  }
  onDestroy(() => void endDrag());

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

  // Not stopped either: the tracker's map must lose the pointer it gained on
  // the press, or the phantom entry turns the next press into a "pinch".
  function onPointerUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = endDrag()!;
    if (!d.moved) {
      const k = d.kind;
      if (typeof k !== 'string') session.selectLine(pageIndex, index, k.line);
      else session.select(pageIndex, index, e.shiftKey);
    }
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
    composing = null;
    commitAfterComposition = false;
  }

  // ---- the open draft must survive a hidden tab and an unmount ----
  // Typed text lives only in `draft` until the editor closes, and neither a
  // tab going away nor the overlay unmounting fires focusout — the session's
  // own flush would save a page that never heard about the text. So the draft
  // is committed in place: the editor stays open, and because the model then
  // equals what each line already holds, `initText` leaves the DOM (and the
  // caret) alone.
  //
  // Never mid-IME-composition: the candidate is not text yet, and committing
  // under it would rewrite the line the IME is composing in. A hide that lands
  // mid-composition commits on compositionend instead.
  let composing: { i: number; before: string } | null = null;
  let commitAfterComposition = false;

  function saveOpenDraft() {
    // Lines are inserted/removed through the session as they happen, so the
    // counts only differ if the model changed under the open editor — then
    // `index` may not even be this block any more; never write over it.
    const cur = session.pageFor(pageIndex).blocks[index];
    if (!cur || cur.lines.length !== draft.length) return;
    commitTexts();
  }

  function onPageHidden() {
    if (!editing) return;
    if (composing) {
      commitAfterComposition = true;
      return;
    }
    saveOpenDraft();
    // The reader flushes the session on the same event, but its listener was
    // registered first: without this the commit above waits on the debounce
    // of a tab that may never run again.
    void session.flush();
  }

  $effect(() => {
    if (!editing) return;
    const onVisibility = () => {
      if (document.hidden) onPageHidden();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHidden);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHidden);
    };
  });

  onDestroy(() => {
    if (!editing) return;
    // No compositionend is coming for a line that is going away: keep the
    // confirmed text, drop the candidate.
    if (composing) draft[composing.i] = composing.before;
    saveOpenDraft();
  });

  function onCompositionStart(e: CompositionEvent) {
    const line = editableLine(e.target);
    // Fires before the candidate reaches the DOM: this is the confirmed text.
    if (line) composing = { i: line.i, before: line.el.textContent ?? '' };
  }

  function onCompositionEnd(e: CompositionEvent) {
    composing = null;
    if (!commitAfterComposition) return;
    commitAfterComposition = false;
    // Browsers disagree on whether the final `input` precedes this event.
    const line = editableLine(e.target);
    if (line) draft[line.i] = line.el.textContent ?? '';
    onPageHidden();
  }

  // ---- paste / drop: a line is ONE line of plain text ----
  // Handled on the block root (both events bubble), so the positioned and the
  // flow line variants share one path and neither's markup carries it.
  function editableLine(target: EventTarget | null): { el: HTMLElement; i: number } | null {
    if (!editing || !root || !(target instanceof Node)) return null;
    const from = target instanceof Element ? target : target.parentElement;
    const el = from?.closest<HTMLElement>('[contenteditable]');
    if (!el || !root.contains(el)) return null;
    const i = [...root.querySelectorAll('[contenteditable]')].indexOf(el);
    return i < 0 ? null : { el, i };
  }

  /** The default paste/drop inserts the clipboard's RICH flavour (nested
   * nodes the line renderer never expects) and collapses line breaks into
   * nothing. Take the plain flavour; a run of breaks/tabs between two pieces
   * of text becomes one space, at the ends it is dropped. */
  function insertPlain(line: { el: HTMLElement; i: number }, raw: string) {
    const text = raw.replace(/^[\r\n\t]+|[\r\n\t]+$/g, '').replace(/[\r\n\t]+/g, ' ');
    if (text) {
      // execCommand keeps the browser's own undo stack (Ctrl+Z inside the
      // line); the Range path covers engines where it is missing or refuses.
      let done = false;
      try {
        done = document.execCommand?.('insertText', false, text) ?? false;
      } catch {
        done = false;
      }
      if (!done) insertAtCaret(line.el, text);
    }
    // Same as oninput — the Range path fires no input event of its own.
    draft[line.i] = line.el.textContent ?? '';
  }

  function insertAtCaret(el: HTMLElement, text: string) {
    const sel = window.getSelection();
    let range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    if (!range || !el.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  function onPaste(e: ClipboardEvent) {
    const line = editableLine(e.target);
    if (!line) return;
    e.preventDefault();
    insertPlain(line, e.clipboardData?.getData('text/plain') ?? '');
  }

  function caretFromPoint(x: number, y: number): Range | null {
    const doc = document as Document & {
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?(x: number, y: number): Range | null;
    };
    const pos = doc.caretPositionFromPoint?.(x, y);
    if (!pos) return doc.caretRangeFromPoint?.(x, y) ?? null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }

  function onDrop(e: DragEvent) {
    const line = editableLine(e.target);
    if (!line) return;
    e.preventDefault();
    line.el.focus();
    const at = caretFromPoint(e.clientX, e.clientY);
    if (at && line.el.contains(at.startContainer)) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(at);
    }
    insertPlain(line, e.dataTransfer?.getData('text/plain') ?? '');
  }

  // With the drop handled by hand, a drag of the line's OWN selection would
  // copy instead of move (the default that removes the source is prevented).
  // Dragging text around inside a one-line editor is not worth that.
  function onDragStart(e: DragEvent) {
    if (editableLine(e.target)) e.preventDefault();
  }

  /** Own the line's DOM imperatively — cells or plain text: written at mount
   * and again whenever the MODEL changes under a stable element (undo, redo,
   * revert, a merge that rewrites a neighbour, a reflow after a commit), the
   * font mode flips the repair, or the editor opens/closes (cells ↔ plain).
   * While the user types the line is always plain, and the model only changes
   * when the draft is committed — to exactly what the element already holds —
   * so the equality guard keeps the caret from ever being fought mid-edit. */
  function initText(el: HTMLElement, content: LineContent) {
    // What the cells last written looked like; null while the line is plain.
    let celled: string | null = null;
    function write({ text, cells }: LineContent) {
      if (!cells) {
        if (celled !== null || el.textContent !== text) el.textContent = text;
        celled = null;
        return;
      }
      const signature = cells.cells.map((c) => `${c.text}\u0000${c.size}`).join('\u0001');
      if (signature === celled) return;
      // One span per character and nothing between them, so the line's
      // textContent is exactly the processed text (the viewer's invariant).
      el.replaceChildren(
        ...cells.cells.map((cell) => {
          const span = document.createElement('span');
          span.className = 'ocr-char';
          span.style.inlineSize = `${cell.size}px`;
          span.textContent = cell.text;
          return span;
        })
      );
      celled = signature;
    }
    write(content);
    return { update: write };
  }

  function onLineInput(i: number, e: Event) {
    draft[i] = (e.currentTarget as HTMLElement).textContent ?? '';
  }

  async function onLineKeyDown(i: number, e: KeyboardEvent) {
    // Mid-composition Enter/Backspace confirm an IME candidate — let them
    // through untouched, or Enter inserts a stray line and Backspace eats
    // the candidate instead of the conversion.
    if (e.isComposing || e.keyCode === 229) return;
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
  onpaste={onPaste}
  ondrop={onDrop}
  ondragstart={onDragStart}
  oncompositionstart={onCompositionStart}
  oncompositionend={onCompositionEnd}
>
  {#if geoms}
    {#each block.lines as line, i (lineIds[i] ?? `k${i}`)}
      {@const g = geoms[i]}
      {@const cells = placed?.[i] ?? null}
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
        style:font-size={`${cells ? cells.fontSize : g.fontSize}px`}
        style:padding-inline-start={cells ? `${cells.cells.start}px` : undefined}
        use:initText={{ text: line, cells: cells?.cells ?? null }}
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
          use:initText={{ text: line, cells: null }}
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
  /* The viewer's cell (TextBoxes.svelte): in flow — never absolute, issue #254
     per glyph — sized to the character's advance, glyph centred and free to
     overflow a tight cell. :global because the spans are built by `initText`. */
  .line :global(.ocr-char) {
    display: inline-block;
    text-align: center;
    overflow: visible;
    line-height: 1;
    letter-spacing: 0;
    /* A press on a glyph is a press on its line, as it is for plain text. */
    pointer-events: none;
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
