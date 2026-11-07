import { describe, it, expect } from 'vitest';
import {
  calculateVolumeTimeToFinish,
  calculateEstimatedTime,
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
