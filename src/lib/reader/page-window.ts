/**
 * Which pages of a continuous strip are near the viewport.
 *
 * The scroll readers keep a sized wrapper for EVERY page (scroll geometry,
 * zoom correction and page detection all measure those wrappers), but only
 * mount a page's CONTENT — its image and its OCR text boxes — while the page
 * is within `marginViewports` viewport lengths of the visible strip. Mounting
 * every page's text at once made opening a volume, swapping OCR layers,
 * rotating and toggling continuous mode cost one forced layout over every
 * text box of the volume (seconds on a 236-page manga, far worse on phones),
 * and kept a decoded image per page alive.
 *
 * Membership comes from an IntersectionObserver on the scroll container, so
 * it follows scrolling, zoom transforms and resizes without any per-frame
 * work of ours. The margin is a percentage of the container along the strip
 * axis only.
 *
 * A page mounts only after it has stayed near for `mountDelayMs`; leaving
 * drops it at once. An animated jump (End, Home, the page slider) flies past
 * every page in between, each near for a few milliseconds — mounting and
 * unmounting all of them stalled the animation for over a second. Reading
 * scroll is unaffected: the margin is two viewports ahead of the eye.
 */
export interface PageWindowOptions {
  axis: 'x' | 'y';
  /** How far beyond the visible strip a page stays mounted, in viewports. */
  marginViewports?: number;
  /** How long a page must stay near before its content mounts. */
  mountDelayMs?: number;
  onChange: (near: ReadonlySet<number>) => void;
}

export const DEFAULT_PAGE_WINDOW_MARGIN = 2;
export const DEFAULT_PAGE_MOUNT_DELAY_MS = 100;

/** Pages to mount before the observer has reported: `center` ± `radius`. */
export function seedPageWindow(center: number, count: number, radius = 2): Set<number> {
  const near = new Set<number>();
  for (let i = Math.max(0, center - radius); i <= Math.min(count - 1, center + radius); i++) {
    near.add(i);
  }
  return near;
}

export class PageWindow {
  private observer: IntersectionObserver | null = null;
  private near: Set<number>;
  private indexOf = new Map<Element, number>();
  /** Pages near but not yet mounted → their dwell timer. */
  private pending = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly opts: PageWindowOptions,
    initial: Iterable<number> = []
  ) {
    this.near = new Set(initial);
  }

  get current(): ReadonlySet<number> {
    return this.near;
  }

  /** Observe `elements` (index = page index) inside the scrolling `root`. */
  attach(root: Element, elements: readonly (Element | null | undefined)[]): void {
    this.detach();
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (old engine, test env): mount everything, as before.
      this.set(new Set(elements.flatMap((el, i) => (el ? [i] : []))));
      return;
    }
    const pct = `${(this.opts.marginViewports ?? DEFAULT_PAGE_WINDOW_MARGIN) * 100}%`;
    this.observer = new IntersectionObserver((entries) => this.update(entries), {
      root,
      rootMargin: this.opts.axis === 'y' ? `${pct} 0px` : `0px ${pct}`
    });
    elements.forEach((el, i) => {
      if (!el) return;
      this.indexOf.set(el, i);
      this.observer!.observe(el);
    });
  }

  detach(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.indexOf.clear();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private update(entries: readonly IntersectionObserverEntry[]): void {
    const next = new Set(this.near);
    for (const entry of entries) {
      const i = this.indexOf.get(entry.target);
      if (i === undefined) continue;
      if (entry.isIntersecting) {
        if (!next.has(i) && !this.pending.has(i)) this.schedule(i);
      } else {
        clearTimeout(this.pending.get(i));
        this.pending.delete(i);
        next.delete(i);
      }
    }
    this.set(next);
  }

  private schedule(i: number): void {
    const delay = this.opts.mountDelayMs ?? DEFAULT_PAGE_MOUNT_DELAY_MS;
    this.pending.set(
      i,
      setTimeout(() => {
        this.pending.delete(i);
        this.set(new Set(this.near).add(i));
      }, delay)
    );
  }

  private set(next: Set<number>): void {
    if (next.size === this.near.size && [...next].every((i) => this.near.has(i))) return;
    this.near = next;
    this.opts.onChange(next);
  }
}
