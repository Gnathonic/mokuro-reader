import { describe, it, expect } from 'vitest';
import { formatMemory } from './memory';

describe('formatMemory', () => {
  it('should format bytes', () => {
    expect(formatMemory(0)).toBe('0.00 B');
    expect(formatMemory(100)).toBe('100.00 B');
    expect(formatMemory(1023)).toBe('1023.00 B');
  });

  it('should format kilobytes', () => {
    expect(formatMemory(1024)).toBe('1.00 KB');
    expect(formatMemory(1536)).toBe('1.50 KB');
    expect(formatMemory(10240)).toBe('10.00 KB');
  });

  it('should format megabytes', () => {
    expect(formatMemory(1024 * 1024)).toBe('1.00 MB');
    expect(formatMemory(1024 * 1024 * 5.5)).toBe('5.50 MB');
    expect(formatMemory(1024 * 1024 * 100)).toBe('100.00 MB');
  });

  it('should format gigabytes', () => {
    expect(formatMemory(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatMemory(1024 * 1024 * 1024 * 2.5)).toBe('2.50 GB');
    expect(formatMemory(1024 * 1024 * 1024 * 8)).toBe('8.00 GB');
  });

  it('should format terabytes', () => {
    expect(formatMemory(1024 * 1024 * 1024 * 1024)).toBe('1.00 TB');
    expect(formatMemory(1024 * 1024 * 1024 * 1024 * 2)).toBe('2.00 TB');
  });

  it('should handle edge cases', () => {
    // Just under 1KB
    expect(formatMemory(1023)).toBe('1023.00 B');
    // Just at 1KB
    expect(formatMemory(1024)).toBe('1.00 KB');
    // Just over 1KB
    expect(formatMemory(1025)).toMatch(/^1\.00 KB$/);
  });

  it('should handle fractional values', () => {
    expect(formatMemory(1.5)).toBe('1.50 B');
    expect(formatMemory(1024 * 1.234)).toBe('1.23 KB');
  });
});
