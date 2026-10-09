import { LEGACY_DEVICE_PREFIX } from './paths';
import { nativeCoverage } from './project-turns';
import type { ReadingEvent } from './types';

/**
 * Reading stats from history events (phase 3a; spec: "Speed and stats"). Pure:
 * the same events give the same figures on every device.
 *
 * - **One clock.** Time read is the counted dwell of `page` views plus
 *   `adjust` deltas.
 * - **Adaptive cutoff.** A view's expected dwell is its visible characters ×
 *   one global pace (the median ms per character of recent views); its cap is
 *   `clamp(k × expected, FLOOR, CEILING)`, or the manual override. A view over
 *   its cap counts TYPICAL time (`expected`, at least the floor) — the spec's
 *   "unanswered" rule until phase 3b asks the user.
 * - **Skips.** A view faster than `SKIP_CPM` is a skip: its time counts, but
 *   it never feeds speed, and pages only skip views showed are skipped, not
 *   read.
 * - **Passes.** A `restart` starts a new pass: a page's characters are read
 *   once per pass, credited (for speed) to the first non-skip view that
 *   showed it. A `forget` hides everything recorded before its `before`.
 * - **Legacy turns** (converted `recentPageTurns`) count only where no native
 *   view covers them; their page characters are the difference between
 *   consecutive turns' cumulative counts (the old pair rule), and one over its
 *   cap counts nothing (the old idle rule).
 */

export const DEFAULT_K = 3;
/** The least any view may take before it counts as a long pause (art pages). */
export const FLOOR_MS = 60_000;
export const CEILING_MS = 30 * 60_000;
/** The cap before there is enough data for a pace: the old default timeout. */
export const NO_DATA_CAP_MS = 5 * 60_000;
export const SKIP_CPM = 1500;

const PACE_MIN_CHARS = 20;
const PACE_MAX_SAMPLES = 500;
const PACE_MIN_SAMPLES = 30;
/** Recent speed looks back over this much counted reading. */
export const RECENT_WINDOW_MS = 8 * 60 * 60_000;

export interface IdleSettings {
  /** Cap multiplier over the expected dwell. */
  k: number;
  /** Manual cutoff; replaces the adaptive cap everywhere when set. */
  overrideMs: number | null;
}

export interface PreparedView {
  t: number;
  end: number;
  /** Raw dwell; `null` = unknown (the last converted turn of a sitting). */
  dwell: number | null;
  /** Characters on screen (`chars_visible`). */
  chars: number;
  skip: boolean;
  legacy: boolean;
  pass: number;
  /** Pages on screen and their characters. */
  pages: Array<[page: number, chars: number]>;
}

export interface PreparedVolume {
  views: PreparedView[];
  adjustMs: number;
  adjustChars: number;
}

export interface SpeedSample {
  end: number;
  ms: number;
  chars: number;
}

export interface VolumeTotals {
  timeMs: number;
  readChars: number;
  skippedChars: number;
  lastReadAt: number | null;
  /** Non-skip views that counted time, oldest first. */
  samples: SpeedSample[];
}

export interface SpeedEstimate {
  charsPerMinute: number;
  minutes: number;
}

type PageEvent = Extract<ReadingEvent, { kind: 'page' }>;

const byTime = (a: ReadingEvent, b: ReadingEvent) =>
  a.t - b.t || a.device.localeCompare(b.device) || a.seq - b.seq;

/** One volume's events → the pace-independent part of its stats. */
export function prepareVolume(events: ReadingEvent[]): PreparedVolume {
  let horizon = -Infinity;
  for (const e of events) if (e.kind === 'forget' && e.before > horizon) horizon = e.before;
  const live = events.filter((e) => e.t >= horizon).sort(byTime);

  const native = live.filter(
    (e): e is PageEvent => e.kind === 'page' && !e.device.startsWith(LEGACY_DEVICE_PREFIX)
  );
  const covered = nativeCoverage(native);
  // Legacy page chars come from the NEXT legacy turn, covered or not: the
  // cumulative count is a position, whichever device recorded the next one.
  const legacyAll = live.filter(
    (e): e is PageEvent => e.kind === 'page' && e.device.startsWith(LEGACY_DEVICE_PREFIX)
  );
  const legacyChars = new Map<PageEvent, number>();
  for (let i = 0; i < legacyAll.length; i++) {
    const here = legacyAll[i];
    const next = legacyAll[i + 1];
    const known = here.page_chars.length > 0 && next && next.page_chars.length > 0;
    legacyChars.set(here, known ? Math.max(0, next.chars_before - here.chars_before) : 0);
  }

  const views: PreparedView[] = [];
  let adjustMs = 0;
  let adjustChars = 0;
  let pass = 0;
  for (const e of live) {
    if (e.kind === 'restart') {
      pass++;
      continue;
    }
    if (e.kind === 'adjust') {
      adjustMs += e.time_delta_ms;
      adjustChars += e.chars_delta;
      continue;
    }
    if (e.kind !== 'page') continue;
    const legacy = e.device.startsWith(LEGACY_DEVICE_PREFIX);
    if (legacy && covered(e.t)) continue;
    const pages: Array<[number, number]> = legacy
      ? [[e.first_page, legacyChars.get(e) ?? 0]]
      : e.page_chars.map((c, i) => [e.first_page + i, c]);
    const chars = pages.reduce((sum, [, c]) => sum + c, 0);
    const dwell = e.dwell_ms;
    views.push({
      t: e.t,
      end: e.t + (dwell ?? 0),
      dwell,
      chars,
      skip: chars > 0 && dwell !== null && (dwell <= 0 || (chars / dwell) * 60_000 > SKIP_CPM),
      legacy,
      pass,
      pages
    });
  }
  return { views, adjustMs, adjustChars };
}

/** Median ms per character over the newest usable views of every volume. */
export function estimatePace(volumes: Iterable<PreparedVolume>): number | null {
  const usable: Array<{ t: number; rate: number }> = [];
  for (const volume of volumes) {
    for (const v of volume.views) {
      if (v.skip || v.dwell === null || v.chars < PACE_MIN_CHARS) continue;
      if (v.dwell <= 0 || v.dwell > CEILING_MS) continue;
      usable.push({ t: v.t, rate: v.dwell / v.chars });
    }
  }
  if (usable.length < PACE_MIN_SAMPLES) return null;
  const recent = usable
    .sort((a, b) => b.t - a.t)
    .slice(0, PACE_MAX_SAMPLES)
    .map((s) => s.rate)
    .sort((a, b) => a - b);
  const mid = recent.length >> 1;
  return recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2;
}

/** How long a view of `chars` characters may last before it is a long pause. */
export function viewCap(chars: number, pace: number | null, idle: IdleSettings): number {
  if (idle.overrideMs !== null) return idle.overrideMs;
  if (pace === null) return NO_DATA_CAP_MS;
  return clamp(idle.k * chars * pace, FLOOR_MS, CEILING_MS);
}

/** What a view over its cap counts: its expected dwell, within floor and cap. */
export function typicalDwell(chars: number, pace: number | null, cap: number): number {
  const expected = pace === null ? cap : chars * pace;
  return clamp(expected, Math.min(FLOOR_MS, cap), cap);
}

export function countVolume(
  prepared: PreparedVolume,
  pace: number | null,
  idle: IdleSettings
): VolumeTotals {
  let timeMs = prepared.adjustMs;
  let lastReadAt: number | null = null;
  const counted: Array<{ view: PreparedView; ms: number; reads: boolean }> = [];
  for (const view of prepared.views) {
    const cap = viewCap(view.chars, pace, idle);
    let ms: number;
    let reads = !view.skip;
    if (view.dwell === null) ms = 0;
    else if (view.dwell <= cap) ms = view.dwell;
    else if (view.legacy) {
      // The old idle rule: a gap over the timeout was neither time nor reading.
      ms = 0;
      reads = false;
    } else ms = Math.min(view.dwell, typicalDwell(view.chars, pace, cap));
    timeMs += ms;
    lastReadAt = Math.max(lastReadAt ?? view.end, view.end);
    counted.push({ view, ms, reads });
  }

  // Per pass: a page is read when any counting non-skip view showed it,
  // skipped when only skip views did.
  let readChars = prepared.adjustChars;
  let skippedChars = 0;
  const samples: SpeedSample[] = [];
  const credited = new Set<string>();
  const readPages = new Set<string>();
  for (const { view, reads } of counted) {
    if (reads) for (const [page] of view.pages) readPages.add(`${view.pass}|${page}`);
  }
  const skippedSeen = new Set<string>();
  for (const { view, ms, reads } of counted) {
    let fresh = 0;
    for (const [page, chars] of view.pages) {
      const key = `${view.pass}|${page}`;
      if (reads) {
        if (credited.has(key)) continue;
        credited.add(key);
        fresh += chars;
      } else if (view.skip && !readPages.has(key) && !skippedSeen.has(key)) {
        skippedSeen.add(key);
        skippedChars += chars;
      }
    }
    readChars += fresh;
    if (reads && ms > 0) samples.push({ end: view.end, ms, chars: fresh });
  }

  return {
    timeMs: Math.max(0, timeMs),
    readChars: Math.max(0, readChars),
    skippedChars,
    lastReadAt,
    samples
  };
}

/** Speed over the newest `windowMs` of counted reading; a sample straddling the edge counts pro rata. */
export function speedFromSamples(
  samples: SpeedSample[],
  windowMs: number = RECENT_WINDOW_MS
): SpeedEstimate {
  const newest = [...samples].sort((a, b) => b.end - a.end);
  let ms = 0;
  let chars = 0;
  for (const s of newest) {
    if (ms >= windowMs) break;
    const take = Math.min(s.ms, windowMs - ms);
    ms += take;
    chars += s.chars * (take / s.ms);
  }
  return ms > 0
    ? { charsPerMinute: (chars / ms) * 60_000, minutes: ms / 60_000 }
    : { charsPerMinute: 0, minutes: 0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
