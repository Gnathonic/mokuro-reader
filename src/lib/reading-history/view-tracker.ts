import type { Layout, Orientation, PagePayload, PauseCount } from './types';

/** What is on screen right now (see `describeView`). */
export interface ViewDescriptor {
  volume: string;
  first_page: number;
  last_page: number;
  page_chars: number[];
  chars_before: number;
  layout: Layout;
  orientation: Orientation;
  viewport: { w: number; h: number };
}

/**
 * Two descriptors are the same view when the same pages of the same volume are
 * shown in the same layout. A resize or rotation alone doesn't start a new view;
 * the event keeps the orientation/viewport it opened with.
 */
export function viewKey(view: ViewDescriptor): string {
  return `${view.volume}|${view.first_page}|${view.last_page}|${view.layout}`;
}

/** The view on screen now and when it opened (the live timer's clock). */
export interface OpenView {
  view: ViewDescriptor;
  since: number;
}

/**
 * Turns a stream of "what's on screen" into `page` events. An event is emitted
 * when its view ENDS (another view, hidden, closed), so its dwell is known.
 *
 * A long-pause answer rides out with its view's event (`emit`'s third
 * argument), stamped with the time it was given, so the recorder can write the
 * page and its `resolve` in one transaction. `split` is that live answer: the
 * paused view ends NOW with it (or unanswered), and the same view reopens at
 * the answer time, so the time after it counts normally and a later pause on
 * the same pages is prompted afresh.
 */
export class ViewTracker {
  private open: { view: ViewDescriptor; key: string; since: number } | null = null;

  constructor(
    private readonly emit: (
      payload: PagePayload,
      t: number,
      answer: { count: PauseCount; t: number } | null
    ) => void,
    private readonly onChange?: (open: OpenView | null) => void
  ) {}

  setView(view: ViewDescriptor | null, now: number): void {
    const key = view ? viewKey(view) : null;
    if (this.open && key === this.open.key) return;
    const wasOpen = this.open !== null;
    this.end(now);
    if (view && key) this.start(view, key, now);
    else if (wasOpen) this.onChange?.(null);
  }

  close(now: number): void {
    if (this.end(now)) this.onChange?.(null);
  }

  /**
   * End the open view with this live answer (`null`: unanswered, so it counts
   * up to its cutoff) and reopen the same view at `now`.
   */
  split(now: number, count: PauseCount | null): void {
    if (!this.open) return;
    const { view, key } = this.open;
    this.end(now, count === null ? null : { count, t: now });
    this.start(view, key, now);
  }

  private start(view: ViewDescriptor, key: string, now: number): void {
    this.open = { view, key, since: now };
    this.onChange?.({ view, since: now });
  }

  /** `answer`: a split's live answer; a view that just ends has none. */
  private end(now: number, answer: { count: PauseCount; t: number } | null = null): boolean {
    if (!this.open) return false;
    const { view, since } = this.open;
    this.open = null;
    this.emit({ kind: 'page', ...view, dwell_ms: Math.max(0, now - since) }, since, answer);
    return true;
  }
}
