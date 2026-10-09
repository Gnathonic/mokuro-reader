import { get, writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import { idleSettings } from '$lib/settings/tracking-data';
import { VolumeData, volumesWithTrash, type LegacyStats } from '$lib/settings/volume-data';
import type { ReadingSpeedResult } from '$lib/util/reading-speed';
import {
  DEFAULT_K,
  RECENT_WINDOW_MS,
  countVolume,
  estimatePace,
  prepareVolume,
  recentSpeed,
  totalsBefore,
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

/** The record fields the pre-history snapshot is taken from. */
export type BaselineSource = {
  legacyStats?: LegacyStats;
  timeReadInMinutes?: number;
  chars?: number;
  completed?: boolean;
  archivedReads?: Array<{ chars: number }>;
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
 * A volume's time and characters: its history, plus whatever of the
 * pre-history snapshot the events from before its freeze do not explain.
 * Clamped only here, after the snapshot is added, so an editor edit below
 * the old figure takes effect.
 */
export function figuresFor(
  stats: ReadingStatsState,
  volume: string,
  record?: BaselineSource
): VolumeFigures {
  const totals = stats.byVolume.get(volume);
  let timeMs = totals?.timeMs ?? 0;
  let chars = totals?.readChars ?? 0;
  const snapshot = snapshotOf(record, !baselinesFrozen);
  if (snapshot) {
    const explained = totals
      ? totalsBefore(totals, snapshot.before)
      : { timeMs: 0, readChars: 0, skippedChars: 0 };
    timeMs += Math.max(0, snapshot.time_ms - explained.timeMs);
    chars += Math.max(0, snapshot.chars - explained.readChars - explained.skippedChars);
  }
  timeMs = Math.max(0, timeMs);
  return {
    timeMs,
    minutes: Math.floor(timeMs / 60_000),
    chars: Math.max(0, chars),
    skippedChars: totals?.skippedChars ?? 0,
    lastReadAt: totals?.lastReadAt ?? null
  };
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
 * volumes' pre-history reading (their baselines) fills in — never their event
 * time, which the samples already hold.
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
    const completed = Object.values(records)
      .filter(
        (r) => r.completed && r.legacyStats && r.legacyStats.time_ms > 0 && r.legacyStats.chars > 0
      )
      .map((r) => ({ at: r.lastProgressUpdate, ...r.legacyStats! }))
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
  let changed = 0;
  volumesWithTrash.update((all) => {
    const next = { ...all };
    for (const [id, record] of Object.entries(all)) {
      if (record.deletedOn || record.legacyStats) continue;
      const snapshot = snapshotOf(record, firstPass);
      if (!snapshot) continue;
      // Not a user action: no new stamp.
      next[id] = new VolumeData({ ...record, legacyStats: { ...snapshot, before: now } });
      changed++;
    }
    return changed > 0 ? next : all;
  });
  baselinesFrozen = true;
  writeFlag('done');
  return changed;
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
