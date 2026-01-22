import { describe, it, expect } from 'vitest';
import {
  calculateReadingSpeed,
  calculateReadingSpeedFromCompletedVolumes,
  calculateReadingSpeedFromSessions,
  calculateVolumeTimeToFinish,
  calculateEstimatedTime,
  SESSION_DATA_HOURS,
  ESTIMATION_HOURS,
  type ReadingSpeedResult
} from './reading-speed';

describe('calculateEstimatedTime', () => {
  const defaultSpeed: ReadingSpeedResult = {
    charsPerMinute: 100,
    isPersonalized: false,
    confidence: 'none',
    sessionsUsed: 0
  };

  const personalizedSpeed: ReadingSpeedResult = {
    charsPerMinute: 150,
    isPersonalized: true,
    confidence: 'high',
    sessionsUsed: 3
  };

  it('should calculate time less than 60 minutes', () => {
    const result = calculateEstimatedTime(3000, defaultSpeed); // 30 chars/min = 30 minutes
    expect(result.minutes).toBe(30);
    expect(result.hours).toBe(0);
    expect(result.displayText).toBe('30 min');
    expect(result.isPersonalized).toBe(false);
  });

  it('should calculate exact hours with no remainder', () => {
    const result = calculateEstimatedTime(12000, defaultSpeed); // 120 minutes = 2 hours
    expect(result.minutes).toBe(120);
    expect(result.hours).toBe(2);
    expect(result.displayText).toBe('2h');
    expect(result.isPersonalized).toBe(false);
  });

  it('should calculate hours and minutes', () => {
    const result = calculateEstimatedTime(15000, defaultSpeed); // 150 minutes = 2h 30m
    expect(result.minutes).toBe(150);
    expect(result.hours).toBe(2);
    expect(result.displayText).toBe('2h 30m');
    expect(result.isPersonalized).toBe(false);
  });

  it('should round up to nearest minute', () => {
    // 100 chars at 100 cpm = 1 minute, 101 chars should round to 2 minutes
    const result = calculateEstimatedTime(101, defaultSpeed);
    expect(result.minutes).toBe(2);
    expect(result.displayText).toBe('2 min');
  });

  it('should use personalized speed correctly', () => {
    const result = calculateEstimatedTime(4500, personalizedSpeed); // 4500/150 = 30 min
    expect(result.minutes).toBe(30);
    expect(result.isPersonalized).toBe(true);
  });

  it('should handle zero characters', () => {
    const result = calculateEstimatedTime(0, defaultSpeed);
    expect(result.minutes).toBe(0);
    expect(result.hours).toBe(0);
    expect(result.displayText).toBe('0 min');
  });
});

describe('calculateVolumeTimeToFinish', () => {
  const defaultSpeed: ReadingSpeedResult = {
    charsPerMinute: 100,
    isPersonalized: false,
    confidence: 'none',
    sessionsUsed: 0
  };

  it('should calculate remaining time correctly', () => {
    const result = calculateVolumeTimeToFinish(10000, 5000, defaultSpeed);
    expect(result).not.toBeNull();
    expect(result!.minutes).toBe(50);
    expect(result!.hours).toBe(0);
    expect(result!.displayText).toBe('~50 min left');
  });

  it('should format hours and minutes display', () => {
    const result = calculateVolumeTimeToFinish(20000, 5000, defaultSpeed);
    expect(result).not.toBeNull();
    expect(result!.minutes).toBe(150);
    expect(result!.hours).toBe(2);
    expect(result!.displayText).toBe('~2h 30m left');
  });

  it('should return null when total chars is zero', () => {
    const result = calculateVolumeTimeToFinish(0, 0, defaultSpeed);
    expect(result).toBeNull();
  });

  it('should return null when volume is already finished', () => {
    const result = calculateVolumeTimeToFinish(10000, 10000, defaultSpeed);
    expect(result).toBeNull();
  });

  it('should return null when more chars read than total', () => {
    const result = calculateVolumeTimeToFinish(5000, 6000, defaultSpeed);
    expect(result).toBeNull();
  });

  it('should round up remaining time', () => {
    // 101 remaining chars at 100 cpm = 1.01 minutes -> 2 minutes
    const result = calculateVolumeTimeToFinish(200, 99, defaultSpeed);
    expect(result).not.toBeNull();
    expect(result!.minutes).toBe(2);
  });
});

describe('calculateReadingSpeedFromCompletedVolumes', () => {
  it('should return default speed when no volumes provided', () => {
    const result = calculateReadingSpeedFromCompletedVolumes({});
    expect(result.charsPerMinute).toBe(100);
    expect(result.isPersonalized).toBe(false);
    expect(result.confidence).toBe('none');
    expect(result.sessionsUsed).toBe(0);
  });

  it('should return default speed when no completed volumes', () => {
    const result = calculateReadingSpeedFromCompletedVolumes({
      'vol-1': {
        completed: false,
        timeReadInMinutes: 60,
        chars: 6000,
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    });
    expect(result.charsPerMinute).toBe(100);
    expect(result.isPersonalized).toBe(false);
    expect(result.confidence).toBe('none');
  });

  it('should calculate speed from single completed volume', () => {
    const result = calculateReadingSpeedFromCompletedVolumes({
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 12000, // 200 CPM
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    });
    expect(result.charsPerMinute).toBe(200);
    expect(result.isPersonalized).toBe(true);
    expect(result.confidence).toBe('low');
    expect(result.sessionsUsed).toBe(1);
  });

  it('should calculate average from multiple volumes', () => {
    const result = calculateReadingSpeedFromCompletedVolumes({
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 12000, // 200 CPM
        lastProgressUpdate: '2024-01-03T00:00:00Z'
      },
      'vol-2': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000, // 100 CPM
        lastProgressUpdate: '2024-01-02T00:00:00Z'
      },
      'vol-3': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 9000, // 150 CPM
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    });
    // Average: (200 + 100 + 150) / 3 = 150
    expect(result.charsPerMinute).toBe(150);
    expect(result.isPersonalized).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.sessionsUsed).toBe(3);
  });

  it('should use only 3 most recent volumes', () => {
    const result = calculateReadingSpeedFromCompletedVolumes({
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 12000, // 200 CPM - most recent
        lastProgressUpdate: '2024-01-04T00:00:00Z'
      },
      'vol-2': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 12000, // 200 CPM
        lastProgressUpdate: '2024-01-03T00:00:00Z'
      },
      'vol-3': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 12000, // 200 CPM
        lastProgressUpdate: '2024-01-02T00:00:00Z'
      },
      'vol-4': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 3000, // 50 CPM - oldest, should be excluded
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    });
    // Should only use first 3: (200 + 200 + 200) / 3 = 200
    expect(result.charsPerMinute).toBe(200);
    expect(result.sessionsUsed).toBe(3);
  });

  it('should filter out speeds above 1000 CPM', () => {
    const result = calculateReadingSpeedFromCompletedVolumes({
      'vol-1': {
        completed: true,
        timeReadInMinutes: 1,
        chars: 10000, // 10000 CPM - invalid, too fast
        lastProgressUpdate: '2024-01-02T00:00:00Z'
      },
      'vol-2': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000, // 100 CPM - valid
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    });
    expect(result.charsPerMinute).toBe(100);
    expect(result.sessionsUsed).toBe(1);
    expect(result.confidence).toBe('low');
  });

  it('should filter out volumes with zero time', () => {
    const result = calculateReadingSpeedFromCompletedVolumes({
      'vol-1': {
        completed: true,
        timeReadInMinutes: 0,
        chars: 6000,
        lastProgressUpdate: '2024-01-02T00:00:00Z'
      },
      'vol-2': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 12000, // 200 CPM
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    });
    expect(result.charsPerMinute).toBe(200);
    expect(result.sessionsUsed).toBe(1);
  });

  it('should filter out volumes with zero chars', () => {
    const result = calculateReadingSpeedFromCompletedVolumes({
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 0,
        lastProgressUpdate: '2024-01-02T00:00:00Z'
      },
      'vol-2': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 9000, // 150 CPM
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    });
    expect(result.charsPerMinute).toBe(150);
    expect(result.sessionsUsed).toBe(1);
  });

  it('should return confidence medium for 2 volumes', () => {
    const result = calculateReadingSpeedFromCompletedVolumes({
      'vol-1': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 12000,
        lastProgressUpdate: '2024-01-02T00:00:00Z'
      },
      'vol-2': {
        completed: true,
        timeReadInMinutes: 60,
        chars: 6000,
        lastProgressUpdate: '2024-01-01T00:00:00Z'
      }
    });
    expect(result.confidence).toBe('medium');
    expect(result.sessionsUsed).toBe(2);
  });
});

describe('calculateReadingSpeedFromSessions', () => {
  it('should return default speed (deprecated function)', () => {
    const result = calculateReadingSpeedFromSessions({}, 10);
    expect(result.charsPerMinute).toBe(100);
    expect(result.isPersonalized).toBe(false);
    expect(result.confidence).toBe('none');
    expect(result.sessionsUsed).toBe(0);
  });
});

describe('calculateReadingSpeed', () => {
  it('should return default speed when no data available', () => {
    const result = calculateReadingSpeed({}, 10);
    expect(result.charsPerMinute).toBe(100);
    expect(result.isPersonalized).toBe(false);
    expect(result.confidence).toBe('none');
    expect(result.sessionsUsed).toBe(0);
  });

  it('should calculate from completed volumes when no turn data', () => {
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: true,
          timeReadInMinutes: 60,
          chars: 12000, // 200 CPM
          lastProgressUpdate: '2024-01-01T00:00:00Z'
        }
      },
      10
    );
    expect(result.charsPerMinute).toBe(200);
    expect(result.isPersonalized).toBe(true);
    expect(result.sessionsUsed).toBe(1);
  });

  it('should calculate from page turns with 3-tuple format', () => {
    const now = Date.now();
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: false,
          timeReadInMinutes: 0,
          chars: 6000,
          lastProgressUpdate: '2024-01-01T00:00:00Z',
          recentPageTurns: [
            [now - 120000, 0, 0], // 2 min ago, page 0, 0 cumulative chars
            [now - 60000, 1, 100], // 1 min ago, page 1, 100 cumulative chars
            [now, 2, 200] // now, page 2, 200 cumulative chars
          ]
        }
      },
      10
    );
    // 200 chars in 120 seconds = 200 chars in 2 min = 100 CPM
    expect(result.charsPerMinute).toBe(100);
    expect(result.isPersonalized).toBe(true);
    expect(result.sessionsUsed).toBe(1);
  });

  it('should skip 2-tuple format (legacy data)', () => {
    const now = Date.now();
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: true,
          timeReadInMinutes: 60,
          chars: 12000, // 200 CPM
          lastProgressUpdate: '2024-01-01T00:00:00Z',
          recentPageTurns: [
            [now - 60000, 0], // Legacy 2-tuple format
            [now, 1]
          ] as unknown as [number, number, number][]
        }
      },
      10
    );
    // Should fall back to completed volume data
    expect(result.charsPerMinute).toBe(200);
    expect(result.sessionsUsed).toBe(1);
  });

  it('should skip idle periods based on timeout', () => {
    const now = Date.now();
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: false,
          timeReadInMinutes: 0,
          chars: 6000,
          lastProgressUpdate: '2024-01-01T00:00:00Z',
          recentPageTurns: [
            [now - 3600000, 0, 0], // 60 min ago (idle period)
            [now - 60000, 1, 100], // 1 min ago
            [now, 2, 200] // now
          ]
        }
      },
      10 // 10 minute timeout - first gap is idle
    );
    // Only counts 60 seconds (last transition), 100 chars = 100 CPM
    expect(result.charsPerMinute).toBe(100);
    expect(result.isPersonalized).toBe(true);
  });

  it('should filter out invalid CPM from turn data (> 1000)', () => {
    const now = Date.now();
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: true,
          timeReadInMinutes: 60,
          chars: 9000, // 150 CPM
          lastProgressUpdate: '2024-01-01T00:00:00Z',
          recentPageTurns: [
            [now - 1000, 0, 0], // 1 second ago
            [now, 1, 5000] // 5000 chars in 1 second = way too fast
          ]
        }
      },
      10
    );
    // Should fall back to completed volume
    expect(result.charsPerMinute).toBe(150);
    expect(result.sessionsUsed).toBe(1);
  });

  it('should combine turn data with completed volumes', () => {
    const now = Date.now();
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: false,
          timeReadInMinutes: 0,
          chars: 6000,
          lastProgressUpdate: '2024-01-01T00:00:00Z',
          recentPageTurns: [
            [now - 60000, 0, 0],
            [now, 1, 100] // 100 chars in 60 seconds = 100 CPM
          ]
        },
        'vol-2': {
          completed: true,
          timeReadInMinutes: 60,
          chars: 12000, // 200 CPM
          lastProgressUpdate: '2024-01-01T00:00:00Z'
        }
      },
      10
    );
    // Combined: 100 chars + 12000 chars = 12100 chars
    // Combined: 1 min + 60 min = 61 min
    // CPM: 12100 / 61 ≈ 198
    expect(result.charsPerMinute).toBeCloseTo(198, 0);
    expect(result.sessionsUsed).toBe(2);
  });

  it('should include aggregate sessions in calculation', () => {
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: false,
          timeReadInMinutes: 0,
          chars: 6000,
          lastProgressUpdate: '2024-01-01T00:00:00Z',
          sessions: [
            { durationMs: 60000, charsRead: 150 } // 150 chars/min
          ]
        }
      },
      10
    );
    expect(result.charsPerMinute).toBe(150);
    expect(result.isPersonalized).toBe(true);
    expect(result.sessionsUsed).toBe(1);
  });

  it('should filter invalid aggregate sessions', () => {
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: true,
          timeReadInMinutes: 60,
          chars: 12000, // 200 CPM
          lastProgressUpdate: '2024-01-01T00:00:00Z',
          sessions: [
            { durationMs: 0, charsRead: 100 }, // Invalid: 0 duration
            { durationMs: 60000, charsRead: 0 }, // Invalid: 0 chars
            { durationMs: -1000, charsRead: 100 }, // Invalid: negative duration
            { durationMs: 1, charsRead: 10000 } // Invalid: > 1000 CPM
          ]
        }
      },
      10
    );
    // All sessions invalid, should use completed volume
    expect(result.charsPerMinute).toBe(200);
    expect(result.sessionsUsed).toBe(1);
  });

  it('should determine high confidence with enough data', () => {
    // ESTIMATION_HOURS is 8, so we need 8 * 60 * 0.75 = 360 minutes for high confidence
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: true,
          timeReadInMinutes: 200,
          chars: 20000, // 100 CPM
          lastProgressUpdate: '2024-01-03T00:00:00Z'
        },
        'vol-2': {
          completed: true,
          timeReadInMinutes: 200,
          chars: 20000, // 100 CPM
          lastProgressUpdate: '2024-01-02T00:00:00Z'
        }
      },
      10
    );
    // 400 minutes total >= 360 minutes for high confidence
    expect(result.confidence).toBe('high');
    expect(result.charsPerMinute).toBe(100);
  });

  it('should determine medium confidence', () => {
    // 8 * 60 * 0.5 = 240 minutes for medium, < 360 for high
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: true,
          timeReadInMinutes: 250, // 250 minutes
          chars: 25000, // 100 CPM
          lastProgressUpdate: '2024-01-01T00:00:00Z'
        }
      },
      10
    );
    // 250 minutes >= 240 (medium) but < 360 (high)
    expect(result.confidence).toBe('medium');
  });

  it('should determine low confidence', () => {
    // >= 30 minutes but < 240 minutes for low
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: true,
          timeReadInMinutes: 35, // 35 minutes
          chars: 3500, // 100 CPM
          lastProgressUpdate: '2024-01-01T00:00:00Z'
        }
      },
      10
    );
    // 35 minutes >= 30 (low) but < 240 (medium)
    expect(result.confidence).toBe('low');
  });

  it('should accumulate time from multiple pages in same volume', () => {
    const now = Date.now();
    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: false,
          timeReadInMinutes: 0,
          chars: 6000,
          lastProgressUpdate: '2024-01-01T00:00:00Z',
          recentPageTurns: [
            [now - 180000, 0, 0], // 3 min ago
            [now - 120000, 1, 100], // 2 min ago (60s on page 0)
            [now - 60000, 2, 200], // 1 min ago (60s on page 1)
            [now, 3, 300] // now (60s on page 2)
          ]
        }
      },
      10
    );
    // 300 chars in 180 seconds = 300 chars in 3 min = 100 CPM
    expect(result.charsPerMinute).toBe(100);
    expect(result.sessionsUsed).toBe(1);
  });

  it('should handle multiple volumes with turn data sorted by recency', () => {
    const now = Date.now();

    const result = calculateReadingSpeed(
      {
        'vol-1': {
          completed: false,
          timeReadInMinutes: 0,
          chars: 6000,
          lastProgressUpdate: '2024-01-01T00:00:00Z',
          recentPageTurns: [
            [now - 120000, 0, 0], // 2 min ago
            [now - 60000, 1, 100], // 1 min ago
            [now, 2, 200] // now - most recent
          ]
        },
        'vol-2': {
          completed: false,
          timeReadInMinutes: 0,
          chars: 6000,
          lastProgressUpdate: '2024-01-01T00:00:00Z',
          recentPageTurns: [
            [now - 240000, 0, 0], // 4 min ago
            [now - 180000, 1, 100] // 3 min ago - older
          ]
        }
      },
      10
    );
    // vol-1: 200 chars in 120s = 100 CPM
    // vol-2: 100 chars in 60s = 100 CPM
    // Combined: 300 chars in 180s = 100 CPM
    expect(result.charsPerMinute).toBe(100);
    expect(result.isPersonalized).toBe(true);
    expect(result.sessionsUsed).toBe(2);
  });
});

describe('constants', () => {
  it('should export SESSION_DATA_HOURS', () => {
    expect(SESSION_DATA_HOURS).toBe(4);
  });

  it('should export ESTIMATION_HOURS', () => {
    expect(ESTIMATION_HOURS).toBe(8);
  });
});
