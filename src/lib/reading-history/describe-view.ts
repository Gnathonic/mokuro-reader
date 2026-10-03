import type { ViewDescriptor } from './view-tracker';

/**
 * A continuous range is only valid for the volume and scroll mode it was
 * measured in. Tagging it (instead of nulling it from an effect) keeps it
 * immune to unrelated store emissions — every cloud sync re-emits `settings`.
 */
export function rangeScopeKey(volume: string | undefined, scrollMode: 'vertical' | 'horizontal') {
  return `${volume ?? ''}|${scrollMode}`;
}

export interface ContinuousRange {
  scope: string;
  first: number;
  last: number;
}

export interface ViewInputs {
  volume: string | undefined;
  /** Cumulative chars per page (`buildPageCharCounts(pages).cumulative`). */
  pageCharCumulative: number[];
  /** 1-based current page from progress. */
  page: number;
  continuous: boolean;
  scrollMode: 'vertical' | 'horizontal';
  /** Paged mode: a second page is shown beside `page`. */
  showSecondPage: boolean;
  /** Continuous mode: 1-based inclusive range of pages with any part on screen. */
  continuousRange: ContinuousRange | null;
  /**
   * The reader is actually showing this volume's pages (not a loading or
   * "not on this device" screen, and not the previous volume's layer pages).
   */
  showing: boolean;
  viewport: { w: number; h: number };
}

/**
 * What the reader is showing, as whole pages. Returns null until there are
 * pages to show. A continuous range that no longer contains the current page
 * is stale (mode or volume switched) and is ignored.
 */
export function describeView(inputs: ViewInputs): ViewDescriptor | null {
  const cum = inputs.pageCharCumulative;
  const count = cum.length;
  if (!inputs.showing || !inputs.volume || count === 0) return null;

  const page = clamp(inputs.page, 1, count);
  let first = page;
  let last = page;
  let layout: ViewDescriptor['layout'];

  if (inputs.continuous) {
    layout = inputs.scrollMode === 'vertical' ? 'continuous-v' : 'continuous-h';
    const range = inputs.continuousRange;
    if (
      range &&
      range.scope === rangeScopeKey(inputs.volume, inputs.scrollMode) &&
      range.first <= page &&
      page <= range.last
    ) {
      first = range.first;
      last = range.last;
    }
  } else {
    layout = inputs.showSecondPage ? 'double' : 'single';
    if (inputs.showSecondPage) last = page + 1;
  }

  first = clamp(first, 1, count);
  last = clamp(last, first, count);

  const before = (p: number) => (p > 1 ? cum[p - 2] : 0);
  const page_chars: number[] = [];
  for (let p = first; p <= last; p++) page_chars.push(cum[p - 1] - before(p));

  return {
    volume: inputs.volume,
    first_page: first,
    last_page: last,
    page_chars,
    chars_before: before(first),
    layout,
    orientation: inputs.viewport.w > inputs.viewport.h ? 'landscape' : 'portrait',
    viewport: { w: Math.round(inputs.viewport.w), h: Math.round(inputs.viewport.h) }
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
