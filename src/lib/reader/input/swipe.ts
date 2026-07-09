/**
 * Swipe-to-flip classification for paged mode — the pure decision extracted
 * from Reader.svelte's window-level touch handlers.
 *
 * A page-flip swipe is a fast (<500ms), mostly-horizontal touch gesture
 * crossing the user's distance threshold (swipeThreshold, % of viewport
 * width). Two suppressions carry the contracts that matter:
 *
 * - **Edge gating (#186):** if pannable content was hidden in the swipe's
 *   direction when the gesture BEGAN, the gesture is an intra-page pan and
 *   must not flip — the user is dragging hidden content into view. The
 *   edge state is sampled at press time, before the pan moves it.
 * - **Pinch suppression:** a gesture that was ever a pinch (wasPinch, from
 *   the pointer tracker) is zooming, and its tail movement must not flip
 *   the page. Replaces the old 200ms lastMultiTouchTime debounce.
 *
 * Returns which side's page to flip to — 'left' for a rightward swipe
 * (revealing the page to the left), 'right' for a leftward swipe — or null.
 * RTL direction semantics are the caller's concern.
 */

import type { PanSummary } from './pointer-tracker';

export interface SwipeContext {
  summary: PanSummary;
  /** PointerGestureTracker.wasPinch for this press sequence. */
  wasPinch: boolean;
  viewport: { width: number; height: number };
  /** settings.swipeThreshold — required travel as a % of viewport width. */
  thresholdPercent: number;
  /** Camera edge state sampled when the gesture began. */
  canRevealLeftAtStart: boolean;
  canRevealRightAtStart: boolean;
}

export function classifySwipe(ctx: SwipeContext): 'left' | 'right' | null {
  const { summary } = ctx;
  if (summary.cancelled) return null;
  if (summary.pointerType !== 'touch') return null;
  if (ctx.wasPinch) return null;
  if (summary.durationMs >= 500) return null;

  const dy = summary.endY - summary.startY;
  const verticalThreshold = Math.min(200, ctx.viewport.height * 0.3);
  if (Math.abs(dy) >= verticalThreshold) return null;

  const dx = summary.endX - summary.startX;
  const threshold = (ctx.thresholdPercent / 100) * ctx.viewport.width;

  if (dx > threshold && !ctx.canRevealLeftAtStart) return 'left';
  if (dx < -threshold && !ctx.canRevealRightAtStart) return 'right';
  return null;
}
