/**
 * Snap behavior logic for continuous scroll reader mode.
 * Handles momentum-based snap targeting and animation.
 */

export interface SnapState {
  /** Current Y position (0 = top, negative = scrolled down) */
  currentY: number;
  /** Current pan velocity (pixels per millisecond) */
  velocity: number;
  /** Height of current spread in pixels */
  spreadHeight: number;
  /** Viewport height in pixels */
  viewportHeight: number;
  /** Current spread index */
  currentSpreadIndex: number;
  /** Total number of spreads */
  totalSpreads: number;
}

export interface SnapConfig {
  /** Decay factor for velocity prediction (0-1, higher = more decay) */
  decayFactor: number;
  /** Threshold for transition as fraction of spread height */
  transitionThreshold: number;
}

const DEFAULT_CONFIG: SnapConfig = {
  decayFactor: 0.95,
  transitionThreshold: 0.3
};

export type SnapResult =
  | { type: 'snap'; targetY: number }
  | { type: 'transition'; direction: 'up' | 'down' }
  | { type: 'none' };

/**
 * Calculates the snap target based on current position and velocity.
 * Uses momentum prediction to determine where the user intended to stop.
 */
export function calculateSnapTarget(
  state: SnapState,
  config: SnapConfig = DEFAULT_CONFIG
): SnapResult {
  const { currentY, velocity, spreadHeight, viewportHeight, currentSpreadIndex, totalSpreads } =
    state;
  const { decayFactor, transitionThreshold } = config;

  // Predict end position based on velocity with decay
  // Formula: position + velocity * (1 / (1 - decayFactor))
  const predictedEnd = currentY + (velocity * 1000) / (1 - decayFactor);

  // Calculate boundaries for current spread
  const topBoundary = 0;
  const bottomBoundary = Math.min(0, viewportHeight - spreadHeight);

  // If content fits in viewport, always center
  if (spreadHeight <= viewportHeight) {
    const centerY = (viewportHeight - spreadHeight) / 2;
    if (Math.abs(currentY - centerY) < 5) {
      return { type: 'none' };
    }
    return { type: 'snap', targetY: centerY };
  }

  // Check if momentum would cause transition to next spread
  if (
    predictedEnd < bottomBoundary - spreadHeight * transitionThreshold &&
    currentSpreadIndex < totalSpreads - 1
  ) {
    return { type: 'transition', direction: 'down' };
  }

  // Check if momentum would cause transition to previous spread
  if (predictedEnd > topBoundary + spreadHeight * transitionThreshold && currentSpreadIndex > 0) {
    return { type: 'transition', direction: 'up' };
  }

  // Clamp predicted position to boundaries
  let targetY: number;
  if (predictedEnd > topBoundary) {
    targetY = topBoundary;
  } else if (predictedEnd < bottomBoundary) {
    targetY = bottomBoundary;
  } else {
    // Snap to nearest edge
    const distToTop = Math.abs(predictedEnd - topBoundary);
    const distToBottom = Math.abs(predictedEnd - bottomBoundary);
    targetY = distToTop < distToBottom ? topBoundary : bottomBoundary;
  }

  // Don't snap if already at target
  if (Math.abs(currentY - targetY) < 5) {
    return { type: 'none' };
  }

  return { type: 'snap', targetY };
}

/**
 * Determines if snap animation should occur.
 * Returns true if snap is enabled and there's meaningful movement to snap.
 */
export function shouldSnap(currentY: number, targetY: number, threshold: number = 5): boolean {
  return Math.abs(targetY - currentY) > threshold;
}

/**
 * Calculates eased animation progress.
 * Uses ease-out cubic for natural deceleration.
 */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Interpolates between start and end values with easing.
 */
export function interpolateWithEasing(
  start: number,
  end: number,
  progress: number,
  easingFn: (t: number) => number = easeOutCubic
): number {
  const easedProgress = easingFn(Math.min(1, Math.max(0, progress)));
  return start + (end - start) * easedProgress;
}
