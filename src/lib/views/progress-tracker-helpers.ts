import { VolumeData, calculatePagesReadInPeriod } from '$lib/settings/volume-data';
import { normalizeSeriesKey } from '$lib/metadata/series-key';
import { isCompletedInPeriod, isFinished } from '$lib/goals/goal-counting';
import { calculatePeriodPageTargetTotal } from '$lib/goals/progress-targets';
import type { GoalPeriod, GoalSnapshot } from '$lib/goals/types';
import type { ProgressTargetMode, ProgressTrackerSorting } from '$lib/settings/misc';

export type TrackerEntryWithSortData = {
  volumeId: string;
  volumeData: VolumeData;
  remainingPages: number;
  targetPagesPerPeriod: number | null;
  pagesReadInPeriod: number;
  pagesToGoal: number | null;
  daysUntilDeadline: number | null;
  lastProgressUpdate: number;
  hasDeadline: boolean;
};

export type CompletedSeriesEntry = {
  key: string;
  representativeEntry: TrackerEntryWithSortData;
  completedCount: number;
  completedLabel: string;
  latestCompletedTimestamp: number;
};

function getValidTimestamp(value?: string | null): number | null {
  if (!value) return null;

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function getCompletionTimestamp(
  entry: TrackerEntryWithSortData,
  completedAtMap: Record<string, string>
): number {
  return getValidTimestamp(completedAtMap[entry.volumeId]) ?? entry.lastProgressUpdate;
}

export function formatCompletedVolumeCount(count: number): string {
  return `${count} volume${count === 1 ? '' : 's'}`;
}

export function sortByAddedDate(
  entriesWithSortData: TrackerEntryWithSortData[]
): TrackerEntryWithSortData[] {
  return [...entriesWithSortData].sort((a, b) => {
    const aAddedOn = getValidTimestamp(a.volumeData.addedOn);
    const bAddedOn = getValidTimestamp(b.volumeData.addedOn);

    if (aAddedOn !== null && bAddedOn !== null) {
      return bAddedOn - aAddedOn;
    }

    if (aAddedOn !== null && bAddedOn === null) {
      return -1;
    }
    if (aAddedOn === null && bAddedOn !== null) {
      return 1;
    }

    const aLastUpdate = a.lastProgressUpdate;
    const bLastUpdate = b.lastProgressUpdate;

    if (aLastUpdate !== 0 && bLastUpdate !== 0) {
      return bLastUpdate - aLastUpdate;
    }

    if (aLastUpdate !== 0 && bLastUpdate === 0) {
      return -1;
    }
    if (aLastUpdate === 0 && bLastUpdate !== 0) {
      return 1;
    }

    return 0;
  });
}

export function sortByCompletionDate(
  entriesWithSortData: TrackerEntryWithSortData[],
  completedAtMap: Record<string, string>
): TrackerEntryWithSortData[] {
  return [...entriesWithSortData].sort((a, b) => {
    const aCompletedAt = getValidTimestamp(completedAtMap[a.volumeId]);
    const bCompletedAt = getValidTimestamp(completedAtMap[b.volumeId]);

    if (aCompletedAt !== null && bCompletedAt !== null) {
      return aCompletedAt - bCompletedAt;
    }

    if (aCompletedAt !== null && bCompletedAt === null) {
      return -1;
    }
    if (aCompletedAt === null && bCompletedAt !== null) {
      return 1;
    }

    return a.lastProgressUpdate - b.lastProgressUpdate;
  });
}

/** The series a completed entry belongs to, or its own bucket when it has none. */
function seriesGroupKey(entry: TrackerEntryWithSortData): string {
  const title = entry.volumeData.series_title?.trim();
  // The stats views use this sentinel for records whose series is unknown.
  // Grouping every one of them together would claim they are one series.
  if (!title || title === '[Missing Series Info]') return `volume:${entry.volumeId}`;
  return normalizeSeriesKey(title);
}

export function groupCompletedEntriesBySeries(
  entriesWithSortData: TrackerEntryWithSortData[],
  completedAtMap: Record<string, string>
): CompletedSeriesEntry[] {
  const groups = new Map<string, TrackerEntryWithSortData[]>();

  for (const entry of entriesWithSortData) {
    // `normalizeSeriesKey(series_title)` is the key the rest of the app groups
    // series by (`series_metadata`, `series.json`, the catalog join). Grouping
    // on `series_uuid` here split one series into several whenever its volumes
    // were imported separately — each import mints its own uuid — so the
    // Completed-by-series view disagreed with every other series surface.
    const groupKey = seriesGroupKey(entry);
    const groupEntries = groups.get(groupKey);

    if (groupEntries) {
      groupEntries.push(entry);
    } else {
      groups.set(groupKey, [entry]);
    }
  }

  return [...groups.entries()]
    .map(([key, groupEntries]) => {
      const representativeEntry = groupEntries.reduce((currentLatest, entry) => {
        const currentTimestamp = getCompletionTimestamp(currentLatest, completedAtMap);
        const entryTimestamp = getCompletionTimestamp(entry, completedAtMap);

        return entryTimestamp > currentTimestamp ? entry : currentLatest;
      });

      const latestCompletedTimestamp = getCompletionTimestamp(representativeEntry, completedAtMap);

      return {
        key,
        representativeEntry,
        completedCount: groupEntries.length,
        completedLabel: formatCompletedVolumeCount(groupEntries.length),
        latestCompletedTimestamp
      };
    })
    .sort((a, b) => a.latestCompletedTimestamp - b.latestCompletedTimestamp);
}

// ---------------------------------------------------------------------------
// Bucketing and sorting. These lived inline in ProgressTrackerView.svelte,
// where nothing could test them — and a `.svelte` file is where the bugs below
// went unnoticed. They are pure functions of their inputs; the view supplies
// the store values.
// ---------------------------------------------------------------------------

export type TrackerVolumeStats = {
  progressPercent: number;
  progressPercentString: string;
  remainingPages: number;
  currentPage: number;
  totalPages: number;
  /** No page count anywhere — not installed, and no index has supplied one. */
  lengthUnknown: boolean;
};

/**
 * Per-volume display numbers.
 *
 * `lengthUnknown` is carried explicitly rather than encoded as `totalPages === 0`
 * so callers stop confusing "a zero-page volume" with "we do not know how long
 * this is". The bucketing below turned that confusion into a disappearance: a
 * volume whose pages are not on this device had `totalPages` 0, failed
 * `totalPages - currentPage >= 1`, and was dropped from every section.
 */
export function computeVolumeStats(
  volumeEntries: [string, VolumeData][],
  catalog: Record<string, { page_count?: number }>,
  progressByVolume: Record<string, number>
): Record<string, TrackerVolumeStats> {
  const stats: Record<string, TrackerVolumeStats> = {};

  for (const [volumeId] of volumeEntries) {
    const totalPages = catalog[volumeId]?.page_count ?? 0;
    let currentPage = progressByVolume[volumeId] ?? 0;
    // A reader who stopped on page 1 has not started; treat it as 0%.
    if (currentPage === 1) currentPage = 0;

    const progressPercent = totalPages > 0 ? (currentPage / totalPages) * 100 : 0;

    stats[volumeId] = {
      progressPercent,
      progressPercentString: `${progressPercent.toFixed(0)}%`,
      remainingPages: Math.max(0, totalPages - currentPage),
      currentPage,
      totalPages,
      lengthUnknown: totalPages <= 0
    };
  }

  return stats;
}

export function createEntriesWithSortData(
  entries: [string, VolumeData][],
  stats: Record<string, TrackerVolumeStats>,
  deadlines: Record<string, string>,
  mode: ProgressTargetMode,
  periodStart: number
): TrackerEntryWithSortData[] {
  return entries.map(([volumeId, volumeData]) => {
    const remainingPages = stats[volumeId]?.remainingPages ?? 0;
    const deadline = deadlines[volumeId] || null;

    const pagesReadInPeriod = calculatePagesReadInPeriod(volumeData.recentPageTurns, periodStart);
    const targetPagesPerPeriod = calculatePeriodPageTargetTotal(
      remainingPages,
      deadline,
      mode,
      pagesReadInPeriod,
      periodStart
    );
    const pagesToGoal =
      targetPagesPerPeriod !== null ? targetPagesPerPeriod - pagesReadInPeriod : null;

    // SIGNED days: `calculateDaysRemaining` floors at 0, which collapsed every
    // overdue volume into one tie, so the deadline sort could not tell a volume
    // a day late from one a month late. `daysUntilDeadline` here goes negative.
    const daysUntilDeadline = deadline ? signedDaysUntil(deadline) : null;
    const lastProgressUpdate = new Date(volumeData.lastProgressUpdate || 0).getTime();

    return {
      volumeId,
      volumeData,
      remainingPages,
      targetPagesPerPeriod,
      pagesReadInPeriod,
      pagesToGoal,
      daysUntilDeadline,
      lastProgressUpdate: Number.isNaN(lastProgressUpdate) ? 0 : lastProgressUpdate,
      hasDeadline: deadline !== null
    };
  });
}

/** Whole days from today's local midnight to the deadline; negative when past. */
export function signedDaysUntil(deadline: string, now = new Date()): number | null {
  const parts = deadline.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;

  const [year, month, day] = parts;
  const end = new Date(year, month - 1, day + 1);
  if (Number.isNaN(end.getTime())) return null;

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((end.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24));
}

/** `null`/`NaN` last, and never as a comparator result — that corrupts the sort. */
function nullsLast(a: number | null, b: number | null, tieBreak: number): number {
  const aBad = a === null || !Number.isFinite(a);
  const bBad = b === null || !Number.isFinite(b);
  if (aBad && bBad) return tieBreak;
  if (aBad) return 1;
  if (bBad) return -1;
  return 0;
}

export function sortEntries(
  entriesWithSortData: TrackerEntryWithSortData[],
  sorting: ProgressTrackerSorting
): TrackerEntryWithSortData[] {
  return [...entriesWithSortData].sort((a, b) => {
    const recentFirst = b.lastProgressUpdate - a.lastProgressUpdate;

    switch (sorting) {
      case 'last-read':
        return recentFirst;

      case 'pages-per-period': {
        const order = nullsLast(a.targetPagesPerPeriod, b.targetPagesPerPeriod, recentFirst);
        if (order !== 0) return order;
        return (b.targetPagesPerPeriod as number) - (a.targetPagesPerPeriod as number);
      }

      case 'pages-to-goal': {
        const order = nullsLast(a.pagesToGoal, b.pagesToGoal, recentFirst);
        if (order !== 0) return order;
        return (b.pagesToGoal as number) - (a.pagesToGoal as number);
      }

      case 'fewest-pages':
        return a.remainingPages - b.remainingPages;

      case 'deadline': {
        if (!a.hasDeadline && !b.hasDeadline) return recentFirst;
        if (!a.hasDeadline) return 1;
        if (!b.hasDeadline) return -1;
        const order = nullsLast(a.daysUntilDeadline, b.daysUntilDeadline, recentFirst);
        if (order !== 0) return order;
        // Signed, so the most overdue sorts first.
        return (a.daysUntilDeadline as number) - (b.daysUntilDeadline as number);
      }

      default:
        return 0;
    }
  });
}

export type TrackerBuckets = {
  currentlyReading: [string, VolumeData][];
  futureReads: [string, VolumeData][];
  completedVolumes: [string, VolumeData][];
};

/**
 * Split the library into the tracker's three sections.
 *
 * Completion is decided by the goal's own record — a completion event inside
 * the active period, or membership in that period's frozen snapshot — and only
 * falls back to the page count when there is no active period. The old order
 * was inverted: it required `currentPage >= totalPages` FIRST, so a volume
 * finished on another device (progress synced, pages never downloaded here, so
 * `totalPages` 0) was counted by the goal ring in the header and simultaneously
 * missing from the Completed list underneath it.
 */
export function bucketVolumes(
  volumeEntries: [string, VolumeData][],
  stats: Record<string, TrackerVolumeStats>,
  activePeriod: GoalPeriod | null,
  snapshot: GoalSnapshot | null,
  now = Date.now()
): TrackerBuckets {
  const currentlyReading: [string, VolumeData][] = [];
  const futureReads: [string, VolumeData][] = [];
  const completedVolumes: [string, VolumeData][] = [];

  for (const [volumeId, volumeData] of volumeEntries) {
    const { currentPage, totalPages, lengthUnknown } = stats[volumeId] ?? {
      currentPage: 0,
      totalPages: 0,
      lengthUnknown: true
    };

    const finished = isFinished(volumeId, volumeData, totalPages);

    // THE GOAL'S RECORD FIRST, current progress second.
    //
    // Asking "is it finished right now" before "did this period count it"
    // dropped two cases the header still counted, so the ring above the list
    // disagreed with the list: a volume finished on another device whose pages
    // are not here (page count 0, so the derivation says no), and a volume
    // finished inside the period and since restarted (progress back to 0).
    const countedByActiveGoal = activePeriod
      ? snapshot
        ? Object.prototype.hasOwnProperty.call(snapshot.completed, volumeId)
        : isCompletedInPeriod(volumeData, activePeriod.start, activePeriod.end, now)
      : finished;

    if (countedByActiveGoal) {
      completedVolumes.push([volumeId, volumeData]);
      continue;
    }

    // Finished, but not in this period: done, and not something to start.
    if (finished) continue;

    /*
     * CURRENTLY READING requires a known length: without one there is no
     * progress bar and no page target, only a card that can say "0% (0p)". A
     * device holding synced progress for series it has never opened has one of
     * those per volume, which is a wall of empty cards.
     *
     * FUTURE READS keeps them, because that list is picked down to ONE VOLUME
     * PER SERIES and dropping candidates here silently changes WHICH one: a
     * series whose volumes 1-5 are unresolved and whose 6 has a row offered
     * volume 6 as the thing to read next. The pick has to see the whole series
     * to be right; `pickNextPerSeries` drops an unresolved winner afterwards,
     * so at most one card per series is ever withheld instead of the series
     * quietly recommending the wrong volume.
     *
     * COMPLETED is not gated either (above): a finished volume is a record of
     * something you did, and a title alone is enough to show it. Nor are the
     * goal COUNTS — progress belongs to the volume rather than the files, and a
     * volume with no page count contributes no fractional credit anyway.
     */
    if (currentPage > 0 && !lengthUnknown && totalPages - currentPage >= 1) {
      currentlyReading.push([volumeId, volumeData]);
    } else if (currentPage === 0) {
      futureReads.push([volumeId, volumeData]);
    }
  }

  return { currentlyReading, futureReads, completedVolumes };
}

/**
 * Future Reads shows ONE volume per series, and never a series already in
 * Currently Reading — the point of the section is "what to start next".
 */
export function pickNextPerSeries(
  futureReads: [string, VolumeData][],
  currentlyReading: [string, VolumeData][],
  stats?: Record<string, TrackerVolumeStats>
): [string, VolumeData][] {
  const readingSeries = new Set<string>();
  for (const [, volumeData] of currentlyReading) {
    if (volumeData.series_uuid) readingSeries.add(volumeData.series_uuid);
  }

  const sorted = [...futureReads].sort(([, a], [, b]) =>
    (a.volume_title || '').localeCompare(b.volume_title || '', undefined, {
      numeric: true,
      sensitivity: 'base'
    })
  );

  const picked: [string, VolumeData][] = [];
  const seen = new Set<string>();

  for (const [volumeId, volumeData] of sorted) {
    const seriesUuid = volumeData.series_uuid;
    if (!seriesUuid) {
      picked.push([volumeId, volumeData]);
      continue;
    }
    if (readingSeries.has(seriesUuid) || seen.has(seriesUuid)) continue;
    // Claimed even when the winner is then withheld below: the next volume of
    // this series IS this one, and letting the runner-up through would offer a
    // volume the reader should not start yet.
    seen.add(seriesUuid);
    picked.push([volumeId, volumeData]);
  }

  // The length filter runs AFTER the pick, never before it — see `bucketVolumes`.
  if (!stats) return picked;
  return picked.filter(([volumeId]) => !(stats[volumeId]?.lengthUnknown ?? false));
}
