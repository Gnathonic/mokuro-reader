/**
 * The line as a rotated box with its characters on a uniform grid — the
 * placement model the Android reader Chimahon uses, which our own bench found
 * as good as any per-character data (docs/superpowers/specs/
 * 2026-09-19-ocr-engine-options-findings.md: print pitch varies ~1.5%, a
 * uniform grid is 0.047 pitch off the ink on average).
 *
 * A line is a centre, a main extent (along the writing direction), a cross
 * extent and an angle. Its characters sit one per step of the line's PITCH,
 * each glyph centred in its step, all in the line's own rotated frame.
 *
 * The pitch is NOT `main / count`: a detector's quad hugs the ink, and the
 * first and last glyphs leave part of their cells empty (`glyph-insets.ts`),
 * so the quad covers fewer than `count` cells and the first cell starts before
 * the quad does. And the columns of one block are typeset at ONE pitch, so a
 * block's lines share theirs (`linePitches`) — a short line's own estimate is
 * the worst one available.
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
 * …and the tilt must also carry the line's end sideways by more than this
 * share of the line's thickness (`|sin θ| · main > TILT_MIN_SHIFT · cross`).
 * An angle is only as good as the line is long: a 10px corner error on a
 * 243px line already reads 2.4°, and on two-glyph ruby lines the same noise
 * reads 5–11° — all level in print. On the calibration pages every such line
 * stays under 0.27; a real 5° slant on a 600px line is 0.8, and the slanted
 * SFX the rotation exists for are far above. So a long column turns at 2°, a
 * five-glyph line at about 4°, a two-glyph one only past 10°.
 */
export const TILT_MIN_SHIFT = 0.35;

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
   * turned upside down, and 0 inside the dead band (`ANGLE_DEAD_BAND`,
   * `TILT_MIN_SHIFT`).
   */
  angle: number;
  /**
   * The same angle as MEASURED, dead band or not. Rendering never reads it;
   * the OCR editor's quad operations do, so that a tilted quad dragged short
   * (where its angle stops counting as a rotation) still moves along its own
   * axes and keeps its shape.
   */
  tilt: number;
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
  const main = vertical ? axes.v : axes.h;
  const cross = vertical ? axes.h : axes.v;
  const tilt = angle === 0 ? 0 : angle; // never -0
  const shift = Math.abs(Math.sin((angle * Math.PI) / 180)) * main;
  if (Math.abs(angle) < ANGLE_DEAD_BAND || shift <= TILT_MIN_SHIFT * cross) angle = 0;
  return { cx: axes.cx, cy: axes.cy, main, cross, angle, tilt };
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

/** What the pitch model needs to know about one line. */
export interface PitchInput {
  /** quad extents in the line's own frame, px */
  main: number;
  cross: number;
  /** natural advance of the rendered text, em */
  advanceEm: number;
  /** characters the browser letter-spaces (`spacingUnits`) */
  count: number;
  /** ink insets of the first / last glyph, em (`inkInsets`) */
  lead: number;
  trail: number;
}

export interface LinePitch {
  /** px: the step of a fullwidth character — glyph size plus tracking */
  pitch: number;
  /**
   * px — the PRINT's glyph size as far as the quad can tell: the pitch, but
   * never more than the quad's thickness. Text tracked out wider than its own
   * size (a contents page: 62px glyphs on a 146px step) has its ink insets in
   * units of THIS, not of the step.
   */
  em: number;
  /** em — the inset the placement uses; 0 where the insets were unusable */
  lead: number;
  trail: number;
}

/** An inset-corrected line must keep at least this much of its advance: a
 * lone `。` whose quad is drawn around the dot has no cell to recover. */
const MIN_EFFECTIVE_SHARE = 0.25;

/** One glyph has no second glyph to measure a step to: it is set solid
 * whatever its quad's thickness. */
const printEm = (pitch: number, line: PitchInput) =>
  line.count >= 2 ? Math.min(pitch, line.cross) : pitch;

/**
 * Length of ink a line of this text has at `pitch`: every glyph's advance at
 * the print's size, the tracking between them, less the ink-free parts of the
 * first and last glyphs. The inverse of `ownPitch`.
 */
export function inkLength(line: PitchInput, pitch: number): number {
  const em = printEm(pitch, line);
  return line.advanceEm * em + (line.count - 1) * (pitch - em) - (line.lead + line.trail) * em;
}

/**
 * The pitch ONE line's quad implies. Set solid (glyph size = step), a quad
 * that spans the ink covers `advance − lead − trail` cells. When that comes
 * out larger than the quad is thick the text is TRACKED: the glyphs are as big
 * as the quad is thick and the rest of the length is the tracking between
 * them — 四三二一 across a contents page measures 145.7px a step in print;
 * `main / count` says 126, this says 145.2. The two meet where step = thickness.
 */
export function ownPitch(input: PitchInput): LinePitch | null {
  const { main, cross, advanceEm, count } = input;
  if (!(main > 0) || !(cross > 0) || !(advanceEm > 0)) return null;
  let { lead, trail } = input;
  if (!(lead >= 0) || !(trail >= 0) || advanceEm - lead - trail < MIN_EFFECTIVE_SHARE * advanceEm) {
    lead = 0;
    trail = 0;
  }
  const line = { ...input, lead, trail };
  const cells = advanceEm - lead - trail;
  const solid = main / cells;
  const pitch =
    solid <= cross || !(count >= 2) ? solid : cross + (main - cells * cross) / (count - 1);
  if (!Number.isFinite(pitch) || !(pitch > 0)) return null;
  return { pitch, em: printEm(pitch, line), lead, trail };
}

/**
 * A line is typeset at the block's pitch when, at that pitch, its ink would
 * end within this many cells of where its quad ends. Measured against the
 * print, a line's own inset-corrected estimate is off by at most 0.65 of a
 * cell at the far end WHATEVER its length (1.7% of a 38-glyph column, 8% of a
 * five-glyph line, 36% of `る。`), so the test is absolute, not a percentage:
 * a percentage loose enough for short lines would let a 40-glyph column run
 * five cells past its quad. A line in another size misses by
 * `cells × size ratio` — a heading 20% larger by a whole cell from four
 * glyphs on.
 */
export const PITCH_TOLERANCE_CELLS = 0.75;
/** …or by this share of its length, for columns so long that the block
 * pitch's own error (0.3% p95 across a block's columns) adds up. */
export const PITCH_TOLERANCE_SHARE = 0.02;
/** Lines with at least this many effective cells estimate the pitch to a few
 * percent and vote for the block's; shorter ones vote only when no such line
 * exists (a manga balloon of three-glyph lines). */
const VOTER_MIN_CELLS = 4;

export function sharesPitch(line: PitchInput, pitch: number): boolean {
  if (!(pitch > 0)) return false;
  const miss = Math.abs(inkLength(line, pitch) - line.main);
  return miss <= Math.max(PITCH_TOLERANCE_CELLS * pitch, PITCH_TOLERANCE_SHARE * line.main);
}

export interface PitchVoter extends PitchInput {
  /** false for lines whose quad says nothing about the print's pitch:
   * hidden, wrapped, banded, merged-columns suspects, lines drawn on cells */
  votes: boolean;
}

/**
 * One pitch per line of a block (null = no usable geometry). The block's
 * pitch is the glyph-count-weighted (`count`) median of the voting lines' own pitches;
 * every voting line that `sharesPitch` with it takes it — ANCHORED AT ITS
 * START, so a quad that ends a little early or late no longer squeezes or
 * stretches the line. The lines it does not fit (ruby split around its base
 * text, a heading in another size) vote again among themselves, so each print
 * size in the block ends up with one pitch; a line alone in its size keeps
 * its own.
 *
 * Shared by the viewer (`layoutLines`) and the OCR editor (`block-geometry`).
 */
export function linePitches(lines: PitchVoter[]): (LinePitch | null)[] {
  const result = lines.map((line) => ownPitch(line));
  interface Voter {
    index: number;
    /** the line with the insets its own pitch settled on */
    line: PitchVoter;
    pitch: number;
  }
  let open: Voter[] = [];
  lines.forEach((line, index) => {
    const own = result[index];
    if (line.votes && own) {
      open.push({ index, line: { ...line, lead: own.lead, trail: own.trail }, pitch: own.pitch });
    }
  });
  const cells = (v: Voter) => v.line.advanceEm - v.line.lead - v.line.trail;
  while (open.length > 0) {
    const long = open.filter((v) => cells(v) >= VOTER_MIN_CELLS);
    const pool = (long.length ? long : open).slice().sort((a, b) => a.pitch - b.pitch);
    const total = pool.reduce((sum, v) => sum + Math.max(v.line.count, 1), 0);
    let winner = pool[pool.length - 1];
    let cumulative = 0;
    for (const v of pool) {
      cumulative += Math.max(v.line.count, 1);
      if (cumulative >= total / 2) {
        winner = v;
        break;
      }
    }
    const rest: Voter[] = [];
    for (const v of open) {
      if (v !== winner && !sharesPitch(v.line, winner.pitch)) {
        rest.push(v);
        continue;
      }
      const mine = result[v.index]!;
      result[v.index] = { ...mine, pitch: winner.pitch, em: printEm(winner.pitch, v.line) };
    }
    open = rest;
  }
  return result;
}

export interface GridSpacing {
  /** px, may be negative */
  letterSpacing: number;
  /** px from the line's start edge to where the run starts. Usually NEGATIVE:
   * the first glyph's cell begins before its ink does. */
  inset: number;
}

/**
 * The CSS that puts a text run on its line's fixed-pitch grid.
 *
 * The print's run is every glyph at the print's size (`em`) plus the tracking
 * (`pitch − em`) after each; `letter-spacing` makes the rendered run — natural
 * advance `advanceEm × fontSize` — exactly that long, shared out per
 * character. A fullwidth character then steps one pitch, a half-width one
 * keeps its narrower advance. The browser adds the spacing AFTER every
 * character, so the run starts where the first glyph, centred on the print's
 * first glyph, has its ink begin at the quad's start edge: `lead` print ems
 * before it, plus half the difference between the print's glyph size and the
 * rendered one.
 *
 * Null = no grid for this line (see the clamps above): render it as before.
 */
export function gridSpacing(args: {
  pitch: LinePitch;
  advanceEm: number;
  fontSize: number;
  count: number;
}): GridSpacing | null {
  const { pitch, advanceEm, fontSize, count } = args;
  if (!pitch || !(pitch.pitch > 0) || !(pitch.em > 0)) return null;
  if (!(advanceEm > 0) || !(fontSize > 0) || !(count >= 1)) return null;
  let letterSpacing = pitch.pitch - pitch.em + (advanceEm * (pitch.em - fontSize)) / count;
  if (!Number.isFinite(letterSpacing)) return null;
  const spacingEm = letterSpacing / fontSize;
  if (spacingEm < MIN_SPACING_EM || spacingEm > MAX_SPACING_EM) return null;
  if (Math.abs(spacingEm) < SPACING_EPS_EM) letterSpacing = 0;
  // Set solid at the rendered size there is no glyph-size difference to
  // split either: only the ink inset moves the run.
  const centring = letterSpacing === 0 && pitch.em === pitch.pitch ? 0 : (pitch.em - fontSize) / 2;
  const inset = centring - pitch.lead * pitch.em;
  return { letterSpacing, inset: inset === 0 ? 0 : inset };
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
 * Upright: a translate, as it has always been — `target` is the line's start
 * edge, plus the grid inset (usually negative) along the reading axis.
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
