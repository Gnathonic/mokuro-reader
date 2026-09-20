/**
 * The reader's per-volume edit session: working copies of the pages being
 * edited, the selection, the active tool, per-page undo history, and the
 * debounced save. Pure ops live in `edit-ops.ts`; the DOM lives in
 * `EditOverlay.svelte`; this class is the seam between them.
 */
import type { Page } from '$lib/types';
import { EditHistory, type HistoryMark } from './edit-history';
import {
  addBlock,
  flipBlock,
  insertLine,
  mergeBlocks,
  moveBlock,
  moveLine,
  placeLines,
  removeBlocks,
  removeLine,
  resizeBlock,
  resizeLine,
  setBlockLines,
  splitBlock
} from './edit-ops';
import { loadOriginalPage, persistPageEdit } from './edit-persist';

export interface BlockRef {
  pageIndex: number;
  blockIndex: number;
}

export interface LineRef extends BlockRef {
  lineIndex: number;
}

export interface EditSessionOptions {
  volumeUuid: string;
  /** The alternate layer being edited, or null for the primary row. */
  layerId?: string | null;
  /** The reader's current pages — the source a working copy is seeded from. */
  getPage: (pageIndex: number) => Page | undefined;
  /** A page was written; the reader patches its in-memory data from this. */
  onPersisted?: (pageIndex: number, page: Page) => void;
  persist?: typeof persistPageEdit;
  loadOriginal?: typeof loadOriginalPage;
  debounceMs?: number;
}

/** A page's history as it stood when a cancellable gesture began (`beginGesture`). */
export interface GestureMark {
  readonly pageIndex: number;
  readonly history: HistoryMark<Page>;
}

export const SAVE_DEBOUNCE_MS = 500;

export class EditSession {
  readonly volumeUuid: string;
  readonly layerId: string | null;
  selection = $state<BlockRef[]>([]);
  /** The line singled out inside the (single) selected block, if any. */
  selectedLine = $state<LineRef | null>(null);
  /** A block the UI should open the line editor on (context-menu entry). */
  pendingFocus = $state<LineRef | null>(null);
  tool = $state<'select' | 'draw'>('select');
  /** The page the user last selected on or edited — what undo/redo/revert and
   * the toolbar act on. A spread shows two pages with two histories; the
   * reader's own `index` is only the LEFT one, so acting on it silently
   * missed every edit made on the right-hand page. Null until the first
   * interaction (the reader falls back to its current page). */
  activePageIndex = $state<number | null>(null);
  /** Bumps on every change; components key their render on it. */
  version = $state(0);
  dirty = $state(false);

  private opts: EditSessionOptions;
  private histories = new Map<number, EditHistory<Page>>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private pendingSaves = new Set<Promise<void>>();
  private unsaved = new Set<number>();
  private disposed = false;

  constructor(opts: EditSessionOptions) {
    this.opts = opts;
    this.volumeUuid = opts.volumeUuid;
    this.layerId = opts.layerId ?? null;
  }

  private history(pageIndex: number): EditHistory<Page> {
    let h = this.histories.get(pageIndex);
    if (!h) {
      const source = this.opts.getPage(pageIndex);
      if (!source) throw new Error(`EditSession: no page ${pageIndex}`);
      h = new EditHistory<Page>(source);
      this.histories.set(pageIndex, h);
    }
    return h;
  }

  pageFor(pageIndex: number): Page {
    // `version` is read so Svelte re-renders callers after every change.
    void this.version;
    return this.history(pageIndex).current;
  }

  private commit(pageIndex: number, next: Page, coalesceKey?: string): void {
    this.history(pageIndex).push(next, coalesceKey);
    this.activePageIndex = pageIndex;
    this.touched(pageIndex);
  }

  private touched(pageIndex: number): void {
    this.version++;
    this.dirty = true;
    this.unsaved.add(pageIndex);
    const existing = this.timers.get(pageIndex);
    if (existing) clearTimeout(existing);
    // Nobody flushes a disposed session again (the reader has let go of it),
    // so a late commit — a line editor closing as the overlay unmounts — is
    // written now: on the debounce it would land long after whatever awaited
    // `dispose()` had moved on, or never if the page is going away.
    if (this.disposed) {
      void this.save(pageIndex);
      return;
    }
    this.timers.set(
      pageIndex,
      setTimeout(() => void this.save(pageIndex), this.opts.debounceMs ?? SAVE_DEBOUNCE_MS)
    );
  }

  private save(pageIndex: number): Promise<void> {
    this.timers.delete(pageIndex);
    const page = this.history(pageIndex).current;
    const persist = this.opts.persist ?? persistPageEdit;
    const run: Promise<void> = persist(this.volumeUuid, pageIndex, page)
      .then(() => {
        this.unsaved.delete(pageIndex);
        if (this.unsaved.size === 0) this.dirty = false;
        this.opts.onPersisted?.(pageIndex, page);
      })
      .catch((error) => console.error('[edit-session] save failed:', error))
      .finally(() => this.pendingSaves.delete(run));
    this.pendingSaves.add(run);
    return run;
  }

  /**
   * Save everything pending now and wait for it. Loops until the session is
   * quiet: callers (promote, new layer, an engine run) read or replace the DB
   * rows the moment this resolves, so an edit committed while an earlier save
   * was still in flight must be on disk by then too — not back on the timer.
   */
  async flush(): Promise<void> {
    while (this.timers.size > 0 || this.pendingSaves.size > 0) {
      for (const [pageIndex, timer] of [...this.timers]) {
        clearTimeout(timer);
        this.timers.delete(pageIndex);
        void this.save(pageIndex);
      }
      await Promise.all([...this.pendingSaves]);
    }
  }

  // ---- selection ----
  select(pageIndex: number, blockIndex: number, additive = false): void {
    const ref = { pageIndex, blockIndex };
    this.selectedLine = null;
    this.activePageIndex = pageIndex;
    if (!additive || this.selection.some((r) => r.pageIndex !== pageIndex)) {
      this.selection = [ref];
      return;
    }
    if (this.selection.some((r) => r.blockIndex === blockIndex)) {
      this.selection = this.selection.filter((r) => r.blockIndex !== blockIndex);
    } else {
      this.selection = [...this.selection, ref];
    }
  }
  clearSelection(): void {
    this.selection = [];
    this.selectedLine = null;
  }
  selectLine(pageIndex: number, blockIndex: number, lineIndex: number): void {
    this.activePageIndex = pageIndex;
    if (!this.isSelected(pageIndex, blockIndex) || this.selection.length !== 1) {
      this.selection = [{ pageIndex, blockIndex }];
    }
    this.selectedLine = { pageIndex, blockIndex, lineIndex };
  }
  isSelected(pageIndex: number, blockIndex: number): boolean {
    return this.selection.some((r) => r.pageIndex === pageIndex && r.blockIndex === blockIndex);
  }

  // ---- history ----
  canUndo(pageIndex: number): boolean {
    void this.version;
    return this.histories.get(pageIndex)?.canUndo ?? false;
  }
  canRedo(pageIndex: number): boolean {
    void this.version;
    return this.histories.get(pageIndex)?.canRedo ?? false;
  }
  undo(pageIndex: number): void {
    const h = this.histories.get(pageIndex);
    if (h && h.undo() !== null) {
      this.selection = [];
      this.touched(pageIndex);
    }
  }
  redo(pageIndex: number): void {
    const h = this.histories.get(pageIndex);
    if (h && h.redo() !== null) {
      this.selection = [];
      this.touched(pageIndex);
    }
  }

  /**
   * Call where a pointer gesture (a drag) starts; hand the mark to
   * `cancelGesture` if the gesture is abandoned. A gesture that ends normally
   * just drops it.
   */
  beginGesture(pageIndex: number): GestureMark {
    return { pageIndex, history: this.history(pageIndex).mark() };
  }

  /**
   * Abandon a gesture: the page is what it was at `beginGesture`, the steps the
   * gesture committed are gone from undo AND redo, and the redo entries that
   * existed before it are back (see `EditHistory.cancelTo`). Selection is the
   * caller's — it knows what it was.
   */
  cancelGesture(mark: GestureMark): void {
    const h = this.history(mark.pageIndex);
    const changed = h.current !== mark.history.present;
    h.cancelTo(mark.history);
    // A drag that paused may already have been autosaved: the restored page
    // has to be written back over it. Nothing moved → nothing to save.
    if (changed) this.touched(mark.pageIndex);
  }

  // ---- ops ----
  move(pageIndex: number, blockIndex: number, dx: number, dy: number, coalesceKey?: string): void {
    const next = moveBlock(this.pageFor(pageIndex), blockIndex, dx, dy);
    if (next === this.pageFor(pageIndex)) return;
    this.commit(pageIndex, next, coalesceKey);
  }
  resize(pageIndex: number, blockIndex: number, box: number[], coalesceKey?: string): void {
    this.commit(pageIndex, resizeBlock(this.pageFor(pageIndex), blockIndex, box), coalesceKey);
  }
  setLines(pageIndex: number, blockIndex: number, lines: string[]): void {
    this.commit(pageIndex, setBlockLines(this.pageFor(pageIndex), blockIndex, lines));
  }
  add(pageIndex: number, box: number[]): number {
    const { page, index } = addBlock(this.pageFor(pageIndex), box);
    this.commit(pageIndex, page);
    this.selection = [{ pageIndex, blockIndex: index }];
    return index;
  }
  private selectedOn(): { pageIndex: number; indices: number[] } | null {
    if (this.selection.length === 0) return null;
    const pageIndex = this.selection[0].pageIndex;
    return { pageIndex, indices: this.selection.map((r) => r.blockIndex) };
  }
  deleteSelected(): void {
    const sel = this.selectedOn();
    if (!sel) return;
    this.commit(sel.pageIndex, removeBlocks(this.pageFor(sel.pageIndex), sel.indices));
    this.selection = [];
  }
  mergeSelected(): void {
    const sel = this.selectedOn();
    if (!sel || sel.indices.length < 2) return;
    const { page, index } = mergeBlocks(this.pageFor(sel.pageIndex), sel.indices);
    this.commit(sel.pageIndex, page);
    this.selection = [{ pageIndex: sel.pageIndex, blockIndex: index }];
  }
  splitSelected(atLine: number): void {
    const sel = this.selectedOn();
    if (!sel || sel.indices.length !== 1) return;
    const { page, indices } = splitBlock(this.pageFor(sel.pageIndex), sel.indices[0], atLine);
    if (indices[0] === indices[1]) return;
    this.commit(sel.pageIndex, page);
    this.selection = [{ pageIndex: sel.pageIndex, blockIndex: indices[0] }];
  }
  flipSelected(swapBox = false): void {
    const sel = this.selectedOn();
    if (!sel) return;
    let page = this.pageFor(sel.pageIndex);
    for (const i of sel.indices) page = flipBlock(page, i, swapBox);
    this.commit(sel.pageIndex, page);
  }

  // ---- line ops ----
  moveLine(
    pageIndex: number,
    blockIndex: number,
    lineIndex: number,
    dx: number,
    dy: number,
    coalesceKey?: string
  ): void {
    const cur = this.pageFor(pageIndex);
    const next = moveLine(cur, blockIndex, lineIndex, dx, dy);
    if (next !== cur) this.commit(pageIndex, next, coalesceKey);
  }
  resizeLine(
    pageIndex: number,
    blockIndex: number,
    lineIndex: number,
    quad: number[][],
    coalesceKey?: string
  ): void {
    const cur = this.pageFor(pageIndex);
    const next = resizeLine(cur, blockIndex, lineIndex, quad);
    // a refused resize (a tilted quad leaving the image) is not an edit
    if (next !== cur) this.commit(pageIndex, next, coalesceKey);
  }
  placeLines(pageIndex: number, blockIndex: number): void {
    const cur = this.pageFor(pageIndex);
    const next = placeLines(cur, blockIndex);
    if (next !== cur) this.commit(pageIndex, next);
  }
  /** Returns the new line's index. */
  insertLine(pageIndex: number, blockIndex: number, afterLine: number): number {
    this.commit(pageIndex, insertLine(this.pageFor(pageIndex), blockIndex, afterLine));
    return afterLine + 1;
  }
  removeLine(pageIndex: number, blockIndex: number, lineIndex: number): void {
    const cur = this.pageFor(pageIndex);
    const next = removeLine(cur, blockIndex, lineIndex);
    if (next !== cur) this.commit(pageIndex, next);
  }

  async revertPage(pageIndex: number): Promise<boolean> {
    // The default loader reads the PRIMARY row's snapshot — the only original
    // there is. An alternate layer has none of its own, so falling back to it
    // would overwrite the layer's page with another layer's text.
    if (this.layerId && !this.opts.loadOriginal) return false;
    const load = this.opts.loadOriginal ?? loadOriginalPage;
    const original = await load(this.volumeUuid, pageIndex);
    if (!original) return false;
    this.commit(pageIndex, original);
    this.selection = [];
    return true;
  }

  /** End the session: every pending page is saved now. Never drops work. */
  dispose(): Promise<void> {
    this.disposed = true;
    return this.flush();
  }
}
