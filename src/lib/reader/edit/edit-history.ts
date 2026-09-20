/**
 * Snapshot undo/redo stack. A continuous drag pushes many states with one
 * `coalesceKey`; pushes with the same key within the window REPLACE the last
 * entry so one drag is one undo step.
 */
export const COALESCE_WINDOW_MS = 400;

/**
 * The whole stack as it stood at `mark()` — see `cancelTo`. Opaque to callers.
 * Entries are shared references (snapshots are immutable), so a mark costs two
 * shallow array copies.
 */
export interface HistoryMark<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
}

export class EditHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  private present: T;
  private lastKey: string | undefined;
  private lastTime = -Infinity;

  constructor(
    initial: T,
    private now: () => number = () => performance.now()
  ) {
    this.present = initial;
  }

  get current(): T {
    return this.present;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  push(next: T, coalesceKey?: string): void {
    const t = this.now();
    const coalesce =
      coalesceKey !== undefined &&
      coalesceKey === this.lastKey &&
      t - this.lastTime <= COALESCE_WINDOW_MS &&
      this.past.length > 0;
    if (!coalesce) this.past.push(this.present);
    this.present = next;
    this.future = [];
    this.lastKey = coalesceKey;
    this.lastTime = coalesceKey === undefined ? -Infinity : t;
  }

  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.present);
    this.present = prev;
    this.lastKey = undefined;
    return prev;
  }

  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.present);
    this.present = next;
    this.lastKey = undefined;
    return next;
  }

  /** Remember the stack as it is now, ahead of a gesture that may be cancelled. */
  mark(): HistoryMark<T> {
    return { past: this.past.slice(), present: this.present, future: this.future.slice() };
  }

  /**
   * CANCEL everything since `mark` — as if it was never pushed. Not an undo:
   * undo() parks the abandoned state on the redo stack, where Ctrl+Y would
   * replay a gesture the user backed out of, and the gesture's first push
   * already wiped whatever redo entries existed before it. Restoring the
   * marked stack wholesale drops the gesture's entries, puts that redo branch
   * back, and is exact even when the gesture coalesced INTO the entry before
   * it (same key inside the window), where "undo until the page matches" would
   * walk past the pre-gesture state.
   */
  cancelTo(mark: HistoryMark<T>): void {
    this.past = mark.past.slice();
    this.present = mark.present;
    this.future = mark.future.slice();
    // Whatever comes next is a new step, never a continuation of the old one.
    this.lastKey = undefined;
    this.lastTime = -Infinity;
  }

  reset(value: T): void {
    this.past = [];
    this.future = [];
    this.present = value;
    this.lastKey = undefined;
  }
}
