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
  speedFromSamples,
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
  const pace = estimatePace(prepared.values());
  const recountAll =
    work === 'all' ||
    !previous.ready ||
    pace !== previous.pace ||
    idle.k !== previous.idle.k ||
    idle.overrideMs !== previous.idle.overrideMs;
  const byVolume = recountAll ? new Map<string, VolumeTotals>() : new Map(previous.byVolume);
  for (const volume of recountAll ? prepared.keys() : volumes) {
    const p = prepared.get(volume);
    if (p) byVolume.set(volume, countVolume(p, pace, idle));
    else byVolume.delete(volume);
  }

  const samples = [...byVolume.values()].flatMap((t) => t.samples);
  state.set({ ready: true, pace, idle, byVolume, recent: speedFromSamples(samples) });
}

/** A volume's time and characters: its events plus its pre-history baseline. */
export function figuresFor(
  stats: ReadingStatsState,
  volume: string,
  record?: { legacyStats?: LegacyStats }
): VolumeFigures {
  const totals = stats.byVolume.get(volume);
  const timeMs = (totals?.timeMs ?? 0) + (record?.legacyStats?.time_ms ?? 0);
  return {
    timeMs,
    minutes: Math.floor(timeMs / 60_000),
    chars: (totals?.readChars ?? 0) + (record?.legacyStats?.chars ?? 0),
    skippedChars: totals?.skippedChars ?? 0,
    lastReadAt: totals?.lastReadAt ?? null
  };
}

/** A series' own speed, once it has an hour of reading; else `null`. */
export function seriesSpeed(stats: ReadingStatsState, volumeIds: string[]): SpeedEstimate | null {
  const samples = volumeIds.flatMap((id) => stats.byVolume.get(id)?.samples ?? []);
  const estimate = speedFromSamples(samples, RECENT_WINDOW_MS);
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
 * Give each volume's reading from before history a baseline (`legacyStats`):
 * the minutes and characters its record holds that its events do not
 * explain, so totals never drop at the switch to event-based stats.
 *
 * Once per device, every live record with reading gets one; after that only
 * records still carrying the retired minute counter (from a device that has
 * not switched yet). Never twice for a record: a baseline only merges down.
 * Run once history is complete — after a sync imported other devices' events,
 * or on a device with no provider.
 */
export async function fillLegacyBaselines(): Promise<number> {
  await historyTurnsReady();
  if (!get(state).ready && historyTurnsLoaded()) schedule('all');
  flushReadingStats();
  const stats = get(state);
  const firstPass = readFlag() !== 'done';

  let changed = 0;
  volumesWithTrash.update((all) => {
    const next = { ...all };
    for (const [id, record] of Object.entries(all)) {
      if (record.deletedOn || record.legacyStats) continue;
      const oldMinutes = record.timeReadInMinutes > 0;
      const hasReading = record.chars > 0 || record.completed || record.archivedReads.length > 0;
      if (!oldMinutes && !(firstPass && hasReading)) continue;
      const totals = stats.byVolume.get(id);
      const oldChars = record.chars + record.archivedReads.reduce((sum, r) => sum + r.chars, 0);
      const explainedChars = (totals?.readChars ?? 0) + (totals?.skippedChars ?? 0);
      // Not a user action: no new stamp.
      next[id] = new VolumeData({
        ...record,
        legacyStats: {
          time_ms: Math.max(0, record.timeReadInMinutes * 60_000 - (totals?.timeMs ?? 0)),
          chars: Math.max(0, oldChars - explainedChars)
        }
      });
      changed++;
    }
    return changed > 0 ? next : all;
  });
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
export function _resetReadingStatsForTests(): void {
  stop?.();
  stop = null;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending = null;
  prepared.clear();
  preparedLog = [];
  idle = EMPTY.idle;
  state.set(EMPTY);
}
