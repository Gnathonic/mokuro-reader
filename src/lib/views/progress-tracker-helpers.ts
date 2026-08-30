import { VolumeData } from '$lib/settings/volume-data';

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

export function groupCompletedEntriesBySeries(
  entriesWithSortData: TrackerEntryWithSortData[],
  completedAtMap: Record<string, string>
): CompletedSeriesEntry[] {
  const groups = new Map<string, TrackerEntryWithSortData[]>();

  for (const entry of entriesWithSortData) {
    const groupKey = entry.volumeData.series_uuid || `volume:${entry.volumeId}`;
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
