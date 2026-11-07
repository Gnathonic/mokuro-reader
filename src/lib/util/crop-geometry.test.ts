import { describe, expect, it } from 'vitest';
import {
  clampMove,
  clampResize,
  constrainSelection,
  containLayout,
  cropZoneToRect,
  croppedCanvasPlan,
  initialCoverCrop,
  layoutBounds,
  layoutMatrix,
  nextQuarterTurn,
  normalizeDecimalNumber,
  rectToCropZone,
  rotatedSize,
  roundCropData,
  toFrameRect,
  toImageRect,
  type CropRect
} from './crop-geometry';

/*
 * Numbers marked "v1" were measured on cropperjs 1.6.2 in Chromium (a 1200×600
 * crop area, the cover picker's and the Anki modal's options) before it was
 * replaced: getData(), getData(true), getCroppedCanvas() sizes, and the crop
 * after rotate(90) + recentre.
 */

function expectRect(actual: CropRect | null, expected: CropRect, digits = 6) {
  expect(actual).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(actual![key], key).toBeCloseTo(expected[key], digits);
  }
}

describe('initialCoverCrop', () => {
  it('is the whole page when the page is narrower than 3:4', () => {
    expect(initialCoverCrop(1000, 1400)).toEqual({ x: 0, y: 0, width: 1000, height: 1400 });
    expect(initialCoverCrop(1350, 1920)).toEqual({ x: 0, y: 0, width: 1350, height: 1920 });
  });

  it('is full height at 3:4 and centred when the page is at least 3:4', () => {
    expect(initialCoverCrop(1200, 1600)).toEqual({ x: 0, y: 0, width: 1200, height: 1600 });
    // v1 Reset: 0.625, 0, 999.75, 1333
    expectRect(initialCoverCrop(1001, 1333), { x: 0.625, y: 0, width: 999.75, height: 1333 });
    // v1 Reset: 469.75, 0, 1060.5, 1414 (v1's first view started left of this)
    expectRect(initialCoverCrop(2000, 1414), { x: 469.75, y: 0, width: 1060.5, height: 1414 });
    // v1 Reset: 387.5, 0, 825, 1100
    expectRect(initialCoverCrop(1600, 1100), { x: 387.5, y: 0, width: 825, height: 1100 });
  });

  it('keeps 3:4 exactly', () => {
    const crop = initialCoverCrop(1200, 900);
    expect(crop.width / crop.height).toBeCloseTo(3 / 4, 12);
    expect(crop.x * 2 + crop.width).toBeCloseTo(1200, 9);
  });
});

describe('croppedCanvasPlan (the output size)', () => {
  // v1 getCroppedCanvas() sizes for the same getData() crops.
  const cases: [CropRect, number, number, number, number][] = [
    [{ x: 10.399999999999997, y: 20.6, width: 300.7, height: 400.2 }, 1000, 1400, 300, 400],
    [{ x: 0, y: 0, width: 999.7499999999999, height: 1332.9999999999998 }, 1001, 1333, 999, 1333],
    [{ x: 55.75, y: 0, width: 1060.5, height: 1414 }, 2000, 1414, 1060, 1414],
    [{ x: 87.5, y: 0, width: 825, height: 1100 }, 1600, 1100, 825, 1100],
    [{ x: 0, y: 0, width: 1000, height: 1400 }, 1000, 1400, 1000, 1400],
    // after rotate(90): cut from the turned image
    [{ x: 342.8571428571428, y: 0, width: 714.2857142857143, height: 1000 }, 1400, 1000, 714, 1000],
    [{ x: 291.125, y: 0, width: 750.75, height: 1001 }, 1333, 1001, 750, 1001],
    [{ x: 485.390625, y: 0, width: 949.21875, height: 1350 }, 1920, 1350, 949, 1350]
  ];

  it.each(cases)('%o of %i×%i → %i×%i, like v1', (crop, sourceW, sourceH, width, height) => {
    const plan = croppedCanvasPlan(crop, sourceW, sourceH);
    expect([plan.width, plan.height]).toEqual([width, height]);
    expect(plan.drawParams).not.toBeNull();
  });

  it('cuts the crop from the source one to one, floored as v1 floored', () => {
    expect(croppedCanvasPlan({ x: 262.5, y: 0, width: 675, height: 900 }, 1200, 900)).toEqual({
      width: 675,
      height: 900,
      drawParams: [262, 0, 675, 900, 0, 0, 675, 900]
    });
    expect(croppedCanvasPlan({ x: 0, y: 0, width: 937.5, height: 900 }, 1200, 900)).toEqual({
      width: 937,
      height: 900,
      drawParams: [0, 0, 937, 900, 0, 0, 937, 900]
    });
  });

  it('draws only the part of a crop that is on the source', () => {
    // 50 px off the left and top: the canvas keeps the crop's size and the
    // image lands 50 px in. (v1 reads the source size after zeroing srcX/srcY,
    // so it asks for the full 200×100 and the canvas edge cuts it; the crops
    // here never leave the image, so only the placement matters.)
    expect(croppedCanvasPlan({ x: -50, y: -50, width: 200, height: 100 }, 1000, 1000)).toEqual({
      width: 200,
      height: 100,
      drawParams: [0, 0, 200, 100, 50, 50, 200, 100]
    });
    // Past the right and bottom edges.
    expect(croppedCanvasPlan({ x: 900, y: 950, width: 200, height: 100 }, 1000, 1000)).toEqual({
      width: 200,
      height: 100,
      drawParams: [900, 950, 100, 50, 0, 0, 100, 50]
    });
  });

  it('draws nothing for a crop entirely off the source', () => {
    expect(croppedCanvasPlan({ x: 2000, y: 0, width: 10, height: 10 }, 1000, 1000)).toEqual({
      width: 10,
      height: 10,
      drawParams: null
    });
  });
});

describe('roundCropData (the Anki card crop)', () => {
  it('rounds the corners, like v1 getData(true)', () => {
    // v1: 101.3, 205.7, 378.9, 695.2 → 101, 206, 379, 695
    expect(roundCropData({ x: 101.3, y: 205.7, width: 378.9, height: 695.2 })).toEqual({
      x: 101,
      y: 206,
      width: 379,
      height: 695
    });
    // v1: 1500.5000000000002, 1000.2499999999999, 499.5, 413.75000000000006 → 1501, 1000, 499, 414
    expect(
      roundCropData({
        x: 1500.5000000000002,
        y: 1000.2499999999999,
        width: 499.5,
        height: 413.75000000000006
      })
    ).toEqual({ x: 1501, y: 1000, width: 499, height: 414 });
  });

  it('never adds a pixel at the right or bottom edge', () => {
    const crop = roundCropData({ x: 0.5, y: 0.5, width: 999.5, height: 1399.5 });
    expect(crop.x + crop.width).toBe(1000);
    expect(crop.y + crop.height).toBe(1400);
  });
});

describe('normalizeDecimalNumber', () => {
  it('drops floating-point noise and nothing else', () => {
    expect(normalizeDecimalNumber(999.9999999999999)).toBe(1000);
    expect(normalizeDecimalNumber(0.30000000000000004)).toBe(0.3);
    expect(normalizeDecimalNumber(999.75)).toBe(999.75);
    expect(normalizeDecimalNumber(1060.5)).toBe(1060.5);
  });
});

describe('clamping (the crop stays on the image)', () => {
  const bounds = { x: 100, y: 50, width: 400, height: 300 };

  it('a move slides along the edge, same size', () => {
    expect(clampMove({ x: 450, y: 0, width: 100, height: 100 }, bounds)).toEqual({
      x: 400,
      y: 50,
      width: 100,
      height: 100
    });
  });

  it('a box larger than the image is shrunk to it', () => {
    expect(clampMove({ x: -10, y: -10, width: 1000, height: 1000 }, bounds)).toEqual(bounds);
  });

  it('is the Anki modal’s old clampToImage on image pixels', () => {
    const W = 1350;
    const H = 1920;
    const old = (d: CropRect): CropRect => {
      let { x, y, width, height } = d;
      x = Math.max(0, Math.min(x, W - width));
      y = Math.max(0, Math.min(y, H - height));
      if (width > W) {
        width = W;
        x = 0;
      }
      if (height > H) {
        height = H;
        y = 0;
      }
      return { x, y, width, height };
    };
    for (const d of [
      { x: -20, y: 30, width: 100, height: 100 },
      { x: 1300, y: 1900, width: 100, height: 100 },
      { x: 5, y: 5, width: 2000, height: 50 },
      { x: 5, y: 5, width: 50, height: 3000 },
      { x: 200, y: 300, width: 400, height: 500 }
    ]) {
      expect(clampMove(d, { x: 0, y: 0, width: W, height: H })).toEqual(old(d));
    }
  });

  it('a resize stops at the edge it crosses', () => {
    expect(clampResize({ x: 50, y: 0, width: 200, height: 500 }, bounds)).toEqual({
      x: 100,
      y: 50,
      width: 150,
      height: 300
    });
    expect(clampResize({ x: 600, y: 0, width: 10, height: 10 }, bounds)).toBeNull();
  });

  it('tells a move from a resize by the size', () => {
    const current = { x: 200, y: 100, width: 100, height: 100 };
    // Same size: moved, kept whole.
    expect(constrainSelection({ ...current, x: 480 }, current, bounds)).toEqual({
      ...current,
      x: 400
    });
    // Wider: resized, cut at the edge.
    expect(constrainSelection({ ...current, width: 400 }, current, bounds)).toEqual({
      ...current,
      width: 300
    });
    expect(constrainSelection({ x: 0, y: 0, width: 50, height: 40 }, current, bounds)).toBeNull();
  });
});

describe('layout (fit, quarter turns, frame ↔ image pixels)', () => {
  it('fits the turned image inside the frame, centred', () => {
    // v1 after rotate(90) of 1000×1400 in 1200×600: canvas 840×600 at 180, 0
    expect(containLayout(1000, 1400, 90, 1200, 600)).toEqual({
      scale: 0.6,
      left: 180,
      top: 0,
      width: 840,
      height: 600
    });
    const upright = containLayout(1000, 1400, 0, 1200, 600);
    expect(upright.width).toBeCloseTo(428.5714285714, 8);
    expect(upright.left).toBeCloseTo(385.7142857143, 8);
  });

  it('turns clockwise a quarter at a time', () => {
    expect(nextQuarterTurn(0)).toBe(90);
    expect(nextQuarterTurn(270)).toBe(0);
    expect(rotatedSize(1000, 1400, 90)).toEqual({ width: 1400, height: 1000 });
    expect(rotatedSize(1000, 1400, 180)).toEqual({ width: 1000, height: 1400 });
  });

  it('maps frame and image pixels both ways', () => {
    const layout = containLayout(1200, 900, 0, 1840, 756);
    const image = { x: 262.5, y: 0, width: 675, height: 900 };
    expectRect(toImageRect(toFrameRect(image, layout), layout), image, 9);
  });

  it('puts the <cropper-image> box exactly on the layout', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const [W, H] = [1000, 1400];
      const layout = containLayout(W, H, rotation, 1200, 600);
      const [a, b, c, d, e, f] = layoutMatrix(W, H, rotation, layout);
      // CSS: a natural-size box at the origin, transformed about its centre.
      const corners = [
        [0, 0],
        [W, 0],
        [0, H],
        [W, H]
      ].map(([x, y]) => {
        const dx = x - W / 2;
        const dy = y - H / 2;
        return [W / 2 + a * dx + c * dy + e, H / 2 + b * dx + d * dy + f];
      });
      const xs = corners.map(([x]) => x);
      const ys = corners.map(([, y]) => y);
      expectRect(
        {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys)
        },
        layoutBounds(layout),
        9
      );
      // Clockwise: the image's top-left corner ends up top-right at 90°.
      if (rotation === 90) {
        expect(corners[0][0]).toBeCloseTo(layout.left + layout.width, 9);
        expect(corners[0][1]).toBeCloseTo(layout.top, 9);
      }
    }
  });

  it('keeps the selection where it was on screen through a turn, like v1 rotate(90)', () => {
    // v1 (portrait pages, the cover picker's usual input): the crop after
    // rotate(90) + recentre from the default full-page selection.
    const cases: [number, number, CropRect][] = [
      [1000, 1400, { x: 342.8571428571428, y: 0, width: 714.2857142857143, height: 1000 }],
      [1200, 1600, { x: 350, y: 0, width: 900, height: 1200 }],
      [1350, 1920, { x: 485.390625, y: 0, width: 949.21875, height: 1350 }]
    ];
    for (const [W, H, v1] of cases) {
      const before = containLayout(W, H, 0, 1200, 600);
      const onScreen = toFrameRect(initialCoverCrop(W, H), before);
      const after = containLayout(W, H, 90, 1200, 600);
      expectRect(toImageRect(clampMove(onScreen, layoutBounds(after)), after), v1, 6);
    }
  });
});

describe('crop zones (Copy Last Crop Zone)', () => {
  it('round-trips on the same image', () => {
    const rect = { x: 120, y: 40, width: 600, height: 800 };
    const zone = rectToCropZone(rect, 1200, 900)!;
    expectRect(cropZoneToRect(zone, 1200, 900), rect, 9);
  });

  it('keeps the aspect ratio and stays inside a smaller image', () => {
    const zone = rectToCropZone({ x: 600, y: 0, width: 600, height: 800 }, 1200, 900)!;
    const rect = cropZoneToRect(zone, 600, 700)!;
    expect(rect.width / rect.height).toBeCloseTo(0.75, 9);
    expect(rect.x + rect.width).toBeLessThanOrEqual(600 + 1e-9);
    expect(rect.y + rect.height).toBeLessThanOrEqual(700 + 1e-9);
  });

  it('has none for an empty crop or image', () => {
    expect(rectToCropZone({ x: 0, y: 0, width: 0, height: 10 }, 100, 100)).toBeNull();
    expect(
      cropZoneToRect(
        { xPercent: 0, yPercent: 0, widthPercent: 1, heightPercent: 1, aspectRatio: 1 },
        0,
        0
      )
    ).toBeNull();
  });
});
