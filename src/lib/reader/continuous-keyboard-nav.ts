/**
 * Keyboard navigation logic for continuous scroll reader mode.
 * Extracted for testability and reusability.
 */

export type NavigationAction =
  | { type: 'pan'; deltaY: number }
  | { type: 'jump_spread'; direction: 'prev' | 'next' }
  | { type: 'jump_edge'; edge: 'first' | 'last' }
  | { type: 'volume_nav'; direction: 'prev' | 'next' }
  | { type: 'none' };

export interface NavigationState {
  currentSpreadIndex: number;
  totalSpreads: number;
  /** Current Y position within spread (0 = top, negative = scrolled down) */
  panY: number;
  /** Height of current spread in pixels */
  spreadHeight: number;
  /** Viewport height in pixels */
  viewportHeight: number;
}

export interface NavigationConfig {
  /** Pixels to pan per arrow key press */
  panStep: number;
}

const DEFAULT_CONFIG: NavigationConfig = {
  panStep: 100
};

/**
 * Determines the navigation action for a given keyboard event.
 * Pure function - no side effects.
 */
export function getNavigationAction(
  key: string,
  state: NavigationState,
  config: NavigationConfig = DEFAULT_CONFIG
): NavigationAction {
  switch (key) {
    case 'ArrowUp':
      return { type: 'pan', deltaY: config.panStep };

    case 'ArrowDown':
    case ' ': // Space
      return { type: 'pan', deltaY: -config.panStep };

    case 'PageUp':
      return handlePageUp(state);

    case 'PageDown':
      return handlePageDown(state);

    case 'Home':
      return handleHome(state);

    case 'End':
      return handleEnd(state);

    default:
      return { type: 'none' };
  }
}

function handlePageUp(state: NavigationState): NavigationAction {
  if (state.currentSpreadIndex > 0) {
    return { type: 'jump_spread', direction: 'prev' };
  }
  // At first spread - navigate to previous volume
  return { type: 'volume_nav', direction: 'prev' };
}

function handlePageDown(state: NavigationState): NavigationAction {
  if (state.currentSpreadIndex < state.totalSpreads - 1) {
    return { type: 'jump_spread', direction: 'next' };
  }
  // At last spread - navigate to next volume
  return { type: 'volume_nav', direction: 'next' };
}

function handleHome(state: NavigationState): NavigationAction {
  if (state.currentSpreadIndex === 0) {
    return { type: 'none' };
  }
  return { type: 'jump_edge', edge: 'first' };
}

function handleEnd(state: NavigationState): NavigationAction {
  if (state.currentSpreadIndex === state.totalSpreads - 1) {
    return { type: 'none' };
  }
  return { type: 'jump_edge', edge: 'last' };
}

/**
 * Checks if pan action should trigger a spread transition.
 * Returns the new spread index or null if no transition.
 */
export function checkPanTransition(
  state: NavigationState,
  newPanY: number
): { newSpreadIndex: number; direction: 'up' | 'down' } | null {
  const { currentSpreadIndex, totalSpreads, spreadHeight, viewportHeight } = state;

  // Calculate boundaries
  const topBoundary = 0;
  const bottomBoundary = Math.min(0, viewportHeight - spreadHeight);

  // Scrolled past bottom - go to next spread
  if (newPanY < bottomBoundary - spreadHeight * 0.1 && currentSpreadIndex < totalSpreads - 1) {
    return { newSpreadIndex: currentSpreadIndex + 1, direction: 'down' };
  }

  // Scrolled past top - go to previous spread
  if (newPanY > topBoundary + spreadHeight * 0.1 && currentSpreadIndex > 0) {
    return { newSpreadIndex: currentSpreadIndex - 1, direction: 'up' };
  }

  return null;
}

/**
 * Clamps pan position to valid bounds for the current spread.
 */
export function clampPanY(panY: number, spreadHeight: number, viewportHeight: number): number {
  const topBoundary = 0;
  const bottomBoundary = Math.min(0, viewportHeight - spreadHeight);

  // If spread fits in viewport, center it
  if (spreadHeight <= viewportHeight) {
    return (viewportHeight - spreadHeight) / 2;
  }

  return Math.max(bottomBoundary, Math.min(topBoundary, panY));
}
