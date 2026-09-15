/**
 * Snapshot undo/redo stack. A continuous drag pushes many states with one
 * `coalesceKey`; pushes with the same key within the window REPLACE the last
 * entry so one drag is one undo step.
 */
export const COALESCE_WINDOW_MS = 400;

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

  reset(value: T): void {
    this.past = [];
    this.future = [];
    this.present = value;
    this.lastKey = undefined;
  }
}
