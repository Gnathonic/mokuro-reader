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
  /** Volume-editor edits, in time order. */
  adjusts: Array<{ t: number; ms: number; chars: number }>;
  /** This volume's newest views usable for the pace, `[t, ms per char]`, newest first. */
  paceTail: Array<[t: number, rate: number]>;
}

export interface SpeedSample {
  end: number;
  ms: number;
  chars: number;
}

/** Running totals after each counted entry, by time — for `totalsBefore`. */
export type TimelinePoint = [t: number, timeMs: number, readChars: number, skippedChars: number];

export interface VolumeTotals {
  /**
   * RAW totals: a negative `adjust` (an editor edit below what history
   * holds) may take them below zero — the pre-history baseline is added
   * before anything is clamped (`figuresFor`).
   */
  timeMs: number;
  readChars: number;
  skippedChars: number;
  lastReadAt: number | null;
  /** Latest end among `samples` (−Infinity without any). */
  newestSampleEnd: number;
  timeline: TimelinePoint[];
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
  const adjusts: PreparedVolume['adjusts'] = [];
  let pass = 0;
  for (const e of live) {
    if (e.kind === 'restart') {
      pass++;
      continue;
    }
    if (e.kind === 'adjust') {
      adjusts.push({ t: e.t, ms: e.time_delta_ms, chars: e.chars_delta });
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
  const paceTail: PreparedVolume['paceTail'] = [];
  for (let i = views.length - 1; i >= 0 && paceTail.length < PACE_MAX_SAMPLES; i--) {
    const v = views[i];
    if (v.skip || v.dwell === null || v.chars < PACE_MIN_CHARS) continue;
    if (v.dwell <= 0 || v.dwell > CEILING_MS) continue;
    paceTail.push([v.t, v.dwell / v.chars]);
  }
  paceTail.sort((a, b) => b[0] - a[0]);
  return { views, adjusts, paceTail };
}

/** Median ms per character over the newest usable views of every volume. */
export function estimatePace(volumes: Iterable<PreparedVolume>): number | null {
  // Newest volumes first; once 500 candidates are in hand, a volume whose
  // newest view is older than the 500th can contribute nothing. A page turn
  // then costs the few volumes read lately, not the whole library.
  const tails = [...volumes]
    .map((v) => v.paceTail)
    .filter((tail) => tail.length > 0)
    .sort((a, b) => b[0][0] - a[0][0]);
  let usable: Array<[number, number]> = [];
  for (const tail of tails) {
    if (usable.length >= PACE_MAX_SAMPLES) {
      usable.sort((a, b) => b[0] - a[0]);
      usable.length = PACE_MAX_SAMPLES;
      if (tail[0][0] < usable[PACE_MAX_SAMPLES - 1][0]) break;
    }
    usable = usable.concat(tail);
  }
  if (usable.length < PACE_MIN_SAMPLES) return null;
  const recent = usable
    .sort((a, b) => b[0] - a[0])
    .slice(0, PACE_MAX_SAMPLES)
    .map((s) => s[1])
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
  let timeMs = 0;
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
  let readChars = 0;
  let skippedChars = 0;
  const entries: Array<[t: number, ms: number, read: number, skipped: number]> = [];
  const samples: SpeedSample[] = [];
  const credited = new Set<string>();
  const readPages = new Set<string>();
  for (const { view, reads } of counted) {
    if (reads) for (const [page] of view.pages) readPages.add(`${view.pass}|${page}`);
  }
  const skippedSeen = new Set<string>();
  for (const { view, ms, reads } of counted) {
    let fresh = 0;
    let skimmed = 0;
    for (const [page, chars] of view.pages) {
      const key = `${view.pass}|${page}`;
      if (reads) {
        if (credited.has(key)) continue;
        credited.add(key);
        fresh += chars;
      } else if (view.skip && !readPages.has(key) && !skippedSeen.has(key)) {
        skippedSeen.add(key);
        skimmed += chars;
      }
    }
    readChars += fresh;
    skippedChars += skimmed;
    entries.push([view.t, ms, fresh, skimmed]);
    if (reads && ms > 0) samples.push({ end: view.end, ms, chars: fresh });
  }
  for (const a of prepared.adjusts) {
    timeMs += a.ms;
    readChars += a.chars;
    entries.push([a.t, a.ms, a.chars, 0]);
  }

  entries.sort((a, b) => a[0] - b[0]);
  const timeline: TimelinePoint[] = [];
  let [t0, r0, s0] = [0, 0, 0];
  for (const [t, ms, read, skipped] of entries) {
    t0 += ms;
    r0 += read;
    s0 += skipped;
    timeline.push([t, t0, r0, s0]);
  }

  let newestSampleEnd = -Infinity;
  for (const sample of samples) if (sample.end > newestSampleEnd) newestSampleEnd = sample.end;
  return { timeMs, readChars, skippedChars, lastReadAt, newestSampleEnd, timeline, samples };
}

/** What a volume's history held from before `before` (views by their start). */
export function totalsBefore(
  totals: Pick<VolumeTotals, 'timeline'>,
  before: number
): { timeMs: number; readChars: number; skippedChars: number } {
  const line = totals.timeline;
  let lo = 0;
  let hi = line.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (line[mid][0] < before) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return { timeMs: 0, readChars: 0, skippedChars: 0 };
  const [, timeMs, readChars, skippedChars] = line[found];
  return { timeMs, readChars, skippedChars };
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

/**
 * `speedFromSamples` over many volumes without sorting every sample: volumes
 * are taken newest first until the window is full and the next volume's
 * newest sample is older than the window's edge.
 */
export function recentSpeed(
  volumes: Iterable<Pick<VolumeTotals, 'samples' | 'newestSampleEnd'>>,
  windowMs: number = RECENT_WINDOW_MS
): SpeedEstimate {
  const ordered = [...volumes]
    .filter((v) => v.samples.length > 0)
    .sort((a, b) => b.newestSampleEnd - a.newestSampleEnd);
  let picked: SpeedSample[] = [];
  let pickedMs = 0;
  for (const volume of ordered) {
    if (pickedMs >= windowMs && volume.newestSampleEnd < windowEdge(picked, windowMs)) break;
    picked = picked.concat(volume.samples);
    for (const s of volume.samples) pickedMs += s.ms;
  }
  return speedFromSamples(picked, windowMs);
}

/** The end of the oldest sample the window (newest first) still reaches. */
function windowEdge(samples: SpeedSample[], windowMs: number): number {
  const newest = [...samples].sort((a, b) => b.end - a.end);
  let ms = 0;
  for (const s of newest) {
    ms += s.ms;
    if (ms >= windowMs) return s.end;
  }
  return -Infinity;
}
