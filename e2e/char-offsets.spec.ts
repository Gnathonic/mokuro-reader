import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * char_offsets in a REAL layout engine — ORIGINAL mode, viewer and editor.
 * (Every other mode ignores the field since the uniform grid: a line is one
 * text node on its quad in both, see e2e/line-grid.spec.ts. What this spec
 * used to measure in auto mode is measured in original mode here.)
 *
 * The unit and component suites run in
 * jsdom, which lays nothing out: they prove the DOM shape, never that a glyph
 * lands on its cell, that a line of cells stays one line, or that a selection
 * across the cells reads as one string. This spec measures all three in
 * Chromium, against the real producer page the unit tests share.
 *
 * Page 0 is the fixture as the producer wrote it; page 1 is the same page with
 * every `char_offsets` stripped — today's renderer, the control for selection
 * strings and for the screenshots.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(HERE, '../src/lib/reader/__fixtures__/char-offsets-page.json'), 'utf8')
) as FixturePage;
// Playwright empties test-results at the start of every run; point
// CHAR_OFFSETS_SHOTS somewhere else to keep the captures.
const SHOTS = process.env.CHAR_OFFSETS_SHOTS ?? join(HERE, '../test-results/char-offsets-shots');

const SERIES = 'Char Offsets Series';
const SERIES_UUID = 'e2e-char-offsets-series';
const VOLUME_UUID = 'e2e-char-offsets-volume';

/**
 * Block 0, line 0: `地道なポイント稼ぎと、` — the と cell is [363, 363). Real data,
 * and SQUEEZED as well: 地 sits in 94px while な ポ ン get 22–26px at a ~41px
 * pitch. Original mode — viewer and editor — draws it as filed; every other
 * mode ignores the offsets and puts the line on the uniform grid.
 */
const ZERO_BLOCK = 0;
const ZERO_LINE = 0;
const ZERO_CHAR = 9;
/** Block 0, line 2 ends in three fullwidth periods the reader shows as `…`. */
const ELLIPSIS_LINE = 2;

type Quad = [number, number][];
interface FixtureBlock {
  box: [number, number, number, number];
  vertical: boolean;
  font_size: number;
  lines: string[];
  lines_coords: Quad[];
  char_offsets?: (number[] | null)[];
}
interface FixturePage {
  version: string;
  img_width: number;
  img_height: number;
  img_path: string;
  char_offsets_method?: string;
  blocks: FixtureBlock[];
}

/**
 * The fixture is all vertical, and `inline-size` / centring are LOGICAL: the
 * same rule has to hold in `horizontal-tb`. Block 0 turned a quarter — its
 * rightmost column becomes the top row, same text, same offsets — parked in
 * empty paper gives the horizontal case real advances too.
 */
function quarterTurn(block: FixtureBlock, x0: number, y0: number): FixtureBlock {
  const [bx0, by0, bx1, by1] = block.box;
  const turn = ([x, y]: [number, number]): [number, number] => [x0 + (y - by0), y0 + (bx1 - x)];
  return {
    ...structuredClone(block),
    box: [x0, y0, x0 + (by1 - by0), y0 + (bx1 - bx0)],
    vertical: false,
    // [TL, TR, BR, BL] of the column → TR, BR, BL, TL land on the row's
    // TL, TR, BR, BL.
    lines_coords: block.lines_coords.map(([tl, tr, br, bl]) => [
      turn(tr),
      turn(br),
      turn(bl),
      turn(tl)
    ])
  };
}

const HORIZONTAL_BLOCK = FIXTURE.blocks.length;
/**
 * Latin text with the contract's zero-width whitespace cells (the gap between
 * the words belongs to the letters either side). Synthetic: the producers in
 * the fixture never emit a space, a GCV layer of an English page emits many.
 */
const SPACED_BLOCK = HORIZONTAL_BLOCK + 1;
const SPACED: FixtureBlock = {
  box: [500, 1700, 800, 1820],
  vertical: false,
  font_size: 50,
  lines: ['NO WAY', 'OK GO'],
  lines_coords: [
    [
      [500, 1700],
      [800, 1700],
      [800, 1750],
      [500, 1750]
    ],
    [
      [500, 1770],
      [760, 1770],
      [760, 1820],
      [500, 1820]
    ]
  ],
  char_offsets: [
    [0, 50, 120, 120, 190, 245, 300],
    [0, 55, 130, 130, 200, 260]
  ]
};
/**
 * A zero-width cell on its own: え has no cell and お has two, on a line whose
 * other cells are plausible. Synthetic, because the fixture's one zero-width
 * cell sits on a line that is squeezed as well. (No renderer repairs it any
 * more: `lineCells`' repair is covered by its unit tests.)
 */
const REPAIRED_BLOCK = SPACED_BLOCK + 1;
const REPAIRED_CHAR = 3;
const REPAIRED: FixtureBlock = {
  box: [500, 1900, 550, 2140],
  vertical: true,
  font_size: 40,
  lines: ['あいうえおか'],
  lines_coords: [
    [
      [500, 1900],
      [550, 1900],
      [550, 2140],
      [500, 2140]
    ]
  ],
  char_offsets: [[0, 40, 80, 120, 120, 200, 240]]
};
const BLOCKS: FixtureBlock[] = [
  ...FIXTURE.blocks,
  quarterTurn(FIXTURE.blocks[0], 500, 1300),
  SPACED,
  REPAIRED
];
const PAGE: FixturePage = { ...FIXTURE, blocks: BLOCKS };

function stripOffsets(page: FixturePage): FixturePage {
  const copy = structuredClone(page);
  delete copy.char_offsets_method;
  // Its own image: the seeded files are keyed by path, and this page's has no
  // cell ticks ruled on it.
  copy.img_path = `plain-${page.img_path}`;
  for (const block of copy.blocks) delete block.char_offsets;
  return copy;
}

const chars = (pages: FixturePage[]) =>
  pages.map((p) => p.blocks.reduce((n, b) => n + b.lines.join('').length, 0));

async function seedVolume(page: Page, pages: FixturePage[], fontSize: string) {
  await page.goto('/');
  await page.waitForTimeout(800);
  const counts = chars(pages);
  await page.evaluate(
    async ({ SERIES, SERIES_UUID, VOLUME_UUID, pages, counts, fontSize }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      await Promise.all([
        db.volumes.clear(),
        db.volume_ocr.clear(),
        db.volume_files.clear(),
        db.volume_ocr_layers.clear()
      ]);
      const files: Record<string, File> = {};
      for (const p of pages) {
        const canvas = document.createElement('canvas');
        canvas.width = p.img_width;
        canvas.height = p.img_height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, p.img_width, p.img_height);
        // Rule the file's cell boundaries onto the page image, so a screenshot
        // shows by eye what the assertions measure: glyphs between the ticks.
        ctx.strokeStyle = '#e11d48';
        ctx.lineWidth = 1;
        for (const block of p.blocks) {
          block.lines_coords.forEach((quad, i) => {
            const offsets = block.char_offsets?.[i];
            if (!offsets) return;
            const xs = quad.map((q) => q[0]);
            const ys = quad.map((q) => q[1]);
            const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
            const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
            for (const o of offsets) {
              ctx.beginPath();
              if (block.vertical) {
                ctx.moveTo(minX - 6, minY + o + 0.5);
                ctx.lineTo(maxX + 6, minY + o + 0.5);
              } else {
                ctx.moveTo(minX + o + 0.5, minY - 6);
                ctx.lineTo(minX + o + 0.5, maxY + 6);
              }
              ctx.stroke();
            }
          });
        }
        const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), 'image/png'));
        files[p.img_path] = new File([blob], p.img_path, { type: 'image/png' });
      }
      let total = 0;
      await db.volumes.put({
        volume_uuid: VOLUME_UUID,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.3.0b',
        page_count: pages.length,
        character_count: counts.reduce((a: number, b: number) => a + b, 0),
        page_char_counts: counts.map((n: number) => (total += n))
      });
      await db.volume_ocr.put({ volume_uuid: VOLUME_UUID, pages });
      await db.volume_files.put({ volume_uuid: VOLUME_UUID, files });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('quickActions', true);
      updateSetting('singlePageView', 'single');
      updateSetting('displayOCR', true);
      updateSetting('alwaysShowOCR', true);
      updateSetting('fontSize', fontSize);
      window.localStorage.removeItem('sidecar-backfill:edited-volumes');
    },
    { SERIES, SERIES_UUID, VOLUME_UUID, pages, counts, fontSize }
  );
}

async function openReader(page: Page) {
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
  await waitForPositioned(page, 0);
}

/**
 * Re-assert the reader page before measuring it. The route can bounce back to
 * the catalog after `openReader` returns, and a `querySelector(...)!` on an
 * unmounted page throws an opaque null-dereference instead of waiting.
 */
async function requireReaderPage(page: Page, pageIndex = 0) {
  await expect(page.locator(`[data-page-index="${pageIndex}"]`)).toBeVisible({ timeout: 20000 });
}

/** Every per-line span on the page has been snapped onto its quad. */
async function waitForPositioned(page: Page, pageIndex: number) {
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

async function setFontSize(page: Page, fontSize: string) {
  await page.evaluate(async (fontSize) => {
    const { updateSetting } = await import('/src/lib/settings/index.ts');
    updateSetting('fontSize', fontSize as never);
  }, fontSize);
  await page.waitForTimeout(400);
}

async function enterEditMode(page: Page) {
  await page.getByLabel('Quick actions menu').click();
  await page.getByLabel('Edit OCR').click();
  await expect(page.locator('[data-edit-toolbar]')).toBeVisible();
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface MeasuredChar {
  text: string;
  /** The `.ocr-char` box, image px relative to the page. */
  cell: Rect;
  /** The painted glyph — a Range over the character's text node. */
  glyph: Rect;
  position: string;
  display: string;
  inlineSize: string;
  textNodes: number;
  /** A caret hit-test at the glyph's centre lands in this cell (Yomitan's scan). */
  hit: boolean;
}
interface MeasuredLine {
  text: string;
  box: Rect;
  /** Computed font-size: image px already (zoom is a transform, not a font scale). */
  fontSize: number;
  chars: MeasuredChar[];
}
interface MeasuredBlock {
  box: Rect;
  lines: MeasuredLine[];
}

const SURFACES = {
  viewer: { block: '.textBox', line: '.ocr-line' },
  editor: { block: '.editBlock', line: '.line' }
};

/**
 * Every block on a page, measured in IMAGE px relative to the page element —
 * zoom is an ancestor transform, so screen rects divide by the page's own
 * rendered scale.
 */
async function measure(
  page: Page,
  surface: keyof typeof SURFACES,
  pageIndex = 0
): Promise<MeasuredBlock[]> {
  await requireReaderPage(page, pageIndex);
  return page.evaluate(
    ({ pageIndex, selectors }) => {
      const pageEl = document.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`)!;
      const origin = pageEl.getBoundingClientRect();
      const scale = origin.width / pageEl.offsetWidth;
      const rel = (r: DOMRect) => ({
        x: (r.left - origin.left) / scale,
        y: (r.top - origin.top) / scale,
        w: r.width / scale,
        h: r.height / scale
      });
      return [...pageEl.querySelectorAll<HTMLElement>(selectors.block)].map((box) => ({
        box: rel(box.getBoundingClientRect()),
        lines: [...box.querySelectorAll<HTMLElement>(selectors.line)].map((line) => ({
          text: line.textContent!,
          box: rel(line.getBoundingClientRect()),
          fontSize: parseFloat(getComputedStyle(line).fontSize),
          chars: [...line.querySelectorAll<HTMLElement>('.ocr-char')].map((cell) => {
            const range = document.createRange();
            range.selectNodeContents(cell.firstChild!);
            const glyph = range.getBoundingClientRect();
            const caret = document.caretRangeFromPoint(
              glyph.left + glyph.width / 2,
              glyph.top + glyph.height / 2
            );
            const style = getComputedStyle(cell);
            return {
              text: cell.textContent!,
              cell: rel(cell.getBoundingClientRect()),
              glyph: rel(glyph),
              position: style.position,
              display: style.display,
              inlineSize: style.inlineSize,
              textNodes: [...cell.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).length,
              hit: !!caret && cell.contains(caret.startContainer)
            };
          })
        }))
      }));
    },
    { pageIndex, selectors: SURFACES[surface] }
  );
}

interface ExpectedLine {
  text: string;
  /**
   * Unit vector of the line's reading axis in page space. Upright: straight
   * down (vertical) or right (horizontal). The VIEWER turns a line whose quad
   * is tilted, and then so does its axis; `start`/`end` below are positions
   * ALONG this axis (a point's dot product with it), which for an upright line
   * is simply its y or x. (No line of this page turns: its one leaning quad —
   * block 2, 力で！, -4.2° — is three glyphs long, and over that length 4° is
   * within what corner noise does. Turned cells are measured in
   * e2e/line-grid.spec.ts.)
   */
  axis: [number, number];
  /** null = the line renders fitted (no offsets, or they failed validation) */
  cells: { text: string; start: number; end: number }[] | null;
}

/**
 * Where the production layout module says each cell is, in page image px along
 * the line's reading axis — from the fixture's offsets and the quad's start
 * edge. Viewer and editor both turn a tilted line about its quad's centre.
 */
async function expectedCells(page: Page, repair: boolean): Promise<ExpectedLine[][]> {
  return page.evaluate(
    async ({ blocks, repair }) => {
      const { lineCells, processLine } = await import('/src/lib/reader/char-offsets-layout.ts');
      const { quadExtents, layoutLines, getDefaultMeasurer } = await import(
        '/src/lib/reader/line-coords-layout.ts'
      );
      const { lineFrame } = await import('/src/lib/reader/line-grid.ts');
      return blocks.map((block) => {
        const processed = block.lines.map(processLine);
        const layouts = layoutLines(block, processed, getDefaultMeasurer(), {
          cells: repair ? 'repaired' : 'as-is'
        });
        return block.lines.map((raw, i) => {
          const quad = block.lines_coords[i];
          const main = quadExtents(quad, block.vertical)!.main;
          const placed = lineCells(raw, block.char_offsets?.[i] ?? null, main, { repair });
          const turn = ((layouts?.[i].rotation ?? 0) * Math.PI) / 180;
          const axis: [number, number] = block.vertical
            ? [-Math.sin(turn), Math.cos(turn)]
            : [Math.cos(turn), Math.sin(turn)];
          if (!placed) return { text: processed[i], axis, cells: null };
          // Upright: the bbox start edge. Turned: half the main extent back
          // from the quad's centre, along the turned axis.
          const frame = lineFrame(quad, block.vertical)!;
          const edge = turn
            ? frame.cx * axis[0] + frame.cy * axis[1] - frame.main / 2
            : Math.min(...quad.map((q) => q[block.vertical ? 1 : 0]));
          let at = edge + placed.start;
          return {
            text: processed[i],
            axis,
            cells: placed.cells.map((cell) => {
              const start = at;
              at += cell.size;
              return { text: cell.text, start, end: at };
            })
          };
        });
      });
    },
    { blocks: BLOCKS, repair }
  );
}

/** Blocks are told apart by where they are: the quarter-turned twin has block 0's text. */
function findBlock(measured: MeasuredBlock[], block: FixtureBlock): MeasuredBlock {
  const found = measured.find(
    (m) => Math.abs(m.box.x - block.box[0]) < 3 && Math.abs(m.box.y - block.box[1]) < 3
  );
  expect(found, `a block is rendered at ${block.box.slice(0, 2)}`).toBeTruthy();
  return found!;
}

/** Main-axis [start, end] of a rect for a block's writing direction. */
const mainSpan = (r: Rect, vertical: boolean): [number, number] =>
  vertical ? [r.y, r.y + r.h] : [r.x, r.x + r.w];
/** A rect's centre along a line's reading axis / across it. A turned line's
 * rects are bboxes of turned boxes: their centres are still the true centres. */
const along = (r: Rect, [ux, uy]: [number, number]) => (r.x + r.w / 2) * ux + (r.y + r.h / 2) * uy;
const across = (r: Rect, [ux, uy]: [number, number]) => (r.x + r.w / 2) * uy - (r.y + r.h / 2) * ux;

interface Deviation {
  block: number;
  line: number;
  char: string;
  cell: number;
  glyph: number;
  off: number;
}

/** glyph centre − cell centre along the reading axis, every celled character. */
function centreDeviations(measured: MeasuredBlock[], expected: ExpectedLine[][]): Deviation[] {
  const out: Deviation[] = [];
  BLOCKS.forEach((block, b) => {
    const shown = findBlock(measured, block);
    expected[b].forEach((line, l) => {
      if (!line.cells) return;
      const got = shown.lines[l].chars;
      expect(got.map((c) => c.text)).toEqual(line.cells.map((c) => c.text));
      line.cells.forEach((cell, k) => {
        // A space paints nothing: there is no glyph to be off-centre.
        if (cell.text.trim() === '') return;
        const [g0, g1] = mainSpan(got[k].glyph, block.vertical);
        out.push({
          block: b,
          line: l,
          char: cell.text,
          cell: cell.end - cell.start,
          glyph: g1 - g0,
          off: along(got[k].glyph, line.axis) - (cell.start + cell.end) / 2
        });
      });
    });
  });
  return out;
}

function summarize(label: string, deviations: Deviation[]) {
  const stats = (list: Deviation[]) => {
    const abs = list.map((d) => Math.abs(d.off)).sort((a, b) => a - b);
    return abs.length
      ? `n=${abs.length} median ${abs[abs.length >> 1].toFixed(2)}px max ${abs[abs.length - 1].toFixed(2)}px`
      : 'n=0';
  };
  const tight = deviations.filter((d) => d.cell < d.glyph);
  for (const [name, vertical] of [
    ['vertical', true],
    ['horizontal', false]
  ] as const) {
    const of = (list: Deviation[]) => list.filter((d) => BLOCKS[d.block].vertical === vertical);
    console.log(
      `[char-offsets] ${label} ${name}: glyph-vs-cell centre error ${stats(of(deviations))}; ` +
        `glyphs wider than their cell ${stats(of(tight))}`
    );
  }
}

function expectCentred(deviations: Deviation[]) {
  for (const d of deviations) {
    expect(
      Math.abs(d.off),
      `block ${d.block} line ${d.line} "${d.char}" (cell ${d.cell}px, glyph ${d.glyph.toFixed(1)}px) is ${d.off.toFixed(2)}px off its cell centre`
    ).toBeLessThanOrEqual(2);
  }
}

/** (c): cells in flow, continuity-safe display, ONE line box per OCR line. */
function expectOneFlowLine(measured: MeasuredBlock[], expected: ExpectedLine[][]) {
  BLOCKS.forEach((block, b) => {
    const shown = findBlock(measured, block);
    shown.lines.forEach((line, l) => {
      if (!expected[b][l].cells) {
        expect(line.chars).toHaveLength(0);
        return;
      }
      expect(line.text).toBe(expected[b][l].text);
      const centres = line.chars.map((c) => across(c.cell, expected[b][l].axis));
      for (const [k, c] of line.chars.entries()) {
        expect(['static', 'relative']).toContain(c.position);
        // Yomitan's scanner cuts the display value at the first '-': these two
        // read as `inline`; block / flex / grid / table are a line break.
        expect(['inline-block', 'inline-flex']).toContain(c.display);
        expect(c.textNodes).toBe(1);
        // A wrapped cell would sit in the next column (row): a font size away.
        expect(Math.abs(centres[k] - centres[0])).toBeLessThanOrEqual(1);
      }
    });
  });
}

async function shot(page: Page, name: string, block: FixtureBlock, pageIndex = 0) {
  await requireReaderPage(page, pageIndex);
  mkdirSync(SHOTS, { recursive: true });
  // The boxes' white ground hides the cell ticks ruled on the page image.
  const style = await page.addStyleTag({
    content:
      '.textBox, .textBox p, .editBlock, .editBlock .line { background: transparent !important; }'
  });
  const clip = await page.evaluate(
    ({ box, pageIndex }) => {
      const el = document.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`)!;
      const origin = el.getBoundingClientRect();
      const scale = origin.width / el.offsetWidth;
      const pad = 40;
      return {
        x: origin.left + (box[0] - pad) * scale,
        y: origin.top + (box[1] - pad) * scale,
        width: (box[2] - box[0] + 2 * pad) * scale,
        height: (box[3] - box[1] + 2 * pad) * scale
      };
    },
    { box: block.box, pageIndex }
  );
  await page.screenshot({ path: join(SHOTS, `${name}.png`), clip });
  await style.evaluate((el) => el.remove());
}

test.describe('char_offsets — viewer', () => {
  // Denser raster only: CSS px (and so every measurement) are unchanged, but a
  // fit-to-screen page is ~0.4x and its glyphs are unreadable in a 1x capture.
  test.use({ deviceScaleFactor: 3 });

  test('auto: char_offsets are ignored — no cells, every line one text node on its quad', async ({
    page
  }) => {
    await seedVolume(page, [PAGE, stripOffsets(PAGE)], 'auto');
    await openReader(page);

    const measured = await measure(page, 'viewer');
    const shape = (pageIndex: number) =>
      page.evaluate((pageIndex) => {
        const pageEl = document.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`)!;
        return [...pageEl.querySelectorAll<HTMLElement>('.textBox .ocr-line')].map((line) => ({
          text: line.textContent,
          elements: line.querySelectorAll('*').length,
          textNodes: [...line.childNodes].filter(
            (n) => n.nodeType === Node.TEXT_NODE && n.nodeValue !== ''
          ).length,
          fontSize: line.style.fontSize,
          letterSpacing: line.style.letterSpacing,
          transform: line.style.transform
        }));
      }, pageIndex);

    await expect(page.locator('.ocr-char')).toHaveCount(0);
    BLOCKS.forEach((block) => {
      const shown = findBlock(measured, block);
      expect(shown.lines.map((line) => line.text)).toEqual(
        block.lines.map((raw) => raw.replace('．．．', '…'))
      );
      for (const line of shown.lines) expect(line.chars).toHaveLength(0);
    });
    const withOffsets = await shape(0);
    for (const line of withOffsets) {
      expect(line.elements).toBe(0);
      expect(line.textNodes).toBe(1);
    }

    await shot(page, 'viewer-auto-block0', BLOCKS[0]);
    await shot(page, 'viewer-auto-horizontal', BLOCKS[HORIZONTAL_BLOCK]);
    await page.keyboard.press('PageDown');
    await expect(page.locator('[data-page-index="1"]')).toBeVisible();
    await waitForPositioned(page, 1);
    // The same page with every char_offsets stripped renders the SAME markup:
    // size, spacing and transform, line for line. The field changes nothing.
    expect(await shape(1)).toEqual(withOffsets);
    await shot(page, 'viewer-auto-block0-without-offsets', BLOCKS[0], 1);
  });

  test('original: selection across cells reads exactly like a block without offsets', async ({
    page
  }) => {
    await seedVolume(page, [PAGE, stripOffsets(PAGE)], 'original');
    await openReader(page);

    const select = (pageIndex: number) =>
      page.evaluate((pageIndex) => {
        const texts = (el: Element) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const out: Text[] = [];
          for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
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
        const pageEl = document.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`)!;
        return [...pageEl.querySelectorAll<HTMLElement>('.textBox')].map((box) => {
          const lines = [...box.querySelectorAll('.ocr-line')];
          return {
            left: parseFloat(box.style.left),
            top: parseFloat(box.style.top),
            cells: box.querySelectorAll('.ocr-char').length,
            perLine: lines.map((line) => pick(line, line)),
            // Leave the whole block selected last, for the screenshot.
            whole: pick(lines[0], lines[lines.length - 1])
          };
        });
      }, pageIndex);

    const celled = await select(0);
    await page.evaluate(([left, top]) => {
      const box = [...document.querySelectorAll<HTMLElement>('.textBox')].find(
        (el) => parseFloat(el.style.left) === left && parseFloat(el.style.top) === top
      )!;
      window.getSelection()!.selectAllChildren(box);
    }, BLOCKS[0].box);
    await shot(page, 'viewer-original-selection', BLOCKS[0]);
    await page.keyboard.press('PageDown');
    await expect(page.locator('[data-page-index="1"]')).toBeVisible();
    // Without offsets original mode still places every line on its quad (at
    // the file's font size), so this page is positioned per line as well.
    await expect(page.locator('[data-page-index="1"] .textBox')).toHaveCount(BLOCKS.length);
    await waitForPositioned(page, 1);
    const plain = await select(1);

    // The stock page (no offsets) is where mokuro's font_size contradicts its
    // own quads: block 2 says 155px on a 111px step, and drew 〝 on 新 and 〟
    // on 齟. Original mode caps the file's size by the file's geometry: no
    // line is closed up by more than 0.05em, and a bubble keeps ONE size.
    await page.evaluate(() => window.getSelection()!.removeAllRanges());
    const stock = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-page-index="1"] .textBox')].map((box) => ({
        left: parseFloat(box.style.left),
        top: parseFloat(box.style.top),
        lines: [...box.querySelectorAll<HTMLElement>('.ocr-line.positionedLine')].map((line) => {
          const style = getComputedStyle(line);
          return {
            size: parseFloat(style.fontSize),
            spacing: parseFloat(style.letterSpacing) || 0
          };
        })
      }))
    );
    await shot(page, 'viewer-original-stock-block2', BLOCKS[2], 1);
    for (const block of BLOCKS) {
      const found = stock.find((x) => x.left === block.box[0] && x.top === block.box[1])!;
      expect(found.lines.length).toBe(block.lines.length);
      for (const line of found.lines) {
        expect(line.size).toBeLessThanOrEqual(block.font_size + 0.01);
        expect(line.spacing / line.size).toBeGreaterThanOrEqual(-0.05 - 1e-3);
      }
    }
    const collided = stock.find((x) => x.left === BLOCKS[2].box[0] && x.top === BLOCKS[2].box[1])!;
    expect(BLOCKS[2].font_size).toBe(155);
    expect(new Set(collided.lines.map((l) => l.size)).size).toBe(1);
    expect(collided.lines[0].size).toBeLessThan(125);
    console.log(
      `[char-offsets] original, stock block 2 (font_size 155): rendered at ${collided.lines[0].size.toFixed(2)}px, ` +
        `letter-spacing ${collided.lines[0].spacing.toFixed(2)}px (${(collided.lines[0].spacing / collided.lines[0].size).toFixed(3)}em)`
    );

    const expected = await expectedCells(page, false);
    expect(plain.every((b) => b.cells === 0)).toBe(true);
    const at = (block: FixtureBlock) => (x: { left: number; top: number }) =>
      x.left === block.box[0] && x.top === block.box[1];
    BLOCKS.forEach((block, b) => {
      const withCells = celled.find(at(block))!;
      const without = plain.find(at(block))!;
      expect(withCells.cells).toBe(expected[b].reduce((n, l) => n + (l.cells?.length ?? 0), 0));
      // A line selected end to end is the processed line — the guard against
      // per-glyph absolute positioning, which shreds this into fragments.
      expect(withCells.perLine).toEqual(expected[b].map((l) => l.text));
      // Across lines: whatever today's renderer yields, cells yield the same.
      expect(withCells.whole).toBe(without.whole);
      expect(withCells.whole.replace(/\n/g, '')).toBe(expected[b].map((l) => l.text).join(''));
    });
    // The contract gives a space a zero-width cell; it is still a character of
    // the line, and a copy that loses it glues the words together.
    expect(celled.find(at(SPACED))!.perLine).toEqual(BLOCKS[SPACED_BLOCK].lines);
    console.log(
      `[char-offsets] original: selection across block 0: ${JSON.stringify(celled.find(at(BLOCKS[0]))!.whole)}; ` +
        `across the spaced block: ${JSON.stringify(celled.find(at(SPACED))!.whole)}`
    );
  });

  test('original: the file as-is — the zero-width cell stays zero and its glyph sits on its neighbour', async ({
    page
  }) => {
    await seedVolume(page, [PAGE], 'original');
    await openReader(page);

    const expected = await expectedCells(page, false);
    const measured = await measure(page, 'viewer');
    for (const b of [ZERO_BLOCK, HORIZONTAL_BLOCK]) {
      const vertical = BLOCKS[b].vertical;
      const line = findBlock(measured, BLOCKS[b]).lines[ZERO_LINE];
      const zero = line.chars[ZERO_CHAR];
      expect(zero.text).toBe('と');
      expect(parseFloat(zero.inlineSize)).toBe(0);
      const [z0, z1] = mainSpan(zero.glyph, vertical);
      const overlaps = [ZERO_CHAR - 1, ZERO_CHAR + 1].map((k) => {
        const [n0, n1] = mainSpan(line.chars[k].glyph, vertical);
        return Math.min(z1, n1) - Math.max(z0, n0);
      });
      console.log(
        `[char-offsets] original ${vertical ? 'vertical' : 'horizontal'}: the ${(z1 - z0).toFixed(1)}px と glyph in its 0px cell ` +
          `overlaps the glyph before by ${overlaps[0].toFixed(1)}px, the one after by ${overlaps[1].toFixed(1)}px`
      );
      expect(Math.max(...overlaps)).toBeGreaterThan(0);
    }

    // The fixture's shape survived the trip: a null line and a block without
    // offsets render fitted; every other line is on its cells, the squeezed
    // と line (and its quarter-turned twin) included.
    expect(expected[1][1].cells).toBeNull();
    expect(expected[3][0].cells).toBeNull();
    expect(expected[ZERO_BLOCK][ZERO_LINE].cells).toHaveLength(11);
    expect(expected[HORIZONTAL_BLOCK][ZERO_LINE].cells).toHaveLength(11);
    expect(expected[REPAIRED_BLOCK][0].cells).toHaveLength(6);
    // The one leaning quad of the page (力で！, -4.2°) stays upright: it is 140
    // × 332, so the lean moves its end by 25px — a sixth of its thickness, the
    // size of the detector's corner noise on a three-glyph line.
    expect(Math.abs(expected[2][1].axis[0])).toBe(0);
    expect(expected.flat().filter((line) => line.axis[0] !== 0 && line.axis[1] !== 0)).toHaveLength(
      0
    );
    // Upright lines render the file's own advances, untouched: for them the
    // prediction is the fixture's numbers, not the module's opinion.
    BLOCKS.forEach((block, b) =>
      block.lines.forEach((raw, l) => {
        const offsets = block.char_offsets?.[l];
        const { axis } = expected[b][l];
        if (!offsets || raw.includes('．') || (axis[0] !== 0 && axis[1] !== 0)) return;
        const edge = Math.min(...block.lines_coords[l].map((q) => q[block.vertical ? 1 : 0]));
        expect(expected[b][l].cells!.map((c) => c.end)).toEqual(
          offsets.slice(1).map((o) => edge + o)
        );
      })
    );

    // As-is still means ON the cell: every glyph is centred on the boundaries
    // the file gives, the zero-width one included.
    const deviations = centreDeviations(measured, expected);
    summarize('original', deviations);
    expect(deviations.filter((d) => BLOCKS[d.block].vertical).length).toBeGreaterThan(40);
    expect(deviations.filter((d) => !BLOCKS[d.block].vertical).length).toBeGreaterThan(25);
    expectCentred(deviations);
    expectOneFlowLine(measured, expected);
    // Across the line the glyph rides the line span's own centre — a baseline
    // shift from the cell's display type would show up here.
    BLOCKS.forEach((block, b) =>
      findBlock(measured, block).lines.forEach((line, l) => {
        for (const c of line.chars) {
          if (c.text.trim() === '') continue;
          expect(
            Math.abs(across(c.glyph, expected[b][l].axis) - across(line.box, expected[b][l].axis))
          ).toBeLessThanOrEqual(2);
        }
      })
    );
    // What Yomitan does under the pointer: the caret at a glyph's centre is in
    // that glyph's cell, overflowing glyphs included. (A zero-width cell's
    // glyph sits ON its neighbour by the file's own account; the topmost of
    // the two wins the hit-test, so those are counted apart.)
    let hits = 0;
    let glyphs = 0;
    let zeroCells = 0;
    BLOCKS.forEach((block) =>
      findBlock(measured, block).lines.forEach((line) => {
        const crowded = line.chars.some((c) => parseFloat(c.inlineSize) === 0 && c.text.trim());
        line.chars.forEach((c) => {
          if (c.text.trim() === '') return;
          if (crowded) {
            zeroCells++;
            return;
          }
          glyphs++;
          if (c.hit) hits++;
        });
      })
    );
    console.log(
      `[char-offsets] original: caret hit-test at the glyph centre ${hits}/${glyphs} ` +
        `(${zeroCells} glyphs on lines with a zero-width cell not counted)`
    );
    expect(glyphs).toBeGreaterThan(50);
    expect(hits).toBe(glyphs);

    await shot(page, 'viewer-original-block0', BLOCKS[0]);
    await shot(page, 'viewer-original-horizontal', BLOCKS[HORIZONTAL_BLOCK]);
    await shot(page, 'viewer-original-tilted', BLOCKS[2]);
  });

  test('a manual font size renders no cells at all, nor does auto; original does', async ({
    page
  }) => {
    await seedVolume(page, [PAGE], '24');
    await page.waitForTimeout(800);
    await page.evaluate(
      ({ SERIES_UUID, VOLUME_UUID }) => {
        window.location.hash = `#/reader/${SERIES_UUID}/${VOLUME_UUID}`;
      },
      { SERIES_UUID, VOLUME_UUID }
    );
    await expect(page.locator('.textBox')).toHaveCount(BLOCKS.length, { timeout: 20000 });
    await expect(page.locator('.ocr-char')).toHaveCount(0);
    // …auto has none either (the uniform grid needs no cells)…
    await setFontSize(page, 'auto');
    await expect(page.locator('.positionedLine').first()).toBeVisible();
    await expect(page.locator('.ocr-char')).toHaveCount(0);
    // …and flipping to original brings them in without a reload.
    await setFontSize(page, 'original');
    await expect(page.locator('.ocr-char').first()).toBeVisible();
  });
});

test.describe('char_offsets — editor', () => {
  test.use({ deviceScaleFactor: 3 });

  async function readBlock(page: Page, blockIndex: number) {
    return page.evaluate(
      async ({ uuid, blockIndex }) => {
        const { db } = await import('/src/lib/catalog/db.ts');
        const ocr = await db.volume_ocr.get(uuid);
        const block = ocr!.pages[0].blocks[blockIndex];
        return { lines: block.lines, char_offsets: block.char_offsets ?? null };
      },
      { uuid: VOLUME_UUID, blockIndex }
    );
  }

  /** Replace one character of an open line by typing over a real selection. */
  async function typeOver(
    page: Page,
    blockIndex: number,
    lineIndex: number,
    at: number,
    text: string
  ) {
    await page.evaluate(
      ({ blockIndex, lineIndex, at }) => {
        const line = document
          .querySelectorAll('.editBlock')
          [blockIndex].querySelectorAll<HTMLElement>('[contenteditable]')[lineIndex];
        line.focus();
        const range = document.createRange();
        range.setStart(line.firstChild!, at);
        range.setEnd(line.firstChild!, at + 1);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      },
      { blockIndex, lineIndex, at }
    );
    await page.keyboard.type(text);
  }

  /** A press on bare paper: focus leaves the block and its editor closes. */
  async function clickAway(page: Page) {
    const at = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
      const r = el.getBoundingClientRect();
      const scale = r.width / el.offsetWidth;
      return { x: r.left + 850 * scale, y: r.top + 2100 * scale };
    });
    await page.mouse.click(at.x, at.y);
  }

  test('original mode: cells until the editor opens, RAW plain text while typing, reflowed cells after; persisted and undoable', async ({
    page
  }) => {
    const RAW = BLOCKS[0].lines[ELLIPSIS_LINE];
    const ORIGINAL_OFFSETS = BLOCKS[0].char_offsets!;
    expect(RAW.endsWith('．．．')).toBe(true);

    // Cells are the ORIGINAL font mode's, in the editor as in the viewer (any
    // other mode: e2e/line-grid.spec.ts), so that is the mode this runs in.
    await seedVolume(page, [PAGE], 'original');
    await openReader(page);
    const viewCells = () => measure(page, 'viewer');
    const viewed = await viewCells();
    await enterEditMode(page);
    const block = page.locator('.editBlock').first();
    await expect(block.locator('.ocr-char').first()).toBeVisible();

    // Cells in the editor sit where the file puts them, as filed — the page's
    // one leaning quad upright, exactly like the viewer.
    const expected = await expectedCells(page, false);
    const before = await measure(page, 'editor');

    // ...and their glyphs are the viewer's size: a celled line is fitted to its
    // CELLS' extent (up to a fifth shorter than the quad), not to the quad. The
    // editor rounds to a whole px; the viewer does not.
    const sized: string[] = [];
    for (const fixtureBlock of BLOCKS) {
      const inViewer = findBlock(viewed, fixtureBlock);
      const inEditor = findBlock(before, fixtureBlock);
      for (const [i, line] of inEditor.lines.entries()) {
        if (line.chars.length === 0) continue;
        expect(inViewer.lines[i].chars.length).toBe(line.chars.length);
        sized.push(`${inViewer.lines[i].fontSize.toFixed(2)}/${line.fontSize}`);
        expect(Math.abs(line.fontSize - inViewer.lines[i].fontSize)).toBeLessThanOrEqual(0.5);
      }
    }
    console.log(
      `[char-offsets] edit mode: celled line font-size, viewer/editor: ${sized.join(' ')}`
    );
    expect(sized.length).toBeGreaterThan(0);
    const deviations = centreDeviations(before, expected);
    summarize('edit mode', deviations);
    expectCentred(deviations);
    expectOneFlowLine(before, expected);
    // As filed: the squeezed と line keeps its cells, え keeps its 0px cell.
    expect(expected[ZERO_BLOCK][ZERO_LINE].cells).toHaveLength(11);
    const squeezed = findBlock(before, BLOCKS[ZERO_BLOCK]).lines[ZERO_LINE].chars;
    expect(squeezed).toHaveLength(11);
    expect(parseFloat(squeezed[ZERO_CHAR].inlineSize)).toBe(0);
    const zeroCell = findBlock(before, BLOCKS[REPAIRED_BLOCK]).lines[0].chars;
    expect(zeroCell[REPAIRED_CHAR].text).toBe('え');
    expect(zeroCell.map((c) => parseFloat(c.inlineSize))).toEqual([40, 40, 40, 0, 80, 40]);
    // The leaning quad's cells sit where the VIEWER's do, glyph for glyph.
    const TILTED = [2, 1] as const;
    expect(Math.abs(expected[TILTED[0]][TILTED[1]].axis[0])).toBe(0);
    const turnedInViewer = findBlock(viewed, BLOCKS[TILTED[0]]).lines[TILTED[1]].chars;
    const turnedInEditor = findBlock(before, BLOCKS[TILTED[0]]).lines[TILTED[1]].chars;
    expect(turnedInEditor).toHaveLength(turnedInViewer.length);
    turnedInEditor.forEach((c, k) => {
      const v = turnedInViewer[k].glyph;
      const off = Math.hypot(
        c.glyph.x + c.glyph.w / 2 - (v.x + v.w / 2),
        c.glyph.y + c.glyph.h / 2 - (v.y + v.h / 2)
      );
      expect(off, `leaning quad, glyph ${k}, editor vs viewer`).toBeLessThanOrEqual(1);
    });
    await shot(page, 'editor-cells-block0', BLOCKS[0]);

    // Opening the editor: the whole block goes plain, and plain means RAW —
    // three fullwidth periods, never the … the cells showed.
    const shownLine = block.locator('.line').nth(ELLIPSIS_LINE);
    await expect(shownLine).toHaveText(RAW.replace('．．．', '…'));
    await shownLine.dblclick();
    await expect(block).toHaveClass(/editing/);
    await expect(block.locator('.ocr-char')).toHaveCount(0);
    const editables = block.locator('[contenteditable]');
    await expect(editables).toHaveCount(BLOCKS[0].lines.length);
    for (const [i, raw] of BLOCKS[0].lines.entries())
      await expect(editables.nth(i)).toHaveText(raw);
    expect(await page.evaluate(() => document.activeElement?.closest('.editBlock') !== null)).toBe(
      true
    );
    // Every OTHER block keeps its cells.
    await expect(page.locator('.editBlock').nth(1).locator('.ocr-char').first()).toBeVisible();
    await shot(page, 'editor-open-block0', BLOCKS[0]);

    // One character fixed: 組 → 祖. Same length, so the reflow keeps every cell.
    const FIX_AT = 3;
    expect([...RAW][FIX_AT]).toBe('組');
    await typeOver(page, 0, ELLIPSIS_LINE, FIX_AT, '祖');
    await clickAway(page);
    await expect(block).not.toHaveClass(/editing/);
    const FIXED = RAW.replace('組', '祖');
    await expect(shownLine).toHaveText(FIXED.replace('．．．', '…'));

    const after = await measure(page, 'editor');
    const was = findBlock(before, BLOCKS[0]).lines[ELLIPSIS_LINE].chars;
    const now = findBlock(after, BLOCKS[0]).lines[ELLIPSIS_LINE].chars;
    expect(now).toHaveLength(was.length);
    expect(now[FIX_AT].text).toBe('祖');
    for (const [k, c] of now.entries()) {
      expect(Math.abs(c.cell.y - was[k].cell.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(c.cell.h - was[k].cell.h)).toBeLessThanOrEqual(0.5);
    }

    // Autosave (500 ms debounce): the RAW text and the offsets are in the row.
    await page.waitForTimeout(1200);
    let saved = await readBlock(page, 0);
    expect(saved.lines[ELLIPSIS_LINE]).toBe(FIXED);
    expect(saved.char_offsets).toEqual(ORIGINAL_OFFSETS);

    // Undo: the original text and offsets, on screen and in the row.
    await page.keyboard.press('Control+Z');
    await expect(shownLine).toHaveText(RAW.replace('．．．', '…'));
    await expect(shownLine.locator('.ocr-char')).toHaveCount(was.length);
    await page.waitForTimeout(1200);
    saved = await readBlock(page, 0);
    expect(saved.lines).toEqual(BLOCKS[0].lines);
    expect(saved.char_offsets).toEqual(ORIGINAL_OFFSETS);
    await page.keyboard.press('Control+Shift+Z');
    await expect(shownLine).toHaveText(FIXED.replace('．．．', '…'));
    await page.waitForTimeout(1200);

    // Reload: the fix and the placement persisted, and the viewer shows both.
    await page.reload();
    await openReader(page);
    saved = await readBlock(page, 0);
    expect(saved.lines[ELLIPSIS_LINE]).toBe(FIXED);
    expect(saved.char_offsets).toEqual(ORIGINAL_OFFSETS);
    const viewer = findBlock(await viewCells(), BLOCKS[0]).lines[ELLIPSIS_LINE];
    expect(viewer.chars[FIX_AT].text).toBe('祖');
    expect(viewer.chars).toHaveLength(was.length);

    // An edit that CHANGES the offsets (a character typed in), then undo: the
    // exact old offsets come back.
    await enterEditMode(page);
    await page.locator('.editBlock').first().locator('.line').nth(ELLIPSIS_LINE).dblclick();
    await expect(page.locator('.editBlock').first()).toHaveClass(/editing/);
    await typeOver(page, 0, ELLIPSIS_LINE, FIX_AT, '祖父');
    await clickAway(page);
    await page.waitForTimeout(1200);
    saved = await readBlock(page, 0);
    const grown = saved.char_offsets![ELLIPSIS_LINE]!;
    const old = ORIGINAL_OFFSETS[ELLIPSIS_LINE]!;
    expect(saved.lines[ELLIPSIS_LINE]).toBe(RAW.replace('組', '祖父'));
    // A pure insertion has no span of its own: the region widens by one
    // character each side (祖 and の) and the three share it. Everything
    // outside keeps its boundary and the line keeps its extent.
    expect(grown).toHaveLength(old.length + 1);
    expect(grown.slice(0, FIX_AT + 1)).toEqual(old.slice(0, FIX_AT + 1));
    expect(grown.slice(FIX_AT + 3)).toEqual(old.slice(FIX_AT + 2));
    const shared = grown.slice(FIX_AT, FIX_AT + 4);
    expect(shared.every((o, k) => k === 0 || o > shared[k - 1])).toBe(true);
    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(1200);
    saved = await readBlock(page, 0);
    expect(saved.lines[ELLIPSIS_LINE]).toBe(FIXED);
    expect(saved.char_offsets).toEqual(ORIGINAL_OFFSETS);
  });
});

// Auto mode answered the question by dropping the cells: a page whose file
// carries char_offsets now weighs exactly what one without them does. The
// celled weight is still measured — in original mode, the one place cells
// render — so the number stays on record.
test.describe('char_offsets — DOM weight (spec open question 4)', () => {
  const KANA =
    'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';

  /** 40 blocks × 4 lines × 20 characters, every line placed (or none). */
  function densePage(withOffsets: boolean, name: string): FixturePage {
    const blocks: FixtureBlock[] = [];
    // Alternating 24/36px advances at a 30px glyph: half the cells are tighter
    // than their glyph, so the overflow-centring path is what gets timed.
    const offsets = Array.from({ length: 21 }, (_, k) => 30 * k + (k % 2 ? -6 : 0));
    for (let b = 0; b < 40; b++) {
      const bx = 40 + (b % 10) * 165;
      const by = 60 + Math.floor(b / 10) * 680;
      const lines: string[] = [];
      const quads: Quad[] = [];
      for (let l = 0; l < 4; l++) {
        const from = (b * 4 + l) % KANA.length;
        lines.push((KANA + KANA).slice(from, from + 20));
        const x = bx + (3 - l) * 36;
        quads.push([
          [x, by],
          [x + 30, by],
          [x + 30, by + 600],
          [x, by + 600]
        ]);
      }
      blocks.push({
        box: [bx, by, bx + 138, by + 600],
        vertical: true,
        font_size: 30,
        lines,
        lines_coords: quads,
        ...(withOffsets ? { char_offsets: lines.map(() => offsets.slice()) } : {})
      });
    }
    return { version: '0.3.0b', img_width: 1700, img_height: 2800, img_path: name, blocks };
  }

  function lightPage(name: string): FixturePage {
    return {
      version: '0.3.0b',
      img_width: 1700,
      img_height: 2800,
      img_path: name,
      blocks: [
        {
          box: [800, 1000, 830, 1090],
          vertical: true,
          font_size: 30,
          lines: ['あいう'],
          lines_coords: [
            [
              [800, 1000],
              [830, 1000],
              [830, 1090],
              [800, 1090]
            ]
          ]
        }
      ]
    };
  }

  const median = (values: number[]) => values.slice().sort((a, b) => a - b)[values.length >> 1];

  test('a dense page with and without char_offsets: auto weighs the same, original carries the cells', async ({
    page
  }) => {
    test.setTimeout(120000);
    // Light pages in between, so neither dense page's teardown is billed to
    // the other's mount.
    const pages = [
      lightPage('l0.png'),
      densePage(true, 'celled.png'),
      lightPage('l1.png'),
      densePage(false, 'plain.png'),
      lightPage('l2.png')
    ];
    await seedVolume(page, pages, 'auto');
    await openReader(page);

    /** Turn the page from inside it: t0 → the first line snapped → that frame painted. */
    const turn = (target: number, code: string) =>
      page.evaluate(
        ({ target, code }) =>
          new Promise<{ positioned: number; painted: number }>((resolve) => {
            const t0 = performance.now();
            const observer = new MutationObserver(() => {
              const line = document.querySelector<HTMLElement>(
                `[data-page-index="${target}"] .positionedLine`
              );
              if (!line || line.style.transform === '') return;
              observer.disconnect();
              const positioned = performance.now() - t0;
              requestAnimationFrame(() =>
                setTimeout(() => resolve({ positioned, painted: performance.now() - t0 }), 0)
              );
            });
            observer.observe(document.body, {
              subtree: true,
              childList: true,
              attributes: true,
              attributeFilter: ['style']
            });
            window.dispatchEvent(
              new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true })
            );
          }),
        { target, code }
      );

    const weigh = (target: number) =>
      page.evaluate((target) => {
        const boxes = document.querySelectorAll(`[data-page-index="${target}"] .textBox`);
        let nodes = 0;
        let elements = 0;
        for (const box of boxes) {
          const walker = document.createTreeWalker(box, NodeFilter.SHOW_ALL);
          for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
            nodes++;
            if (n.nodeType === Node.ELEMENT_NODE) elements++;
          }
        }
        return {
          boxes: boxes.length,
          nodes,
          elements,
          cells: document.querySelectorAll(`[data-page-index="${target}"] .ocr-char`).length
        };
      }, target);

    const runs: Record<'celled' | 'plain', { positioned: number; painted: number }[]> = {
      celled: [],
      plain: []
    };
    let weight: Record<'celled' | 'plain', Awaited<ReturnType<typeof weigh>>> | null = null;
    // One unmeasured lap first: module/JIT warm-up and image decode are not
    // what the question is about.
    for (let lap = 0; lap < 6; lap++) {
      const celled = await turn(1, 'PageDown');
      await waitForPositioned(page, 1);
      const celledWeight = await weigh(1);
      await turn(2, 'PageDown');
      const plain = await turn(3, 'PageDown');
      await waitForPositioned(page, 3);
      weight ??= { celled: celledWeight, plain: await weigh(3) };
      if (lap > 0) {
        runs.celled.push(celled);
        runs.plain.push(plain);
      }
      await page.keyboard.press('Home');
      await expect(page.locator('[data-page-index="0"]')).toBeVisible();
      await page.waitForTimeout(300);
    }

    expect(weight!.celled.boxes).toBe(40);
    expect(weight!.plain.boxes).toBe(40);
    // auto: no cells, and not one node more than the page without offsets
    expect(weight!.celled.cells).toBe(0);
    expect(weight!.plain.cells).toBe(0);
    expect(weight!.celled.nodes).toBe(weight!.plain.nodes);
    expect(weight!.celled.elements).toBe(weight!.plain.elements);

    const report = (kind: 'celled' | 'plain') => ({
      ...weight![kind],
      positionedMs: +median(runs[kind].map((r) => r.positioned)).toFixed(1),
      paintedMs: +median(runs[kind].map((r) => r.painted)).toFixed(1),
      positionedRuns: runs[kind].map((r) => +r.positioned.toFixed(1))
    });
    const celled = report('celled');
    const plain = report('plain');
    console.log(
      `[char-offsets] DOM weight (auto), page WITH char_offsets: ${JSON.stringify(celled)}`
    );
    console.log(
      `[char-offsets] DOM weight (auto), page without:          ${JSON.stringify(plain)}`
    );
    console.log(
      `[char-offsets] DOM weight ratio with/without (auto): nodes ${(celled.nodes / plain.nodes).toFixed(1)}x, ` +
        `time to first positioned line ${(celled.positionedMs / plain.positionedMs).toFixed(2)}x, ` +
        `time to painted ${(celled.paintedMs / plain.paintedMs).toFixed(2)}x`
    );
    // No threshold on the timings: they are a measurement, not a gate.

    // Original mode is where the cells still render: one per character.
    await setFontSize(page, 'original');
    await turn(1, 'PageDown');
    await waitForPositioned(page, 1);
    const original = await weigh(1);
    console.log(
      `[char-offsets] DOM weight, celled page in ORIGINAL mode: ${JSON.stringify(original)}`
    );
    expect(original.cells).toBe(40 * 4 * 20);
    expect(original.nodes).toBeGreaterThan(weight!.plain.nodes * 5);
  });
});
