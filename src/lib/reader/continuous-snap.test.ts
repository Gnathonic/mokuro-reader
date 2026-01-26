import { describe, it, expect } from 'vitest';
import {
  calculateSnapTarget,
  shouldSnap,
  easeOutCubic,
  interpolateWithEasing,
  type SnapState,
  type SnapConfig
} from './continuous-snap';

function createState(overrides: Partial<SnapState> = {}): SnapState {
  return {
    currentY: 0,
    velocity: 0,
    spreadHeight: 1500,
    viewportHeight: 1080,
    currentSpreadIndex: 5,
    totalSpreads: 10,
    ...overrides
  };
}

const defaultConfig: SnapConfig = {
  decayFactor: 0.95,
  transitionThreshold: 0.3
};

describe('calculateSnapTarget', () => {
  describe('spread taller than viewport', () => {
    it('should snap to top when near top and no velocity', () => {
      const state = createState({ currentY: -50, velocity: 0 });
      const result = calculateSnapTarget(state, defaultConfig);

      expect(result).toEqual({ type: 'snap', targetY: 0 });
    });

    it('should snap to bottom when near bottom and no velocity', () => {
      const state = createState({
        currentY: -400, // Near bottom boundary (-420)
        velocity: 0,
        spreadHeight: 1500,
        viewportHeight: 1080
      });
      const result = calculateSnapTarget(state, defaultConfig);

      // Bottom boundary = 1080 - 1500 = -420
      expect(result).toEqual({ type: 'snap', targetY: -420 });
    });

    it('should use momentum to predict snap target with gentle downward velocity', () => {
      // With decay 0.95, velocity is multiplied by ~20000
      // So velocity of 0.01 predicts ~200 pixels of movement
      const state = createState({
        currentY: -100,
        velocity: -0.01, // Gentle downward movement
        spreadHeight: 1500,
        viewportHeight: 1080
      });
      const result = calculateSnapTarget(state, defaultConfig);

      // Small momentum should snap to nearest boundary (bottom is closer now)
      // predictedEnd = -100 + (-0.01 * 1000 / 0.05) = -100 + (-200) = -300
      // Still closer to top (0) than bottom (-420), but past middle, so bottom
      expect(result).toEqual({ type: 'snap', targetY: -420 });
    });

    it('should use momentum to predict snap target with gentle upward velocity', () => {
      const state = createState({
        currentY: -300,
        velocity: 0.01, // Gentle upward movement
        spreadHeight: 1500,
        viewportHeight: 1080
      });
      const result = calculateSnapTarget(state, defaultConfig);

      // predictedEnd = -300 + (0.01 * 1000 / 0.05) = -300 + 200 = -100
      // Closer to top (0) than bottom (-420)
      expect(result).toEqual({ type: 'snap', targetY: 0 });
    });

    it('should return none when already at target', () => {
      const state = createState({ currentY: 0, velocity: 0 });
      const result = calculateSnapTarget(state, defaultConfig);

      expect(result).toEqual({ type: 'none' });
    });
  });

  describe('spread smaller than viewport', () => {
    it('should snap to center when spread fits in viewport', () => {
      const state = createState({
        currentY: 0,
        velocity: 0,
        spreadHeight: 800,
        viewportHeight: 1080
      });
      const result = calculateSnapTarget(state, defaultConfig);

      // Center = (1080 - 800) / 2 = 140
      expect(result).toEqual({ type: 'snap', targetY: 140 });
    });

    it('should return none when already centered', () => {
      const state = createState({
        currentY: 140, // Already centered
        velocity: 0,
        spreadHeight: 800,
        viewportHeight: 1080
      });
      const result = calculateSnapTarget(state, defaultConfig);

      expect(result).toEqual({ type: 'none' });
    });
  });

  describe('momentum-based transitions', () => {
    it('should return transition down with strong downward momentum', () => {
      const state = createState({
        currentY: -350, // Near bottom
        velocity: -2, // Strong downward velocity
        spreadHeight: 1500,
        viewportHeight: 1080,
        currentSpreadIndex: 5,
        totalSpreads: 10
      });
      const result = calculateSnapTarget(state, defaultConfig);

      expect(result).toEqual({ type: 'transition', direction: 'down' });
    });

    it('should return transition up with strong upward momentum', () => {
      const state = createState({
        currentY: -50, // Near top
        velocity: 2, // Strong upward velocity
        spreadHeight: 1500,
        viewportHeight: 1080,
        currentSpreadIndex: 5,
        totalSpreads: 10
      });
      const result = calculateSnapTarget(state, defaultConfig);

      expect(result).toEqual({ type: 'transition', direction: 'up' });
    });

    it('should not transition down when at last spread', () => {
      const state = createState({
        currentY: -350,
        velocity: -2,
        spreadHeight: 1500,
        viewportHeight: 1080,
        currentSpreadIndex: 9, // Last spread
        totalSpreads: 10
      });
      const result = calculateSnapTarget(state, defaultConfig);

      // Should snap, not transition
      expect(result.type).toBe('snap');
    });

    it('should not transition up when at first spread', () => {
      const state = createState({
        currentY: -50,
        velocity: 2,
        spreadHeight: 1500,
        viewportHeight: 1080,
        currentSpreadIndex: 0, // First spread
        totalSpreads: 10
      });
      const result = calculateSnapTarget(state, defaultConfig);

      // Should snap, not transition
      expect(result.type).toBe('snap');
    });
  });

  describe('edge cases', () => {
    it('should handle zero velocity', () => {
      const state = createState({
        currentY: -200,
        velocity: 0,
        spreadHeight: 1500,
        viewportHeight: 1080
      });
      const result = calculateSnapTarget(state, defaultConfig);

      // Should snap to nearest edge (top is closer)
      expect(result).toEqual({ type: 'snap', targetY: 0 });
    });

    it('should handle single spread volume', () => {
      const state = createState({
        currentY: -50,
        velocity: 2, // Would normally trigger transition up
        currentSpreadIndex: 0,
        totalSpreads: 1
      });
      const result = calculateSnapTarget(state, defaultConfig);

      // Can't transition, should snap
      expect(result.type).not.toBe('transition');
    });
  });
});

describe('shouldSnap', () => {
  it('should return true when difference exceeds threshold', () => {
    expect(shouldSnap(0, 100, 5)).toBe(true);
    expect(shouldSnap(-100, 0, 5)).toBe(true);
  });

  it('should return false when difference is within threshold', () => {
    expect(shouldSnap(0, 3, 5)).toBe(false);
    expect(shouldSnap(-100, -98, 5)).toBe(false);
  });

  it('should handle custom threshold', () => {
    expect(shouldSnap(0, 8, 10)).toBe(false);
    expect(shouldSnap(0, 12, 10)).toBe(true);
  });
});

describe('easeOutCubic', () => {
  it('should return 0 at start', () => {
    expect(easeOutCubic(0)).toBe(0);
  });

  it('should return 1 at end', () => {
    expect(easeOutCubic(1)).toBe(1);
  });

  it('should return values between 0 and 1 for inputs between 0 and 1', () => {
    const mid = easeOutCubic(0.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('should have faster progress at start (ease-out characteristic)', () => {
    // Ease-out should cover more ground early
    const quarter = easeOutCubic(0.25);
    expect(quarter).toBeGreaterThan(0.25); // Progress faster than linear
  });
});

describe('interpolateWithEasing', () => {
  it('should return start value at progress 0', () => {
    const result = interpolateWithEasing(100, 200, 0);
    expect(result).toBe(100);
  });

  it('should return end value at progress 1', () => {
    const result = interpolateWithEasing(100, 200, 1);
    expect(result).toBe(200);
  });

  it('should interpolate with easing', () => {
    const result = interpolateWithEasing(0, 100, 0.5);
    // With ease-out cubic, 0.5 progress gives more than 0.5 of the way
    expect(result).toBeGreaterThan(50);
  });

  it('should handle negative values', () => {
    const result = interpolateWithEasing(-100, 0, 1);
    expect(result).toBe(0);
  });

  it('should clamp progress to 0-1 range', () => {
    expect(interpolateWithEasing(0, 100, -0.5)).toBe(0);
    expect(interpolateWithEasing(0, 100, 1.5)).toBe(100);
  });

  it('should accept custom easing function', () => {
    const linear = (t: number) => t;
    const result = interpolateWithEasing(0, 100, 0.5, linear);
    expect(result).toBe(50);
  });
});
