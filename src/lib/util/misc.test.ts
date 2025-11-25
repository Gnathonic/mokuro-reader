import { describe, it, expect } from 'vitest';
import { clamp } from './misc';

describe('clamp', () => {
  it('should return the number when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('should return min when number is below range', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(-100, 0, 10)).toBe(0);
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it('should return max when number is above range', () => {
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(100, 0, 10)).toBe(10);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('should handle negative ranges', () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
    expect(clamp(-15, -10, -1)).toBe(-10);
    expect(clamp(0, -10, -1)).toBe(-1);
  });

  it('should handle floating point numbers', () => {
    expect(clamp(5.5, 0, 10)).toBe(5.5);
    expect(clamp(10.1, 0, 10)).toBe(10);
    expect(clamp(-0.1, 0, 10)).toBe(0);
  });

  it('should handle zero-width ranges', () => {
    expect(clamp(5, 5, 5)).toBe(5);
    expect(clamp(0, 5, 5)).toBe(5);
    expect(clamp(10, 5, 5)).toBe(5);
  });

  it('should handle inverted ranges (min > max)', () => {
    // Math.min(Math.max(5, 10), 0) = Math.min(10, 0) = 0
    // This is edge case behavior, probably not intended use
    expect(clamp(5, 10, 0)).toBe(0);
  });
});
