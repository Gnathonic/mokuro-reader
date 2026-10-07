import { LEGACY_DEVICE_PREFIX } from './paths';
import type { ReadingEvent } from './types';

/**
 * Where a volume should be, across devices (phase 2c, spec: "Position across
 * devices"). The position itself stays the newest page event; this decides
 * when OTHER reading is worth offering instead of silently losing to it.
 *
 * The signal is what the newest device actually saw. A device that stopped on
 * a view is "superseded" once the newest device has viewed that page after it
 * — a handoff (picked up there), or a stale device the sync on open corrected.
 * A device whose final page the newest device never reached read on without
 * knowing: that page (where it stopped, not how far it peeked) is offered, on
 * every device. A view's page is its FIRST page (the reader's own position for
 * a spread); a view whose pages include the current position is that position.
 *
 * A restart wins over reading that never saw it. A restart is FOLLOWED once any
 * device has viewed page 1 (or earlier) after it. When nobody has and a newer
 * device read on elsewhere, the restart is re-applied (`reset`) and that
 * reading — as it stood when the reset was applied — is offered until answered.
 *
 * Answers (`position` events) are history like everything else: no offer is
 * made again for reading at or before an answered `through`, on any device,
 * and no stale copy can bring it back. A `forget` hides everything before it.
 * Converted (legacy) events never drive offers — they carry no device.
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
type RestartEvent = Extract<ReadingEvent, { kind: 'restart' }>;
type PositionEvent = Extract<ReadingEvent, { kind: 'position' }>;

const byTime = (a: ReadingEvent, b: ReadingEvent) =>
  a.t - b.t || a.seq - b.seq || a.device.localeCompare(b.device);

const isNative = (e: ReadingEvent) => !e.device.startsWith(LEGACY_DEVICE_PREFIX);
const covers = (view: PageEvent, page: number) => view.first_page <= page && page <= view.last_page;

export function planPosition(
  events: ReadingEvent[],
  record: { progress: number },
  ownDevice: string
): PositionPlan {
  let horizon = -Infinity;
  for (const e of events) if (e.kind === 'forget' && e.before > horizon) horizon = e.before;
  const live = events.filter((e) => e.t >= horizon).sort(byTime);

  const views = live.filter((e): e is PageEvent => e.kind === 'page' && isNative(e));
  const restarts = live.filter((e): e is RestartEvent => e.kind === 'restart' && isNative(e));
  const answers = live.filter((e): e is PositionEvent => e.kind === 'position');
  const last = views.at(-1);
  if (!last) return {};
  const newest = last.device;

  const offerOf = (view: PageEvent): PositionOffer => ({
    page: view.first_page,
    chars: view.chars_before + (view.page_chars[0] ?? 0),
    at: view.t,
    device: view.device,
    ownDevice: view.device === ownDevice
  });
  const answeredThrough = (kinds: PositionEvent['answer'][]) =>
    answers.reduce(
      (max, a) => (kinds.includes(a.answer) && a.through > max ? a.through : max),
      -Infinity
    );
  const decided = answeredThrough(['jump', 'stay']);

  // ---- a restart nobody followed ----
  const restart = restarts.at(-1);
  if (restart && restart.device !== newest) {
    const followed = views.some((v) => v.t > restart.t && v.first_page <= 1);
    const missedBy = views.filter((v) => v.device === newest && v.t > restart.t);
    if (!followed && missedBy.length > 0) {
      const applied = answers.find((a) => a.answer === 'reset' && a.through >= restart.t);
      if (!applied) {
        // Pending: the position is about to become the start, so the reading is news.
        const final = missedBy.at(-1)!;
        return final.t > decided
          ? { reset: { at: restart.t }, offer: offerOf(final) }
          : { reset: { at: restart.t } };
      }
      // Applied: offer the reading as it stood then — later turns are not new offers.
      const final = missedBy.filter((v) => v.t <= applied.t).at(-1);
      if (final && final.t > decided) return { offer: offerOf(final) };
      return {};
    }
  }

  // ---- reading the newest device never reached ----
  // Reading from before the newest restart belongs to the previous pass.
  const floor = Math.max(answeredThrough(['jump', 'stay', 'reset']), restart?.t ?? -Infinity);
  const finals = new Map<string, PageEvent>();
  for (const v of views) if (v.device !== newest && v.t > floor) finals.set(v.device, v);

  let best: PageEvent | undefined;
  for (const final of finals.values()) {
    if (covers(final, record.progress)) continue;
    const reached = views.some(
      (v) => v.device === newest && v.t > final.t && covers(v, final.first_page)
    );
    if (reached) continue;
    if (!best || byTime(final, best) > 0) best = final;
  }
  return best ? { offer: offerOf(best) } : {};
}
