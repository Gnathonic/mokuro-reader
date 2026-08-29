import { describe, expect, it } from 'vitest';
import { computeStackLayout, hitTestStack, spineBadgePlacements } from './spine-stack-layout';

/**
 * The card's ORIGINAL inline math (CatalogItem.handleMouseMove, before the extraction),
 * kept verbatim as the oracle: the extraction is only correct if it agrees with this for
 * every input the card can produce.
 */
function legacyPositions(
  count: number,
  leftOffset: number,
  horizontal: number,
  offsets: Map<number, number>
): number[] {
  let cumOffset = 0;
  const positions: number[] = [];
  for (let i = 0; i < count; i++) {
    positions[i] = leftOffset + i * horizontal + cumOffset;
    cumOffset += offsets.get(i) ?? 0;
  }
  return positions;
}

function legacyHitTest(
  count: number,
  positions: number[],
  mouseX: number,
  baseWidth: number
): number {
  for (let i = 0; i < count; i++) {
    const left = positions[i];
    const right = left + baseWidth;
    if (mouseX >= left && mouseX <= right) return i;
  }
  return count - 1;
}

describe('computeStackLayout', () => {
  it('places each volume one horizontal step further right', () => {
    const { lefts, totalWidth } = computeStackLayout({
      count: 4,
      baseWidth: 250,
      horizontalStepPx: 27.5
    });
    expect(lefts).toEqual([0, 27.5, 55, 82.5]);
    expect(totalWidth).toBe(332.5);
  });

  it('cascades a per-volume offset onto every volume after it', () => {
    // +10 on volume 1 pushes 2 and 3; volume 1 itself keeps its stepped position.
    const { lefts, totalWidth } = computeStackLayout({
      count: 4,
      baseWidth: 250,
      horizontalStepPx: 20,
      volumeOffsetsByIndex: new Map([
        [1, 10],
        [2, -4]
      ])
    });
    expect(lefts).toEqual([0, 20, 50, 66]);
    expect(totalWidth).toBe(316);
  });

  it("ignores the last volume's own offset (nothing follows it)", () => {
    const withTrailing = computeStackLayout({
      count: 3,
      baseWidth: 250,
      horizontalStepPx: 20,
      volumeOffsetsByIndex: new Map([[2, 40]])
    });
    const without = computeStackLayout({ count: 3, baseWidth: 250, horizontalStepPx: 20 });
    expect(withTrailing).toEqual(without);
  });

  it('is empty for a count of zero', () => {
    expect(computeStackLayout({ count: 0, baseWidth: 250, horizontalStepPx: 20 })).toEqual({
      lefts: [],
      totalWidth: 0
    });
  });

  it('matches the card’s previous inline math across a fixture matrix', () => {
    const offsets = new Map([
      [0, 6],
      [2, -12],
      [3, 30]
    ]);
    for (const count of [1, 2, 3, 5, 9]) {
      for (const horizontal of [0, 11, 27.5, 62.5]) {
        const legacy = legacyPositions(count, 0, horizontal, offsets);
        const { lefts } = computeStackLayout({
          count,
          baseWidth: 250,
          horizontalStepPx: horizontal,
          volumeOffsetsByIndex: offsets
        });
        expect(lefts).toEqual(legacy);
      }
    }
  });
});

describe('hitTestStack', () => {
  const layout = computeStackLayout({
    count: 3,
    baseWidth: 100,
    horizontalStepPx: 30,
    volumeOffsetsByIndex: new Map([[1, 10]])
  });
  // lefts: [0, 30, 70]

  it('returns the front-most volume under the point (index 0 is on top)', () => {
    expect(hitTestStack(layout, 0, 100)).toBe(0);
    expect(hitTestStack(layout, 50, 100)).toBe(0);
    expect(hitTestStack(layout, 100, 100)).toBe(0); // right edge is inclusive
  });

  it('falls through to the volume behind once past the front one’s right edge', () => {
    expect(hitTestStack(layout, 100.5, 100)).toBe(1);
    expect(hitTestStack(layout, 130, 100)).toBe(1);
    expect(hitTestStack(layout, 130.5, 100)).toBe(2);
  });

  it('returns null left of the stack and right of every spine', () => {
    expect(hitTestStack(layout, -1, 100)).toBeNull();
    expect(hitTestStack(layout, 171, 100)).toBeNull();
  });

  it('returns null for an empty stack', () => {
    expect(hitTestStack({ lefts: [], totalWidth: 0 }, 10, 100)).toBeNull();
  });

  describe('per-volume widths', () => {
    // The shelf draws each volume at its own aspect width: a narrow spine behind a wide
    // cover only owns its own few pixels, so a fixed band would target the wrong volume.
    const shelf = computeStackLayout({ count: 3, baseWidth: 40, horizontalStepPx: 60 });
    // lefts: [0, 60, 120]
    const coverFirst = [250, 40, 40]; // a full cover in front of two narrow spines
    const spinesOnly = [40, 40, 40];

    it('keeps the front volume for its full drawn width', () => {
      expect(hitTestStack(shelf, 0, coverFirst)).toBe(0);
      expect(hitTestStack(shelf, 200, coverFirst)).toBe(0);
      expect(hitTestStack(shelf, 250, coverFirst)).toBe(0);
      // The cover is drawn over both spines, and past its edge nothing is left.
      expect(hitTestStack(shelf, 250.5, coverFirst)).toBeNull();
    });

    it('gives a narrow spine only the band it is actually drawn in', () => {
      expect(hitTestStack(shelf, 40, spinesOnly)).toBe(0);
      expect(hitTestStack(shelf, 41, spinesOnly)).toBeNull(); // the gap between two spines
      expect(hitTestStack(shelf, 60, spinesOnly)).toBe(1);
      expect(hitTestStack(shelf, 130, spinesOnly)).toBe(2);
      // A single nominal width would have handed all of that to volume 0.
      expect(hitTestStack(shelf, 130, 250)).toBe(0);
    });

    it('never hits a volume whose width is missing (nothing is drawn for it)', () => {
      expect(hitTestStack(shelf, 20, [40])).toBe(0);
      expect(hitTestStack(shelf, 70, [40])).toBeNull();
    });

    it('agrees with the scalar form when every width is the same', () => {
      const uniform = [100, 100, 100];
      const layout = computeStackLayout({ count: 3, baseWidth: 100, horizontalStepPx: 30 });
      for (let x = -10; x <= 250; x += 2.5) {
        expect(hitTestStack(layout, x, uniform)).toBe(hitTestStack(layout, x, 100));
      }
    });
  });

  it('matches the card’s previous inline hit test (null ⇒ its last-volume fallback)', () => {
    const offsets = new Map([
      [0, 6],
      [1, -12]
    ]);
    for (const count of [1, 2, 4, 7]) {
      const positions = legacyPositions(count, 0, 27.5, offsets);
      const { lefts, totalWidth } = computeStackLayout({
        count,
        baseWidth: 250,
        horizontalStepPx: 27.5,
        volumeOffsetsByIndex: offsets
      });
      expect(lefts).toEqual(positions);
      for (let x = -20; x <= totalWidth + 20; x += 5) {
        const expected = legacyHitTest(count, positions, x, 250);
        expect(hitTestStack({ lefts, totalWidth }, x, 250) ?? count - 1).toBe(expected);
      }
    }
  });
});

describe('spineBadgePlacements', () => {
  /** A stack of three 100×200 spines, stepped 30px apart inside a 160px canvas. */
  const threeSpines = (marked: number[], sizes?: ({ width: number; height: number } | null)[]) => ({
    volumes: [0, 1, 2],
    isMarked: (i: number) => marked.includes(i),
    drawnSize: (i: number) =>
      sizes ? sizes[i] : ({ width: 100, height: 200 } as { width: number; height: number } | null),
    horizontalStepPx: 30,
    verticalStepPx: 0,
    topOffsetPx: 0,
    canvasWidth: 160
  });

  it('places nothing for an empty stack', () => {
    expect(
      spineBadgePlacements({
        volumes: [],
        isMarked: () => true,
        drawnSize: () => ({ width: 10, height: 10 }),
        horizontalStepPx: 0,
        verticalStepPx: 0,
        topOffsetPx: 0,
        canvasWidth: 10
      })
    ).toEqual([]);
  });

  it('centres a badge along the visible strip of each marked spine', () => {
    // lefts are 0/30/60 and every spine is 100 wide, so each one is overlapped by the next
    // except the last: spine 1 shows [100, 130) and spine 2 shows [130, 160). A badge is
    // centred in the strip that is actually on screen, sitting on the bottom edge.
    expect(spineBadgePlacements(threeSpines([1, 2]))).toEqual([
      { index: 1, left: (100 + 130) / 2 - 10, top: 200 - 22 },
      { index: 2, left: (130 + 160) / 2 - 10, top: 200 - 22 }
    ]);
  });

  it('centres on the whole spine when nothing overlaps it', () => {
    expect(
      spineBadgePlacements({
        volumes: [0],
        isMarked: () => true,
        drawnSize: () => ({ width: 100, height: 200 }),
        horizontalStepPx: 30,
        verticalStepPx: 0,
        topOffsetPx: 0,
        canvasWidth: 100
      })
    ).toEqual([{ index: 0, left: 50 - 10, top: 200 - 22 }]);
  });

  it('marks nothing for a volume the canvas paints nothing for', () => {
    const sizes = [{ width: 100, height: 200 }, null, { width: 100, height: 200 }];
    const placements = spineBadgePlacements(threeSpines([0, 1, 2], sizes));
    expect(placements.map((p) => p.index)).toEqual([0, 2]);
    // …and the spine BEHIND the unpainted one is still covered by spine 0, which reaches
    // 100: its visible strip is [100, 160], not the whole [60, 160] the gap suggests.
    expect(placements[1].left).toBe((100 + 160) / 2 - 10);
  });

  it('looks past an unpainted neighbour to whatever is really covering the spine', () => {
    // Spine 1 has no pixels, so spine 2 is covered by spine 0 (reaching 100) — reading only
    // one spine back would centre the mark inside spine 0's territory.
    const sizes = [{ width: 100, height: 200 }, null, { width: 100, height: 200 }];
    const placements = spineBadgePlacements(threeSpines([2], sizes));
    expect(placements[0].left).toBe((100 + 160) / 2 - 10);
  });

  it('takes the furthest-reaching painted spine in front, not just the nearest', () => {
    // A wide spine 0 reaches 150 while the narrow spine 1 in front of it stops at 60:
    // spine 2 shows [150, 160].
    const sizes = [
      { width: 150, height: 200 },
      { width: 30, height: 200 },
      { width: 100, height: 200 }
    ];
    const placements = spineBadgePlacements(threeSpines([2], sizes));
    expect(placements[0].left).toBe((150 + 160) / 2 - 10);
  });

  it('follows the right-alignment CompositeCanvas draws with', () => {
    // The last spine is half-width, so the whole stack shifts right by 50px to keep its
    // right edge on the canvas — every badge moves with it. Spine 0 is the top one and
    // shows in full: [50, 150]. Spine 2 ends at 160 while spine 1 (in front of it) reaches
    // 180, so nothing of it shows and its badge collapses onto its right edge.
    const sizes = [
      { width: 100, height: 200 },
      { width: 100, height: 200 },
      { width: 50, height: 200 }
    ];
    const placements = spineBadgePlacements(threeSpines([0, 2], sizes));
    expect(placements).toEqual([
      { index: 0, left: (50 + 150) / 2 - 10, top: 178 },
      { index: 2, left: 160 - 10, top: 178 }
    ]);
  });

  it('cascades the per-volume nudges, like the lefts they come from', () => {
    const placements = spineBadgePlacements({
      ...threeSpines([2]),
      volumeOffsetsByIndex: new Map([[0, 10]])
    });
    // Volume 0's +10 pushes 1 and 2; the right-align then takes it back off the shift, so
    // the last spine still ends at the canvas edge and shows [130, 160].
    expect(placements[0].left).toBe((130 + 160) / 2 - 10);
  });

  it('follows the vertical step and the stack top inset', () => {
    const placements = spineBadgePlacements({
      ...threeSpines([2]),
      verticalStepPx: 12,
      topOffsetPx: 5
    });
    expect(placements[0].top).toBe(5 + 2 * 12 + 200 - 22);
  });

  it('takes the badge size and inset from the caller', () => {
    const placements = spineBadgePlacements({ ...threeSpines([0]), badgePx: 24, insetPx: 0 });
    // Spine 0 is on top and shows in full, so its badge centres on 0-100.
    expect(placements[0]).toEqual({ index: 0, left: 50 - 12, top: 200 - 24 });
  });
});
