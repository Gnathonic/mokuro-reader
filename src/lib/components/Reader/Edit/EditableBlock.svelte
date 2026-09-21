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
   * A line is drawn the way the viewer draws it (`line-grid.ts`): centred
   * ACROSS its quad (one line box as thick as the quad — the text is usually
   * thinner than the quad the detector drew), its text
   * ONE text node on the line's fixed-pitch grid — letter-spacing steps the
   * run at the block's pitch, a (usually negative) text-indent starts it where
   * the first glyph's ink meets the quad's start edge, the cell a little
   * before it — and a TILTED quad shows the line turned: the element
   * is the quad's own-frame box with `rotate(θ)` about its centre, also while
   * its editor is open (a caret and an IME work inside a transformed
   * contenteditable like anywhere else; hit-testing follows the turn, so a
   * press on the turned text is a press on the line).
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
   * The reader's font mode changes ONE thing here, the cells below. Placement
   * never depends on it: the viewer puts a line on its quad, grid and tilt, in
   * `auto` and in `original` alike, and so does this. The SIZE deliberately
   * does not follow `original` (where the viewer renders the file's block
   * `font_size`): in the editor the quad is the size — the side handle resizes
   * the text by resizing the quad, and `font_size` is an OUTPUT, re-derived
   * from the quads after every quad edit (`edit-ops.ts`) — so a line drawn at
   * the stored `font_size` would not answer its own handle.
   *
   * Only the `original` font mode — the viewer's diagnostic view of the file —
   * draws `char_offsets`: there a positioned line whose entry is usable (and
   * which runs the way its block does — see `placed`) shows the file's
   * per-character cells exactly as the viewer does (`lineCells`), until the
   * block's editor opens: from then on EVERY line of the block is plain RAW
   * text. Cell spans never live
   * inside a contenteditable (an IME composes into a text node, and a caret has
   * no sane home between inline-blocks), and the cells show the PROCESSED text
   * (`…`) while the model stores the raw one (`...`).
   */
  import type { Block } from '$lib/types';
  import type { EditSession, GestureMark } from '$lib/reader/edit/edit-session.svelte';
  import {
    blockLineGeometries,
    lineGeometry,
    lineGrid,
    lineHandlePoints,
    resizeQuadEdge,
    type LineGeometry
  } from '$lib/reader/edit/block-geometry';
  import { parallelOffsets } from '$lib/reader/char-offsets';
  import {
    isBlankCell,
    lineCells,
    processLine,
    type LineCells
  } from '$lib/reader/char-offsets-layout';
  import { getDefaultMeasurer, quadExtents } from '$lib/reader/line-coords-layout';
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
  // Sized by the PITCH (the quad's length over the cells its ink spans, shared
  // by the lines of the block as in the viewer, capped by the quad's
  // thickness) — a mis-detected fat quad must not explode across the page.
  let geoms = $derived<LineGeometry[] | null>(
    block.lines_coords && block.lines_coords.length === block.lines.length
      ? blockLineGeometries(block.lines_coords, block.lines)
      : null
  );
  /**
   * Per-line cells (null = that line renders as plain text on the grid). Same
   * rule as the viewer: `original` renders the file as-is, every other font
   * mode ignores the field. Nothing is celled while the editor is open.
   *
   * Offsets run along the BLOCK's reading axis — the producer warps every line
   * crop by the block's `vertical` flag and clamps to the quad's extent along
   * it, whatever the line's own shape — so that is the extent a line validates
   * against, here as in `layoutLines`. This component writes each line along
   * its OWN orientation, though, so a line lying across its block (a row in a
   * vertical block) stays plain text: its cells measure the axis its element
   * is not written on.
   */
  let showCells = $derived($settings.fontSize === 'original');
  let placed = $derived.by<(PlacedLine | null)[] | null>(() => {
    if (!geoms || editing || !showCells) return null;
    const offsets = parallelOffsets(block);
    const quads = block.lines_coords;
    if (!offsets || !quads) return null;
    const measure = getDefaultMeasurer();
    return geoms.map((g, i) => {
      if (g.vertical !== block.vertical) return null;
      const extents = quadExtents(quads[i], block.vertical);
      const cells = extents?.main
        ? lineCells(block.lines[i], offsets[i], extents.main, { repair: false })
        : null;
      if (!extents || !cells) return null;
      // The viewer sizes a celled line min(cross, fitted), and fits it to the
      // CELLS' extent, not the quad's (real offsets stop as short as 83% of
      // the quad): the glyphs are drawn in the cells, so a quad-fitted size
      // would paint them larger here than the reader will. Measured on the
      // text it renders — the processed one, which `...` → `…` makes shorter.
      const advanceEm = measure(processLine(block.lines[i]));
      const fitted = advanceEm > 0 ? cells.extent / advanceEm : extents.cross;
      return { cells, fontSize: Math.max(1, Math.round(Math.min(extents.cross, fitted))) };
    });
  });

  /**
   * The fixed-pitch grid per line, for the text the line SHOWS: the RAW one (a
   * plain line has always shown the raw text, at a size fitted to it). While
   * the editor is open it stays what the committed text gave — opening the
   * editor must not make the text jump, and the draft is not reactive; the
   * commit re-spaces the line.
   */
  let grids = $derived(geoms?.map((g, i) => lineGrid(g, block.lines[i])) ?? null);

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
    /** The line's quad when the drag began (line drags only). */
    quad?: number[][];
    moved: boolean;
    key: string;
    /** The element holding the pointer capture. */
    el: HTMLElement;
    /** Pre-drag state, for yielding to a pinch without leaving an edit. */
    mark: GestureMark;
    selection: EditSession['selection'];
    selectedLine: EditSession['selectedLine'];
  }
  let drag: Drag | null = null;

  // The press is NOT stopped: the surface's tracker must see every pointer, or
  // a pinch whose first finger landed on a block never zooms ("pinch always
  // wins"). Role 'editor' already keeps the surface from panning or tapping.
  function beginDrag(e: PointerEvent, kind: Kind, box: number[], quad?: number[][]) {
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
      quad,
      moved: false,
      key: `${keyKind}:${pageIndex}:${index}:${e.pointerId}`,
      el,
      mark: session.beginGesture(pageIndex),
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
   * CANCELLED, not undone — an undo would leave the aborted drag on the redo
   * stack for Ctrl+Y to replay — and the pre-drag selection is put back. */
  function yieldDrag() {
    const d = endDrag();
    if (!d?.moved) return;
    session.cancelGesture(d.mark);
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
    beginDrag(
      e,
      { line: lineIndex, part },
      [g.left, g.top, g.left + g.width, g.top + g.height],
      block.lines_coords?.[lineIndex]
    );
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
      // end = length along the writing axis; side = thickness (→ font size).
      // Absolute from the quad the drag began on, in that quad's own frame —
      // a tilted line keeps its tilt (the op squares an upright one up).
      // The orientation is the START quad's too: a line dragged through
      // square must not swap which edge the handle holds mid-drag.
      if (!drag.quad) return;
      const { vertical } = lineGeometry(drag.quad);
      session.resizeLine(
        pageIndex,
        index,
        k.line,
        resizeQuadEdge(drag.quad, vertical, k.part, dx, dy),
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

  /** The resize cursor nearest to a handle's drag axis, which turns with the
   * line: degrees clockwise from the x axis. */
  function axisCursor(degrees: number): string {
    const folded = ((degrees % 180) + 180) % 180;
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(folded / 45) % 4];
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
          span.className = isBlankCell(cell.text) ? 'ocr-char ocr-space' : 'ocr-char';
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
      {@const grid = cells ? null : grids?.[i]}
      <div
        class="line positioned"
        class:lineSelected={selectedLineIndex === i && !editing}
        role="textbox"
        aria-readonly={!editing}
        contenteditable={editing ? 'true' : undefined}
        tabindex={editing ? 0 : undefined}
        style:left={`${g.box.left - left}px`}
        style:top={`${g.box.top - top}px`}
        style:width={g.vertical ? `${g.box.width}px` : undefined}
        style:min-width={g.vertical ? undefined : `${g.box.width}px`}
        style:height={g.vertical ? undefined : `${g.box.height}px`}
        style:min-height={g.vertical ? `${g.box.height}px` : undefined}
        style:writing-mode={g.vertical ? 'vertical-rl' : 'horizontal-tb'}
        style:font-size={`${cells ? cells.fontSize : g.fontSize}px`}
        style:line-height={`${g.vertical ? g.box.width : g.box.height}px`}
        style:padding-inline-start={cells ? `${cells.cells.start}px` : undefined}
        style:letter-spacing={grid?.letterSpacing ? `${grid.letterSpacing}px` : undefined}
        style:text-indent={grid?.inset ? `${grid.inset}px` : undefined}
        style:transform={g.rotation ? `rotate(${g.rotation}deg)` : undefined}
        style:transform-origin={g.rotation
          ? `${g.box.width / 2}px ${g.box.height / 2}px`
          : undefined}
        use:initText={{ text: line, cells: cells?.cells ?? null }}
        onpointerdown={(e) => onLinePointerDown(e, i, 'move')}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        oninput={(e) => onLineInput(i, e)}
        onkeydown={(e) => onLineKeyDown(i, e)}
      ></div>
      {#if selectedLineIndex === i && !editing}
        <!-- end = length along the writing axis, side = thickness (font size);
             each in the middle of its edge of the (turned) quad -->
        {@const at = lineHandlePoints(g)}
        <span
          data-line-handle="end"
          class="lineHandle"
          role="none"
          style:left={`${at.end.x - left - 5}px`}
          style:top={`${at.end.y - top - 5}px`}
          style:cursor={axisCursor(g.rotation + (g.vertical ? 90 : 0))}
          onpointerdown={(e) => onLinePointerDown(e, i, 'end')}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
        ></span>
        <span
          data-line-handle="side"
          class="lineHandle"
          role="none"
          style:left={`${at.side.x - left - 5}px`}
          style:top={`${at.side.y - top - 5}px`}
          style:cursor={axisCursor(g.rotation + (g.vertical ? 0 : 90))}
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
    /* An outline drawn INSIDE the edge, not a border: lines are positioned
       from the padding box, and a border pushed every line 1px off its quad —
       2px once the block was selected. */
    outline: 1px dashed rgba(220, 38, 38, 0.8);
    outline-offset: -1px;
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
    outline: 2px solid rgb(37, 99, 235);
    outline-offset: -2px;
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
    /* as the viewer's line: fixed-pitch text, measured unkerned */
    font-kerning: none;
    /* grows along its writing axis as text is typed; never clipped */
  }
  /* The viewer's cell (TextBoxes.svelte): in flow — never absolute, issue #254
     per glyph — sized to the character's advance, glyph centred and free to
     overflow a tight cell. Centred by flex, because `text-align: center`
     start-aligns a glyph wider than its cell. :global because the spans are
     built by `initText`. */
  .line :global(.ocr-char) {
    display: inline-flex;
    justify-content: center;
    overflow: visible;
    line-height: 1;
    letter-spacing: 0;
    /* A press on a glyph is a press on its line, as it is for plain text. */
    pointer-events: none;
  }
  /* A flex cell does not render a lone space at all; a space keeps a plain
     inline-block, `pre` so it is not collapsed away there either. */
  .line :global(.ocr-space) {
    display: inline-block;
    white-space: pre;
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
  /* 4px out from the block's edge — where they sat when the selected block
     still had a 2px border inside them */
  .handle-nw {
    left: -4px;
    top: -4px;
    cursor: nwse-resize;
  }
  .handle-n {
    left: calc(50% - 5px);
    top: -4px;
    cursor: ns-resize;
  }
  .handle-ne {
    right: -4px;
    top: -4px;
    cursor: nesw-resize;
  }
  .handle-e {
    right: -4px;
    top: calc(50% - 5px);
    cursor: ew-resize;
  }
  .handle-se {
    right: -4px;
    bottom: -4px;
    cursor: nwse-resize;
  }
  .handle-s {
    left: calc(50% - 5px);
    bottom: -4px;
    cursor: ns-resize;
  }
  .handle-sw {
    left: -4px;
    bottom: -4px;
    cursor: nesw-resize;
  }
  .handle-w {
    left: -4px;
    top: calc(50% - 5px);
    cursor: ew-resize;
  }
</style>
