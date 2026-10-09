import type { Layout, Orientation, PagePayload } from './types';

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
 * Turns a stream of "what's on screen" into `page` events. An event is emitted
 * when its view ENDS (another view, hidden, closed), so its dwell is known.
 */
/** The view on screen now and when it opened (the live timer's clock). */
export interface OpenView {
  view: ViewDescriptor;
  since: number;
}

export class ViewTracker {
  private open: { view: ViewDescriptor; key: string; since: number } | null = null;

  constructor(
    private readonly emit: (payload: PagePayload, t: number) => void,
    private readonly onChange?: (open: OpenView | null) => void
  ) {}

  setView(view: ViewDescriptor | null, now: number): void {
    const key = view ? viewKey(view) : null;
    if (this.open && key === this.open.key) return;
    const wasOpen = this.open !== null;
    this.end(now);
    if (view && key) {
      this.open = { view, key, since: now };
      this.onChange?.({ view, since: now });
    } else if (wasOpen) this.onChange?.(null);
  }

  close(now: number): void {
    if (this.end(now)) this.onChange?.(null);
  }

  private end(now: number): boolean {
    if (!this.open) return false;
    const { view, since } = this.open;
    this.open = null;
    this.emit({ kind: 'page', ...view, dwell_ms: Math.max(0, now - since) }, since);
    return true;
  }
}
