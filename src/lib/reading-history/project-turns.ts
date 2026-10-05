import type { PageTurn } from '$lib/settings/volume-data';
import { LEGACY_DEVICE_PREFIX } from './paths';
import type { ReadingEvent } from './types';

/**
 * How close a legacy turn may sit to a native view and still be that view
 * (phase-1 devices recorded both for the same reading).
 */
export const COVER_SLACK_MS = 2000;

/**
 * The merged event table of every device, back in the shape existing stats
 * read: per volume, `PageTurn[]` in time order (spec: Rollout 2 — the
 * stopgap until phase 3 computes stats from events directly).
 *
 * - A native `page` view is a turn at its start: `[t, last_page, chars through
 *   its last page]` — the same "arrival" a turn always recorded.
 * - A legacy (converted) turn counts only if no native view of the same volume
 *   covers its time, so reading recorded both ways during phase 1 counts once.
 * - A `forget` hides that volume's events recorded before its `before`, on
 *   every device, legacy included. `restart` changes nothing: turns never
 *   reset on a restart.
 */
export function projectTurns(events: ReadingEvent[]): Map<string, PageTurn[]> {
  const byVolume = new Map<string, ReadingEvent[]>();
  for (const event of events) {
    const list = byVolume.get(event.volume);
    if (list) list.push(event);
    else byVolume.set(event.volume, [event]);
  }

  const out = new Map<string, PageTurn[]>();
  for (const [volume, list] of byVolume) {
    const turns = projectVolume(list);
    if (turns.length > 0) out.set(volume, turns);
  }
  return out;
}

/** One volume's events → its turns. Exported for incremental recomputation. */
export function projectVolume(list: ReadingEvent[]): PageTurn[] {
  let horizon = -Infinity;
  for (const e of list) if (e.kind === 'forget' && e.before > horizon) horizon = e.before;

  const native: Extract<ReadingEvent, { kind: 'page' }>[] = [];
  const legacy: Extract<ReadingEvent, { kind: 'page' }>[] = [];
  for (const e of list) {
    if (e.kind !== 'page' || e.t < horizon) continue;
    (e.device.startsWith(LEGACY_DEVICE_PREFIX) ? legacy : native).push(e);
  }

  const covered = coverage(native);
  const turns: PageTurn[] = native.map((n) => [
    n.t,
    n.last_page,
    n.chars_before + sum(n.page_chars)
  ]);
  for (const l of legacy) {
    if (covered(l.t)) continue;
    turns.push(
      l.page_chars.length === 0
        ? ([l.t, l.last_page] as unknown as PageTurn)
        : [l.t, l.last_page, l.chars_before + sum(l.page_chars)]
    );
  }
  return turns.sort((a, b) => a[0] - b[0]);
}

/** Disjoint, sorted intervals around every native view; binary-searched. */
function coverage(native: Extract<ReadingEvent, { kind: 'page' }>[]): (t: number) => boolean {
  const spans = native
    .map((n) => [n.t - COVER_SLACK_MS, n.t + (n.dwell_ms ?? 0) + COVER_SLACK_MS] as const)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return (t) => {
    let lo = 0;
    let hi = merged.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < merged[mid][0]) hi = mid - 1;
      else if (t > merged[mid][1]) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
