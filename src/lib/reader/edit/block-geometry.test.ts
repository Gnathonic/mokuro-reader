import { describe, expect, it } from 'vitest';
import {
  clampBox,
  estimateFontSize,
  readingOrder,
  scaleQuads,
  splitBoxAtLine,
  translateQuads,
  unionBox
} from './block-geometry';

describe('clampBox', () => {
  it('clamps to the image and keeps at least 1px extent', () => {
    expect(clampBox([-5, 10, 50, 20], 40, 40)).toEqual([0, 10, 40, 20]);
    expect(clampBox([10, 10, 10, 10], 40, 40)).toEqual([10, 10, 11, 11]);
  });
  it('re-orders inverted corners', () => {
    expect(clampBox([30, 30, 10, 10], 100, 100)).toEqual([10, 10, 30, 30]);
  });
});

describe('quads', () => {
  const quad = [
    [
      [10, 10],
      [20, 10],
      [20, 30],
      [10, 30]
    ]
  ];
  it('translates every point', () => {
    expect(translateQuads(quad, 5, -5)).toEqual([
      [
        [15, 5],
        [25, 5],
        [25, 25],
        [15, 25]
      ]
    ]);
    expect(translateQuads(undefined, 1, 1)).toBeUndefined();
  });
  it('scales points affinely from one box to another', () => {
    expect(scaleQuads(quad, [10, 10, 20, 30], [0, 0, 20, 40])).toEqual([
      [
        [0, 0],
        [20, 0],
        [20, 40],
        [0, 40]
      ]
    ]);
  });
});

describe('unionBox / splitBoxAtLine', () => {
  it('unions', () => {
    expect(
      unionBox([
        [0, 0, 10, 10],
        [5, 5, 20, 8]
      ])
    ).toEqual([0, 0, 20, 10]);
  });
  it('splits a vertical box right-to-left by line count when there are no quads', () => {
    // 4 lines, split after line 1 → first block keeps the RIGHT quarter
    expect(splitBoxAtLine([0, 0, 40, 100], true, 1, 4)).toEqual([
      [30, 0, 40, 100],
      [0, 0, 30, 100]
    ]);
  });
  it('splits a horizontal box top-to-bottom by line count', () => {
    expect(splitBoxAtLine([0, 0, 100, 40], false, 2, 4)).toEqual([
      [0, 0, 100, 20],
      [0, 20, 100, 40]
    ]);
  });
  it('splits at the quad boundary when quads exist', () => {
    const quads = [
      [
        [30, 0],
        [40, 0],
        [40, 100],
        [30, 100]
      ],
      [
        [0, 0],
        [12, 0],
        [12, 100],
        [0, 100]
      ]
    ];
    expect(splitBoxAtLine([0, 0, 40, 100], true, 1, 2, quads)).toEqual([
      [21, 0, 40, 100],
      [0, 0, 21, 100]
    ]);
  });
});

describe('estimateFontSize', () => {
  it('uses the cross-writing axis divided by line count, clamped', () => {
    expect(estimateFontSize([0, 0, 60, 200], true, 2)).toBe(30);
    expect(estimateFontSize([0, 0, 200, 60], false, 3)).toBe(20);
    expect(estimateFontSize([0, 0, 4, 4], true, 1)).toBe(8);
    expect(estimateFontSize([0, 0, 1000, 1000], false, 1)).toBe(200);
  });
});

describe('readingOrder', () => {
  it('orders vertical blocks right-to-left, horizontal top-to-bottom', () => {
    const blocks = [{ box: [0, 0, 10, 10] }, { box: [50, 0, 60, 10] }, { box: [20, 20, 30, 30] }];
    expect(readingOrder(blocks, true)).toEqual([1, 2, 0]);
    expect(readingOrder(blocks, false)).toEqual([0, 1, 2]);
  });
});

describe('quad helpers', () => {
  it('rectQuad / quadBounds round-trip and medianLineFontSize', async () => {
    const { rectQuad, quadBounds, medianLineFontSize } = await import('./block-geometry');
    expect(quadBounds(rectQuad(5, 6, 10, 20))).toEqual([5, 6, 15, 26]);
    expect(
      medianLineFontSize([
        rectQuad(0, 0, 40, 200),
        rectQuad(0, 0, 500, 90),
        rectQuad(0, 0, 30, 300)
      ])
    ).toBe(40);
  });
});
