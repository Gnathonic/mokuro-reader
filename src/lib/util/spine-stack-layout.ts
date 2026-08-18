/**
 * The spine-stack geometry shared by the catalog card and the series editor's spine
 * showcase: where each volume sits along the x axis, and which one the pointer is over.
 *
 * Pure on purpose — both callers hand it numbers they already derived (step size in px,
 * per-index nudges) so the same arithmetic can be unit-tested once instead of living
 * inline in two components that must agree.
 */

export interface StackLayoutInput {
  /** Number of volumes in the stack. */
  count: number;
  /** Nominal width of one spine, in the caller's coordinate space. */
  baseWidth: number;
  /** Distance between consecutive spines, in px (already includes the series offset). */
  horizontalStepPx: number;
  /**
   * Per-volume nudges in px, keyed by stack index. Each one CASCADES: an offset on
   * volume i shifts every volume after it, which is what makes a nudge feel like
   * "move this spine and everything behind it", not "detach this spine".
   */
  volumeOffsetsByIndex?: Map<number, number>;
}

export interface StackLayout {
  /** Left edge of each volume, index-aligned with the stack. */
  lefts: number[];
  /** Left edge of the last volume plus one spine width; `0` for an empty stack. */
  totalWidth: number;
}

export function computeStackLayout({
  count,
  baseWidth,
  horizontalStepPx,
  volumeOffsetsByIndex
}: StackLayoutInput): StackLayout {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const lefts: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < total; i++) {
    lefts.push(i * horizontalStepPx + cumulative);
    // Read AFTER placing i: the last volume's own offset has nothing behind it to push.
    cumulative += volumeOffsetsByIndex?.get(i) ?? 0;
  }
  return { lefts, totalWidth: total > 0 ? lefts[total - 1] + baseWidth : 0 };
}

/**
 * Which volume is under `x` (same coordinate space as `layout.lefts`).
 *
 * Front-to-back: index 0 is drawn on top, so the first spine whose band contains `x`
 * wins even though later spines overlap it. Returns `null` when `x` is left of the stack
 * or past every spine's right edge — callers decide what that means (the catalog card
 * treats it as "the back-most volume").
 *
 * `width` is either one nominal width for every spine (the catalog card, whose stack is
 * clipped to the base box) or a per-index array (the spine shelf, where each volume is
 * drawn at its own aspect width — hit-testing a narrow spine against a full 250px band
 * would target the wrong volume). A missing entry is treated as zero width: nothing is
 * drawn for that volume, so nothing can be over it.
 */
export function hitTestStack(
  layout: StackLayout,
  x: number,
  width: number | number[]
): number | null {
  for (let i = 0; i < layout.lefts.length; i++) {
    const left = layout.lefts[i];
    const w = typeof width === 'number' ? width : (width[i] ?? 0);
    if (x >= left && x <= left + w) return i;
  }
  return null;
}
