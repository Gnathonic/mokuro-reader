import { get, writable, type Readable } from 'svelte/store';
import { browser } from '$app/env';
import { idleSettings } from '#lib/settings/tracking-data.js';
import { VolumeData, volumesWithTrash, type LegacyStats } from '#lib/settings/volume-data.js';
import type { ReadingSpeedResult } from '#lib/util/reading-speed.js';
import {
  DEFAULT_K,
  RECENT_WINDOW_MS,
  countVolume,
  estimatePace,
  prepareVolume,
  recentSpeed,
  totalsBefore,
  coverFirstPages,
  type CreditTotals,
  type IdleSettings,
  type PreparedVolume,
  type SpeedEstimate,
  type VolumeTotals
} from './stats-engine';
import {
  getVolumeEvents,
  historyTurnsLoaded,
  historyTurnsReady,
  historyVolumes,
  onHistoryChanged
} from './turns-store';

/**
 * Reading stats in the app (phase 3a): the engine (`stats-engine.ts`) run over
 * the merged history, kept current as events arrive. Each volume is prepared
 * again only when its own events change; counting (which depends on the
 * global pace and the idle settings) is a cheap pass. Recomputation is
 * coalesced, so a burst of events — an import, a sync — costs one pass.
 *
 * Components read these figures through `figuresFor` and the speed helpers;
 * none of them runs the engine.
 */

export interface ReadingStatsState {
  /** History has loaded and been counted at least once. */
  ready: boolean;
  /** Median ms per character; `null` until there is enough reading. */
  pace: number | null;
  idle: IdleSettings;
  byVolume: Map<string, VolumeTotals>;
  /** Speed over the newest `RECENT_WINDOW_MS` of counted reading. */
  recent: SpeedEstimate;
}

export interface VolumeFigures {
  timeMs: number;
  minutes: number;
  chars: number;
  skippedChars: number;
  lastReadAt: number | null;
  /** The pre-history snapshot's share of the above (`unexplainedBaseline`). */
  baseline: { timeMs: number; chars: number };
  /**
   * What "mark as read" counted (#224) — inside `timeMs` and `chars`, never
   * measured reading: speed figures subtract it (`measuredFigures`).
   */
  credit: { timeMs: number; chars: number };
}

const RECOMPUTE_DELAY_MS = 500;
const SERIES_MIN_MINUTES = 60;
const RECENT_MIN_MINUTES = 30;
const BASELINES_DONE_KEY = 'reading-stats:baselines';
export const DEFAULT_SPEED: ReadingSpeedResult = {
  charsPerMinute: 100,
  isPersonalized: false,
  confidence: 'none',
  sessionsUsed: 0
};

const EMPTY: ReadingStatsState = {
  ready: false,
  pace: null,
  idle: { k: DEFAULT_K, overrideMs: null },
  byVolume: new Map(),
  recent: { charsPerMinute: 0, minutes: 0 }
};
const state = writable<ReadingStatsState>(EMPTY);
export const readingStats: Readable<ReadingStatsState> = { subscribe: state.subscribe };

const prepared = new Map<string, PreparedVolume>();
let pending: Set<string> | 'all' | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let idle: IdleSettings = EMPTY.idle;
let stop: (() => void) | null = null;
let preparedLog: string[] = [];
let countedLog: string[] = [];
/** Relative pace change that makes every volume's counts stale. */
const PACE_TOLERANCE = 0.02;
/** This device has taken its first-pass snapshots (`freezeLegacyBaselines`). */
let baselinesFrozen = readFlag() === 'done';

/** Start counting: once history has loaded, and again whenever it changes. */
export function initReadingStats(): () => void {
  stop?.();
  const stopHistory = onHistoryChanged((volumes) => schedule(volumes));
  const stopIdle = idleSettings.subscribe((next) => {
    if (next.k === idle.k && next.overrideMs === idle.overrideMs) return;
    idle = next;
    schedule(new Set());
  });
  if (historyTurnsLoaded()) schedule('all');
  else void historyTurnsReady().then(() => schedule('all'));
  stop = () => {
    stopHistory();
    stopIdle();
  };
  return stop;
}

function schedule(volumes: Set<string> | 'all'): void {
  if (volumes === 'all' || pending === 'all') pending = 'all';
  else {
    pending ??= new Set();
    for (const v of volumes) pending.add(v);
  }
  timer ??= setTimeout(flushReadingStats, RECOMPUTE_DELAY_MS);
}

/** Count whatever is pending now (tests; the baseline pass). */
export function flushReadingStats(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const work = pending;
  pending = null;
  if (work === null) return;

  const volumes = work === 'all' ? historyVolumes() : [...work];
  if (work === 'all') prepared.clear();
  for (const volume of volumes) {
    const events = getVolumeEvents(volume);
    if (events.length === 0) prepared.delete(volume);
    else {
      prepared.set(volume, prepareVolume(events));
      preparedLog.push(volume);
    }
  }

  const previous = get(state);
  const estimated = estimatePace(prepared.values());
  // Every volume's caps depend on the pace, but the median of the newest 500
  // views moves a hair with nearly every page: recounting the whole library
  // for that cost ~100 ms per page on a large history. Counts keep the pace
  // they were made with until it moves by more than PACE_TOLERANCE.
  const paceMoved =
    (estimated === null) !== (previous.pace === null) ||
    (estimated !== null &&
      previous.pace !== null &&
      Math.abs(estimated - previous.pace) > PACE_TOLERANCE * previous.pace);
  const recountAll =
    work === 'all' ||
    !previous.ready ||
    paceMoved ||
    idle.k !== previous.idle.k ||
    idle.overrideMs !== previous.idle.overrideMs;
  const pace = recountAll ? estimated : previous.pace;
  const byVolume = recountAll ? new Map<string, VolumeTotals>() : new Map(previous.byVolume);
  for (const volume of recountAll ? prepared.keys() : volumes) {
    const p = prepared.get(volume);
    if (p) {
      byVolume.set(volume, countVolume(p, pace, idle));
      countedLog.push(volume);
    } else byVolume.delete(volume);
  }

  state.set({ ready: true, pace, idle, byVolume, recent: recentSpeed(byVolume.values()) });
}

/**
 * Settles once history has loaded and been counted at least once — flushing
 * a pending pass instead of waiting out its debounce. For a reader that acts
 * on a volume's figures (the volume editor records the DIFFERENCE from the
 * time it showed): before the first flush `byVolume` is empty and the figure
 * is the baseline alone.
 */
export async function readingStatsReady(): Promise<void> {
  if (get(state).ready) return;
  await historyTurnsReady();
  if (get(state).ready) return;
  pending = 'all';
  flushReadingStats();
}

/** The record fields the pre-history snapshot is taken from. */
export type BaselineSource = {
  legacyStats?: LegacyStats;
  timeReadInMinutes?: number;
  chars?: number;
  completed?: boolean;
  archivedReads?: Array<{ chars: number; at?: number }>;
};

/**
 * The record's pre-history snapshot: the stored one, or — for a record that
 * should get one and has not been frozen yet — the same figures, unfrozen
 * (`before: Infinity`, so every event is set against them). Either way the
 * total never shows less than the old figure.
 */
function snapshotOf(
  record: BaselineSource | undefined,
  firstPass: boolean
): LegacyStats | undefined {
  if (!record) return undefined;
  if (record.legacyStats) return record.legacyStats;
  const minutes = record.timeReadInMinutes ?? 0;
  const oldChars =
    (record.chars ?? 0) + (record.archivedReads ?? []).reduce((n, r) => n + r.chars, 0);
  const hasReading = oldChars > 0 || !!record.completed;
  if (minutes <= 0 && !(firstPass && hasReading)) return undefined;
  return { time_ms: minutes * 60_000, chars: oldChars, before: Infinity };
}

/**
 * What a snapshot holds beyond the events from before its freeze: the old
 * counter's reading that history does not explain (a skim counts as
 * explained — it was in the old lifetime count, and it is not re-read).
 *
 * It is explained by the reading and edits from before its freeze only (the
 * engine's timeline: never a credit, #224). An unfrozen snapshot (`before:
 * Infinity`) is explained exactly as freezing it now would: by every view
 * and edit so far, never a credit — so the freeze changes no figure, and a
 * credit never moves the baseline in the meantime. (This device freezes a
 * record before it marks it with a credit, `withFrozenBaselines`: a live
 * count a mark already moved to the whole volume would cut the credit.)
 */
function unexplained(
  snapshot: LegacyStats,
  totals: VolumeTotals | undefined
): { timeMs: number; chars: number } {
  const explained = totals
    ? totalsBefore(totals, snapshot.before)
    : { timeMs: 0, readChars: 0, skippedChars: 0 };
  return {
    timeMs: Math.max(0, snapshot.time_ms - explained.timeMs),
    chars: Math.max(0, snapshot.chars - explained.readChars - explained.skippedChars)
  };
}

/**
 * Whatever of a volume's pre-history snapshot the events from before its
 * freeze do not explain — never negative. It belongs to no device (the
 * device stats' "Before history" row).
 */
export function unexplainedBaseline(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource
): { timeMs: number; chars: number } {
  return baselineOf(stats.byVolume.get(volume), record).baseline;
}

const NO_BASELINE = { timeMs: 0, chars: 0 };
const NO_CUT = { chars: 0, ms: 0 };

/** A volume's baseline and what it does to the volume's credits (`baselineOf`). */
interface Baseline {
  baseline: { timeMs: number; chars: number };
  lump: { pass: number; chars: number } | null;
  /** What the credits of the lump's pass give up: the sum over `credits`. */
  cut: { chars: number; ms: number };
  /** Every live credit with what it counts once cut (the engine's when nothing is). */
  credits: CreditTotals[];
}

/**
 * A volume's baseline, and how it meets the volume's credits (#224).
 *
 * The baseline is a lump without pages, so the engine cannot set it against
 * a credit's pages; this does, by characters. Its share of ONE pass is the
 * old counter's POSITION part — the snapshot less the reads archived before
 * the freeze, each a pass of its own (`convertLegacyRecord` made them
 * restarts) — in the pass the record was on when it was frozen (`lump`).
 * A credit in that pass gives up what would take the pass past the
 * volume's characters with the lump in it (`cut`, off the lowest pages the
 * pass's credits hold, as the engine does). A pass a
 * "Reset All" ended keeps none of the lump.
 *
 * Credits never explain the snapshot, frozen or not (the engine's timeline
 * leaves them out), so its baseline is the same with or without them and
 * what they count is never measured reading.
 *
 * The cut is computed here ONCE, per credit (`credits`): each keeps the
 * pages `coverFirstPages` leaves it and its time in proportion to the
 * characters it keeps. `cut` is their sum, so the figures (`figuresFor`,
 * `passFiguresFor`) and what a credit shows or Remove takes back
 * (`creditsFor`) are the same computation.
 */
function baselineOf(
  totals: VolumeTotals | undefined,
  record: BaselineSource | undefined
): Baseline {
  const engine = totals?.credits ?? [];
  const snapshot = snapshotOf(record, !baselinesFrozen);
  if (!snapshot) return { baseline: NO_BASELINE, lump: null, cut: NO_CUT, credits: engine };
  const baseline = unexplained(snapshot, totals);
  const none = { baseline, lump: null, cut: NO_CUT, credits: engine };
  if (baseline.chars <= 0) return none;
  let archived = 0;
  for (const read of record?.archivedReads ?? []) {
    if ((read.at ?? -Infinity) < snapshot.before) archived += read.chars;
  }
  const chars = Math.min(baseline.chars, Math.max(0, snapshot.chars - archived));
  if (chars <= 0) return none;
  let pass = 0;
  const passes = totals?.passes ?? [];
  for (let p = 1; p < passes.length; p++) if (passes[p].start < snapshot.before) pass = p;
  const inPass = passes[pass];
  // "Reset All" ended that pass: its share of the lump counts nothing either.
  if (inPass?.reset) {
    return {
      baseline: { timeMs: baseline.timeMs, chars: baseline.chars - chars },
      lump: { pass, chars: 0 },
      cut: NO_CUT,
      credits: engine
    };
  }
  const lump = { pass, chars };
  const uncut = { baseline, lump, cut: NO_CUT, credits: engine };
  if (!inPass || inPass.creditChars <= 0) return uncut;
  const over = inPass.chars + chars - (inPass.volumeChars ?? Infinity);
  const cutChars = Math.min(inPass.creditChars, Math.max(0, over));
  if (cutChars <= 0) return uncut;
  // Reading from the start: the cut covers the lowest pages the pass's credits hold.
  const here = engine.flatMap((credit, i) => (credit.pass === pass ? [i] : []));
  const kept = coverFirstPages(
    here.map((i) => {
      const { pages, pageChars } = engine[i];
      return pages.map((page, j): [number, number] => [page, pageChars[j] ?? 0]);
    }),
    cutChars
  );
  const credits = [...engine];
  const cut = { chars: 0, ms: 0 };
  here.forEach((i, k) => {
    const credit = engine[i];
    const ms = credit.chars > 0 ? (credit.ms * kept[k].chars) / credit.chars : credit.ms;
    cut.chars += credit.chars - kept[k].chars;
    cut.ms += credit.ms - ms;
    credits[i] = { ...credit, ms, ...kept[k] };
  });
  return { baseline, lump, cut, credits };
}

/**
 * A volume's time and characters: its history, plus whatever of the
 * pre-history snapshot the events from before its freeze do not explain.
 * Clamped only here, after the snapshot is added, so an editor edit below
 * the old figure takes effect. A credit never takes a pass past the volume
 * (the engine's budget, and `baselineOf` for the baseline's pass).
 */
export function figuresFor(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource
): VolumeFigures {
  const totals = stats.byVolume.get(volume);
  const { baseline, cut } = baselineOf(totals, record);
  const timeMs = Math.max(0, (totals?.timeMs ?? 0) - cut.ms + baseline.timeMs);
  const chars = (totals?.readChars ?? 0) - cut.chars + baseline.chars;
  return {
    timeMs,
    minutes: Math.floor(timeMs / 60_000),
    chars: Math.max(0, chars),
    skippedChars: totals?.skippedChars ?? 0,
    lastReadAt: totals?.lastReadAt ?? null,
    baseline,
    credit: {
      timeMs: (totals?.creditMs ?? 0) - cut.ms,
      chars: (totals?.creditChars ?? 0) - cut.chars
    }
  };
}

/**
 * The minutes the volume editor's "Reset All" records its time edit from:
 * the volume's time as the stats will count it once the reset is applied.
 * A reset's pass keeps no credit, so the time its credits count now
 * (`creditsFor`, after the baseline's cut) leaves with the reset itself —
 * an edit from the figure shown would take it off a second time.
 */
export function minutesAfterReset(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource
): number {
  const totals = stats.byVolume.get(volume);
  const pass = totals?.pass ?? 0;
  const { baseline, cut, credits } = baselineOf(totals, record);
  let creditMs = 0;
  for (const credit of credits) if (credit.pass === pass) creditMs += credit.ms;
  const timeMs = (totals?.timeMs ?? 0) - cut.ms + baseline.timeMs - creditMs;
  // Whole milliseconds: a credit's time scaled by its characters is
  // fractional, and 659,999.99… ms must be the 11 minutes it is.
  return Math.floor(Math.max(0, Math.round(timeMs)) / 60_000);
}

/**
 * Whether the volume editor's "Reset All" has a pass to end — whether it
 * records a `reset` (#224). Not "the pass shows characters": that figure is
 * the pass's CLAMPED net, and an editor edit (a v1.11.0 Reset All recorded
 * the record's characters as a negative adjust) can hold it at 0 while the
 * pass's pages are read and its credits live. Unended, such a pass would
 * count a re-read as nothing, and its credits' time would come off again
 * with the editor's time edit. So: any page read or claimed in the pass,
 * any live credit in it, any characters at all in its raw count (an edit
 * either way), or the pre-history baseline's share in it.
 */
export function resetEndsPass(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource
): boolean {
  const totals = stats.byVolume.get(volume);
  if (totals) {
    const pass = totals.pass;
    if (totals.passRead.size > 0) return true;
    if (totals.credits.some((credit) => credit.pass === pass)) return true;
    if ((totals.passes[pass]?.chars ?? 0) !== 0) return true;
  }
  return passFiguresFor(stats, volume, record).chars > 0;
}

/** The current pass of a volume: what it counts, and of that what credits count. */
export interface PassFigures {
  /** The latest pass (restarts so far). */
  pass: number;
  /**
   * Its characters: views, credits and editor edits of the pass, plus the
   * baseline's share when the record was on this pass when it was frozen.
   * A credit never takes it past the volume's characters.
   */
  chars: number;
  credit: { timeMs: number; chars: number };
}

/**
 * The volume's CURRENT PASS as the stats count it (#224) — the reading of
 * this time through the volume, which never exceeds it once credits are in;
 * `figuresFor` is the lifetime (every pass, re-reads included). `which`
 * names an earlier pass instead (tests sweep every one).
 */
export function passFiguresFor(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource,
  which?: number
): PassFigures {
  const totals = stats.byVolume.get(volume);
  const pass = which ?? totals?.pass ?? 0;
  const current = totals?.passes[pass];
  const { lump, cut } = baselineOf(totals, record);
  const here = lump?.pass === pass;
  const cutHere = here ? cut : NO_CUT;
  return {
    pass,
    chars: Math.max(0, (current?.chars ?? 0) - cutHere.chars + (here ? lump.chars : 0)),
    credit: {
      timeMs: (current?.creditMs ?? 0) - cutHere.ms,
      chars: (current?.creditChars ?? 0) - cutHere.chars
    }
  };
}

/**
 * Every live credit of a volume with what it counts now, oldest first: the
 * engine's, less the baseline's cut (`baselineOf`), which — reading from the
 * start, like everything a pass counts without pages — covers the lowest
 * pages its pass's credits hold (`coverFirstPages`).
 */
export function creditsFor(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource
): CreditTotals[] {
  const totals = stats.byVolume.get(volume);
  if (!totals || totals.credits.length === 0) return [];
  return baselineOf(totals, record).credits;
}

/**
 * A volume's figures without what "mark as read" counted: the reading this
 * app measured (plus the pre-history baseline and editor edits, as before).
 * What every speed figure is made of.
 */
export function measuredFigures(figures: Pick<VolumeFigures, 'timeMs' | 'chars' | 'credit'>): {
  timeMs: number;
  chars: number;
} {
  return {
    timeMs: Math.max(0, figures.timeMs - figures.credit.timeMs),
    chars: Math.max(0, figures.chars - figures.credit.chars)
  };
}

/**
 * The pages of a volume this app never saw read in its current pass (#224),
 * `pageChars` its pages' characters (page p at index p − 1): 1..N minus the
 * pass's pages read by a counting view or claimed by a live credit — and
 * never more characters than the pass has left of the volume
 * (`passFiguresFor`). What the pass counts beyond its pages' (the
 * pre-history baseline, an older editor's adjusts, a converted turn's
 * stretch, a recount) is reading from the start, so the FIRST of those pages
 * go: a page only partly left goes too — a credit may count less than was
 * read elsewhere, never more.
 */
export function pagesNotReadHere(
  stats: ReadingStatsState,
  volume: string,
  pageChars: number[],
  record?: BaselineSource
): number[] {
  const read = stats.byVolume.get(volume)?.passRead;
  const pages: number[] = [];
  let unread = 0;
  let size = 0;
  for (let page = 1; page <= pageChars.length; page++) {
    size += pageChars[page - 1];
    if (read?.has(page)) continue;
    pages.push(page);
    unread += pageChars[page - 1];
  }
  let over = unread - Math.max(0, size - passFiguresFor(stats, volume, record).chars);
  let first = 0;
  while (first < pages.length && over > 0) over -= pageChars[pages[first++] - 1];
  return first > 0 ? pages.slice(first) : pages;
}

/** A series' own speed, once it has an hour of reading; else `null`. */
export function seriesSpeed(stats: ReadingStatsState, volumeIds: string[]): SpeedEstimate | null {
  const totals = volumeIds.flatMap((id) => stats.byVolume.get(id) ?? []);
  const estimate = recentSpeed(totals, RECENT_WINDOW_MS);
  return estimate.minutes >= SERIES_MIN_MINUTES ? estimate : null;
}

function confidenceFor(minutes: number): ReadingSpeedResult['confidence'] {
  const windowMinutes = RECENT_WINDOW_MS / 60_000;
  return minutes >= windowMinutes * 0.75
    ? 'high'
    : minutes >= windowMinutes * 0.5
      ? 'medium'
      : minutes >= RECENT_MIN_MINUTES
        ? 'low'
        : 'none';
}

/**
 * The speed for time left in a series: the series' own, once it has an hour
 * of reading (spec: "Time left uses the series' own speed once it has enough
 * data"), else `fallback` (the recent speed).
 */
export function seriesReadingSpeed(
  stats: ReadingStatsState,
  volumeIds: string[],
  fallback: ReadingSpeedResult
): ReadingSpeedResult {
  const own = seriesSpeed(stats, volumeIds);
  if (!own) return fallback;
  return {
    charsPerMinute: Math.round(own.charsPerMinute),
    isPersonalized: true,
    confidence: confidenceFor(own.minutes),
    sessionsUsed: volumeIds.filter((id) => (stats.byVolume.get(id)?.samples.length ?? 0) > 0).length
  };
}

/**
 * The reading speed estimates use: the newest 8 hours of counted reading
 * across every volume and device. With under half an hour of it, completed
 * volumes' pre-history reading (their baselines) fills in — only the part
 * their events from before the freeze do not explain (`unexplained`, as in
 * `figuresFor`): the samples already hold that event time.
 */
export function recentReadingSpeed(
  stats: ReadingStatsState,
  records: Record<string, Pick<VolumeData, 'completed' | 'lastProgressUpdate' | 'legacyStats'>>
): ReadingSpeedResult {
  let minutes = stats.recent.minutes;
  let chars = stats.recent.charsPerMinute * minutes;
  let used = 0;
  for (const totals of stats.byVolume.values()) if (totals.samples.length > 0) used++;

  if (minutes < RECENT_MIN_MINUTES) {
    const completed = Object.entries(records)
      .flatMap(([id, r]) => {
        if (!r.completed || !r.legacyStats) return [];
        const rest = unexplained(r.legacyStats, stats.byVolume.get(id));
        return rest.timeMs > 0 && rest.chars > 0
          ? [{ at: r.lastProgressUpdate, time_ms: rest.timeMs, chars: rest.chars }]
          : [];
      })
      .filter((r) => (r.chars / r.time_ms) * 60_000 <= 1000)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    for (const r of completed) {
      if (minutes >= RECENT_WINDOW_MS / 60_000) break;
      minutes += r.time_ms / 60_000;
      chars += r.chars;
      used++;
    }
  }

  if (minutes <= 0) return DEFAULT_SPEED;
  return {
    charsPerMinute: Math.round(chars / minutes),
    isPersonalized: true,
    confidence: confidenceFor(minutes),
    sessionsUsed: used
  };
}

/**
 * Freeze each record's pre-history snapshot (`legacyStats`): its old minutes
 * and lifetime characters, stamped with now. Needs no events — what history
 * holds from before the freeze is set against it whenever it arrives
 * (`figuresFor`) — so it runs at start, and after each sync for records a
 * device still on the minute counter sent.
 *
 * Once per device, every live record with reading gets one; after that only
 * records still carrying the retired minute counter. Never twice for a record.
 */
export function freezeLegacyBaselines(now: number = Date.now()): number {
  const firstPass = !baselinesFrozen;
  const frozen: Record<string, VolumeData> = {};
  for (const [id, record] of Object.entries(get(volumesWithTrash))) {
    if (record.deletedOn || record.legacyStats) continue;
    const snapshot = snapshotOf(record, firstPass);
    if (!snapshot) continue;
    // Not a user action: no new stamp.
    frozen[id] = new VolumeData({ ...record, legacyStats: { ...snapshot, before: now } });
  }
  const changed = Object.keys(frozen).length;
  // Only a real change touches the store: an `update` returning the same
  // object still notifies every subscriber and rewrites localStorage, and
  // this runs at every start and after every sync.
  if (changed > 0) volumesWithTrash.update((all) => ({ ...all, ...frozen }));
  baselinesFrozen = true;
  writeFlag('done');
  return changed;
}

/**
 * Run `change` (a mark as read) with the pre-history snapshots of `volumes`
 * frozen as they stood BEFORE it (#224). An unfrozen snapshot is the
 * record's live count, and a mark moves that to the whole volume: frozen
 * after it, the snapshot would hold the mark's pages as old reading and
 * the mark's credit would be cut to nothing — its characters measured as
 * "Before history". A record that has no snapshot yet but would get one at
 * this device's first pass (`snapshotOf`) gets an empty one, which records
 * that it was frozen. Not a user action: no new stamp.
 */
export function withFrozenBaselines<T>(
  volumes: Iterable<string>,
  change: () => T,
  now: number = Date.now()
): T {
  const firstPass = !baselinesFrozen;
  const records = get(volumesWithTrash);
  const snapshots = new Map<string, LegacyStats>();
  for (const id of volumes) {
    const record = records[id];
    if (record?.legacyStats || record?.deletedOn) continue;
    const snapshot = snapshotOf(record, firstPass);
    if (snapshot) snapshots.set(id, { ...snapshot, before: now });
    else if (firstPass) snapshots.set(id, { time_ms: 0, chars: 0, before: now });
  }
  const result = change();
  if (snapshots.size > 0) {
    volumesWithTrash.update((all) => {
      const next = { ...all };
      for (const [id, legacyStats] of snapshots) {
        const record = next[id];
        if (record && !record.legacyStats) next[id] = new VolumeData({ ...record, legacyStats });
      }
      return next;
    });
  }
  return result;
}

function readFlag(): string | null {
  if (!browser) return null;
  try {
    return window.localStorage.getItem(BASELINES_DONE_KEY);
  } catch {
    return null;
  }
}

function writeFlag(value: string): void {
  if (!browser) return;
  try {
    window.localStorage.setItem(BASELINES_DONE_KEY, value);
  } catch {
    // Storage blocked: the first pass runs again next start — it skips every
    // record that already has a baseline, so only new records are affected.
  }
}

/** Test hooks. */
export function _preparedForTests(): string[] {
  return preparedLog;
}
export function _countedForTests(): string[] {
  return countedLog;
}
export function _resetReadingStatsForTests(): void {
  stop?.();
  stop = null;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending = null;
  prepared.clear();
  preparedLog = [];
  countedLog = [];
  baselinesFrozen = readFlag() === 'done';
  idle = EMPTY.idle;
  state.set(EMPTY);
}
