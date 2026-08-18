import { describe, expect, it } from 'vitest';
import { computeStackLayout, hitTestStack } from './spine-stack-layout';

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
