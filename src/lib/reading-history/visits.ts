import { LEGACY_DEVICE_PREFIX } from './paths';
import { SKIP_CPM } from './stats-engine';
import type { PagePayload, ReadingEvent } from './types';

/**
 * Visits and look-ups (spec: "Look-up visits claim nothing"). Pure: every
 * device draws the same visits from the same events.
 *
 * A visit is one device's run of native page views of one volume, split where
 * the gap between one view's end and the next view's start exceeds
 * `VISIT_GAP_MS`. It is a look-up when it has at least two views, its last
 * view shows a page of its first (ranges overlap, spreads included), and it
 * read at most `LOOKUP_MAX_READ_PAGES` distinct pages outside the first view.
 * The read-pages guard keeps "read the whole volume, flip back to the cover"
 * counted as reading.
 */

export const VISIT_GAP_MS = 10 * 60_000;
export const LOOKUP_MAX_READ_PAGES = 2;
export const READ_DWELL_MS = 3000;

type PageEvent = Extract<ReadingEvent, { kind: 'page' }>;

export type ViewLike = Pick<PagePayload, 'first_page' | 'last_page' | 'page_chars' | 'dwell_ms'> & {
  t: number;
};

export function eventKey(e: { device: string; seq: number }): string {
  return `${e.device}\u0000${e.seq}`;
}

export function sameView(
  a: Pick<ViewLike, 'first_page' | 'last_page'>,
  b: Pick<ViewLike, 'first_page' | 'last_page'>
): boolean {
  return a.first_page <= b.last_page && b.first_page <= a.last_page;
}

/** The view stayed long enough to read, and not at a skip's pace. */
export function readsPages(v: ViewLike): boolean {
  const dwell = v.dwell_ms;
  if (dwell === null || dwell < READ_DWELL_MS) return false;
  const chars = v.page_chars.reduce((sum, c) => sum + c, 0);
  return chars === 0 || (chars / dwell) * 60_000 <= SKIP_CPM;
}

/** Distinct pages read outside the first view, counted up to one past the limit. */
export function pagesReadAway(visit: ViewLike[]): number {
  const home = visit[0];
  const read = new Set<number>();
  for (const view of visit) {
    if (!home || sameView(view, home) || !readsPages(view)) continue;
    for (let p = view.first_page; p <= view.last_page; p++) read.add(p);
    if (read.size > LOOKUP_MAX_READ_PAGES) break;
  }
  return read.size;
}

export function isLookupVisit(visit: ViewLike[]): boolean {
  if (visit.length < 2) return false;
  if (!sameView(visit[visit.length - 1], visit[0])) return false;
  return pagesReadAway(visit) <= LOOKUP_MAX_READ_PAGES;
}

/** Native page views, grouped per device and volume, in time order, split on gaps. */
export function splitVisits(events: ReadingEvent[]): PageEvent[][] {
  const runs = new Map<string, PageEvent[]>();
  for (const e of events) {
    if (e.kind !== 'page' || e.device.startsWith(LEGACY_DEVICE_PREFIX)) continue;
    const key = `${e.device}\u0000${e.volume}`;
    const run = runs.get(key);
    if (run) run.push(e);
    else runs.set(key, [e]);
  }
  const visits: PageEvent[][] = [];
  for (const run of runs.values()) {
    run.sort((a, b) => a.t - b.t || a.seq - b.seq);
    let visit: PageEvent[] = [];
    let end = -Infinity;
    for (const e of run) {
      if (visit.length > 0 && e.t - end > VISIT_GAP_MS) {
        visits.push(visit);
        visit = [];
      }
      visit.push(e);
      end = Math.max(end, e.t + (e.dwell_ms ?? 0));
    }
    if (visit.length > 0) visits.push(visit);
  }
  return visits;
}

export interface LookupVerdict {
  /** Every view of a look-up visit. */
  lookup: Set<string>;
  /** The views of look-up visits that showed no page of the home view. */
  outsideHome: Set<string>;
}

export function lookupVisits(events: ReadingEvent[]): LookupVerdict {
  const lookup = new Set<string>();
  const outsideHome = new Set<string>();
  for (const visit of splitVisits(events)) {
    if (!isLookupVisit(visit)) continue;
    const home = visit[0];
    for (const view of visit) {
      const key = eventKey(view);
      lookup.add(key);
      if (!sameView(view, home)) outsideHome.add(key);
    }
  }
  return { lookup, outsideHome };
}
