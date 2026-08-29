/**
 * The catalog card's thumbnail-stack geometry — how big each cover/spine is drawn and how
 * far apart the stack steps.
 *
 * Extracted from `CatalogItem.svelte` so the series editor's spine shelf can render the
 * SAME picture: the shelf is where the offsets are tuned, so a nudge there has to move the
 * card by exactly the same amount, and a gap seen there has to be the gap on the card.
 * Anything the two components disagree on shows up as "it looked right in the editor".
 *
 * Pure and unit-testable on purpose: `spine-stack-geometry.test.ts` pins every function
 * against the card's original inline math.
 *
 * Coordinate space: everything here is CARD pixels (a 250×360 nominal thumbnail box). The
 * shelf multiplies the results by its own zoom when it draws; it never changes the rules.
 */

export interface Dimensions {
  width: number;
  height: number;
}

/** Nominal thumbnail box the card lays a stack out in. */
export const CARD_BASE_WIDTH = 250;
export const CARD_BASE_HEIGHT = 360;

/**
 * Cap for the stack of a series with NOTHING on this device, to limit memory and network
 * use. Each decoded bitmap is ~360KB (250×360×4 RGBA) against a 100MB cache, so an
 * uncapped cloud-only library thrashes the cache in an evict/re-decode loop.
 *
 * It applies to that case ONLY. A series with volumes on this device is stacked by the
 * local rules, all of it, cloud-only volumes included — user decision, 2026-08-23: a
 * partly-downloaded series that silently drew 25 of its 42 volumes was worse than the
 * memory it saved. That is bounded in practice rather than by a number here:
 *
 * - the card's canvas only loads while it is on screen (CompositeCanvas' own
 *   IntersectionObserver), so the bitmaps in play are the visible cards' stacks;
 * - the thumbnail cache is 100MB with LRU eviction, and a realistic long series (~213
 *   volumes ≈ 77MB) fits inside it;
 * - the cover fetch follows the same selection rule, so nothing is downloaded for a
 *   volume the stack is not drawing.
 */
export const MAX_CLOUD_STACK = 25;

/**
 * Contain-fit a thumbnail into the base box. NEVER upscales (`min(…, 1)`): a thumbnail
 * smaller than the box is drawn at its natural size, which is why small spine images render
 * short on the card and must render just as short in the editor.
 */
export function getRenderedDimensions(
  naturalWidth: number,
  naturalHeight: number,
  baseWidth: number = CARD_BASE_WIDTH,
  baseHeight: number = CARD_BASE_HEIGHT
): Dimensions {
  const scaleW = baseWidth / naturalWidth;
  const scaleH = baseHeight / naturalHeight;
  const scale = Math.min(scaleW, scaleH, 1);
  return {
    width: naturalWidth * scale,
    height: naturalHeight * scale
  };
}

export interface UniformHeightInput {
  /** Contain-source dimensions per stacked volume; `undefined` where there is no thumbnail. */
  dims: (Dimensions | undefined)[];
  /** `catalogSettings.verticalStep`, in percent. */
  verticalStepPct: number;
  /** `catalogSettings.stackCount`; 0 means "all volumes" (spine mode). */
  stackCountSetting: number;
  baseWidth?: number;
  baseHeight?: number;
}

/**
 * The single height every volume in the stack is drawn at, or `null` when the stack is in
 * its normal (per-volume contain) mode.
 *
 * Uniform mode is on when the vertical step is 0 or the stack shows all volumes — i.e.
 * spine mode, where the covers line up along one shelf. The height is the AVERAGE of the
 * contain-fitted heights, so a stack of short spine scans stays short instead of being
 * stretched to the 360px box.
 */
export function computeUniformHeight({
  dims,
  verticalStepPct,
  stackCountSetting,
  baseWidth = CARD_BASE_WIDTH,
  baseHeight = CARD_BASE_HEIGHT
}: UniformHeightInput): number | null {
  const hasDims = dims.some((d) => !!d);
  if ((verticalStepPct !== 0 && stackCountSetting !== 0) || !hasDims) return null;

  let totalHeight = 0;
  let count = 0;
  for (const d of dims) {
    if (!d) continue;
    totalHeight += getRenderedDimensions(d.width, d.height, baseWidth, baseHeight).height;
    count++;
  }

  return count > 0 ? totalHeight / count : baseHeight;
}

/**
 * How big one volume is drawn: the uniform height with a width from its aspect ratio
 * (capped at one base width), or a plain contain fit outside uniform mode. `null` when the
 * volume has no thumbnail dimensions yet — the caller draws nothing for it.
 */
export function getSpineCanvasDimensions(
  dims: Dimensions | undefined,
  uniformHeight: number | null,
  baseWidth: number = CARD_BASE_WIDTH,
  baseHeight: number = CARD_BASE_HEIGHT
): Dimensions | null {
  if (!dims) return null;

  if (uniformHeight !== null) {
    const aspectRatio = dims.width / dims.height;
    return { width: Math.min(uniformHeight * aspectRatio, baseWidth), height: uniformHeight };
  }
  return getRenderedDimensions(dims.width, dims.height, baseWidth, baseHeight);
}

export interface StepSizesInput {
  /** `catalogSettings.stackCount`; 0 means "all volumes" (spine mode → no vertical step). */
  stackCountSetting: number;
  /** `catalogSettings.horizontalStep`, in percent of the base width. */
  horizontalStepPct: number;
  /** `catalogSettings.verticalStep`, in percent of the base height. */
  verticalStepPct: number;
  /** The series' own stored spine offset, in percent — added to the horizontal step. */
  hOffsetAdjust: number;
  centerHorizontal: boolean;
  centerVertical: boolean;
  /** How many volumes are actually in the stack. */
  actualCount: number;
  /** Container the stack is laid out in (see `CatalogItem.containerDimensions`). */
  innerWidth: number;
  innerHeight: number;
  /** From `computeUniformHeight`. */
  uniformHeight: number | null;
  /** Per-volume dimensions, used for the tallest volume outside uniform mode. */
  dims: (Dimensions | undefined)[];
  /**
   * Slots the container was sized for. Defaults to the stack count (or `actualCount` in
   * spine mode); the card's cloud placeholders pass their own capped count.
   */
  effectiveStackCount?: number;
  baseWidth?: number;
  baseHeight?: number;
}

export interface StepSizes {
  /** Distance between consecutive volumes, in px. */
  horizontal: number;
  vertical: number;
  /** Inset of the whole stack when it is narrower than the container it was sized for. */
  leftOffset: number;
  topOffset: number;
}

/**
 * Step between consecutive volumes plus the centering/spreading insets.
 *
 * Two shapes of "the stack is smaller than its container": horizontally, a stack with fewer
 * volumes than `stackCount` is either centred (keep the step, inset it) or spread (grow the
 * step to fill); vertically the same choice applies against the tallest rendered volume.
 */
export function computeStepSizes({
  stackCountSetting,
  horizontalStepPct,
  verticalStepPct,
  hOffsetAdjust,
  centerHorizontal,
  centerVertical,
  actualCount,
  innerWidth,
  innerHeight,
  uniformHeight,
  dims,
  effectiveStackCount,
  baseWidth = CARD_BASE_WIDTH,
  baseHeight = CARD_BASE_HEIGHT
}: StepSizesInput): StepSizes {
  const hOffsetPercent = (horizontalStepPct + hOffsetAdjust) / 100;
  // Spine mode (stack count 0 / all volumes) is a single shelf: no vertical step.
  const vOffsetPercent = stackCountSetting === 0 ? 0 : verticalStepPct / 100;

  let horizontalStep = baseWidth * hOffsetPercent;
  let verticalStep = baseHeight * vOffsetPercent;

  const slots = effectiveStackCount ?? (stackCountSetting === 0 ? actualCount : stackCountSetting);

  // Horizontal: centre the short stack, or spread it to fill the width it was sized for.
  let leftOffset = 0;
  if (actualCount < slots && actualCount > 1) {
    if (centerHorizontal) {
      const actualStackWidth = baseWidth + horizontalStep * (actualCount - 1);
      leftOffset = (innerWidth - actualStackWidth) / 2;
    } else {
      horizontalStep = (innerWidth - baseWidth) / (actualCount - 1);
    }
  }

  // Tallest volume actually drawn (uniform mode already answers this).
  let maxRenderedHeight = uniformHeight ?? baseHeight;
  if (uniformHeight === null && dims.some((d) => !!d)) {
    // Start at 0 to find the real max rather than clamping up to the base height.
    let actualMaxHeight = 0;
    for (const d of dims) {
      if (!d) continue;
      const rendered = getRenderedDimensions(d.width, d.height, baseWidth, baseHeight);
      actualMaxHeight = Math.max(actualMaxHeight, rendered.height);
    }
    if (actualMaxHeight > 0) maxRenderedHeight = actualMaxHeight;
  }

  // Vertical: same choice, against the leftover space under the tallest volume.
  let topOffset = 0;
  const actualStackHeight = maxRenderedHeight + verticalStep * (actualCount - 1);
  const extraVerticalSpace = innerHeight - actualStackHeight;

  if (actualCount > 0 && extraVerticalSpace > 0) {
    // Spreading needs 2+ volumes and a non-zero vertical step to spread.
    const canSpread = !centerVertical && vOffsetPercent > 0 && actualCount > 1;
    if (canSpread) {
      verticalStep = (innerHeight - maxRenderedHeight) / (actualCount - 1);
    } else {
      topOffset = extraVerticalSpace / 2;
    }
  }

  return {
    horizontal: horizontalStep,
    vertical: verticalStep,
    leftOffset,
    topOffset
  };
}

export interface CardStackSelectionInput<T> {
  /** Volumes present on this device. */
  localVolumes: T[];
  /**
   * The volumes of the series that are NOT finished — of BOTH kinds. "Hide read" is a rule
   * about volumes, not about where their pages live, so a caller must count the cloud-only
   * ones here too: a finished placeholder (progress synced against its adopted uuid) hides
   * exactly like a finished local volume.
   */
  unreadVolumes: T[];
  /**
   * Cloud-only volumes: the whole stack when nothing is local, and the rest of the series
   * when only part of it is here.
   */
  placeholders: T[];
  /**
   * Natural volume order, for merging the two halves of a partly-downloaded series. Without
   * it the cloud-only volumes simply follow the local ones.
   */
  compare?: (a: T, b: T) => number;
  /** `catalogSettings.hideReadVolumes`. */
  hideRead: boolean;
  /** `catalogSettings.stackCount`; 0 means "all volumes". */
  stackCount: number;
  /** `catalogSettings.compactCloudSeries` — a cloud-only series draws a single cover. */
  compactCloud: boolean;
  maxCloudStack?: number;
}

/**
 * Which volumes the card actually stacks. Local volumes win outright; a cloud-only series
 * falls back to placeholders, capped so a huge series cannot thrash the thumbnail cache.
 *
 * "Hide read" applies on BOTH paths — it is a rule about volumes, not about where their
 * pages live — and only while something is still unread: a finished series keeps showing
 * its covers rather than emptying the card.
 */
/**
 * The two halves of a partly-downloaded series, back in volume order. Sorting the merged
 * list keeps volume 3 between 2 and 4 whether or not it is the one that is missing;
 * without a comparator the absent tail simply follows what is here.
 */
function mergeInVolumeOrder<T>(local: T[], cloud: T[], compare?: (a: T, b: T) => number): T[] {
  const merged = [...local, ...cloud];
  return compare ? merged.sort(compare) : merged;
}

export function selectCardStackVolumes<T>({
  localVolumes,
  unreadVolumes,
  placeholders,
  hideRead,
  stackCount,
  compactCloud,
  compare,
  maxCloudStack = MAX_CLOUD_STACK
}: CardStackSelectionInput<T>): T[] {
  if (localVolumes.length > 0) {
    // A series can be only PARTLY here. Its cloud-only volumes are part of it and belong
    // on the shelf — marked as not-on-device, never dropped.
    //
    // The cloud rules below (the thumbnail-cache cap, the compact collapse) do NOT apply
    // to them: those exist for a series that is ENTIRELY absent, where the whole stack
    // would otherwise be fetched from the cloud. A series with volumes on this device is
    // stacked by the local rules, all of it — "hide read" included, over the whole series
    // rather than half of it.
    const everything = mergeInVolumeOrder(localVolumes, placeholders, compare);
    const stack =
      hideRead && unreadVolumes.length > 0
        ? mergeInVolumeOrder(unreadVolumes, [], compare)
        : everything;
    return stackCount === 0 ? stack : stack.slice(0, stackCount);
  }

  // NOTHING IS HERE — the cloud path. "Hide read" applies just the same: it is a setting
  // about volumes, not about where their pages live. It used to live inside the local
  // branch alone, so a cloud-only or fully-removed series stacked its finished volumes
  // whatever the setting said (and, before `isSeriesFinished`, none of them could even be
  // counted as finished).
  //
  // The unread set is INTERSECTED with the placeholders rather than stacked directly the
  // way the local branch does, so the cap below still measures the cloud half and only the
  // cloud half — and so a caller that hands over the whole series' unread volumes (which
  // is what the type asks for) cannot smuggle a local one into a cloud stack.
  //
  // The empty-card guard checks the FILTERED result, not the input `unreadVolumes` set: a
  // caller whose unread set is disjoint from `placeholders` (nothing in the intersection)
  // must still fall back to every placeholder rather than render a blank card. Guarding on
  // `unread.size > 0` alone would filter to `[]` in that case and show nothing.
  const unread = new Set(unreadVolumes);
  const filtered = placeholders.filter((vol) => unread.has(vol));
  const visible = hideRead && filtered.length > 0 ? filtered : placeholders;

  if (compactCloud) return visible.slice(0, 1);
  const limit = stackCount === 0 ? maxCloudStack : Math.min(stackCount, maxCloudStack);
  return visible.slice(0, limit);
}
