/**
 * Page Up / Page Down / Space on a page taller (or, in the horizontal strip,
 * wider) than the screen (#283): scroll through the page a screenful at a time
 * first, and only turn the page once its far edge is in view.
 *
 * Pure decision logic shared by every reading surface — no DOM. Everything is
 * measured along ONE reading axis, in any unit and origin the caller likes, as
 * long as it is the same for every span and grows in the reading direction
 * (down the page; leftward in a right-to-left strip — `readingSpan` mirrors
 * those).
 *
 * The caller decides what "the page being read" is (paged mode: the shown page
 * or spread; continuous modes: the page at the viewport's centre) and measures
 * the view at the scroll TARGET, not the animated position: a held key's
 * auto-repeat then chains step after step instead of re-deciding from a
 * half-finished glide (which would stall, or turn twice).
 */

export interface AxisSpan {
  start: number;
  end: number;
}

export type PageKeyDirection = 'forward' | 'backward';

export interface PageKeyStepInput {
  direction: PageKeyDirection;
  /** The viewport. */
  view: AxisSpan;
  /** The page (or spread) being read. */
  current: AxisSpan;
  /**
   * Page boundaries a step must not cross (continuous modes: every page). A
   * forward step never carries the view's start past a page start below it,
   * a backward step never carries the view's end past a page end above it —
   * so a page whose start is already on screen is landed on exactly.
   */
  pages?: readonly AxisSpan[];
  /** The profile setting — off means "always turn", today's behaviour. */
  enabled: boolean;
}

export type PageKeyStep =
  | { kind: 'turn' }
  /** Move the view by `by` along the reading axis (positive = forward). */
  | { kind: 'scroll'; by: number };

/** Share of the viewport kept on screen across a step, so the reader keeps context. */
export const PAGE_KEY_OVERLAP = 0.125;

/**
 * Hidden content up to this many px does not earn a keypress of its own: a
 * page a few px taller than the screen (rounding, a fit mode's sub-pixel
 * scale) turns as it always did.
 */
export const PAGE_KEY_EPSILON_PX = 8;

const TURN: PageKeyStep = { kind: 'turn' };

export function pageKeyStep({
  direction,
  view,
  current,
  pages = [],
  enabled
}: PageKeyStepInput): PageKeyStep {
  if (!enabled) return TURN;
  const size = view.end - view.start;
  if (!(size > 0)) return TURN;
  const step = size * (1 - PAGE_KEY_OVERLAP);

  if (direction === 'forward') {
    const hidden = current.end - view.end;
    if (!(hidden > PAGE_KEY_EPSILON_PX)) return TURN;
    // A screenful, but never past the page's own end (the view's end lands on it).
    let by = Math.min(step, hidden);
    for (const p of pages) {
      const gap = p.start - view.start;
      if (gap > PAGE_KEY_EPSILON_PX) by = Math.min(by, gap);
    }
    return { kind: 'scroll', by };
  }

  const hidden = view.start - current.start;
  if (!(hidden > PAGE_KEY_EPSILON_PX)) return TURN;
  let by = Math.min(step, hidden);
  for (const p of pages) {
    const gap = view.end - p.end;
    if (gap > PAGE_KEY_EPSILON_PX) by = Math.min(by, gap);
  }
  return { kind: 'scroll', by: -by };
}

/**
 * A span on a screen axis, as reading-axis coordinates: identity when reading
 * runs toward larger coordinates, mirrored (negated and swapped) when it runs
 * the other way — a right-to-left horizontal strip.
 */
export function readingSpan(start: number, end: number, reversed: boolean): AxisSpan {
  return reversed ? { start: -end, end: -start } : { start, end };
}

/**
 * The scroll position that shows `edge` of `target` flush with the view's
 * matching edge — the start for a forward turn, the end for a backward one
 * (so reading backwards continues from the bottom of the previous page).
 * Returns the delta to move the view by along the reading axis.
 */
export function alignDelta(view: AxisSpan, target: AxisSpan, edge: 'start' | 'end'): number {
  return edge === 'start' ? target.start - view.start : target.end - view.end;
}
