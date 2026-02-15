import { describe, it, expect, beforeEach } from 'vitest';
import { VolumeData } from '$lib/settings/volume-data';

// Helper to create minimal VolumeData for testing
function createVolumeData(overrides: Partial<VolumeData> = {}): VolumeData {
  return new VolumeData({
    progress: 0,
    chars: 0,
    completed: false,
    timeReadInMinutes: 0,
    settings: {},
    lastProgressUpdate: new Date('2024-01-01').toISOString(),
    recentPageTurns: [],
    sessions: [],
    ...overrides
  });
}

// Helper to create entries with sort data (mimics the component's structure)
type EntryWithSortData = {
  volumeId: string;
  volumeData: VolumeData;
  remainingPages: number;
  targetPagesPerPeriod: number | null;
  pagesReadInPeriod: number;
  daysUntilDeadline: number | null;
  lastProgressUpdate: number;
  hasDeadline: boolean;
};

function createEntry(
  volumeId: string,
  volumeData: VolumeData,
  remainingPages: number = 100
): EntryWithSortData {
  return {
    volumeId,
    volumeData,
    remainingPages,
    targetPagesPerPeriod: null,
    pagesReadInPeriod: 0,
    daysUntilDeadline: null,
    lastProgressUpdate: new Date(volumeData.lastProgressUpdate || 0).getTime(),
    hasDeadline: false
  };
}

// Sort functions (copied from component for testing)
function sortByAddedDate(entriesWithSortData: EntryWithSortData[]): EntryWithSortData[] {
  return [...entriesWithSortData].sort((a, b) => {
    const aAddedOn = a.volumeData.addedOn ? new Date(a.volumeData.addedOn).getTime() : null;
    const bAddedOn = b.volumeData.addedOn ? new Date(b.volumeData.addedOn).getTime() : null;

    // If both have addedOn, sort by it (newest first)
    if (aAddedOn !== null && bAddedOn !== null) {
      return bAddedOn - aAddedOn;
    }

    // If one has addedOn and the other doesn't, prioritize the one with addedOn
    if (aAddedOn !== null && bAddedOn === null) {
      return -1;
    }
    if (aAddedOn === null && bAddedOn !== null) {
      return 1;
    }

    // If neither has addedOn, fall back to lastProgressUpdate
    const aLastUpdate = a.lastProgressUpdate;
    const bLastUpdate = b.lastProgressUpdate;

    if (aLastUpdate !== 0 && bLastUpdate !== 0) {
      return bLastUpdate - aLastUpdate;
    }

    // If one has lastProgressUpdate and the other doesn't, prioritize the one with it
    if (aLastUpdate !== 0 && bLastUpdate === 0) {
      return -1;
    }
    if (aLastUpdate === 0 && bLastUpdate !== 0) {
      return 1;
    }

    // Both have no timestamps, maintain current order
    return 0;
  });
}

function sortByCompletionDate(
  entriesWithSortData: EntryWithSortData[],
  completedAtMap: Record<string, string>
): EntryWithSortData[] {
  return [...entriesWithSortData].sort((a, b) => {
    const aCompletedAt = completedAtMap[a.volumeId]
      ? new Date(completedAtMap[a.volumeId]).getTime()
      : null;
    const bCompletedAt = completedAtMap[b.volumeId]
      ? new Date(completedAtMap[b.volumeId]).getTime()
      : null;

    // If both have completedAt, sort by it (oldest first)
    if (aCompletedAt !== null && bCompletedAt !== null) {
      return aCompletedAt - bCompletedAt;
    }

    // If one has completedAt and the other doesn't, prioritize the one with completedAt
    if (aCompletedAt !== null && bCompletedAt === null) {
      return -1;
    }
    if (aCompletedAt === null && bCompletedAt !== null) {
      return 1;
    }

    // If neither has completedAt, fall back to lastProgressUpdate (oldest first)
    return a.lastProgressUpdate - b.lastProgressUpdate;
  });
}

describe('sortByAddedDate (Future Reads)', () => {
  it('should sort by addedOn date with newest first', () => {
    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData({ addedOn: '2024-01-01T00:00:00Z' })),
      createEntry('vol2', createVolumeData({ addedOn: '2024-03-01T00:00:00Z' })),
      createEntry('vol3', createVolumeData({ addedOn: '2024-02-01T00:00:00Z' }))
    ];

    const sorted = sortByAddedDate(entries);

    expect(sorted[0].volumeId).toBe('vol2'); // 2024-03-01 (newest)
    expect(sorted[1].volumeId).toBe('vol3'); // 2024-02-01
    expect(sorted[2].volumeId).toBe('vol1'); // 2024-01-01 (oldest)
  });

  it('should prioritize volumes with addedOn over those without', () => {
    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData({ lastProgressUpdate: '2024-03-01T00:00:00Z' })), // no addedOn
      createEntry('vol2', createVolumeData({ addedOn: '2024-01-01T00:00:00Z' })),
      createEntry('vol3', createVolumeData({ lastProgressUpdate: '2024-02-01T00:00:00Z' })) // no addedOn
    ];

    const sorted = sortByAddedDate(entries);

    expect(sorted[0].volumeId).toBe('vol2'); // has addedOn
    expect(sorted[1].volumeId).toBe('vol1'); // no addedOn, newer lastProgressUpdate
    expect(sorted[2].volumeId).toBe('vol3'); // no addedOn, older lastProgressUpdate
  });

  it('should fall back to lastProgressUpdate when addedOn is missing', () => {
    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData({ lastProgressUpdate: '2024-01-01T00:00:00Z' })), // no addedOn
      createEntry('vol2', createVolumeData({ lastProgressUpdate: '2024-03-01T00:00:00Z' })), // no addedOn
      createEntry('vol3', createVolumeData({ lastProgressUpdate: '2024-02-01T00:00:00Z' })) // no addedOn
    ];

    const sorted = sortByAddedDate(entries);

    expect(sorted[0].volumeId).toBe('vol2'); // 2024-03-01 (newest)
    expect(sorted[1].volumeId).toBe('vol3'); // 2024-02-01
    expect(sorted[2].volumeId).toBe('vol1'); // 2024-01-01 (oldest)
  });

  it('should handle volumes with no addedOn and no lastProgressUpdate', () => {
    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData({ addedOn: '2024-01-01T00:00:00Z' })),
      createEntry('vol2', createVolumeData({ lastProgressUpdate: '1970-01-01T00:00:00Z' })), // epoch (no timestamp)
      createEntry('vol3', createVolumeData({ addedOn: '2024-02-01T00:00:00Z' }))
    ];

    // Override lastProgressUpdate to 0 for vol2 to simulate no timestamp
    entries[1].lastProgressUpdate = 0;

    const sorted = sortByAddedDate(entries);

    expect(sorted[0].volumeId).toBe('vol3'); // has addedOn (newest)
    expect(sorted[1].volumeId).toBe('vol1'); // has addedOn (older)
    expect(sorted[2].volumeId).toBe('vol2'); // no addedOn, no lastProgressUpdate (last)
  });

  it('should maintain stable order for volumes with identical timestamps', () => {
    const sameDate = '2024-01-01T00:00:00Z';
    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData({ addedOn: sameDate })),
      createEntry('vol2', createVolumeData({ addedOn: sameDate })),
      createEntry('vol3', createVolumeData({ addedOn: sameDate }))
    ];

    const sorted = sortByAddedDate(entries);

    // Should maintain original order when timestamps are identical
    expect(sorted.map((e) => e.volumeId)).toEqual(['vol1', 'vol2', 'vol3']);
  });
});

describe('sortByCompletionDate (Completed Volumes)', () => {
  it('should sort by completedAt date with oldest first', () => {
    const completedAtMap = {
      vol1: '2024-01-01T00:00:00Z',
      vol2: '2024-03-01T00:00:00Z',
      vol3: '2024-02-01T00:00:00Z'
    };

    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData()),
      createEntry('vol2', createVolumeData()),
      createEntry('vol3', createVolumeData())
    ];

    const sorted = sortByCompletionDate(entries, completedAtMap);

    expect(sorted[0].volumeId).toBe('vol1'); // 2024-01-01 (oldest)
    expect(sorted[1].volumeId).toBe('vol3'); // 2024-02-01
    expect(sorted[2].volumeId).toBe('vol2'); // 2024-03-01 (newest)
  });

  it('should prioritize volumes with completedAt over those without', () => {
    const completedAtMap = {
      vol2: '2024-01-01T00:00:00Z'
    };

    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData({ lastProgressUpdate: '2024-03-01T00:00:00Z' })), // no completedAt
      createEntry('vol2', createVolumeData({ lastProgressUpdate: '2024-02-01T00:00:00Z' })), // has completedAt
      createEntry('vol3', createVolumeData({ lastProgressUpdate: '2024-04-01T00:00:00Z' })) // no completedAt
    ];

    const sorted = sortByCompletionDate(entries, completedAtMap);

    expect(sorted[0].volumeId).toBe('vol2'); // has completedAt
    expect(sorted[1].volumeId).toBe('vol1'); // no completedAt, older lastProgressUpdate
    expect(sorted[2].volumeId).toBe('vol3'); // no completedAt, newer lastProgressUpdate
  });

  it('should fall back to lastProgressUpdate (oldest first) when completedAt is missing', () => {
    const completedAtMap = {}; // No completion dates

    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData({ lastProgressUpdate: '2024-03-01T00:00:00Z' })),
      createEntry('vol2', createVolumeData({ lastProgressUpdate: '2024-01-01T00:00:00Z' })),
      createEntry('vol3', createVolumeData({ lastProgressUpdate: '2024-02-01T00:00:00Z' }))
    ];

    const sorted = sortByCompletionDate(entries, completedAtMap);

    expect(sorted[0].volumeId).toBe('vol2'); // 2024-01-01 (oldest)
    expect(sorted[1].volumeId).toBe('vol3'); // 2024-02-01
    expect(sorted[2].volumeId).toBe('vol1'); // 2024-03-01 (newest)
  });

  it('should handle mixed completedAt and lastProgressUpdate fallback', () => {
    const completedAtMap = {
      vol1: '2024-03-01T00:00:00Z',
      vol3: '2024-01-01T00:00:00Z'
    };

    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData({ lastProgressUpdate: '2024-02-01T00:00:00Z' })),
      createEntry('vol2', createVolumeData({ lastProgressUpdate: '2024-02-15T00:00:00Z' })), // no completedAt
      createEntry('vol3', createVolumeData({ lastProgressUpdate: '2024-04-01T00:00:00Z' }))
    ];

    const sorted = sortByCompletionDate(entries, completedAtMap);

    expect(sorted[0].volumeId).toBe('vol3'); // has completedAt: 2024-01-01 (oldest)
    expect(sorted[1].volumeId).toBe('vol1'); // has completedAt: 2024-03-01
    expect(sorted[2].volumeId).toBe('vol2'); // no completedAt, falls back to lastProgressUpdate
  });

  it('should handle volumes with no completedAt and lastProgressUpdate of 0', () => {
    const completedAtMap = {
      vol1: '2024-01-01T00:00:00Z'
    };

    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData()),
      createEntry('vol2', createVolumeData({ lastProgressUpdate: '1970-01-01T00:00:00Z' })),
      createEntry('vol3', createVolumeData({ lastProgressUpdate: '2024-02-01T00:00:00Z' }))
    ];

    // Override lastProgressUpdate to 0 for vol2 to simulate no timestamp
    entries[1].lastProgressUpdate = 0;

    const sorted = sortByCompletionDate(entries, completedAtMap);

    expect(sorted[0].volumeId).toBe('vol1'); // has completedAt
    expect(sorted[1].volumeId).toBe('vol2'); // no completedAt, lastProgressUpdate = 0 (oldest)
    expect(sorted[2].volumeId).toBe('vol3'); // no completedAt, lastProgressUpdate = 2024-02-01
  });

  it('should maintain stable order for volumes with identical completion dates', () => {
    const sameDate = '2024-01-01T00:00:00Z';
    const completedAtMap = {
      vol1: sameDate,
      vol2: sameDate,
      vol3: sameDate
    };

    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData()),
      createEntry('vol2', createVolumeData()),
      createEntry('vol3', createVolumeData())
    ];

    const sorted = sortByCompletionDate(entries, completedAtMap);

    // Should maintain original order when timestamps are identical
    expect(sorted.map((e) => e.volumeId)).toEqual(['vol1', 'vol2', 'vol3']);
  });
});

describe('Edge Cases', () => {
  it('sortByAddedDate should handle empty array', () => {
    const sorted = sortByAddedDate([]);
    expect(sorted).toEqual([]);
  });

  it('sortByCompletionDate should handle empty array', () => {
    const sorted = sortByCompletionDate([], {});
    expect(sorted).toEqual([]);
  });

  it('sortByAddedDate should handle single item', () => {
    const entries: EntryWithSortData[] = [
      createEntry('vol1', createVolumeData({ addedOn: '2024-01-01T00:00:00Z' }))
    ];

    const sorted = sortByAddedDate(entries);

    expect(sorted).toHaveLength(1);
    expect(sorted[0].volumeId).toBe('vol1');
  });

  it('sortByCompletionDate should handle single item', () => {
    const completedAtMap = { vol1: '2024-01-01T00:00:00Z' };
    const entries: EntryWithSortData[] = [createEntry('vol1', createVolumeData())];

    const sorted = sortByCompletionDate(entries, completedAtMap);

    expect(sorted).toHaveLength(1);
    expect(sorted[0].volumeId).toBe('vol1');
  });
});
