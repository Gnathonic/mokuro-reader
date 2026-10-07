import { LEGACY_DEVICE_PREFIX } from './paths';
import type { ReadingEvent } from './types';

/**
 * Where a volume should be, across devices (phase 2c, spec: "Position across
 * devices"). The position itself stays the newest page event; this decides
 * when OTHER reading is worth offering instead of silently losing to it.
 *
 * The signal is what the newest device actually saw. A device that stopped on
 * page N is "superseded" once the newest device has viewed page N after it —
 * a handoff (picked up there), or a stale device the sync on open corrected.
 * A device whose final page the newest device never reached read on without
 * knowing: its final page (where it stopped, not how far it peeked) is offered,
 * on every device. Any page difference is offered.
 *
 * A restart wins over reading that never saw it: when the newest device's
 * reading after another device's restart never started over (no view of page
 * 1 or earlier), the restart is re-applied and that reading is offered.
 *
 * Answers (`position` events) are history like everything else: an offer is
 * never made again for reading at or before an answered `through`, on any
 * device, and no stale copy can bring it back. Converted (legacy) turns never
 * drive offers — they carry no device.
 */

export interface PositionOffer {
  page: number;
  /** Characters through that page, for the jump. */
  chars: number;
  /** When that reading stopped (the answer's `through`). */
  at: number;
  device: string;
  ownDevice: boolean;
}

export interface PositionPlan {
  /** A restart the newest reading never saw: re-apply it. */
  reset?: { at: number };
  offer?: PositionOffer;
}

type PageEvent = Extract<ReadingEvent, { kind: 'page' }>;

export function planPosition(
  events: ReadingEvent[],
  record: { progress: number },
  ownDevice: string
): PositionPlan {
  const views = events
    .filter((e): e is PageEvent => e.kind === 'page' && !e.device.startsWith(LEGACY_DEVICE_PREFIX))
    .sort((a, b) => a.t - b.t);
  const last = views.at(-1);
  if (!last) return {};
  const newest = last.device;

  let answered = -Infinity;
  let restart: Extract<ReadingEvent, { kind: 'restart' }> | undefined;
  for (const e of events) {
    if (e.kind === 'position' && e.through > answered) answered = e.through;
    if (e.kind === 'restart' && e.t < last.t && (!restart || e.t > restart.t)) restart = e;
  }

  const offerOf = (view: PageEvent): PositionOffer => ({
    page: view.last_page,
    chars: view.chars_before + view.page_chars.reduce((sum, c) => sum + c, 0),
    at: view.t,
    device: view.device,
    ownDevice: view.device === ownDevice
  });

  // A restart on another device that the newest reading never followed.
  if (restart && restart.device !== newest) {
    const after = views.filter((v) => v.device === newest && v.t > restart.t);
    const startedOver = after.some((v) => v.first_page <= 1);
    if (after.length > 0 && !startedOver) {
      const plan: PositionPlan = {};
      const resetPending = restart.t > answered;
      if (resetPending) plan.reset = { at: restart.t };
      // Pending: the position is about to become the start, so any page is news.
      if (last.t > answered && (resetPending || last.last_page !== record.progress)) {
        plan.offer = offerOf(last);
      }
      return plan;
    }
  }

  // Reading from before the newest restart belongs to the previous pass.
  const floor = Math.max(answered, restart?.t ?? -Infinity);
  const finals = new Map<string, PageEvent>();
  for (const v of views) if (v.device !== newest && v.t > floor) finals.set(v.device, v);

  let best: PageEvent | undefined;
  for (const final of finals.values()) {
    if (final.last_page === record.progress) continue;
    const reached = views.some(
      (v) =>
        v.device === newest &&
        v.t > final.t &&
        v.first_page <= final.last_page &&
        final.last_page <= v.last_page
    );
    if (reached) continue;
    if (!best || final.t > best.t) best = final;
  }
  return best ? { offer: offerOf(best) } : {};
}
