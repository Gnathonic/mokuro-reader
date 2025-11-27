import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  processVolumeSpeedData,
  calculateReadingSpeedStats,
  getSeriesSpeedInfo,
  formatDuration,
  formatRelativeDate,
  type VolumeSpeedData
} from './reading-speed-history';

// Mock the updateVolumeMetadata function to avoid side effects
vi.mock('$lib/settings/volume-data', () => ({
  updateVolumeMetadata: vi.fn()
}));

describe('formatDuration', () => {
  it('should format minutes under 60', () => {
    expect(formatDuration(30)).toBe('30 min');
    expect(formatDuration(1)).toBe('1 min');
    expect(formatDuration(59)).toBe('59 min');
  });

  it('should round minutes', () => {
    expect(formatDuration(30.5)).toBe('31 min');
    expect(formatDuration(0.4)).toBe('0 min');
  });

  it('should format exact hours', () => {
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(120)).toBe('2h');
    expect(formatDuration(180)).toBe('3h');
  });

  it('should format hours and minutes', () => {
    expect(formatDuration(90)).toBe('1h 30m');
    expect(formatDuration(150)).toBe('2h 30m');
    expect(formatDuration(61)).toBe('1h 1m');
  });

  it('should round remaining minutes', () => {
    expect(formatDuration(90.5)).toBe('1h 31m');
  });
});

describe('formatRelativeDate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return "Today" for same day', () => {
    const date = new Date('2024-06-15T08:00:00Z');
    expect(formatRelativeDate(date)).toBe('Today');
  });

  it('should return "Yesterday" for previous day', () => {
    const date = new Date('2024-06-14T12:00:00Z');
    expect(formatRelativeDate(date)).toBe('Yesterday');
  });

  it('should return days ago for less than a week', () => {
    const date = new Date('2024-06-12T12:00:00Z');
    expect(formatRelativeDate(date)).toBe('3 days ago');
  });

  it('should return weeks ago for less than a month', () => {
    const date = new Date('2024-06-01T12:00:00Z');
    expect(formatRelativeDate(date)).toBe('2 weeks ago');

    const date2 = new Date('2024-06-08T12:00:00Z');
    expect(formatRelativeDate(date2)).toBe('1 week ago');
  });

  it('should return months ago for less than a year', () => {
    const date = new Date('2024-03-15T12:00:00Z');
    expect(formatRelativeDate(date)).toBe('3 months ago');

    const date2 = new Date('2024-05-15T12:00:00Z');
    expect(formatRelativeDate(date2)).toBe('1 month ago');
  });

  it('should return years ago for more than a year', () => {
    const date = new Date('2022-06-15T12:00:00Z');
    expect(formatRelativeDate(date)).toBe('2 years ago');

    const date2 = new Date('2023-06-15T12:00:00Z');
    expect(formatRelativeDate(date2)).toBe('1 year ago');
  });
});

describe('getSeriesSpeedInfo', () => {
  it('should return empty array for empty input', () => {
    const result = getSeriesSpeedInfo([]);
    expect(result).toEqual([]);
  });

  it('should group volumes by series', () => {
    const volumeData: VolumeSpeedData[] = [
      {
        volumeId: 'vol-1',
        volumeTitle: 'Volume 1',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-01-01'),
        durationMinutes: 60,
        charsRead: 6000,
        charsPerMinute: 100,
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      },
      {
        volumeId: 'vol-2',
        volumeTitle: 'Volume 2',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-02-01'),
        durationMinutes: 60,
        charsRead: 12000,
        charsPerMinute: 200,
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      }
    ];

    const result = getSeriesSpeedInfo(volumeData);

    expect(result).toHaveLength(1);
    expect(result[0].seriesId).toBe('series-a');
    expect(result[0].volumeCount).toBe(2);
    expect(result[0].averageSpeed).toBe(150); // (100 + 200) / 2
  });

  it('should calculate speed improvement correctly', () => {
    const volumeData: VolumeSpeedData[] = [
      {
        volumeId: 'vol-1',
        volumeTitle: 'Volume 1',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-01-01'), // First
        durationMinutes: 60,
        charsRead: 6000,
        charsPerMinute: 100,
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      },
      {
        volumeId: 'vol-2',
        volumeTitle: 'Volume 2',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-02-01'), // Last
        durationMinutes: 60,
        charsRead: 9000,
        charsPerMinute: 150,
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      }
    ];

    const result = getSeriesSpeedInfo(volumeData);

    // Improvement: (150 - 100) / 100 * 100 = 50%
    expect(result[0].speedImprovement).toBe(50);
  });

  it('should sort series by most recent completion date', () => {
    const volumeData: VolumeSpeedData[] = [
      {
        volumeId: 'vol-1',
        volumeTitle: 'Volume 1',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-01-01'),
        durationMinutes: 60,
        charsRead: 6000,
        charsPerMinute: 100,
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      },
      {
        volumeId: 'vol-2',
        volumeTitle: 'Volume 1',
        seriesTitle: 'Series B',
        seriesId: 'series-b',
        completionDate: new Date('2024-03-01'), // More recent
        durationMinutes: 60,
        charsRead: 6000,
        charsPerMinute: 100,
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      }
    ];

    const result = getSeriesSpeedInfo(volumeData);

    expect(result[0].seriesId).toBe('series-b'); // Most recent first
    expect(result[1].seriesId).toBe('series-a');
  });

  it('should handle single volume series', () => {
    const volumeData: VolumeSpeedData[] = [
      {
        volumeId: 'vol-1',
        volumeTitle: 'Volume 1',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-01-01'),
        durationMinutes: 60,
        charsRead: 6000,
        charsPerMinute: 100,
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      }
    ];

    const result = getSeriesSpeedInfo(volumeData);

    expect(result[0].speedImprovement).toBe(0); // No improvement with single volume
    expect(result[0].volumeCount).toBe(1);
  });
});

describe('calculateReadingSpeedStats', () => {
  it('should return empty stats when no data', () => {
    const result = calculateReadingSpeedStats([], 100, {});

    expect(result.totalTimeMinutes).toBe(0);
    expect(result.averageSpeed).toBe(0);
    expect(result.currentSpeed).toBe(100);
    expect(result.volumesCompleted).toBe(0);
    expect(result.totalCharsRead).toBe(0);
    expect(result.speedTrendLabel).toBe('stable');
    expect(result.badges).toEqual([]);
  });

  it('should calculate total time from volume data', () => {
    const volumeData: VolumeSpeedData[] = [
      {
        volumeId: 'vol-1',
        volumeTitle: 'Volume 1',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-01-01'),
        durationMinutes: 60,
        charsRead: 6000,
        charsPerMinute: 100,
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      },
      {
        volumeId: 'vol-2',
        volumeTitle: 'Volume 2',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-02-01'),
        durationMinutes: 90,
        charsRead: 9000,
        charsPerMinute: 100,
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      }
    ];

    const allVolumesData = {
      'vol-1': { completed: true, chars: 6000 },
      'vol-2': { completed: true, chars: 9000 }
    };

    const result = calculateReadingSpeedStats(volumeData, 100, allVolumesData);

    expect(result.totalTimeMinutes).toBe(150);
    expect(result.volumesCompleted).toBe(2);
    expect(result.totalCharsRead).toBe(15000);
  });

  it('should calculate average speed', () => {
    const volumeData: VolumeSpeedData[] = [
      {
        volumeId: 'vol-1',
        volumeTitle: 'Volume 1',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-01-01'),
        durationMinutes: 60,
        charsRead: 6000,
        charsPerMinute: 100,
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      },
      {
        volumeId: 'vol-2',
        volumeTitle: 'Volume 2',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-02-01'),
        durationMinutes: 60,
        charsRead: 12000,
        charsPerMinute: 200,
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      }
    ];

    const result = calculateReadingSpeedStats(volumeData, 150, {
      'vol-1': { completed: true, chars: 6000 },
      'vol-2': { completed: true, chars: 12000 }
    });

    expect(result.averageSpeed).toBe(150); // (100 + 200) / 2
  });

  it('should detect improving speed trend', () => {
    // Need at least 3 volumes to calculate trend
    const volumeData: VolumeSpeedData[] = [
      // Recent half (faster)
      {
        volumeId: 'vol-3',
        volumeTitle: 'Volume 3',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-03-01'),
        durationMinutes: 60,
        charsRead: 12000,
        charsPerMinute: 200, // Fast
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      },
      {
        volumeId: 'vol-2',
        volumeTitle: 'Volume 2',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-02-01'),
        durationMinutes: 60,
        charsRead: 10500,
        charsPerMinute: 175, // Medium-fast
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      },
      // First half (slower)
      {
        volumeId: 'vol-1',
        volumeTitle: 'Volume 1',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-01-01'),
        durationMinutes: 60,
        charsRead: 6000,
        charsPerMinute: 100, // Slow
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      }
    ];

    const result = calculateReadingSpeedStats(volumeData, 150, {
      'vol-1': { completed: true, chars: 6000 },
      'vol-2': { completed: true, chars: 10500 },
      'vol-3': { completed: true, chars: 12000 }
    });

    expect(result.speedTrendLabel).toBe('improving');
    expect(result.speedTrend).toBeGreaterThan(10);
  });

  it('should detect declining speed trend', () => {
    const volumeData: VolumeSpeedData[] = [
      // Recent half (slower)
      {
        volumeId: 'vol-3',
        volumeTitle: 'Volume 3',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-03-01'),
        durationMinutes: 60,
        charsRead: 6000,
        charsPerMinute: 100, // Slow
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      },
      {
        volumeId: 'vol-2',
        volumeTitle: 'Volume 2',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-02-01'),
        durationMinutes: 60,
        charsRead: 7500,
        charsPerMinute: 125, // Medium-slow
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      },
      // First half (faster)
      {
        volumeId: 'vol-1',
        volumeTitle: 'Volume 1',
        seriesTitle: 'Series A',
        seriesId: 'series-a',
        completionDate: new Date('2024-01-01'),
        durationMinutes: 60,
        charsRead: 12000,
        charsPerMinute: 200, // Fast
        isPersonalBest: false,
        isSlowest: false,
        percentVsAverage: 0
      }
    ];

    const result = calculateReadingSpeedStats(volumeData, 150, {
      'vol-1': { completed: true, chars: 12000 },
      'vol-2': { completed: true, chars: 7500 },
      'vol-3': { completed: true, chars: 6000 }
    });

    expect(result.speedTrendLabel).toBe('declining');
    expect(result.speedTrend).toBeLessThan(-10);
  });

  describe('badges', () => {
    it('should award speed-based badges', () => {
      // Need at least one completed volume for badges to be calculated
      const allVolumesData = {
        'vol-1': { completed: true, chars: 1000 }
      };
      const result = calculateReadingSpeedStats([], 250, allVolumesData);

      expect(result.badges).toContain('Beginner'); // > 10
      expect(result.badges).toContain('¼ Native'); // > 100
      expect(result.badges).toContain('½ Native'); // > 200
    });

    it('should award volume count badges', () => {
      const allVolumesData: Record<string, any> = {};
      for (let i = 0; i < 10; i++) {
        allVolumesData[`vol-${i}`] = { completed: true, chars: 1000 };
      }

      const result = calculateReadingSpeedStats([], 100, allVolumesData);

      expect(result.badges).toContain('First Volume');
      expect(result.badges).toContain('First Steps');
      expect(result.badges).toContain('Getting Started');
      expect(result.badges).toContain('Consistent Reader');
    });

    it('should award character count badges', () => {
      const allVolumesData = {
        'vol-1': { completed: true, chars: 500000 }
      };

      const result = calculateReadingSpeedStats([], 100, allVolumesData);

      expect(result.badges).toContain('10K Characters');
      expect(result.badges).toContain('100K Characters');
      expect(result.badges).toContain('Quarter Million');
    });

    it('should award time-based badges', () => {
      const volumeData: VolumeSpeedData[] = [
        {
          volumeId: 'vol-1',
          volumeTitle: 'Volume 1',
          seriesTitle: 'Series A',
          seriesId: 'series-a',
          completionDate: new Date('2024-01-01'),
          durationMinutes: 1200, // 20 hours
          charsRead: 120000,
          charsPerMinute: 100,
          isPersonalBest: false,
          isSlowest: false,
          percentVsAverage: 0
        }
      ];

      const result = calculateReadingSpeedStats(volumeData, 100, {
        'vol-1': { completed: true, chars: 120000 }
      });

      expect(result.badges).toContain('1 Hour Reader');
      expect(result.badges).toContain('5 Hour Reader');
      expect(result.badges).toContain('10 Hour Reader');
    });

    it('should award improving fast badge', () => {
      const volumeData: VolumeSpeedData[] = [
        {
          volumeId: 'vol-3',
          volumeTitle: 'Volume 3',
          seriesTitle: 'Series A',
          seriesId: 'series-a',
          completionDate: new Date('2024-03-01'),
          durationMinutes: 60,
          charsRead: 15000,
          charsPerMinute: 250, // Very fast
          isPersonalBest: false,
          isSlowest: false,
          percentVsAverage: 0
        },
        {
          volumeId: 'vol-2',
          volumeTitle: 'Volume 2',
          seriesTitle: 'Series A',
          seriesId: 'series-a',
          completionDate: new Date('2024-02-01'),
          durationMinutes: 60,
          charsRead: 12000,
          charsPerMinute: 200,
          isPersonalBest: false,
          isSlowest: false,
          percentVsAverage: 0
        },
        {
          volumeId: 'vol-1',
          volumeTitle: 'Volume 1',
          seriesTitle: 'Series A',
          seriesId: 'series-a',
          completionDate: new Date('2024-01-01'),
          durationMinutes: 60,
          charsRead: 6000,
          charsPerMinute: 100, // Very slow start
          isPersonalBest: false,
          isSlowest: false,
          percentVsAverage: 0
        }
      ];

      const result = calculateReadingSpeedStats(volumeData, 200, {
        'vol-1': { completed: true, chars: 6000 },
        'vol-2': { completed: true, chars: 12000 },
        'vol-3': { completed: true, chars: 15000 }
      });

      expect(result.badges).toContain('Improving Fast');
    });
  });
});

describe('processVolumeSpeedData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty array for empty input', () => {
    const result = processVolumeSpeedData({}, []);
    expect(result).toEqual([]);
  });

  it('should filter out non-completed volumes', () => {
    const volumesData = {
      'vol-1': {
        completed: false,
        timeReadInMinutes: 60,
        chars: 6000,
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    };

    const result = processVolumeSpeedData(volumesData, []);
    expect(result).toHaveLength(0);
  });

  it('should filter out volumes with zero chars', () => {
    const volumesData = {
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 0,
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    };

    const result = processVolumeSpeedData(volumesData, []);
    expect(result).toHaveLength(0);
  });

  it('should filter out volumes with zero time', () => {
    const volumesData = {
      'vol-1': {
        completed: true,
        timeReadInMinutes: 0,
        chars: 6000,
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    };

    const result = processVolumeSpeedData(volumesData, []);
    expect(result).toHaveLength(0);
  });

  it('should filter out volumes with CPM > 1000', () => {
    const volumesData = {
      'vol-1': {
        completed: true,
        timeReadInMinutes: 1,
        chars: 10000, // 10000 CPM
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    };

    const result = processVolumeSpeedData(volumesData, []);
    expect(result).toHaveLength(0);
  });

  it('should filter out volumes with garbage dates before 2005', () => {
    const volumesData = {
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000,
        lastProgressUpdate: '1970-01-01T00:00:00Z' // Epoch date
      }
    };

    const result = processVolumeSpeedData(volumesData, []);
    expect(result).toHaveLength(0);
  });

  it('should process valid volumes correctly', () => {
    const volumesData = {
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000,
        lastProgressUpdate: '2024-01-01T00:00:00Z',
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: 'Volume 1'
      }
    };

    const result = processVolumeSpeedData(volumesData, []);

    expect(result).toHaveLength(1);
    expect(result[0].volumeId).toBe('vol-1');
    expect(result[0].charsPerMinute).toBe(100);
    expect(result[0].durationMinutes).toBe(60);
    expect(result[0].seriesTitle).toBe('Series A');
    expect(result[0].volumeTitle).toBe('Volume 1');
  });

  it('should sort volumes by completion date (newest first)', () => {
    const volumesData = {
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000,
        lastProgressUpdate: '2024-01-01T00:00:00Z',
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: 'Volume 1'
      },
      'vol-2': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000,
        lastProgressUpdate: '2024-02-01T00:00:00Z',
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: 'Volume 2'
      }
    };

    const result = processVolumeSpeedData(volumesData, []);

    expect(result[0].volumeId).toBe('vol-2'); // Newer
    expect(result[1].volumeId).toBe('vol-1'); // Older
  });

  it('should assign isPersonalBest to fastest volume', () => {
    const volumesData = {
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000, // 100 CPM
        lastProgressUpdate: '2024-01-01T00:00:00Z',
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: 'Volume 1'
      },
      'vol-2': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 12000, // 200 CPM - fastest
        lastProgressUpdate: '2024-02-01T00:00:00Z',
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: 'Volume 2'
      }
    };

    const result = processVolumeSpeedData(volumesData, []);

    const fastest = result.find((v) => v.volumeId === 'vol-2');
    const slowest = result.find((v) => v.volumeId === 'vol-1');

    expect(fastest!.isPersonalBest).toBe(true);
    expect(slowest!.isPersonalBest).toBe(false);
  });

  it('should assign isSlowest to slowest volume', () => {
    const volumesData = {
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000, // 100 CPM - slowest
        lastProgressUpdate: '2024-01-01T00:00:00Z',
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: 'Volume 1'
      },
      'vol-2': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 12000, // 200 CPM
        lastProgressUpdate: '2024-02-01T00:00:00Z',
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: 'Volume 2'
      }
    };

    const result = processVolumeSpeedData(volumesData, []);

    const fastest = result.find((v) => v.volumeId === 'vol-2');
    const slowest = result.find((v) => v.volumeId === 'vol-1');

    expect(slowest!.isSlowest).toBe(true);
    expect(fastest!.isSlowest).toBe(false);
  });

  it('should calculate percentVsAverage', () => {
    const volumesData = {
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000, // 100 CPM
        lastProgressUpdate: '2024-01-01T00:00:00Z',
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: 'Volume 1'
      },
      'vol-2': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 12000, // 200 CPM
        lastProgressUpdate: '2024-02-01T00:00:00Z',
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: 'Volume 2'
      }
    };

    const result = processVolumeSpeedData(volumesData, []);
    const avgSpeed = (100 + 200) / 2; // 150

    const vol1 = result.find((v) => v.volumeId === 'vol-1');
    const vol2 = result.find((v) => v.volumeId === 'vol-2');

    // vol1: (100 - 150) / 150 * 100 = -33.33%
    expect(vol1!.percentVsAverage).toBeCloseTo(-33.33, 1);
    // vol2: (200 - 150) / 150 * 100 = 33.33%
    expect(vol2!.percentVsAverage).toBeCloseTo(33.33, 1);
  });

  it('should assign milestone badges', () => {
    const volumesData: Record<string, any> = {};
    // Create 10 volumes
    for (let i = 1; i <= 10; i++) {
      volumesData[`vol-${i}`] = {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000,
        lastProgressUpdate: `2024-${String(i).padStart(2, '0')}-01T00:00:00Z`,
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: `Volume ${i}`
      };
    }

    const result = processVolumeSpeedData(volumesData, []);

    // Position 1 is the first read (oldest), position 10 is most recent
    // Array is sorted newest first, so index 9 is the oldest (position 1)
    const firstVolume = result[9]; // Position 1
    const fifthVolume = result[5]; // Position 5
    const tenthVolume = result[0]; // Position 10

    expect(firstVolume.isMilestone).toBe(1);
    expect(fifthVolume.isMilestone).toBe(5);
    expect(tenthVolume.isMilestone).toBe(10);
  });

  it('should use catalog metadata when volume metadata is missing', () => {
    const volumesData = {
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000,
        lastProgressUpdate: '2024-01-01T00:00:00Z'
        // No metadata in progress data
      }
    };

    const catalog = [
      {
        volume_uuid: 'vol-1',
        series_uuid: 'series-a',
        series_title: 'Series from Catalog',
        volume_title: 'Volume from Catalog',
        page_count: 100,
        chars: 6000
      }
    ];

    const result = processVolumeSpeedData(volumesData, catalog as any);

    expect(result[0].seriesTitle).toBe('Series from Catalog');
    expect(result[0].volumeTitle).toBe('Volume from Catalog');
  });

  it('should calculate percentVsSeriesAvg', () => {
    const volumesData = {
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000, // 100 CPM
        lastProgressUpdate: '2024-01-01T00:00:00Z',
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: 'Volume 1'
      },
      'vol-2': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 12000, // 200 CPM
        lastProgressUpdate: '2024-02-01T00:00:00Z',
        series_title: 'Series A',
        series_uuid: 'series-a',
        volume_title: 'Volume 2'
      }
    };

    const result = processVolumeSpeedData(volumesData, []);
    const seriesAvg = (100 + 200) / 2; // 150

    const vol1 = result.find((v) => v.volumeId === 'vol-1');
    const vol2 = result.find((v) => v.volumeId === 'vol-2');

    // vol1: (100 - 150) / 150 * 100 = -33.33%
    expect(vol1!.percentVsSeriesAvg).toBeCloseTo(-33.33, 1);
    // vol2: (200 - 150) / 150 * 100 = 33.33%
    expect(vol2!.percentVsSeriesAvg).toBeCloseTo(33.33, 1);
  });

  // Note: Thumbnail test removed - thumbnails are now loaded from a separate table (volume_thumbnails)
  // and must be loaded asynchronously by the UI component displaying the reading speed history
});
