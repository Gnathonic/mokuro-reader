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

/** Rendered size of a spine mark, in px — the `spine` DownloadBadge (h-5 w-5). */
export const SPINE_BADGE_PX = 20;

export interface SpineBadgeInput<T> {
  /** The stack, in draw order (index 0 on top), exactly as handed to CompositeCanvas. */
  volumes: T[];
  /** Which of them get a badge. */
  isMarked: (volume: T, index: number) => boolean;
  /**
   * The box a volume is painted in, or `null` when the canvas paints nothing for it (no
   * pixels yet) — an unpainted spine has no corner to mark.
   */
  drawnSize: (volume: T, index: number) => { width: number; height: number } | null;
  /** Distance between consecutive spines, in px (already includes the series offset). */
  horizontalStepPx: number;
  /** Vertical step and top inset the canvas draws with. */
  verticalStepPx: number;
  topOffsetPx: number;
  /** Width of the canvas the stack is right-aligned into. */
  canvasWidth: number;
  /** Per-index nudges in px; cascading, as everywhere else. */
  volumeOffsetsByIndex?: Map<number, number>;
  /** Size of the badge box in px (default `SPINE_BADGE_PX`). */
  badgePx?: number;
  /** Inset from the spine's bottom edge (default 2). */
  insetPx?: number;
}

export interface SpineBadgePlacement {
  /** Index in `volumes`, so the caller can key the badge and name it. */
  index: number;
  left: number;
  top: number;
}

/**
 * Where to put a badge on each marked spine of a stack — the catalog card's cover stack
 * and the series editor's spine shelf both draw one.
 *
 * Positions are derived from the SAME numbers CompositeCanvas draws with: cascading lefts
 * (`computeStackLayout`), then its right-alignment of the last spine to `canvasWidth`, then
 * the vertical step. The badges are overlays; nothing here feeds back into the geometry, so
 * a marked stack measures exactly like an unmarked one.
 *
 * Horizontally each badge is CENTRED on the strip of its spine that is actually visible.
 * Spines overlap — index 0 is painted last and covers the one behind it — so the strip is
 * bounded on the left by the previous spine's right edge, and a badge centred on the full
 * width would sit under its neighbour on every spine but the front one.
 */
export function spineBadgePlacements<T>({
  volumes,
  isMarked,
  drawnSize,
  horizontalStepPx,
  verticalStepPx,
  topOffsetPx,
  canvasWidth,
  volumeOffsetsByIndex,
  badgePx = SPINE_BADGE_PX,
  insetPx = 2
}: SpineBadgeInput<T>): SpineBadgePlacement[] {
  const placements: SpineBadgePlacement[] = [];
  const count = volumes.length;
  if (count === 0) return placements;

  const lastWidth = drawnSize(volumes[count - 1], count - 1)?.width ?? 0;
  const { lefts } = computeStackLayout({
    count,
    baseWidth: lastWidth,
    horizontalStepPx,
    volumeOffsetsByIndex
  });
  // CompositeCanvas pins the stack's right edge to the canvas rather than using the
  // centering offset; mirror that or every badge drifts by the difference.
  const alignShift = canvasWidth - ((lefts[count - 1] ?? 0) + lastWidth);
  const inset = badgePx + insetPx;

  for (let i = 0; i < count; i++) {
    const volume = volumes[i];
    if (!isMarked(volume, i)) continue;
    const size = drawnSize(volume, i);
    if (!size) continue;

    const left = (lefts[i] ?? 0) + alignShift;
    const right = left + size.width;
    // Whatever the spines in FRONT leave showing. Every earlier index is painted over this
    // one, so the cover reaches as far as the furthest of them — not just the nearest, which
    // may be narrow, and not the one immediately before, which may not be painted at all.
    let coveredTo = left;
    for (let j = 0; j < i; j++) {
      const front = drawnSize(volumes[j], j);
      if (!front) continue;
      coveredTo = Math.max(coveredTo, (lefts[j] ?? 0) + alignShift + front.width);
    }
    const visibleLeft = Math.min(coveredTo, right);

    placements.push({
      index: i,
      left: (visibleLeft + right) / 2 - badgePx / 2,
      top: topOffsetPx + i * verticalStepPx + size.height - inset
    });
  }

  return placements;
}
