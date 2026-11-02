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

/**
 * The view on screen now and when it opened (the live timer's clock).
 * `answer` is the long-pause answer preset for it (the standing default,
 * `setAnswer`): the live timer counts the open view by it. `null` = none.
 */
export interface OpenView {
  view: ViewDescriptor;
  since: number;
  answer: PauseCount | null;
}

/**
 * Turns a stream of "what's on screen" into `page` events. An event is emitted
 * when its view ENDS (another view, hidden, closed), so its dwell is known.
 *
 * A long-pause answer rides out with its view's event (`emit`'s third
 * argument), stamped with the time it was given, so the recorder can write the
 * page and its `resolve` in one transaction:
 * - `setAnswer` presets the open view (the standing default) — written when the
 *   view ends however it ends, one event however long the pause; `null`
 *   withdraws it (the cap grew past the time so far);
 * - `split` is a live answer: the paused view ends NOW with it, and the same
 *   view reopens at the answer time, so the time after it counts normally and
 *   a later pause on the same pages is prompted afresh.
 */
export class ViewTracker {
  private open: {
    view: ViewDescriptor;
    key: string;
    since: number;
    answer: { count: PauseCount; t: number } | null;
  } | null = null;

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
   * Preset the open view's answer (the standing default), or withdraw it with
   * `null`; no-op with nothing open, or when withdrawing nothing.
   */
  setAnswer(count: PauseCount | null, now = Date.now()): void {
    if (!this.open) return;
    if (count === null && this.open.answer === null) return;
    this.open.answer = count === null ? null : { count, t: now };
    this.onChange?.({ view: this.open.view, since: this.open.since, answer: count });
  }

  /** End the open view with this live answer and reopen the same view at `now`. */
  split(now: number, count: PauseCount): void {
    if (!this.open) return;
    const { view, key } = this.open;
    this.end(now, { count, t: now });
    this.start(view, key, now);
  }

  private start(view: ViewDescriptor, key: string, now: number): void {
    this.open = { view, key, since: now, answer: null };
    this.onChange?.({ view, since: now, answer: null });
  }

  /** `live` (a split's answer) wins over the preset. */
  private end(now: number, live: { count: PauseCount; t: number } | null = null): boolean {
    if (!this.open) return false;
    const { view, since, answer } = this.open;
    this.open = null;
    this.emit({ kind: 'page', ...view, dwell_ms: Math.max(0, now - since) }, since, live ?? answer);
    return true;
  }
}
