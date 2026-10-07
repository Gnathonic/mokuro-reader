import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './helpers/app';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The fixed-pitch grid and rotation (src/lib/reader/line-grid.ts) in a REAL
 * layout engine. jsdom lays nothing out, so only here can it be shown that
 * `letter-spacing` + the start inset really centres every glyph in its grid
 * step, that a tilted line lands on its quad, and — the point of rotating at
 * all — that the browser's own hit-testing (elementFromPoint,
 * caretRangeFromPoint: what Yomitan scans with) follows the turned text.
 *
 * The page image carries the "print": each line's text drawn one glyph per
 * step in a box of CELLS, in that box's own turned frame. The file's quad is
 * what a detector would draw around it: it hugs the INK (`hug`), so it starts
 * and ends inside the first and last cells. Both are outlined, so the
 * screenshots show the overlay against what it is supposed to cover.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// Playwright empties test-results at the start of every run; point
// LINE_GRID_SHOTS somewhere else to keep the captures.
const SHOTS = process.env.LINE_GRID_SHOTS ?? join(HERE, '../test-results/line-grid-shots');

const SERIES = 'Line Grid Series';
const SERIES_UUID = 'e2e-line-grid-series';
const VOLUME_UUID = 'e2e-line-grid-volume';

type Point = [number, number];
type Quad = Point[];
interface FixtureBlock {
  box: [number, number, number, number];
  vertical: boolean;
  font_size: number;
  lines: string[];
  lines_coords: Quad[];
  /** NOT file data (stripped before seeding): the boxes of cells the print is
   * drawn in, one per line — what every expectation below is measured against. */
  cells: Quad[];
  /** NOT file data: seed the block WITHOUT its lines_coords — a volume from
   * before mokuro wrote them. */
  noQuads?: true;
}
interface FixturePage {
  version: string;
  img_width: number;
  img_height: number;
  img_path: string;
  blocks: FixtureBlock[];
}

const upright = (x0: number, y0: number, x1: number, y1: number): Quad => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1]
];
/** w × h upright rectangle about (cx, cy), turned like CSS rotate(deg). */
function tilted(cx: number, cy: number, w: number, h: number, deg: number): Quad {
  const t = (deg * Math.PI) / 180;
  return (
    [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2]
    ] as Point[]
  ).map(([dx, dy]) => [
    cx + dx * Math.cos(t) - dy * Math.sin(t),
    cy + dx * Math.sin(t) + dy * Math.cos(t)
  ]);
}
function boxOf(quads: Quad[]): [number, number, number, number] {
  const xs = quads.flat().map((p) => p[0]);
  const ys = quads.flat().map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
/** The print's glyphs of a line: a pair of digits in a vertical line is set
 * tate-chu-yoko — side by side, upright, in ONE step. */
const printGlyphs = (line: string, vertical: boolean) =>
  vertical ? line.match(/[0-9]{2}|./gu)! : [...line];
/** Ink-free share of an em at the start / end of a glyph's cell. The fixture's
 * own copy (kana and katakana are all it draws at line ends) — what the
 * detector's quad leaves out must not come from the code under test. */
const INK: Record<string, [number, number]> = { hiragana: [0.11, 0.1], katakana: [0.12, 0.1] };
const inkOf = (ch: string) => INK[ch >= '\u30a0' && ch <= '\u30ff' ? 'katakana' : 'hiragana'];
/**
 * The quad a detector draws around a line printed in the box `cells`: the
 * glyphs are `em` big (no bigger than the box is thick), centred in their
 * steps, and the quad runs from the first glyph's ink to the last one's.
 */
function hug(cells: Quad, line: string, vertical: boolean): Quad {
  const glyphs = printGlyphs(line, vertical);
  const [p0, p1, p2, p3] = cells;
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [from, to] = vertical ? [mid(p0, p1), mid(p2, p3)] : [mid(p0, p3), mid(p1, p2)];
  const main = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const cross = vertical
    ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
    : Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  const step = main / glyphs.length;
  const em = Math.min(cross, step);
  const axis: Point = [(to[0] - from[0]) / main, (to[1] - from[1]) / main];
  const start = (step - em) / 2 + inkOf(glyphs[0])[0] * em;
  const end = (step - em) / 2 + inkOf(glyphs[glyphs.length - 1])[1] * em;
  const shift = (p: Point, d: number): Point => [p[0] + axis[0] * d, p[1] + axis[1] * d];
  return vertical
    ? [shift(p0, start), shift(p1, start), shift(p2, -end), shift(p3, -end)]
    : [shift(p0, start), shift(p1, -end), shift(p2, -end), shift(p3, start)];
}
/** @param quads the file's quads, when they are NOT the ink-hugging ones */
function block(
  vertical: boolean,
  fontSize: number,
  lines: string[],
  cells: Quad[],
  quads: Quad[] = cells.map((c, i) => hug(c, lines[i], vertical))
): FixtureBlock {
  return { box: boxOf(cells), vertical, font_size: fontSize, lines, lines_coords: quads, cells };
}

const KANA8 = 'あいうえおかきく';
// 8 fullwidth glyphs at 40px are 320px; they are tracked out over 400px.
const V_LOOSE = block(true, 40, [KANA8], [upright(300, 300, 340, 700)]);
const H_LOOSE = block(false, 40, [KANA8], [upright(500, 300, 900, 340)]);
// Two half-width digits among fullwidth characters. The quad is the box
// itself: a loose detector, and the text cannot match the print glyph for
// glyph anyway (the print sets 12 upright in one cell).
const MIXED = '第12話ですよ';
const V_MIXED_BOX = [upright(300, 900, 340, 1200)];
const V_MIXED = block(true, 40, [MIXED], V_MIXED_BOX, V_MIXED_BOX);
const H_MIXED_BOX = [upright(500, 900, 800, 940)];
const H_MIXED = block(false, 40, [MIXED], H_MIXED_BOX, H_MIXED_BOX);
// SFX-like tilted lines: 6 glyphs at 50px in a 50 × 360 quad.
const SFX = 'ドドドドドド';
const ROT_20 = block(true, 50, [SFX], [tilted(450, 1700, 50, 360, 20)]);
const ROT_M35 = block(true, 50, [SFX], [tilted(950, 1700, 50, 360, -35)]);
const H_ROT_M15 = block(false, 50, [SFX], [tilted(1300, 650, 360, 50, -15)]);
// An ordinary upright balloon, set solid at 40px: every line fills its cells
// exactly (no spacing at all: the previous build's glyph positions, to the
// pixel). The detector drew line 2's quad 10px too LONG — the block's pitch,
// anchored at the line's start, must not stretch the line over it.
const BALLOON_LINES = ['あいうえおかきく', 'かきくけこさ', 'さしすせそ'];
const BALLOON_CELLS = [
  upright(1300, 1100, 1340, 1420),
  upright(1250, 1100, 1290, 1340),
  upright(1200, 1100, 1240, 1300)
];
const BALLOON_SLACK = 10;
const BALLOON = block(
  true,
  40,
  BALLOON_LINES,
  BALLOON_CELLS,
  BALLOON_CELLS.map((c, i) => {
    const quad = hug(c, BALLOON_LINES[i], true);
    if (i === 2) quad[2][1] = quad[3][1] += BALLOON_SLACK;
    return quad;
  })
);
// A quad thicker than its text (56px around 40px glyphs), as detector quads
// usually are: viewer and editor must both centre the column ACROSS it.
const V_FAT = block(true, 40, ['たちつてとな'], [upright(1500, 1500, 1556, 1740)]);
const BLOCKS = [V_LOOSE, H_LOOSE, V_MIXED, H_MIXED, ROT_20, ROT_M35, H_ROT_M15, BALLOON, V_FAT];
const PAGE: FixturePage = {
  version: '0.3.0b',
  img_width: 1700,
  img_height: 2800,
  img_path: 'grid.png',
  blocks: BLOCKS
};

// ORIGINAL mode: the file's placement at the file's SIZE — capped where the
// file's own quads contradict it. The print is 50px SFX on a 60px step and
// 40px kana set solid; the file's font_size says otherwise, the way mokuro's
// does (it is the quad's thickness, ruby and mask slack included — and
// sometimes short).
const FILE_UNDER = block(true, 44, [SFX], [tilted(450, 2350, 50, 360, 25)]);
const FILE_OVER = block(false, 70, [SFX], [tilted(1100, 2350, 360, 50, -12)]);
const FILE_SOLID_OVER = block(true, 46, [KANA8], [upright(300, 300, 340, 620)]);
// mokuro's usual contradiction: a balloon of 40px print set solid — three
// columns 50px apart — whose font_size says 56 (1.4× its own pitch). Rendered
// as filed the glyphs draw on top of each other (−0.29em) and the columns run
// into their neighbours sideways (56px glyphs every 50px).
const FILE_BUBBLE_OVER = block(true, 56, BALLOON_LINES, BALLOON_CELLS);
// No quads at all: nothing to place the lines on, in any mode.
const FILE_LEGACY: FixtureBlock = {
  ...block(
    true,
    40,
    ['たちつてとな', 'にぬねの'],
    [upright(1560, 300, 1600, 540), upright(1510, 300, 1550, 460)]
  ),
  noQuads: true
};
const ORIGINAL_BLOCKS = [
  ROT_M35,
  H_ROT_M15,
  FILE_UNDER,
  FILE_OVER,
  FILE_SOLID_OVER,
  FILE_BUBBLE_OVER,
  FILE_LEGACY
];
const ORIGINAL_PAGE: FixturePage = { ...PAGE, blocks: ORIGINAL_BLOCKS };

async function seedVolume(page: Page, pages: FixturePage[], fontSize: string) {
  await gotoApp(page);
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOLUME_UUID, pages, fontSize }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      await Promise.all([
        db.volumes.clear(),
        db.volume_ocr.clear(),
        db.volume_files.clear(),
        db.volume_ocr_layers.clear()
      ]);
      // The app registers Noto Sans JP by script (web-fonts.ts): until it has,
      // `fonts.load` finds no face and the reference is drawn in the fallback.
      await (await import('/src/lib/util/web-fonts.ts')).loadWebFonts();
      await document.fonts.load("40px 'Noto Sans JP'").catch(() => undefined);
      const files: Record<string, File> = {};
      for (const p of pages) {
        const canvas = document.createElement('canvas');
        canvas.width = p.img_width;
        canvas.height = p.img_height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, p.img_width, p.img_height);
        for (const b of p.blocks) {
          b.cells.forEach((quad, i) => {
            // the box of cells (pale) and the file's ink-hugging quad
            for (const [outline, colour] of [
              [quad, '#bae6fd'],
              [b.lines_coords[i], '#38bdf8']
            ] as const) {
              ctx.strokeStyle = colour;
              ctx.lineWidth = 1;
              ctx.beginPath();
              outline.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
              ctx.closePath();
              ctx.stroke();
            }
            // the "print": one glyph per step of the box, in the box's frame
            const mid = (a: number[], c: number[]) => [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
            const [p0, p1, p2, p3] = quad;
            const [from, to] = b.vertical ? [mid(p0, p1), mid(p2, p3)] : [mid(p0, p3), mid(p1, p2)];
            const main = Math.hypot(to[0] - from[0], to[1] - from[1]);
            const cross = b.vertical
              ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
              : Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
            // A pair of digits in a vertical line is set tate-chu-yoko: side
            // by side, upright, in ONE step.
            const glyphs = b.vertical ? b.lines[i].match(/[0-9]{2}|./gu)! : [...b.lines[i]];
            const size = Math.min(cross, main / glyphs.length);
            const angle = b.vertical
              ? Math.atan2(-(to[0] - from[0]), to[1] - from[1])
              : Math.atan2(to[1] - from[1], to[0] - from[0]);
            ctx.fillStyle = '#111';
            ctx.font = `${size}px 'Noto Sans JP', sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            glyphs.forEach((glyph, k) => {
              const t = (k + 0.5) / glyphs.length;
              ctx.save();
              ctx.translate(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
              ctx.rotate(angle);
              ctx.fillText(glyph, 0, 0, size);
              ctx.restore();
            });
          });
        }
        const blob: Blob = await new Promise((r) => canvas.toBlob((c) => r(c!), 'image/png'));
        files[p.img_path] = new File([blob], p.img_path, { type: 'image/png' });
      }
      const counts = pages.map((p) => p.blocks.reduce((n, b) => n + b.lines.join('').length, 0));
      let total = 0;
      await db.volumes.put({
        volume_uuid: VOLUME_UUID,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.3.0b',
        page_count: pages.length,
        character_count: counts.reduce((a, c) => a + c, 0),
        page_char_counts: counts.map((n) => (total += n))
      });
      // `cells` is the fixture's, not the file's
      const filePages = pages.map((p) => ({
        ...p,
        blocks: p.blocks.map(({ cells: _cells, noQuads, ...fileBlock }) => {
          if (!noQuads) return fileBlock;
          const { lines_coords: _quads, ...legacy } = fileBlock;
          return legacy;
        })
      }));
      await db.volume_ocr.put({ volume_uuid: VOLUME_UUID, pages: filePages });
      await db.volume_files.put({ volume_uuid: VOLUME_UUID, files });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('singlePageView', 'single');
      updateSetting('displayOCR', true);
      updateSetting('alwaysShowOCR', true);
      updateSetting('fontSize', fontSize as never);
      window.localStorage.removeItem('sidecar-backfill:edited-volumes');
    },
    { SERIES, SERIES_UUID, VOLUME_UUID, pages, fontSize }
  );
}

async function waitForPositioned(page: Page, pageIndex = 0) {
  await page.waitForFunction((pageIndex) => {
    const lines = document.querySelectorAll<HTMLElement>(
      `[data-page-index="${pageIndex}"] .positionedLine`
    );
    return lines.length > 0 && [...lines].every((l) => l.style.transform !== '');
  }, pageIndex);
  await page.evaluate(() => document.fonts.ready);
  // The font-ready re-measure runs on the next frame.
  await page.waitForTimeout(250);
}

async function openReader(page: Page, positioned = true) {
  // The catalog may still be reacting to the freshly seeded rows, and a hash
  // set mid-reaction bounces straight back to the catalog. Setting the route
  // once after a fixed sleep loses that race on a loaded machine, and every
  // later `[data-page-index="0"]` lookup then dereferences null — so set the
  // route, and set it again whenever it has bounced, until it sticks.
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ SERIES_UUID, VOLUME_UUID }) => {
            const target = `#/reader/${SERIES_UUID}/${VOLUME_UUID}`;
            if (window.location.hash !== target) {
              window.location.hash = target;
              return false;
            }
            return !!document.querySelector('[data-page-index="0"]');
          },
          { SERIES_UUID, VOLUME_UUID }
        ),
      { timeout: 30000, intervals: [100, 200, 400, 800] }
    )
    .toBe(true);
  await expect(page.locator('[data-page-index="0"]')).toBeVisible({ timeout: 20000 });
  if (positioned) await waitForPositioned(page);
}

/**
 * Re-assert the reader page before measuring it. The route can bounce back to
 * the catalog after `openReader` returns, and a `querySelector(...)!` on a
 * unmounted page throws an opaque null-dereference instead of waiting.
 */
async function requireReaderPage(page: Page, pageIndex = 0) {
  await expect(page.locator(`[data-page-index="${pageIndex}"]`)).toBeVisible({ timeout: 20000 });
}

async function setFontSize(page: Page, fontSize: string) {
  await page.evaluate(async (fontSize) => {
    const { updateSetting } = await import('/src/lib/settings/index.ts');
    updateSetting('fontSize', fontSize as never);
  }, fontSize);
  await page.waitForTimeout(400);
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface MeasuredLine {
  text: string;
  /** bbox of the (possibly turned) span, image px relative to the page */
  box: Rect;
  fontSize: number;
  letterSpacing: number;
  transform: string;
  transformOrigin: string;
  children: number;
  textNodes: number;
  /** one per character: the bbox of a Range over it */
  glyphs: Rect[];
}
interface MeasuredBlock {
  left: number;
  top: number;
  lines: MeasuredLine[];
}

/** Every block of the page in IMAGE px relative to the page element — zoom is
 * an ancestor transform, so screen rects divide by the page's rendered scale. */
async function measure(page: Page): Promise<MeasuredBlock[]> {
  await requireReaderPage(page);
  return page.evaluate(() => {
    const pageEl = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
    const origin = pageEl.getBoundingClientRect();
    const scale = origin.width / pageEl.offsetWidth;
    const rel = (r: DOMRect) => ({
      x: (r.left - origin.left) / scale,
      y: (r.top - origin.top) / scale,
      w: r.width / scale,
      h: r.height / scale
    });
    return [...pageEl.querySelectorAll<HTMLElement>('.textBox')].map((box) => ({
      left: parseFloat(box.style.left),
      top: parseFloat(box.style.top),
      lines: [...box.querySelectorAll<HTMLElement>('.ocr-line')].map((line) => {
        const node = [...line.childNodes].find(
          (n) => n.nodeType === Node.TEXT_NODE && n.nodeValue !== ''
        ) as Text;
        const style = getComputedStyle(line);
        return {
          text: line.textContent!,
          box: rel(line.getBoundingClientRect()),
          fontSize: parseFloat(style.fontSize),
          letterSpacing: parseFloat(style.letterSpacing) || 0,
          transform: line.style.transform,
          transformOrigin: line.style.transformOrigin,
          children: line.children.length,
          textNodes: [...line.childNodes].filter(
            (n) => n.nodeType === Node.TEXT_NODE && n.nodeValue !== ''
          ).length,
          // every character here is one UTF-16 unit
          glyphs: [...node.data].map((_, k) => {
            const range = document.createRange();
            range.setStart(node, k);
            range.setEnd(node, k + 1);
            return rel(range.getBoundingClientRect());
          })
        };
      })
    }));
  });
}

function findBlock(measured: MeasuredBlock[], b: FixtureBlock): MeasuredBlock {
  const found = measured.find(
    (m) => Math.abs(m.left - b.box[0]) < 0.01 && Math.abs(m.top - b.box[1]) < 0.01
  );
  expect(found, `a block is rendered at ${b.box.slice(0, 2)}`).toBeTruthy();
  return found!;
}

/** A quad as the turned box it is — the same construction as line-grid.ts, on purpose
 * written out again: the expectation must not come from the code under test. */
function frameOf(quad: Quad, vertical: boolean) {
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const [p0, p1, p2, p3] = quad;
  const [from, to] = vertical ? [mid(p0, p1), mid(p2, p3)] : [mid(p0, p3), mid(p1, p2)];
  const main = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const axis: Point = [(to[0] - from[0]) / main, (to[1] - from[1]) / main];
  return { centre: mid(from, to), from, main, axis };
}
/** Centre of grid cell k of n: (k + 0.5) · main / n along the line's axis. */
function cellCentre(quad: Quad, vertical: boolean, k: number, n: number): Point {
  const { from, main, axis } = frameOf(quad, vertical);
  const d = ((k + 0.5) * main) / n;
  return [from[0] + axis[0] * d, from[1] + axis[1] * d];
}
/** Is `p` at least `margin` px outside the turned quad? */
function clearOfQuad(p: Point, quad: Quad, vertical: boolean, margin: number): boolean {
  const { centre, main, axis } = frameOf(quad, vertical);
  const cross = Math.hypot(
    quad[vertical ? 1 : 3][0] - quad[0][0],
    quad[vertical ? 1 : 3][1] - quad[0][1]
  );
  const d = [p[0] - centre[0], p[1] - centre[1]];
  const alongAxis = Math.abs(d[0] * axis[0] + d[1] * axis[1]);
  const acrossAxis = Math.abs(d[0] * axis[1] - d[1] * axis[0]);
  return alongAxis > main / 2 + margin || acrossAxis > cross / 2 + margin;
}
const centreOf = (r: Rect): Point => [r.x + r.w / 2, r.y + r.h / 2];
const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Where a glyph's INK is centred. A Range over one character covers its whole
 * advance, and the browser puts the letter-spacing AFTER the glyph — so the
 * rect's centre is half a spacing late along the reading axis. (Verified below
 * on an upright line, where the rect's length can be read off directly.)
 */
function inkCentre(glyph: Rect, axis: Point, letterSpacing: number): Point {
  const [x, y] = centreOf(glyph);
  return [x - (axis[0] * letterSpacing) / 2, y - (axis[1] * letterSpacing) / 2];
}

async function shot(page: Page, name: string, box: number[], pad = 40) {
  await requireReaderPage(page);
  mkdirSync(SHOTS, { recursive: true });
  // See the print through the overlay: no white ground, translucent text.
  const style = await page.addStyleTag({
    content:
      '.textBox, .textBox p { background: transparent !important; }' +
      '.textBox p { color: rgba(225, 29, 72, 0.8) !important; }'
  });
  const clip = await page.evaluate(
    ({ box, pad }) => {
      const el = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
      const origin = el.getBoundingClientRect();
      const scale = origin.width / el.offsetWidth;
      return {
        x: origin.left + (box[0] - pad) * scale,
        y: origin.top + (box[1] - pad) * scale,
        width: (box[2] - box[0] + 2 * pad) * scale,
        height: (box[3] - box[1] + 2 * pad) * scale
      };
    },
    { box, pad }
  );
  await page.screenshot({ path: join(SHOTS, `${name}.png`), clip });
  await style.evaluate((el) => el.remove());
}

/**
 * A line on a TILTED quad, measured against the print: the turn, the span and
 * its ink centred on the box of cells, every glyph on its step of the turned
 * grid, and the browser's own hit-testing following the turn. One body for
 * auto and original mode — the font mode changes the glyph SIZE, not one
 * tolerance of where the glyphs have to be.
 */
async function probeTurnedLine(
  page: Page,
  measured: MeasuredBlock[],
  mode: string,
  name: string,
  b: FixtureBlock,
  degrees: number
) {
  await requireReaderPage(page);
  // the box of cells the print is drawn in; the file's quad hugs its ink
  const quad = b.cells[0];
  const line = findBlock(measured, b).lines[0];
  let caretHits = 0;
  let caretExact = 0;
  let caretProbes = 0;
  let quarterHits = 0;
  let quarterProbes = 0;
  const { centre, axis } = frameOf(quad, b.vertical);
  const n = line.glyphs.length;
  expect(line.text).toBe(SFX);
  expect(line.children).toBe(0);
  expect(line.textNodes).toBe(1);
  const turn = /rotate\((-?[\d.]+)deg\)/.exec(line.transform);
  expect(turn, line.transform).not.toBeNull();
  expect(Number(turn![1])).toBeCloseTo(degrees, 4);

  // The span's box runs from half a spacing past the cells' start to half
  // a spacing past their end (the trailing spacing of the last glyph), so
  // its centre sits that far along the axis; the INK is centred on them.
  const half = line.letterSpacing / 2;
  const spanCentre = centreOf(line.box);
  const spanError = distance(spanCentre, [centre[0] + axis[0] * half, centre[1] + axis[1] * half]);
  const first = inkCentre(line.glyphs[0], axis, line.letterSpacing);
  const last = inkCentre(line.glyphs[n - 1], axis, line.letterSpacing);
  const inkError = distance([(first[0] + last[0]) / 2, (first[1] + last[1]) / 2], centre);
  expect(spanError).toBeLessThanOrEqual(2);
  expect(inkError).toBeLessThanOrEqual(2);

  const gridErrors = line.glyphs.map((glyph, k) =>
    distance(inkCentre(glyph, axis, line.letterSpacing), cellCentre(quad, b.vertical, k, n))
  );
  for (const e of gridErrors) expect(e).toBeLessThanOrEqual(3);

  // Hit-testing, in SCREEN px: what a pointer (and Yomitan under it) sees.
  const probes = await page.evaluate(
    ({ box, cells, quarters, outside }) => {
      const pageEl = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
      const origin = pageEl.getBoundingClientRect();
      const scale = origin.width / pageEl.offsetWidth;
      const screen = ([x, y]: number[]) => [origin.left + x * scale, origin.top + y * scale];
      const textBox = [...pageEl.querySelectorAll<HTMLElement>('.textBox')].find(
        (el) =>
          Math.abs(parseFloat(el.style.left) - box[0]) < 0.01 &&
          Math.abs(parseFloat(el.style.top) - box[1]) < 0.01
      )!;
      const span = textBox.querySelector<HTMLElement>('.ocr-line')!;
      const caretAt = (p: number[]) => {
        const [x, y] = screen(p);
        const caret = document.caretRangeFromPoint(x, y);
        return caret && span.contains(caret.startContainer) ? caret.startOffset : -1;
      };
      const elementAt = (p: number[]) => {
        const [x, y] = screen(p);
        const el = document.elementFromPoint(x, y);
        return { isSpan: el === span, inTextBox: !!el && textBox.contains(el) };
      };
      return {
        cells: cells.map((p) => ({ ...elementAt(p), caret: caretAt(p) })),
        quarters: quarters.map(([before, after]) => [caretAt(before), caretAt(after)]),
        outside: outside.map(elementAt)
      };
    },
    {
      box: b.box,
      cells: line.glyphs.map((_, k) => cellCentre(quad, b.vertical, k, n)),
      // a quarter and three quarters of the way through each step
      quarters: line.glyphs.map((_, k) => [
        cellCentre(quad, b.vertical, k - 0.25, n),
        cellCentre(quad, b.vertical, k + 0.25, n)
      ]),
      // the bbox's corners, 6px in: inside the quad's axis-aligned bbox
      // (and the .textBox). A shallow tilt puts the quad's own corners in
      // two of them; the rest are empty paper, 10px or more clear of it.
      outside: (
        [
          [b.box[0] + 6, b.box[1] + 6],
          [b.box[2] - 6, b.box[1] + 6],
          [b.box[2] - 6, b.box[3] - 6],
          [b.box[0] + 6, b.box[3] - 6]
        ] as Point[]
      ).filter((p) => clearOfQuad(p, quad, b.vertical, 10))
    }
  );

  // every rotated cell centre is ON the span…
  for (const [k, probe] of probes.cells.entries())
    expect(probe.isSpan, `${name}: elementFromPoint at cell ${k}`).toBe(true);
  // …and the empty corners of its bbox are not (they hit the box behind it)
  expect(probes.outside.length).toBeGreaterThanOrEqual(2);
  for (const [k, probe] of probes.outside.entries()) {
    expect(probe.isSpan, `${name}: bbox corner ${k} is outside the turned line`).toBe(false);
    expect(probe.inTextBox).toBe(true);
  }
  // the caret at cell k's centre is at character k (before or after it)
  probes.cells.forEach((probe, k) => {
    caretProbes++;
    if (probe.caret === k || probe.caret === k + 1) caretHits++;
    if (probe.caret === k) caretExact++;
    expect([k - 1, k, k + 1, k + 2], `${name}: caret at cell ${k} → ${probe.caret}`).toContain(
      probe.caret
    );
  });
  // a quarter into the step the caret is before k; three quarters, after
  probes.quarters.forEach(([before, after], k) => {
    quarterProbes += 2;
    if (before === k) quarterHits++;
    if (after === k + 1) quarterHits++;
  });

  console.log(
    `[line-grid] ${mode} ${name}: rotate(${turn![1]}deg); span centre ${spanError.toFixed(2)}px, ink centre ${inkError.toFixed(2)}px ` +
      `off the quad centre; glyph-vs-rotated-grid max ${Math.max(...gridErrors).toFixed(2)}px ` +
      `[${gridErrors.map((e) => e.toFixed(2)).join(' ')}]; elementFromPoint ${probes.cells.filter((p) => p.isSpan).length}/${n} cells, ` +
      `${probes.outside.filter((p) => !p.isSpan).length}/${probes.outside.length} empty bbox corners miss; caret offsets at cell centres [${probes.cells.map((p) => p.caret).join(' ')}]`
  );
  return { line, gridErrors, caretHits, caretExact, caretProbes, quarterHits, quarterProbes };
}

test.describe('line grid — viewer', () => {
  // Denser raster only: CSS px (and so every measurement) are unchanged, but a
  // fit-to-screen page is ~0.4x and its glyphs are unreadable in a 1x capture.
  test.use({ deviceScaleFactor: 3 });

  test('(1) fixed-pitch grid: every glyph centred in its step, vertical and horizontal; mixed widths stay inside', async ({
    page
  }) => {
    await seedVolume(page, [PAGE], 'auto');
    await openReader(page);
    const measured = await measure(page);

    for (const [name, b] of [
      ['vertical', V_LOOSE],
      ['horizontal', H_LOOSE]
    ] as const) {
      const line = findBlock(measured, b).lines[0];
      const { axis, main } = frameOf(b.cells[0], b.vertical);
      const n = line.glyphs.length;
      expect(n).toBe(8);
      expect(line.fontSize).toBeCloseTo(40, 3);
      // 40px glyphs on the print's 50px step, recovered from a quad that
      // spans only the INK: 400px of cells less the ends of the end cells
      expect(line.letterSpacing).toBeCloseTo(10, 1);
      // The premise of inkCentre(): a character's Range rect is its advance
      // PLUS the trailing spacing.
      const length = (r: Rect) => (b.vertical ? r.h : r.w);
      expect(length(line.glyphs[0])).toBeCloseTo(line.fontSize + line.letterSpacing, 0);

      const errors = line.glyphs.map((glyph, k) => {
        const ink = inkCentre(glyph, axis, line.letterSpacing);
        const cell = cellCentre(b.cells[0], b.vertical, k, n);
        return (ink[0] - cell[0]) * axis[0] + (ink[1] - cell[1]) * axis[1];
      });
      console.log(
        `[line-grid] ${name} loose line (cells ${main}px, natural run ${n * line.fontSize}px): ` +
          `letter-spacing ${line.letterSpacing.toFixed(2)}px; glyph-vs-cell centre error ` +
          `max ${Math.max(...errors.map(Math.abs)).toFixed(2)}px [${errors.map((e) => e.toFixed(2)).join(' ')}]`
      );
      for (const e of errors) expect(Math.abs(e)).toBeLessThanOrEqual(2);
      // and across the line: the glyphs ride the quad's centre line
      const cross = (p: Point) => p[0] * axis[1] - p[1] * axis[0];
      const quadCentre = frameOf(b.cells[0], b.vertical).centre;
      for (const glyph of line.glyphs)
        expect(Math.abs(cross(centreOf(glyph)) - cross(quadCentre))).toBeLessThanOrEqual(2);
    }

    for (const [name, b] of [
      ['vertical', V_MIXED],
      ['horizontal', H_MIXED]
    ] as const) {
      const line = findBlock(measured, b).lines[0];
      expect(line.text).toBe(MIXED);
      expect(line.letterSpacing).toBeGreaterThan(0);
      const [q0, q1] = b.vertical ? [b.box[1], b.box[3]] : [b.box[0], b.box[2]];
      const spans = line.glyphs.map((g) => {
        const start = b.vertical ? g.y : g.x;
        // the INK ends where the rect does, less the trailing spacing
        return [start, start + (b.vertical ? g.h : g.w) - line.letterSpacing];
      });
      // a glyph's BOX may leave the quad by the ink-free part of its cell
      // (0.05em before 第, 0.10em after よ) — its ink does not
      const size = line.fontSize;
      for (const [k, [start, end]] of spans.entries()) {
        expect(start, `${name} glyph ${k} starts inside the quad`).toBeGreaterThanOrEqual(
          q0 - 0.05 * size - 0.5
        );
        expect(end, `${name} glyph ${k} ends inside the quad`).toBeLessThanOrEqual(
          q1 + 0.1 * size + 0.5
        );
        if (k)
          expect(start, `${name} glyph ${k} follows glyph ${k - 1}`).toBeGreaterThan(
            spans[k - 1][0]
          );
      }
      // the digits kept their own narrow advance: the grid did not widen them
      const advance = (k: number) => spans[k][1] - spans[k][0];
      expect(advance(1)).toBeLessThan(advance(0) * 0.8);
      expect(advance(2)).toBeLessThan(advance(0) * 0.8);
      // and the run is flush with the quad: the first glyph's INK starts where
      // the quad does, the last one's ends where it ends
      expect(spans[0][0] + 0.05 * size).toBeCloseTo(q0, 0);
      expect(spans[spans.length - 1][1] - 0.1 * size).toBeCloseTo(q1, 0);
      console.log(
        `[line-grid] ${name} mixed line "${MIXED}": letter-spacing ${line.letterSpacing.toFixed(2)}px, ` +
          `advances [${spans.map((_, k) => advance(k).toFixed(1)).join(' ')}], ` +
          `first box ${(q0 - spans[0][0]).toFixed(2)}px before the quad start, last box ${(spans[spans.length - 1][1] - q1).toFixed(2)}px past its end`
      );
    }

    await shot(page, 'grid-vertical-loose', V_LOOSE.box);
    await shot(page, 'grid-horizontal-loose', H_LOOSE.box);
    await shot(page, 'grid-vertical-mixed', V_MIXED.box);
  });

  test('(2) rotation: the line lands on its tilted quad, and hit-testing follows it', async ({
    page
  }) => {
    await seedVolume(page, [PAGE], 'auto');
    await openReader(page);
    const measured = await measure(page);

    let caretHits = 0;
    let caretExact = 0;
    let caretProbes = 0;
    let quarterHits = 0;
    let quarterProbes = 0;
    for (const [name, b, degrees] of [
      ['vertical +20°', ROT_20, 20],
      ['vertical -35°', ROT_M35, -35],
      ['horizontal -15°', H_ROT_M15, -15]
    ] as const) {
      const probed = await probeTurnedLine(page, measured, 'auto', name, b, degrees);
      caretHits += probed.caretHits;
      caretExact += probed.caretExact;
      caretProbes += probed.caretProbes;
      quarterHits += probed.quarterHits;
      quarterProbes += probed.quarterProbes;
    }
    console.log(
      `[line-grid] touch zones: caret at a rotated cell centre is on character k (offset k or k+1) ${caretHits}/${caretProbes} ` +
        `(exactly k: ${caretExact}); quarter-step probes resolve to the exact side ${quarterHits}/${quarterProbes}`
    );
    expect(caretHits).toBe(caretProbes);
    expect(quarterHits / quarterProbes).toBeGreaterThanOrEqual(0.9);

    // After: the build as it is. Before: the same line as the previous build
    // placed it — upright at the quad's bbox, no spacing (its formula,
    // applied to the live span) — so the two captures differ in nothing else.
    await shot(page, 'tilted-sfx-after', ROT_20.box);
    await shot(page, 'tilted-sfx-minus35-after', ROT_M35.box);
    await shot(page, 'tilted-sfx-horizontal-after', H_ROT_M15.box);
    await page.evaluate(
      ({ boxes }) => {
        const pageEl = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
        for (const { box, vertical } of boxes) {
          const textBox = [...pageEl.querySelectorAll<HTMLElement>('.textBox')].find(
            (el) =>
              Math.abs(parseFloat(el.style.left) - box[0]) < 0.01 &&
              Math.abs(parseFloat(el.style.top) - box[1]) < 0.01
          )!;
          const span = textBox.querySelector<HTMLElement>('.ocr-line')!;
          span.style.letterSpacing = '0px';
          span.style.transform = 'none';
          const size = parseFloat(span.style.fontSize);
          const [w, h] = [box[2] - box[0], box[3] - box[1]];
          const left = vertical ? w / 2 - size / 2 : 0;
          const top = vertical ? 0 : h / 2 - size / 2;
          span.style.transform = `translate(${left - span.offsetLeft}px, ${top - span.offsetTop}px)`;
        }
      },
      {
        boxes: [ROT_20, ROT_M35, H_ROT_M15].map((b) => ({ box: b.box, vertical: b.vertical }))
      }
    );
    await shot(page, 'tilted-sfx-before', ROT_20.box);
    await shot(page, 'tilted-sfx-minus35-before', ROT_M35.box);
    await shot(page, 'tilted-sfx-horizontal-before', H_ROT_M15.box);
  });

  test('(3) selection: a line reads as its string, a block as it does without the grid', async ({
    page
  }) => {
    await seedVolume(page, [PAGE], 'auto');
    await openReader(page);

    const select = () =>
      page.evaluate(() => {
        const texts = (el: Element) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const out: Text[] = [];
          for (let n = walker.nextNode(); n; n = walker.nextNode())
            if ((n as Text).data !== '') out.push(n as Text);
          return out;
        };
        const pick = (from: Element, to: Element) => {
          const range = document.createRange();
          range.setStart(texts(from)[0], 0);
          const end = texts(to).at(-1)!;
          range.setEnd(end, end.data.length);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          return selection.toString();
        };
        const pageEl = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
        return [...pageEl.querySelectorAll<HTMLElement>('.textBox')].map((box) => {
          const lines = [...box.querySelectorAll('.ocr-line')];
          return {
            left: parseFloat(box.style.left),
            top: parseFloat(box.style.top),
            perLine: lines.map((line) => pick(line, line)),
            whole: pick(lines[0], lines[lines.length - 1]),
            paragraph: box.querySelector('p')!.textContent
          };
        });
      });

    const gridded = await select();
    // A manual size is the renderer with none of this: no per-line layout, no
    // letter-spacing of ours, no transform.
    await setFontSize(page, '24');
    await expect(page.locator('.positionedLine')).toHaveCount(0);
    const plain = await select();

    const at = (b: FixtureBlock) => (x: { left: number; top: number }) =>
      Math.abs(x.left - b.box[0]) < 0.01 && Math.abs(x.top - b.box[1]) < 0.01;
    for (const b of BLOCKS) {
      const withGrid = gridded.find(at(b))!;
      const without = plain.find(at(b))!;
      // first to last character of a line: the whole line, rotated or spaced
      expect(withGrid.perLine).toEqual(b.lines);
      expect(withGrid.whole).toBe(without.whole);
      expect(withGrid.whole.replace(/\n/g, '')).toBe(b.lines.join(''));
      // what a DOM text scanner walks: one continuous run (#254)
      expect(withGrid.paragraph).toBe(b.lines.join(''));
    }
    console.log(
      `[line-grid] selection across the 3-line balloon: ${JSON.stringify(gridded.find(at(BALLOON))!.whole)}; ` +
        `across the +20° line: ${JSON.stringify(gridded.find(at(ROT_20))!.whole)}`
    );
  });

  test('(4) no per-character elements, in either font mode', async ({ page }) => {
    await seedVolume(page, [PAGE], 'auto');
    await openReader(page);
    for (const mode of ['auto', 'original'] as const) {
      if (mode !== 'auto') await setFontSize(page, mode);
      const measured = await measure(page);
      for (const b of BLOCKS)
        for (const line of findBlock(measured, b).lines) {
          expect(line.children, mode).toBe(0);
          expect(line.textNodes, mode).toBe(1);
        }
    }
  });

  test('(5) upright lines set solid stay where the previous build put them; a quad that ends late does not stretch its line', async ({
    page
  }) => {
    await seedVolume(page, [PAGE], 'auto');
    await openReader(page);
    const lines = findBlock(await measure(page), BALLOON).lines;

    const report: string[] = [];
    BALLOON.cells.forEach((cells, i) => {
      const line = lines[i];
      const [x0, y0] = cells[0];
      const x1 = cells[1][0];
      // The previous build, from the print alone: one size per balloon (the
      // 40px the lines are set at), the column centred on its quad, every
      // glyph box on its cell — not a pixel of difference, and no spacing.
      expect(line.fontSize).toBeCloseTo(40, 3);
      expect(line.letterSpacing).toBeCloseTo(0, 3);
      expect(line.transform).not.toContain('rotate');
      expect(line.transformOrigin).toBe('');
      expect(line.box.x + line.box.w / 2).toBeCloseTo((x0 + x1) / 2, 1);
      expect(line.box.w).toBeCloseTo(40, 1);
      expect(line.box.h).toBeCloseTo(line.glyphs.length * 40, 1);
      // Line 2's quad runs 10px past its ink. Stretched over it (the previous
      // build: 2px more per glyph) its last glyph would sit 8px late; on the
      // block's pitch, anchored at its start, it is on its cell like the rest.
      line.glyphs.forEach((glyph, k) => expect(glyph.y).toBeCloseTo(y0 + 40 * k, 1));
      report.push(
        `line ${i}: x-centre ${(line.box.x + line.box.w / 2).toFixed(2)} (cells ${(x0 + x1) / 2}), ` +
          `top ${line.box.y.toFixed(2)} (cells ${y0}, quad ${BALLOON.lines_coords[i][0][1].toFixed(1)}), ` +
          `letter-spacing ${line.letterSpacing}px`
      );
    });
    console.log(`[line-grid] upright balloon: ${report.join('; ')}`);
    await shot(page, 'upright-balloon', BALLOON.box);
  });

  test('(6) original mode: the same placement at the FILE’s font size (capped by the file’s own geometry: no colliding glyphs or columns) — turned, on the grid, hit-tested; auto → original → auto re-renders live', async ({
    page
  }) => {
    await seedVolume(page, [ORIGINAL_PAGE], 'auto');
    await openReader(page);
    /** Both frames of a re-measure: the action schedules one rAF per update. */
    const switchTo = async (fontSize: string) => {
      await setFontSize(page, fontSize);
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      );
    };
    const placed = ORIGINAL_BLOCKS.filter((b) => !b.noQuads);
    const shape = (measured: MeasuredBlock[]) =>
      placed.map((b) =>
        findBlock(measured, b).lines.map((l) => ({
          fontSize: l.fontSize,
          letterSpacing: l.letterSpacing,
          transform: l.transform,
          transformOrigin: l.transformOrigin,
          glyphs: l.glyphs.map((g) => [g.x, g.y, g.w, g.h].map((v) => Math.round(v * 100) / 100))
        }))
      );

    const auto = await measure(page);
    // auto FITS: the print's 50px and 40px, whatever the file says
    expect(findBlock(auto, FILE_UNDER).lines[0].fontSize).toBeCloseTo(50, 1);
    expect(findBlock(auto, FILE_OVER).lines[0].fontSize).toBeCloseTo(50, 1);
    expect(findBlock(auto, FILE_SOLID_OVER).lines[0].fontSize).toBeCloseTo(40, 1);

    await switchTo('original');
    const original = await measure(page);

    // Tilted lines: turned, at the file's size, on the turned grid — the very
    // probes and tolerances auto mode is held to in (2).
    const step = 360 / SFX.length; // the print's: six cells in the 360px box
    let caretHits = 0;
    let caretProbes = 0;
    let quarterHits = 0;
    let quarterProbes = 0;
    const worst: number[] = [];
    // The file's size is CAPPED where the file's own quads contradict it:
    // 70px on a 50px-thick quad renders at 1.2 × the thickness.
    for (const [name, b, degrees, size] of [
      ['vertical -35°, file 50px = print', ROT_M35, -35, 50],
      ['horizontal -15°, file 50px = print', H_ROT_M15, -15, 50],
      ['vertical +25°, file 44px < print', FILE_UNDER, 25, 44],
      ['horizontal -12°, file 70px > print (capped: 60px)', FILE_OVER, -12, 60]
    ] as const) {
      const probed = await probeTurnedLine(page, original, 'original', name, b, degrees);
      expect(probed.line.fontSize).toBeCloseTo(size, 3);
      // what is left of the print's step once that size is taken
      expect(probed.line.letterSpacing).toBeCloseTo(step - size, 1);
      caretHits += probed.caretHits;
      caretProbes += probed.caretProbes;
      quarterHits += probed.quarterHits;
      quarterProbes += probed.quarterProbes;
      worst.push(Math.max(...probed.gridErrors));
    }
    expect(caretHits).toBe(caretProbes);
    expect(quarterHits / quarterProbes).toBeGreaterThanOrEqual(0.9);

    // Upright, overstated: the file's 46px on the print's 40px step would
    // close the glyphs up by 0.13em. Capped at −0.05em (42.1px), each glyph
    // centred on its cell; the column centred across its quad.
    const solid = findBlock(original, FILE_SOLID_OVER).lines[0];
    const capped = 40 / 0.95;
    expect(solid.fontSize).toBeCloseTo(capped, 2);
    expect(solid.letterSpacing).toBeCloseTo(40 - capped, 1);
    expect(solid.transform).not.toContain('rotate');
    const solidErrors = solid.glyphs.map((glyph, k) =>
      distance(
        inkCentre(glyph, [0, 1], solid.letterSpacing),
        cellCentre(FILE_SOLID_OVER.cells[0], true, k, solid.glyphs.length)
      )
    );
    for (const e of solidErrors) expect(e).toBeLessThanOrEqual(3);

    // LEGIBILITY: a balloon whose font_size is 1.4× its own pitch. One size
    // for the bubble; no two adjacent glyphs of a line overlap by more than 5%
    // of a glyph; no column reaches into its neighbour.
    const bubble = findBlock(original, FILE_BUBBLE_OVER).lines;
    expect(bubble).toHaveLength(BALLOON_LINES.length);
    expect(FILE_BUBBLE_OVER.font_size / 40).toBeCloseTo(1.4, 6);
    let worstEmOverlap = -Infinity;
    let worstInkOverlap = -Infinity;
    bubble.forEach((line, i) => {
      expect(line.fontSize).toBeCloseTo(capped, 2);
      expect(line.transform).not.toContain('rotate');
      const size = line.fontSize;
      const [lead, trail] = inkOf(line.text[0]);
      line.glyphs.slice(0, -1).forEach((glyph, k) => {
        const next = line.glyphs[k + 1];
        // A Range over one character starts at its glyph's em box (the
        // spacing comes AFTER the glyph): the box is `size` long from there,
        // the ink what the fixture's own inset table leaves of it.
        const emOverlap = glyph.y + size - next.y;
        const inkOverlap = glyph.y + size * (1 - trail) - (next.y + size * lead);
        worstEmOverlap = Math.max(worstEmOverlap, emOverlap / size);
        worstInkOverlap = Math.max(worstInkOverlap, inkOverlap / size);
        expect(inkOverlap, `line ${i}: ink of glyphs ${k}/${k + 1}`).toBeLessThanOrEqual(
          0.05 * size
        );
        expect(emOverlap, `line ${i}: em boxes of glyphs ${k}/${k + 1}`).toBeLessThanOrEqual(
          0.05 * size + 0.1
        );
      });
      // each glyph still centred on its print cell
      line.glyphs.forEach((glyph, k) => {
        const error = distance(
          inkCentre(glyph, [0, 1], line.letterSpacing),
          cellCentre(FILE_BUBBLE_OVER.cells[i], true, k, line.glyphs.length)
        );
        expect(error, `line ${i} glyph ${k} on its cell`).toBeLessThanOrEqual(3);
      });
    });
    // Columns run right → left: no column's glyphs reach into the next one.
    // ACROSS the line a Range's rect is the font's whole content area (ascent
    // + descent, ~1.45em — overlapping rects mean nothing); the glyphs' em
    // boxes are `size` wide about its centre, which sits on the print column.
    const columns = bubble.map((line, i) => {
      const centre = line.glyphs.reduce((sum, g) => sum + g.x + g.w / 2, 0) / line.glyphs.length;
      const cell = FILE_BUBBLE_OVER.cells[i];
      expect(Math.abs(centre - (cell[0][0] + cell[1][0]) / 2)).toBeLessThanOrEqual(1);
      return { min: centre - line.fontSize / 2, max: centre + line.fontSize / 2 };
    });
    let worstSideways = -Infinity;
    for (let i = 0; i + 1 < columns.length; i++) {
      const sideways = columns[i + 1].max - columns[i].min;
      worstSideways = Math.max(worstSideways, sideways);
      expect(sideways, `columns ${i}/${i + 1} overlap sideways`).toBeLessThanOrEqual(0.5);
    }
    console.log(
      `[line-grid] original, font_size 1.4× the pitch: rendered at ${bubble[0].fontSize.toFixed(2)}px, ` +
        `letter-spacing ${bubble[0].letterSpacing.toFixed(2)}px; worst adjacent em-box overlap ${(worstEmOverlap * 100).toFixed(1)}% of a glyph, ` +
        `ink ${(worstInkOverlap * 100).toFixed(1)}%; columns closest ${(-worstSideways).toFixed(2)}px apart`
    );
    await shot(page, 'original-bubble-over', FILE_BUBBLE_OVER.box);

    // No quads: the whole-block paragraph at the file's size, as ever.
    const legacy = await page.evaluate((box) => {
      const textBox = [...document.querySelectorAll<HTMLElement>('.textBox')].find(
        (el) => parseFloat(el.style.left) === box[0] && parseFloat(el.style.top) === box[1]
      )!;
      return {
        classes: [...textBox.classList],
        fontSize: getComputedStyle(textBox.querySelector('.ocr-line')!).fontSize,
        positioned: textBox.querySelectorAll('.positionedLine').length,
        transforms: [...textBox.querySelectorAll<HTMLElement>('.ocr-line')].map(
          (l) => l.style.transform
        )
      };
    }, FILE_LEGACY.box);
    expect(legacy.classes).toContain('originalMode');
    expect(legacy.classes).not.toContain('perLine');
    expect(legacy.positioned).toBe(0);
    expect(legacy.fontSize).toBe('40px');
    expect(legacy.transforms).toEqual(['', '']);

    console.log(
      `[line-grid] original: glyph-vs-rotated-grid worst per line [${worst.map((e) => e.toFixed(2)).join(' ')}]px (limit 3, as auto); ` +
        `upright 46px-file-on-40px-step (capped ${capped.toFixed(1)}px) max ${Math.max(...solidErrors).toFixed(2)}px; caret on character ${caretHits}/${caretProbes}, ` +
        `quarter-step probes ${quarterHits}/${quarterProbes}`
    );
    await shot(page, 'original-tilted-under', FILE_UNDER.box);
    await shot(page, 'original-tilted-over', FILE_OVER.box);
    await shot(page, 'original-upright-over', FILE_SOLID_OVER.box);

    // Live: the same spans are re-sized and RE-MEASURED on every switch (the
    // action's signature carries the mode and every line's size, spacing and
    // turn). Original really differs from auto, and auto comes back exactly.
    expect(shape(original)).not.toEqual(shape(auto));
    await switchTo('auto');
    const back = await measure(page);
    expect(shape(back)).toEqual(shape(auto));
    await switchTo('original');
    expect(shape(await measure(page))).toEqual(shape(original));
  });
});

// The OCR editor draws a line the way the viewer does — one text node on the
// grid, turned with its quad — so what is being corrected sits where the
// reader will paint it, and a press on the turned text is a press on the line.
test.describe('line grid — editor', () => {
  test.use({ deviceScaleFactor: 3 });

  async function enterEditMode(page: Page) {
    await page.getByLabel('Quick actions menu').click();
    await page.getByLabel('Edit OCR').click();
    await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
  }

  /** Image px → screen px (zoom is an ancestor transform of the page). */
  async function toScreen(page: Page, p: Point): Promise<{ x: number; y: number }> {
    await requireReaderPage(page);
    return page.evaluate(([x, y]) => {
      const el = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
      const origin = el.getBoundingClientRect();
      const scale = origin.width / el.offsetWidth;
      return { x: origin.left + x * scale, y: origin.top + y * scale };
    }, p);
  }
  const pageScale = (page: Page) =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
      return el.getBoundingClientRect().width / el.offsetWidth;
    });

  interface EditorLine {
    text: string;
    fontSize: number;
    letterSpacing: number;
    transform: string;
    editable: boolean;
    childNodes: number;
    glyphs: Rect[];
    /** elementFromPoint at each glyph's centre is this line */
    hits: boolean[];
    /** caretRangeFromPoint at each glyph's centre: the offset it lands on */
    carets: (number | null)[];
  }
  async function measureEditorLine(page: Page, b: FixtureBlock): Promise<EditorLine> {
    await requireReaderPage(page);
    return page.evaluate(
      ([left, top]) => {
        const pageEl = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
        const origin = pageEl.getBoundingClientRect();
        const scale = origin.width / pageEl.offsetWidth;
        const block = [...pageEl.querySelectorAll<HTMLElement>('.editBlock')].find(
          (el) =>
            Math.abs(parseFloat(el.style.left) - left) < 0.01 &&
            Math.abs(parseFloat(el.style.top) - top) < 0.01
        )!;
        const line = block.querySelector<HTMLElement>('.line')!;
        const node = line.firstChild as Text;
        const style = getComputedStyle(line);
        const rects = [...node.data].map((_, k) => {
          const range = document.createRange();
          range.setStart(node, k);
          range.setEnd(node, k + 1);
          return range.getBoundingClientRect();
        });
        const spacing = (parseFloat(style.letterSpacing) || 0) * scale;
        const turn = /rotate\((-?[\d.]+)deg\)/.exec(line.style.transform);
        const t = ((turn ? parseFloat(turn[1]) : 0) * Math.PI) / 180;
        const vertical = style.writingMode === 'vertical-rl';
        const axis = vertical ? [-Math.sin(t), Math.cos(t)] : [Math.cos(t), Math.sin(t)];
        // the ink's centre: the Range covers the trailing letter-spacing too
        const centres = rects.map((r) => [
          r.left + r.width / 2 - (axis[0] * spacing) / 2,
          r.top + r.height / 2 - (axis[1] * spacing) / 2
        ]);
        return {
          text: line.textContent!,
          fontSize: parseFloat(style.fontSize),
          letterSpacing: parseFloat(style.letterSpacing) || 0,
          transform: line.style.transform,
          editable: line.isContentEditable,
          childNodes: line.childNodes.length,
          glyphs: rects.map((r) => ({
            x: (r.left - origin.left) / scale,
            y: (r.top - origin.top) / scale,
            w: r.width / scale,
            h: r.height / scale
          })),
          hits: centres.map(([x, y]) => document.elementFromPoint(x, y) === line),
          carets: centres.map(([x, y]) => {
            const caret = document.caretRangeFromPoint(x, y);
            return caret && caret.startContainer === node ? caret.startOffset : null;
          })
        };
      },
      [b.box[0], b.box[1]]
    );
  }

  async function savedBlock(page: Page, index: number) {
    return page.evaluate(
      async ({ uuid, index }) => {
        const { db } = await import('/src/lib/catalog/db.ts');
        const ocr = await db.volume_ocr.get(uuid);
        const block = ocr!.pages[0].blocks[index];
        return { lines: block.lines as string[], quad: block.lines_coords![0] as Quad };
      },
      { uuid: VOLUME_UUID, index }
    );
  }

  /** Degrees clockwise of a vertical quad's reading axis — written out again,
   * not imported from the code under test. */
  function tiltOf(quad: Quad): number {
    const { axis } = frameOf(quad, true);
    return (Math.atan2(-axis[0], axis[1]) * 180) / Math.PI;
  }

  test('a tilted line shows turned on its grid, takes presses where its text is, and keeps its angle through move, edit and resize', async ({
    page
  }) => {
    await seedVolume(page, [PAGE], 'auto');
    await openReader(page);
    const viewed = await measure(page);
    await enterEditMode(page);
    await expect(page.locator('.editBlock')).toHaveCount(BLOCKS.length);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);

    // ---- display: every line on its quad's grid, the tilted ones turned ----
    const report: string[] = [];
    for (const [name, b] of [
      ['vertical loose', V_LOOSE],
      ['horizontal loose', H_LOOSE],
      ['+20°', ROT_20],
      ['-35°', ROT_M35],
      ['horizontal -15°', H_ROT_M15],
      ['fat quad', V_FAT]
    ] as const) {
      const line = await measureEditorLine(page, b);
      const quad = b.cells[0];
      const n = line.glyphs.length;
      expect(line.childNodes).toBe(1);
      expect(line.text).toBe(b.lines[0]);
      const tiltedLine = b === ROT_20 || b === ROT_M35 || b === H_ROT_M15;
      expect(line.transform.includes('rotate(')).toBe(tiltedLine);
      const { axis } = frameOf(quad, b.vertical);
      let worst = 0;
      line.glyphs.forEach((glyph, k) => {
        const off = distance(
          inkCentre(glyph, axis, line.letterSpacing),
          cellCentre(quad, b.vertical, k, n)
        );
        worst = Math.max(worst, off);
      });
      // The editor's size is a whole px (the viewer's is not); the grid
      // absorbs the rounding, so the glyphs are still centred in their steps.
      expect(worst, `${name}: glyph vs grid-cell centre`).toBeLessThan(0.5);
      // ...and where the VIEWER paints them, glyph for glyph — across the quad
      // too (both centre the text in a quad thicker than it).
      const inViewer = findBlock(viewed, b).lines[0];
      let apart = 0;
      line.glyphs.forEach((glyph, k) => {
        apart = Math.max(apart, distance(centreOf(glyph), centreOf(inViewer.glyphs[k])));
      });
      expect(apart, `${name}: editor vs viewer glyph centres`).toBeLessThan(0.75);
      expect(line.hits.every(Boolean), `${name}: elementFromPoint on the turned glyphs`).toBe(true);
      report.push(
        `${name}: font ${line.fontSize}px, spacing ${line.letterSpacing.toFixed(2)}px, ` +
          `glyph-vs-cell max ${worst.toFixed(2)}px, vs viewer max ${apart.toFixed(2)}px, hits ${line.hits.filter(Boolean).length}/${n}`
      );
    }
    console.log(`[line-grid] editor display: ${report.join('; ')}`);
    await shot(page, 'editor-tilted-sfx', ROT_20.box, 60);

    // ---- a press on the TURNED text: select the block, then the line ----
    const INDEX = BLOCKS.indexOf(ROT_20);
    const quad0 = ROT_20.lines_coords[0];
    const block = page.locator('.editBlock').nth(INDEX);
    // the top-right corner of the quad's BBOX is empty paper for a +20° column
    // (the text leans away from it); cell 1's centre is on the text
    const onText = await toScreen(page, cellCentre(quad0, true, 1, 6));
    await page.mouse.click(onText.x, onText.y);
    await expect(block).toHaveClass(/selected/);
    await page.mouse.click(onText.x, onText.y);
    await expect(block.locator('.line')).toHaveClass(/lineSelected/);
    await expect(block.locator('[data-line-handle]')).toHaveCount(2);

    // ---- drag-move: a translation, the tilt intact ----
    const scale = await pageScale(page);
    const MOVE: Point = [36, 24];
    await page.mouse.move(onText.x, onText.y);
    await page.mouse.down();
    await page.mouse.move(onText.x + MOVE[0] / 2, onText.y + MOVE[1] / 2, { steps: 4 });
    await page.mouse.move(onText.x + MOVE[0], onText.y + MOVE[1], { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(1200); // autosave debounce
    let saved = await savedBlock(page, INDEX);
    const moved = saved.quad;
    moved.forEach(([x, y], k) => {
      expect(x).toBeCloseTo(quad0[k][0] + MOVE[0] / scale, 1);
      expect(y).toBeCloseTo(quad0[k][1] + MOVE[1] / scale, 1);
    });
    expect(tiltOf(moved)).toBeCloseTo(20, 3);

    // ---- double click on the turned text: the editor opens IN PLACE ----
    const onMoved = await toScreen(page, cellCentre(moved, true, 1, 6));
    await page.mouse.dblclick(onMoved.x, onMoved.y);
    await expect(block).toHaveClass(/editing/);
    const open = await measureEditorLine(page, { ...ROT_20, box: await boxOfBlock(page, INDEX) });
    expect(open.editable).toBe(true);
    expect(open.childNodes).toBe(1); // one RAW text node: nothing for an IME to trip on
    expect(open.text).toBe(SFX);
    expect(open.transform).toContain('rotate(');
    // the caret lands on the character under the pointer, turned or not
    open.carets.forEach((offset, k) => {
      expect(offset, `caret at glyph ${k}`).not.toBeNull();
      expect(Math.abs(offset! - k)).toBeLessThanOrEqual(1);
    });
    console.log(
      `[line-grid] editor open, caret offsets at glyph centres: ${open.carets.join(' ')}`
    );
    await shot(page, 'editor-tilted-open', ROT_20.box, 60);

    // type over one character, through a real selection
    await page.evaluate(() => {
      const line = document.querySelector<HTMLElement>('.editBlock.editing [contenteditable]')!;
      const range = document.createRange();
      range.setStart(line.firstChild!, 1);
      range.setEnd(line.firstChild!, 2);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.type('ゴ');
    const paper = await toScreen(page, [850, 2400]);
    await page.mouse.click(paper.x, paper.y);
    await expect(block).not.toHaveClass(/editing/);
    const FIXED = 'ドゴドドドド';
    await expect(block.locator('.line')).toHaveText(FIXED);
    await page.waitForTimeout(1200);
    saved = await savedBlock(page, INDEX);
    expect(saved.lines).toEqual([FIXED]);
    expect(saved.quad).toEqual(moved);
    expect(tiltOf(saved.quad)).toBeCloseTo(20, 3);

    // ---- resize by the end handle: longer, same angle ----
    await page.mouse.click(onMoved.x, onMoved.y);
    await page.mouse.click(onMoved.x, onMoved.y);
    const handle = block.locator('[data-line-handle="end"]');
    await expect(handle).toBeVisible();
    const grip = (await handle.boundingBox())!;
    const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
    // the handle sits on the turned quad's end edge
    const end = frameOf(moved, true);
    const endScreen = await toScreen(page, [
      end.from[0] + end.axis[0] * end.main,
      end.from[1] + end.axis[1] * end.main
    ]);
    expect(distance([from.x, from.y], [endScreen.x, endScreen.y])).toBeLessThan(1.5);
    const PULL = 40; // screen px, straight down: only the part along the line counts
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y + PULL / 2, { steps: 4 });
    await page.mouse.move(from.x, from.y + PULL, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(1200);
    saved = await savedBlock(page, INDEX);
    const grown = frameOf(saved.quad, true);
    expect(tiltOf(saved.quad)).toBeCloseTo(20, 3);
    expect(grown.main).toBeCloseTo(
      frameOf(quad0, true).main + (PULL / scale) * Math.cos((20 * Math.PI) / 180),
      1
    );
    // the head of the line stayed put
    expect(distance(grown.from, end.from)).toBeLessThan(0.01);
    console.log(
      `[line-grid] editor: moved by ${(MOVE[0] / scale).toFixed(1)},${(MOVE[1] / scale).toFixed(1)}px, ` +
        `resized ${end.main.toFixed(1)} → ${grown.main.toFixed(1)}px, tilt ${tiltOf(saved.quad).toFixed(4)}°`
    );

    // ---- and the viewer shows the corrected line, still turned ----
    await page.reload();
    await openReader(page);
    const viewer = (await measure(page)).flatMap((m) => m.lines).find((l) => l.text === FIXED);
    expect(viewer).toBeTruthy();
    expect(viewer!.transform).toContain('rotate(');
  });

  /** The block's current box origin (a moved line may have grown its block). */
  async function boxOfBlock(page: Page, index: number): Promise<[number, number, number, number]> {
    return page.evaluate((index) => {
      const el = document.querySelectorAll<HTMLElement>('.editBlock')[index];
      const left = parseFloat(el.style.left);
      const top = parseFloat(el.style.top);
      return [left, top, left + parseFloat(el.style.width), top + parseFloat(el.style.height)];
    }, index);
  }
});
