import { describe, expect, it } from 'vitest';
import {
  CARD_BASE_HEIGHT,
  CARD_BASE_WIDTH,
  MAX_CLOUD_STACK,
  computeStepSizes,
  computeUniformHeight,
  getRenderedDimensions,
  getSpineCanvasDimensions,
  selectCardStackVolumes,
  type Dimensions
} from './spine-stack-geometry';

/**
 * ORACLE — `CatalogItem.svelte`'s inline math as it stood BEFORE the extraction, copied
 * verbatim (only the reactive plumbing turned into arguments). The extraction is correct
 * only if the module agrees with this for every stack the card can produce, so every
 * fixture below is checked against it as well as against its expected numbers.
 */
const BASE_WIDTH = 250;
const BASE_HEIGHT = 360;
const LEGACY_MAX_CLOUD_STACK = 25;

interface LegacyVolume {
  volume_uuid: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
  thumbnail?: unknown;
}

interface LegacySettings {
  stackCount: number;
  horizontalStep: number;
  verticalStep: number;
  centerHorizontal: boolean;
  centerVertical: boolean;
  hideReadVolumes: boolean;
  compactCloudSeries: boolean;
}

function legacyThumbnailDimensions(stackedVolumes: LegacyVolume[]) {
  const dims = new Map<string, { width: number; height: number }>();
  for (const vol of stackedVolumes) {
    if (vol.thumbnail_width && vol.thumbnail_height) {
      dims.set(vol.volume_uuid, { width: vol.thumbnail_width, height: vol.thumbnail_height });
    } else if (vol.thumbnail) {
      dims.set(vol.volume_uuid, { width: BASE_WIDTH, height: BASE_HEIGHT });
    }
  }
  return dims;
}

function legacyGetRenderedDimensions(naturalWidth: number, naturalHeight: number) {
  const scaleW = BASE_WIDTH / naturalWidth;
  const scaleH = BASE_HEIGHT / naturalHeight;
  const scale = Math.min(scaleW, scaleH, 1);
  return { width: naturalWidth * scale, height: naturalHeight * scale };
}

function legacyUniformHeight(
  stackedVolumes: LegacyVolume[],
  thumbnailDimensions: Map<string, { width: number; height: number }>,
  settings: LegacySettings
): number | null {
  const vOffsetPercent = settings.verticalStep;
  const stackCountSetting = settings.stackCount;
  if ((vOffsetPercent !== 0 && stackCountSetting !== 0) || thumbnailDimensions.size === 0)
    return null;

  let totalHeight = 0;
  let count = 0;
  for (const vol of stackedVolumes) {
    const dims = thumbnailDimensions.get(vol.volume_uuid);
    if (dims) {
      const rendered = legacyGetRenderedDimensions(dims.width, dims.height);
      totalHeight += rendered.height;
      count++;
    }
  }
  return count > 0 ? totalHeight / count : BASE_HEIGHT;
}

function legacyGetCanvasDimensions(
  volumeUuid: string,
  thumbnailDimensions: Map<string, { width: number; height: number }>,
  uniformHeight: number | null
): { width: number; height: number } | null {
  const dims = thumbnailDimensions.get(volumeUuid);
  if (!dims) return null;

  if (uniformHeight !== null) {
    const aspectRatio = dims.width / dims.height;
    const width = Math.min(uniformHeight * aspectRatio, BASE_WIDTH);
    return { width, height: uniformHeight };
  }
  return legacyGetRenderedDimensions(dims.width, dims.height);
}

function legacyStepSizes(
  stackedVolumes: LegacyVolume[],
  thumbnailDimensions: Map<string, { width: number; height: number }>,
  uniformHeight: number | null,
  settings: LegacySettings,
  hOffsetAdjust: number,
  containerDimensions: { innerWidth: number; innerHeight: number }
) {
  const stackCountSetting = settings.stackCount;
  const hOffsetPercent = (settings.horizontalStep + hOffsetAdjust) / 100;
  const vOffsetPercent = stackCountSetting === 0 ? 0 : settings.verticalStep / 100;
  const centerHorizontal = settings.centerHorizontal;
  const centerVertical = settings.centerVertical;

  let horizontalStep = BASE_WIDTH * hOffsetPercent;
  let verticalStep = BASE_HEIGHT * vOffsetPercent;

  const actualCount = stackedVolumes.length;
  const effectiveStackCount = stackCountSetting === 0 ? actualCount : stackCountSetting;
  const { innerWidth, innerHeight } = containerDimensions;

  let leftOffset = 0;
  if (actualCount < effectiveStackCount && actualCount > 1) {
    if (centerHorizontal) {
      const actualStackWidth = BASE_WIDTH + horizontalStep * (actualCount - 1);
      leftOffset = (innerWidth - actualStackWidth) / 2;
    } else {
      horizontalStep = (innerWidth - BASE_WIDTH) / (actualCount - 1);
    }
  }

  let maxRenderedHeight = uniformHeight ?? BASE_HEIGHT;
  if (uniformHeight === null && thumbnailDimensions.size > 0) {
    let actualMaxHeight = 0;
    for (const vol of stackedVolumes) {
      const dims = thumbnailDimensions.get(vol.volume_uuid);
      if (dims) {
        const rendered = legacyGetRenderedDimensions(dims.width, dims.height);
        actualMaxHeight = Math.max(actualMaxHeight, rendered.height);
      }
    }
    if (actualMaxHeight > 0) {
      maxRenderedHeight = actualMaxHeight;
    }
  }

  let topOffset = 0;
  const actualStackHeight = maxRenderedHeight + verticalStep * (actualCount - 1);
  const extraVerticalSpace = innerHeight - actualStackHeight;

  if (actualCount > 0 && extraVerticalSpace > 0) {
    const canSpread = !centerVertical && vOffsetPercent > 0 && actualCount > 1;
    if (canSpread) {
      verticalStep = (innerHeight - maxRenderedHeight) / (actualCount - 1);
    } else {
      topOffset = extraVerticalSpace / 2;
    }
  }

  return { horizontal: horizontalStep, vertical: verticalStep, leftOffset, topOffset };
}

function legacyPlaceholderStepSizes(
  seriesVolumes: LegacyVolume[],
  settings: LegacySettings,
  hOffsetAdjust: number,
  containerDimensions: { innerWidth: number; innerHeight: number },
  isPlaceholderOnly: boolean
) {
  const stackCountSetting = settings.stackCount;
  const hOffsetPercent = (settings.horizontalStep + hOffsetAdjust) / 100;
  const vOffsetPercent = stackCountSetting === 0 ? 0 : settings.verticalStep / 100;
  const centerHorizontal = settings.centerHorizontal;
  const centerVertical = settings.centerVertical;

  let horizontalStep = BASE_WIDTH * hOffsetPercent;
  let verticalStep = BASE_HEIGHT * vOffsetPercent;

  const maxCount = isPlaceholderOnly
    ? stackCountSetting === 0
      ? LEGACY_MAX_CLOUD_STACK
      : Math.min(stackCountSetting, LEGACY_MAX_CLOUD_STACK)
    : stackCountSetting;
  const actualCount = Math.min(seriesVolumes.length, maxCount);
  const effectiveStackCount = maxCount;
  const { innerWidth, innerHeight } = containerDimensions;

  let leftOffset = 0;
  if (actualCount < effectiveStackCount && actualCount > 1) {
    if (centerHorizontal) {
      const actualStackWidth = BASE_WIDTH + horizontalStep * (actualCount - 1);
      leftOffset = (innerWidth - actualStackWidth) / 2;
    } else {
      horizontalStep = (innerWidth - BASE_WIDTH) / (actualCount - 1);
    }
  }

  const maxRenderedHeight = BASE_HEIGHT;
  let topOffset = 0;
  const actualStackHeight = maxRenderedHeight + verticalStep * (actualCount - 1);
  const extraVerticalSpace = innerHeight - actualStackHeight;

  if (actualCount > 0 && extraVerticalSpace > 0) {
    const canSpread = !centerVertical && vOffsetPercent > 0 && actualCount > 1;
    if (canSpread) {
      verticalStep = (innerHeight - maxRenderedHeight) / (actualCount - 1);
    } else {
      topOffset = extraVerticalSpace / 2;
    }
  }

  return {
    count: actualCount,
    horizontal: horizontalStep,
    vertical: verticalStep,
    leftOffset,
    topOffset
  };
}

function legacyStackedVolumes(
  seriesVolumes: LegacyVolume[],
  localVolumes: LegacyVolume[],
  unreadVolumes: LegacyVolume[],
  settings: LegacySettings
): LegacyVolume[] {
  const hideRead = settings.hideReadVolumes;
  const stackCount = settings.stackCount;
  const hasLocalVolumes = localVolumes.length > 0;
  const useCompactForCloud = !hasLocalVolumes && settings.compactCloudSeries;

  if (hasLocalVolumes) {
    const sourceVolumes = hideRead && unreadVolumes.length > 0 ? unreadVolumes : localVolumes;
    return stackCount === 0 ? sourceVolumes : sourceVolumes.slice(0, stackCount);
  }

  if (useCompactForCloud) return seriesVolumes.slice(0, 1);
  const limit =
    stackCount === 0 ? LEGACY_MAX_CLOUD_STACK : Math.min(stackCount, LEGACY_MAX_CLOUD_STACK);
  return seriesVolumes.slice(0, limit);
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────
// A real shelf: volume 1 is the full cover the scanner shot flat, the rest are narrow
// spines, and several are SMALLER than the 250×360 box (the case the card refuses to
// upscale — the reason the editor used to render bigger than the card).
const WIDE_COVER: Dimensions = { width: 500, height: 720 }; // 2× the box, contains to 250×360
const SMALL_COVER: Dimensions = { width: 180, height: 260 }; // under the box: natural size
const NARROW_SPINE: Dimensions = { width: 40, height: 300 };
const TINY_SPINE: Dimensions = { width: 24, height: 180 };
const SQUARE: Dimensions = { width: 400, height: 400 };

const FIXTURE_SETS: Dimensions[][] = [
  [WIDE_COVER, NARROW_SPINE, NARROW_SPINE, NARROW_SPINE],
  [SMALL_COVER, TINY_SPINE, TINY_SPINE],
  [NARROW_SPINE, NARROW_SPINE],
  [WIDE_COVER, SQUARE, SMALL_COVER, TINY_SPINE, NARROW_SPINE],
  [SMALL_COVER],
  [SQUARE, SQUARE]
];

function volumesFor(dims: Dimensions[]): LegacyVolume[] {
  return dims.map((d, i) => ({
    volume_uuid: `uuid-${i}`,
    thumbnail_width: d.width,
    thumbnail_height: d.height
  }));
}

function settingsFor(overrides: Partial<LegacySettings> = {}): LegacySettings {
  return {
    stackCount: 3,
    horizontalStep: 11,
    verticalStep: 5,
    centerHorizontal: true,
    centerVertical: false,
    hideReadVolumes: true,
    compactCloudSeries: false,
    ...overrides
  };
}

describe('getRenderedDimensions', () => {
  it('contains a thumbnail bigger than the box', () => {
    expect(getRenderedDimensions(500, 720)).toEqual({ width: 250, height: 360 });
  });

  it('never upscales a thumbnail smaller than the box', () => {
    expect(getRenderedDimensions(180, 260)).toEqual({ width: 180, height: 260 });
    expect(getRenderedDimensions(24, 180)).toEqual({ width: 24, height: 180 });
  });

  it('fits by whichever axis binds first', () => {
    // Wider than tall: width binds.
    expect(getRenderedDimensions(1000, 500)).toEqual({ width: 250, height: 125 });
    // Taller than wide: height binds.
    expect(getRenderedDimensions(400, 1440)).toEqual({ width: 100, height: 360 });
  });

  it('matches the card’s inline fit for every fixture', () => {
    for (const set of FIXTURE_SETS) {
      for (const d of set) {
        expect(getRenderedDimensions(d.width, d.height)).toEqual(
          legacyGetRenderedDimensions(d.width, d.height)
        );
      }
    }
  });
});

describe('computeUniformHeight', () => {
  it('averages the contain-fitted heights in spine mode', () => {
    // 500×720 → 360; 40×300 → 300 (natural, no upscale). Average of 360, 300, 300 = 320.
    const height = computeUniformHeight({
      dims: [WIDE_COVER, NARROW_SPINE, NARROW_SPINE],
      verticalStepPct: 5,
      stackCountSetting: 0
    });
    expect(height).toBeCloseTo(320, 10);
  });

  it('stays below the box when every thumbnail is smaller than it', () => {
    const height = computeUniformHeight({
      dims: [SMALL_COVER, TINY_SPINE, TINY_SPINE],
      verticalStepPct: 5,
      stackCountSetting: 0
    });
    // (260 + 180 + 180) / 3 — NOT stretched to 360.
    expect(height).toBeCloseTo(206.666666, 4);
    expect(height!).toBeLessThan(CARD_BASE_HEIGHT);
  });

  it('is null outside uniform mode (vertical step and a fixed stack count)', () => {
    expect(
      computeUniformHeight({ dims: [WIDE_COVER], verticalStepPct: 5, stackCountSetting: 3 })
    ).toBeNull();
  });

  it('is on when the vertical step is 0 even with a fixed stack count', () => {
    expect(
      computeUniformHeight({ dims: [WIDE_COVER], verticalStepPct: 0, stackCountSetting: 3 })
    ).toBe(360);
  });

  it('is null when nothing has thumbnail dimensions yet', () => {
    expect(
      computeUniformHeight({
        dims: [undefined, undefined],
        verticalStepPct: 0,
        stackCountSetting: 0
      })
    ).toBeNull();
  });

  it('ignores volumes still missing their dimensions', () => {
    expect(
      computeUniformHeight({
        dims: [WIDE_COVER, undefined, NARROW_SPINE],
        verticalStepPct: 0,
        stackCountSetting: 0
      })
    ).toBeCloseTo(330, 10);
  });

  it('matches the card’s inline uniform height across the fixture matrix', () => {
    for (const set of FIXTURE_SETS) {
      for (const stackCount of [0, 1, 3]) {
        for (const verticalStep of [0, 5]) {
          const settings = settingsFor({ stackCount, verticalStep });
          const volumes = volumesFor(set);
          const map = legacyThumbnailDimensions(volumes);
          expect(
            computeUniformHeight({
              dims: set,
              verticalStepPct: verticalStep,
              stackCountSetting: stackCount
            })
          ).toEqual(legacyUniformHeight(volumes, map, settings));
        }
      }
    }
  });
});

describe('getSpineCanvasDimensions', () => {
  it('gives each volume its own aspect width at the shared height', () => {
    const uniformHeight = 320;
    expect(getSpineCanvasDimensions(NARROW_SPINE, uniformHeight)).toEqual({
      width: (320 * 40) / 300,
      height: 320
    });
    // A wide cover would exceed the box: capped at one base width.
    expect(getSpineCanvasDimensions({ width: 800, height: 400 }, uniformHeight)).toEqual({
      width: CARD_BASE_WIDTH,
      height: 320
    });
  });

  it('falls back to a contain fit outside uniform mode', () => {
    expect(getSpineCanvasDimensions(WIDE_COVER, null)).toEqual({ width: 250, height: 360 });
    expect(getSpineCanvasDimensions(SMALL_COVER, null)).toEqual({ width: 180, height: 260 });
  });

  it('is null for a volume without dimensions', () => {
    expect(getSpineCanvasDimensions(undefined, 320)).toBeNull();
    expect(getSpineCanvasDimensions(undefined, null)).toBeNull();
  });

  it('matches the card’s inline canvas dimensions across the fixture matrix', () => {
    for (const set of FIXTURE_SETS) {
      const volumes = volumesFor(set);
      const map = legacyThumbnailDimensions(volumes);
      for (const stackCount of [0, 3]) {
        for (const verticalStep of [0, 5]) {
          const settings = settingsFor({ stackCount, verticalStep });
          const uniformHeight = legacyUniformHeight(volumes, map, settings);
          expect(
            computeUniformHeight({
              dims: set,
              verticalStepPct: verticalStep,
              stackCountSetting: stackCount
            })
          ).toEqual(uniformHeight);
          for (const vol of volumes) {
            expect(getSpineCanvasDimensions(map.get(vol.volume_uuid), uniformHeight)).toEqual(
              legacyGetCanvasDimensions(vol.volume_uuid, map, uniformHeight)
            );
          }
        }
      }
    }
  });
});

describe('computeStepSizes', () => {
  it('steps by the horizontal percentage of the base width, plus the series offset', () => {
    const steps = computeStepSizes({
      stackCountSetting: 0,
      horizontalStepPct: 11,
      verticalStepPct: 5,
      hOffsetAdjust: 0,
      centerHorizontal: true,
      centerVertical: false,
      actualCount: 4,
      innerWidth: 400,
      innerHeight: 320,
      uniformHeight: 320,
      dims: [WIDE_COVER, NARROW_SPINE, NARROW_SPINE, NARROW_SPINE]
    });
    expect(steps.horizontal).toBeCloseTo(27.5, 10);
    // Spine mode: one shelf, no vertical step and no inset.
    expect(steps).toMatchObject({ vertical: 0, leftOffset: 0, topOffset: 0 });
  });

  it('adds the series offset to the step', () => {
    const steps = computeStepSizes({
      stackCountSetting: 0,
      horizontalStepPct: 11,
      verticalStepPct: 0,
      hOffsetAdjust: -3,
      centerHorizontal: true,
      centerVertical: false,
      actualCount: 3,
      innerWidth: 400,
      innerHeight: 320,
      uniformHeight: 320,
      dims: [NARROW_SPINE, NARROW_SPINE, NARROW_SPINE]
    });
    expect(steps.horizontal).toBeCloseTo(20, 10); // 250 × (11 - 3) / 100
  });

  it('centres a stack shorter than the configured stack count', () => {
    const steps = computeStepSizes({
      stackCountSetting: 3,
      horizontalStepPct: 11,
      verticalStepPct: 5,
      hOffsetAdjust: 0,
      centerHorizontal: true,
      centerVertical: false,
      actualCount: 2,
      innerWidth: 305,
      innerHeight: 396,
      uniformHeight: null,
      dims: [WIDE_COVER, WIDE_COVER]
    });
    // Stack is 250 + 27.5 wide inside 305 → inset by half the slack.
    expect(steps.leftOffset).toBeCloseTo((305 - 277.5) / 2, 10);
  });

  it('spreads instead of centring when centring is off', () => {
    const steps = computeStepSizes({
      stackCountSetting: 3,
      horizontalStepPct: 11,
      verticalStepPct: 5,
      hOffsetAdjust: 0,
      centerHorizontal: false,
      centerVertical: false,
      actualCount: 2,
      innerWidth: 305,
      innerHeight: 396,
      uniformHeight: null,
      dims: [WIDE_COVER, WIDE_COVER]
    });
    expect(steps.leftOffset).toBe(0);
    expect(steps.horizontal).toBeCloseTo(55, 10); // (305 - 250) / (2 - 1)
  });

  it('honours an explicit slot count (the card’s capped cloud placeholders)', () => {
    const steps = computeStepSizes({
      stackCountSetting: 0,
      horizontalStepPct: 11,
      verticalStepPct: 5,
      hOffsetAdjust: 0,
      centerHorizontal: true,
      centerVertical: false,
      actualCount: 4,
      effectiveStackCount: 25,
      innerWidth: 910,
      innerHeight: 360,
      uniformHeight: CARD_BASE_HEIGHT,
      dims: []
    });
    // 4 of 25 slots: centred rather than left-aligned.
    expect(steps.leftOffset).toBeCloseTo((910 - (250 + 27.5 * 3)) / 2, 10);
  });

  it('matches the card’s inline step sizes across the fixture matrix', () => {
    for (const set of FIXTURE_SETS) {
      const volumes = volumesFor(set);
      const map = legacyThumbnailDimensions(volumes);
      for (const stackCount of [0, 3, 8]) {
        for (const verticalStep of [0, 5]) {
          for (const centerHorizontal of [true, false]) {
            for (const centerVertical of [true, false]) {
              for (const hOffsetAdjust of [0, 2.5, -4]) {
                const settings = settingsFor({
                  stackCount,
                  verticalStep,
                  centerHorizontal,
                  centerVertical
                });
                const uniformHeight = legacyUniformHeight(volumes, map, settings);
                // Whatever the card's container came out as; the rule only reads it back.
                const container = { innerWidth: 420, innerHeight: 396 };
                expect(
                  computeStepSizes({
                    stackCountSetting: stackCount,
                    horizontalStepPct: settings.horizontalStep,
                    verticalStepPct: verticalStep,
                    hOffsetAdjust,
                    centerHorizontal,
                    centerVertical,
                    actualCount: volumes.length,
                    innerWidth: container.innerWidth,
                    innerHeight: container.innerHeight,
                    uniformHeight,
                    dims: set
                  })
                ).toEqual(
                  legacyStepSizes(volumes, map, uniformHeight, settings, hOffsetAdjust, container)
                );
              }
            }
          }
        }
      }
    }
  });

  it('matches the card’s inline PLACEHOLDER step sizes across the fixture matrix', () => {
    // Placeholders are drawn as uniform base-size boxes, over a capped slot count.
    for (const count of [1, 2, 4, 30]) {
      const volumes = volumesFor(Array.from({ length: count }, () => WIDE_COVER));
      for (const stackCount of [0, 3, 8]) {
        for (const verticalStep of [0, 5]) {
          for (const centerHorizontal of [true, false]) {
            for (const centerVertical of [true, false]) {
              const settings = settingsFor({
                stackCount,
                verticalStep,
                centerHorizontal,
                centerVertical
              });
              const container = { innerWidth: 420, innerHeight: 396 };
              const maxCount =
                stackCount === 0 ? MAX_CLOUD_STACK : Math.min(stackCount, MAX_CLOUD_STACK);
              const actualCount = Math.min(volumes.length, maxCount);
              const expected = legacyPlaceholderStepSizes(volumes, settings, 0, container, true);
              expect({
                count: actualCount,
                ...computeStepSizes({
                  stackCountSetting: stackCount,
                  horizontalStepPct: settings.horizontalStep,
                  verticalStepPct: verticalStep,
                  hOffsetAdjust: 0,
                  centerHorizontal,
                  centerVertical,
                  actualCount,
                  effectiveStackCount: maxCount,
                  innerWidth: container.innerWidth,
                  innerHeight: container.innerHeight,
                  uniformHeight: CARD_BASE_HEIGHT,
                  dims: []
                })
              }).toEqual(expected);
            }
          }
        }
      }
    }
  });
});

describe('selectCardStackVolumes', () => {
  const local = ['a', 'b', 'c', 'd'];
  const unread = ['c', 'd'];
  const placeholders = Array.from({ length: 40 }, (_, i) => `cloud-${i}`);

  it('shows the unread volumes when "hide read" is on', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: local,
        unreadVolumes: unread,
        placeholders: [],
        hideRead: true,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(unread);
  });

  it('falls back to every local volume for a finished series', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: local,
        unreadVolumes: [],
        placeholders: [],
        hideRead: true,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(local);
  });

  it('ignores "hide read" when it is off', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: local,
        unreadVolumes: unread,
        placeholders: [],
        hideRead: false,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(local);
  });

  it('slices to the stack count when it is not "all volumes"', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: local,
        unreadVolumes: [],
        placeholders: [],
        hideRead: false,
        stackCount: 3,
        compactCloud: false
      })
    ).toEqual(['a', 'b', 'c']);
  });

  it('caps a cloud-only series at the thumbnail-cache limit', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: [],
        unreadVolumes: [],
        placeholders,
        hideRead: true,
        stackCount: 0,
        compactCloud: false
      })
    ).toHaveLength(MAX_CLOUD_STACK);
  });

  it('hides the finished volumes of a CLOUD-ONLY series', () => {
    // "Hide read" used to live inside the local branch alone, so a series with nothing on
    // the device stacked its finished volumes whatever the setting said.
    expect(
      selectCardStackVolumes({
        localVolumes: [],
        unreadVolumes: ['cloud-1', 'cloud-3'],
        placeholders: ['cloud-0', 'cloud-1', 'cloud-2', 'cloud-3'],
        hideRead: true,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(['cloud-1', 'cloud-3']);
  });

  it('shows every cloud volume again once the setting is off', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: [],
        unreadVolumes: ['cloud-1', 'cloud-3'],
        placeholders: ['cloud-0', 'cloud-1', 'cloud-2', 'cloud-3'],
        hideRead: false,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(['cloud-0', 'cloud-1', 'cloud-2', 'cloud-3']);
  });

  it('keeps showing a FINISHED cloud series rather than emptying its card', () => {
    // Same rule the local branch has always had: hide-read empties nothing.
    expect(
      selectCardStackVolumes({
        localVolumes: [],
        unreadVolumes: [],
        placeholders: ['cloud-0', 'cloud-1'],
        hideRead: true,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(['cloud-0', 'cloud-1']);
  });

  it('caps the cloud stack AFTER hiding the read volumes, not before', () => {
    // The cap exists to bound how many covers get fetched. Applying it to the unfiltered
    // list would leave a long series showing fewer than `MAX_CLOUD_STACK` unread spines.
    const unread = placeholders.slice(30);
    expect(
      selectCardStackVolumes({
        localVolumes: [],
        unreadVolumes: unread,
        placeholders,
        hideRead: true,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(unread);
  });

  it('caps the FILTERED unread set, not the raw placeholder list, when it exceeds the limit', () => {
    // `placeholders` has 40 volumes; here 30 of them are unread — more than
    // `MAX_CLOUD_STACK` (25) on its own. If the cap were applied to the raw placeholder
    // list before filtering (`placeholders.slice(0, limit)` then intersected with the
    // unread set) this would show far fewer than `MAX_CLOUD_STACK` spines, because the
    // first 10 placeholders are already read.
    const unread = placeholders.slice(10);
    expect(
      selectCardStackVolumes({
        localVolumes: [],
        unreadVolumes: unread,
        placeholders,
        hideRead: true,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(unread.slice(0, MAX_CLOUD_STACK));
  });

  it('falls back to every placeholder when the unread set has no overlap with them', () => {
    // A caller can hand over an unread set disjoint from `placeholders` — e.g. one whose
    // overlap already lives among `localVolumes`, or one that clones volumes between the
    // two arguments. The empty-card guard has to check the FILTERED result, not just
    // whether `unreadVolumes` is non-empty, or this renders a blank card instead of
    // falling back to every placeholder.
    expect(
      selectCardStackVolumes({
        localVolumes: [],
        unreadVolumes: ['not-a-placeholder'],
        placeholders: ['cloud-0', 'cloud-1'],
        hideRead: true,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(['cloud-0', 'cloud-1']);
  });

  it('draws the first UNREAD cover for a compact cloud series', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: [],
        unreadVolumes: ['cloud-2', 'cloud-3'],
        placeholders,
        hideRead: true,
        stackCount: 0,
        compactCloud: true
      })
    ).toEqual(['cloud-2']);
  });

  it('draws a single cover for a compact cloud series', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: [],
        unreadVolumes: [],
        placeholders,
        hideRead: true,
        stackCount: 0,
        compactCloud: true
      })
    ).toEqual(['cloud-0']);
  });

  it('keeps the cloud-only volumes of a series that is only partly here', () => {
    // The regression this pins: a mixed series drew its local volumes and silently
    // dropped the ones it has not downloaded, on the card and in "all volumes" alike.
    expect(
      selectCardStackVolumes({
        localVolumes: ['a', 'b'],
        unreadVolumes: [],
        placeholders: ['cloud-0', 'cloud-1'],
        hideRead: true,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(['a', 'b', 'cloud-0', 'cloud-1']);
  });

  it('still hides the read volumes of a mixed series, and still shows the cloud ones', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: local,
        // The caller counts the unread volumes of the WHOLE series (see the type): the
        // cloud-only one has no progress, so it is one of them.
        unreadVolumes: [...unread, 'cloud-0'],
        placeholders: ['cloud-0'],
        hideRead: true,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual([...unread, 'cloud-0']);
  });

  it('counts the cloud volumes of a mixed series against the stack count', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: ['a', 'b'],
        unreadVolumes: [],
        placeholders: ['cloud-0', 'cloud-1'],
        hideRead: false,
        stackCount: 3,
        compactCloud: false
      })
    ).toEqual(['a', 'b', 'cloud-0']);
  });

  it('never applies the cloud cap to a series that has volumes here', () => {
    // The cap (and the compact collapse below it) exist for a series whose ENTIRE stack
    // would come from the cloud. A series with something on the device is stacked by the
    // local rules, all of it.
    const stacked = selectCardStackVolumes({
      localVolumes: ['a'],
      unreadVolumes: [],
      placeholders,
      hideRead: false,
      stackCount: 0,
      compactCloud: false
    });
    expect(stacked).toHaveLength(1 + placeholders.length);
    expect(stacked).toEqual(['a', ...placeholders]);
  });

  it('hides the finished volumes of a mixed series, whichever kind they are', () => {
    // "Hide read" is a rule about volumes, not about where their pages live: a finished
    // cloud-only volume (progress synced against its adopted uuid) hides exactly like a
    // finished local one.
    expect(
      selectCardStackVolumes({
        localVolumes: ['Vol 1', 'Vol 2'],
        unreadVolumes: ['Vol 2', 'Vol 4'],
        placeholders: ['Vol 3', 'Vol 4'],
        hideRead: true,
        stackCount: 0,
        compactCloud: false,
        compare: (a, b) => a.localeCompare(b, undefined, { numeric: true })
      })
    ).toEqual(['Vol 2', 'Vol 4']);
  });

  it('shows the whole mixed series once every volume is finished', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: ['Vol 1'],
        unreadVolumes: [],
        placeholders: ['Vol 2'],
        hideRead: true,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(['Vol 1', 'Vol 2']);
  });

  it('puts the missing volumes back where they belong when given the series order', () => {
    // Volume 2 is the one that is not here: it belongs between 1 and 3, not after them.
    expect(
      selectCardStackVolumes({
        localVolumes: ['Vol 1', 'Vol 3'],
        unreadVolumes: [],
        placeholders: ['Vol 2'],
        hideRead: false,
        stackCount: 0,
        compactCloud: false,
        compare: (a, b) => a.localeCompare(b, undefined, { numeric: true })
      })
    ).toEqual(['Vol 1', 'Vol 2', 'Vol 3']);
  });

  it('never collapses a series that has volumes here, whatever compact-cloud says', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: ['a', 'b'],
        unreadVolumes: [],
        placeholders: ['cloud-0', 'cloud-1'],
        hideRead: false,
        stackCount: 0,
        compactCloud: true
      })
    ).toEqual(['a', 'b', 'cloud-0', 'cloud-1']);
  });

  it('leaves an all-local series exactly as it was', () => {
    expect(
      selectCardStackVolumes({
        localVolumes: local,
        unreadVolumes: [],
        placeholders: [],
        hideRead: false,
        stackCount: 0,
        compactCloud: false
      })
    ).toEqual(local);
  });

  it('matches the card’s inline subset rule across the fixture matrix', () => {
    const localVols = volumesFor([WIDE_COVER, NARROW_SPINE, NARROW_SPINE, NARROW_SPINE]);
    const unreadVols = localVols.slice(2);
    const cloudVols = volumesFor(Array.from({ length: 40 }, () => WIDE_COVER));

    for (const hasLocal of [true, false]) {
      for (const allRead of [true, false]) {
        for (const stackCount of [0, 1, 3, 30]) {
          for (const hideReadVolumes of [true, false]) {
            for (const compactCloudSeries of [true, false]) {
              const settings = settingsFor({ stackCount, hideReadVolumes, compactCloudSeries });
              const localVolumes = hasLocal ? localVols : [];
              const unreadVolumes = hasLocal && !allRead ? unreadVols : [];
              const seriesVolumes = hasLocal ? localVols : cloudVols;
              expect(
                selectCardStackVolumes({
                  localVolumes,
                  unreadVolumes,
                  placeholders: hasLocal ? [] : cloudVols,
                  hideRead: hideReadVolumes,
                  stackCount,
                  compactCloud: !hasLocal && compactCloudSeries
                })
              ).toEqual(legacyStackedVolumes(seriesVolumes, localVolumes, unreadVolumes, settings));
            }
          }
        }
      }
    }
  });
});

describe('card base constants', () => {
  it('are the card’s 250×360 thumbnail box', () => {
    expect([CARD_BASE_WIDTH, CARD_BASE_HEIGHT]).toEqual([BASE_WIDTH, BASE_HEIGHT]);
    expect(MAX_CLOUD_STACK).toBe(LEGACY_MAX_CLOUD_STACK);
  });
});
