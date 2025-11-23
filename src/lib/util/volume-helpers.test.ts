import { describe, it, expect } from 'vitest';
import { isVolumeComplete, getCurrentPage, getProgressDisplay } from './volume-helpers';

describe('isVolumeComplete', () => {
  it('should return true when on last page (pageCount)', () => {
    expect(isVolumeComplete(200, 200)).toBe(true);
  });

  it('should return true when on second to last page (pageCount - 1)', () => {
    // This handles the case where the reader shows page_count-1 as the last readable page
    expect(isVolumeComplete(199, 200)).toBe(true);
  });

  it('should return false when not near end', () => {
    expect(isVolumeComplete(1, 200)).toBe(false);
    expect(isVolumeComplete(100, 200)).toBe(false);
    expect(isVolumeComplete(198, 200)).toBe(false);
  });

  it('should handle single page volume', () => {
    expect(isVolumeComplete(1, 1)).toBe(true);
    expect(isVolumeComplete(0, 1)).toBe(true); // 0 === 1-1
  });

  it('should handle two page volume', () => {
    expect(isVolumeComplete(2, 2)).toBe(true);
    expect(isVolumeComplete(1, 2)).toBe(true); // 1 === 2-1
  });

  it('should return false for page 0 in multi-page volume', () => {
    expect(isVolumeComplete(0, 100)).toBe(false);
  });
});

describe('getCurrentPage', () => {
  it('should return page from progress when available', () => {
    const progress = {
      'vol-1': 50,
      'vol-2': 100
    };
    expect(getCurrentPage('vol-1', progress)).toBe(50);
    expect(getCurrentPage('vol-2', progress)).toBe(100);
  });

  it('should return 1 when volume not in progress', () => {
    const progress = {
      'vol-1': 50
    };
    expect(getCurrentPage('vol-2', progress)).toBe(1);
  });

  it('should return 1 when progress is undefined', () => {
    expect(getCurrentPage('vol-1', undefined)).toBe(1);
  });

  it('should return 1 when progress is empty object', () => {
    expect(getCurrentPage('vol-1', {})).toBe(1);
  });

  it('should handle zero page in progress', () => {
    const progress = {
      'vol-1': 0
    };
    // 0 is falsy, so ?? operator returns it (0 is a valid value)
    expect(getCurrentPage('vol-1', progress)).toBe(0);
  });
});

describe('getProgressDisplay', () => {
  it('should format basic progress', () => {
    expect(getProgressDisplay(5, 200)).toBe('5 / 200');
    expect(getProgressDisplay(1, 100)).toBe('1 / 100');
    expect(getProgressDisplay(50, 50)).toBe('50 / 50');
  });

  it('should display pageCount when on second to last page', () => {
    // Edge case: page_count-1 shows as page_count for better UX
    expect(getProgressDisplay(199, 200)).toBe('200 / 200');
    expect(getProgressDisplay(99, 100)).toBe('100 / 100');
  });

  it('should use default page when currentPage is 0', () => {
    expect(getProgressDisplay(0, 200)).toBe('1 / 200');
    expect(getProgressDisplay(0, 100, 5)).toBe('5 / 100');
  });

  it('should use custom default page', () => {
    expect(getProgressDisplay(0, 200, 10)).toBe('10 / 200');
  });

  it('should handle single page volume', () => {
    expect(getProgressDisplay(1, 1)).toBe('1 / 1');
    expect(getProgressDisplay(0, 1)).toBe('1 / 1'); // 0 === 1-1, shows as pageCount
  });

  it('should handle two page volume edge case', () => {
    expect(getProgressDisplay(1, 2)).toBe('2 / 2'); // 1 === 2-1
    expect(getProgressDisplay(2, 2)).toBe('2 / 2');
  });

  it('should not modify normal pages', () => {
    expect(getProgressDisplay(198, 200)).toBe('198 / 200');
    expect(getProgressDisplay(1, 200)).toBe('1 / 200');
  });
});
