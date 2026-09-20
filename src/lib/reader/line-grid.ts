/**
 * The line as a rotated box with its characters on a uniform grid — the
 * placement model the Android reader Chimahon uses, which our own bench found
 * as good as any per-character data (docs/superpowers/specs/
 * 2026-09-19-ocr-engine-options-findings.md: print pitch varies ~1.5%, a
 * uniform grid is 0.047 pitch off the ink on average).
 *
 * A line is a centre, a main extent (along the writing direction), a cross
 * extent and an angle. Its characters sit one per step of `main / count`, each
 * glyph centred in its step, all in the line's own rotated frame.
 *
 * The reader draws that WITHOUT a span per character: the line stays one text
 * node (the lightest DOM, and the one extensions such as Yomitan and Migaku
 * are safest with) and the grid is CSS `letter-spacing`; the rotation is a CSS
 * transform, which leaves the span in normal flow (issue #254) and takes the
 * browser's own hit-testing — what a pop-up dictionary scans with — along.
 *
 * Pure geometry, no DOM.
 */

import type { Quad } from './line-coords-layout';

/** Below this tilt a line renders upright: the detector's corner wobble is
 * not a rotation, and unrotated text is pixel-crisp. Degrees. */
export const ANGLE_DEAD_BAND = 2;

/**
 * Letter-spacing outside this range (in em) says the quad or the text is
 * wrong, not that the print is tracked that way: below, a line far too long
 * for its quad (hallucinated OCR); above, a few characters in a quad drawn
 * around much more than them. Such a line keeps the plain fitted rendering.
 */
export const MIN_SPACING_EM = -0.35;
export const MAX_SPACING_EM = 1.5;

/**
 * Spacing under this (in em) is noise, not tracking: `main / advance × advance`
 * in floats, and a canvas measurer that reports 7.99999em for eight fullwidth
 * glyphs. Text that fills its quad must come out with NO spacing, so that it
 * renders exactly as it did before there was a grid. At 1/10000 em a 20-glyph
 * line at 100px is off by a fifth of a pixel in total.
 */
const SPACING_EPS_EM = 1e-4;

export interface QuadAxes {
  /** left-edge midpoint → right-edge midpoint */
  hx: number;
  hy: number;
  /** top-edge midpoint → bottom-edge midpoint */
  vx: number;
  vy: number;
  /** their lengths, both > 0 */
  h: number;
  v: number;
  /** where the two cross: the mean of the four corners */
  cx: number;
  cy: number;
}

/**
 * The two edge-midpoint vectors of a quad — the construction
 * comic-text-detector uses, tolerant of rotated and slightly skewed quads.
 * Null for anything that is not four finite points with both extents > 0.
 */
export function quadAxes(quad: Quad): QuadAxes | null {
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  for (const p of quad) {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      return null;
    }
  }
  const [p0, p1, p2, p3] = quad;
  const hx = (p1[0] + p2[0]) / 2 - (p0[0] + p3[0]) / 2;
  const hy = (p1[1] + p2[1]) / 2 - (p0[1] + p3[1]) / 2;
  const vx = (p2[0] + p3[0]) / 2 - (p0[0] + p1[0]) / 2;
  const vy = (p2[1] + p3[1]) / 2 - (p0[1] + p1[1]) / 2;
  const h = Math.hypot(hx, hy);
  const v = Math.hypot(vx, vy);
  if (!(h > 0) || !(v > 0)) return null;
  return {
    hx,
    hy,
    vx,
    vy,
    h,
    v,
    cx: (p0[0] + p1[0] + p2[0] + p3[0]) / 4,
    cy: (p0[1] + p1[1] + p2[1] + p3[1]) / 4
  };
}

export interface LineFrame {
  /** quad centre, page px */
  cx: number;
  cy: number;
  /** extent along the writing direction, in the line's own frame */
  main: number;
  /** extent across it */
  cross: number;
  /**
   * Degrees, the CSS `rotate()` that turns upright text onto the quad:
   * positive is CLOCKWISE on screen (y points down). A vertical line leaning
   * clockwise has its foot left of its head; a horizontal one ends lower than
   * it starts. Measured from the block's writing axis (vertical-rl: down,
   * horizontal: right) to the quad's main axis, in (-90, 90] so text is never
   * turned upside down, and 0 inside the dead band.
   */
  angle: number;
}

export function lineFrame(quad: Quad, vertical: boolean): LineFrame | null {
  const axes = quadAxes(quad);
  if (!axes) return null;
  // rotate(θ) maps down (0,1) to (-sin θ, cos θ) and right (1,0) to
  // (cos θ, sin θ); solve for the θ that lands on the main vector.
  const radians = vertical ? Math.atan2(-axes.vx, axes.vy) : Math.atan2(axes.hy, axes.hx);
  let angle = (radians * 180) / Math.PI;
  // The corner order is file data: a quad listed from its bottom-right corner
  // has its main vector pointing backwards. The text still reads forwards.
  if (angle > 90) angle -= 180;
  else if (angle <= -90) angle += 180;
  if (Math.abs(angle) < ANGLE_DEAD_BAND) angle = 0;
  return {
    cx: axes.cx,
    cy: axes.cy,
    main: vertical ? axes.v : axes.h,
    cross: vertical ? axes.h : axes.v,
    angle
  };
}

/**
 * How many times the browser applies `letter-spacing` to a string: once after
 * every typographic character. Marks that ride on their base (a decomposed
 * dakuten, a variation selector) and joiners form one unit with it.
 */
export function spacingUnits(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // zero-width space/joiners, word joiner, variation selectors — by code
    // point, since a character class holding them reads as a combined sequence
    const rides =
      (code >= 0x200b && code <= 0x200d) ||
      code === 0x2060 ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      /^[\p{Mn}\p{Me}]$/u.test(char);
    if (!rides) count++;
  }
  return count;
}

/**
 * Leading, trailing or doubled document white space is collapsed by the
 * browser but not by the measurer, so the run's real advance is not the one
 * the grid would be computed from. (The ideographic space is not collapsed.)
 * Shared by the viewer's layout and the OCR editor.
 */
export function griddable(text: string): boolean {
  return text.length > 0 && !/^[ \t\n\r\f]|[ \t\n\r\f]$|[ \t\n\r\f]{2}/.test(text);
}

export interface GridSpacing {
  /** px, may be negative */
  letterSpacing: number;
  /** px the run starts past the line's start edge: half of one spacing */
  inset: number;
}

/**
 * The CSS that puts a text run on the uniform grid of its quad.
 *
 * `letter-spacing` stretches the run (natural advance `advanceEm × fontSize`)
 * to the quad's whole main extent. The browser adds the spacing AFTER every
 * character, the last included, so starting the run half a spacing in centres
 * each glyph in its share of the line. For all-fullwidth text that share is
 * exactly Chimahon's `main / count` step; a half-width character keeps its
 * narrower advance and the slack is still shared out evenly, which is closer
 * to print than one equal step per code point.
 *
 * Null = no grid for this line (see the clamps above): render it as before.
 */
export function gridSpacing(args: {
  main: number;
  advanceEm: number;
  fontSize: number;
  count: number;
}): GridSpacing | null {
  const { main, advanceEm, fontSize, count } = args;
  if (!(main > 0) || !(advanceEm > 0) || !(fontSize > 0) || !(count >= 1)) return null;
  const letterSpacing = (main - advanceEm * fontSize) / count;
  if (!Number.isFinite(letterSpacing)) return null;
  const em = letterSpacing / fontSize;
  if (Math.abs(em) < SPACING_EPS_EM) return { letterSpacing: 0, inset: 0 };
  if (em < MIN_SPACING_EM || em > MAX_SPACING_EM) return null;
  return { letterSpacing, inset: letterSpacing / 2 };
}

/** A rectangle turned about its centre; `angle` as in `LineFrame`. */
export interface OrientedRect {
  cx: number;
  cy: number;
  /** extents along x and y BEFORE the turn */
  width: number;
  height: number;
  angle: number;
}

type Point = [number, number];

function corners(rect: OrientedRect, shrink = 0): Point[] {
  const t = (rect.angle * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const hw = Math.max(0, rect.width / 2 - shrink);
  const hh = Math.max(0, rect.height / 2 - shrink);
  const at = (dx: number, dy: number): Point => [
    rect.cx + dx * cos - dy * sin,
    rect.cy + dx * sin + dy * cos
  ];
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/** Axis-aligned bounds of a turned rectangle. */
export function rectBounds(rect: OrientedRect): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const points = corners(rect);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  };
}

function overlapArea(subject: Point[], clip: Point[]): number {
  // Sutherland–Hodgman: both polygons are rectangles from `corners`, so convex
  // and wound the same way (clockwise on screen) — inside is to the right of
  // each clip edge in y-down coordinates, i.e. a non-negative cross product.
  let polygon = subject;
  for (let e = 0; e < clip.length && polygon.length; e++) {
    const a = clip[e];
    const b = clip[(e + 1) % clip.length];
    const side = (p: Point) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const next: Point[] = [];
    for (let k = 0; k < polygon.length; k++) {
      const p = polygon[k];
      const q = polygon[(k + 1) % polygon.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) next.push(p);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        next.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
    polygon = next;
  }
  let twice = 0;
  for (let k = 0; k < polygon.length; k++) {
    const p = polygon[k];
    const q = polygon[(k + 1) % polygon.length];
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(twice) / 2;
}

/** Area two turned rectangles share. */
export function rectOverlapArea(a: OrientedRect, b: OrientedRect): number {
  return overlapArea(corners(a), corners(b));
}

/**
 * Do two turned rectangles overlap by more than `tolerance` px? Each gives up
 * half the tolerance on every side first, so lines that merely touch are apart.
 */
export function rectsCollide(a: OrientedRect, b: OrientedRect, tolerance: number): boolean {
  return overlapArea(corners(a, tolerance / 2), corners(b, tolerance / 2)) > 1e-9;
}

/**
 * The transform that snaps a line span from where normal flow put it onto its
 * target, for the reader's `positionPerLine` action. Everything is in the
 * text box's own px.
 *
 * Upright: a translate, as it has always been — `target` is where the run
 * starts, plus the grid inset along the reading axis.
 *
 * Rotated: `target` + `box` are the line's own-frame box (main × cross,
 * centred on the quad centre). The span is laid into that box unrotated —
 * inset along the reading axis, CENTRED across it, because the span is one
 * font size thick and the quad usually more — and then turned about the box's
 * centre, which `origin` names in the span's own coordinates. A transform
 * keeps the span in flow, and the browser hit-tests the turned glyphs.
 */
export function lineTransform(args: {
  natural: { left: number; top: number; width: number; height: number };
  target: { left: number; top: number };
  box?: { width: number; height: number };
  inset?: number;
  rotation?: number;
  vertical: boolean;
}): { transform: string; origin: string } {
  const { natural, target, box, vertical } = args;
  const inset = args.inset || 0;
  const rotation = args.rotation || 0;
  if (!rotation || !box) {
    const left = target.left + (vertical ? 0 : inset);
    const top = target.top + (vertical ? inset : 0);
    return {
      transform: `translate(${left - natural.left}px, ${top - natural.top}px)`,
      origin: ''
    };
  }
  const left = vertical ? target.left + (box.width - natural.width) / 2 : target.left + inset;
  const top = vertical ? target.top + inset : target.top + (box.height - natural.height) / 2;
  const originX = target.left + box.width / 2 - left;
  const originY = target.top + box.height / 2 - top;
  return {
    transform: `translate(${left - natural.left}px, ${top - natural.top}px) rotate(${rotation}deg)`,
    origin: `${originX}px ${originY}px`
  };
}
