import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fixed-pitch placement against a PRINTED page (src/lib/reader/line-grid.ts,
 * glyph-insets.ts), in a real layout engine.
 *
 * The defect this guards against was measured on a scanned novel: a detector's
 * line quad hugs the INK, the old grid took it for n full character cells, and
 * every line ending in 。 、 」 (or starting with 「) was squeezed — 0.6 of a
 * glyph off at its end, the pointer on a printed glyph landing in a different
 * rendered character for 12.6% of glyphs (27.6% on a page of dialogue), and
 * 「嫌だ」 rendered at two thirds of the body text beside it.
 *
 * A commercial book cannot be committed, so the test draws its own page and
 * OWNS its ground truth: vertical columns set solid at a known pitch, one
 * glyph per cell; the punctuation whose vertical forms a canvas cannot set
 * (。 、 「 」 ー) is drawn stroke by stroke where print puts it. The file's
 * quads are then MEASURED off the drawn pixels — first to last inked row of
 * each column — so they hug the ink exactly as a detector's do, and nothing in
 * the fixture comes from the code under test.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.NOVEL_GRID_SHOTS ?? join(HERE, '../test-results/novel-grid-shots');

const SERIES = 'Novel Grid Series';
const SERIES_UUID = 'e2e-novel-grid-series';
const VOLUME_UUID = 'e2e-novel-grid-volume';

const PITCH = 64;
/** Column strips are a little thicker than the glyphs, as detector quads are. */
const STRIP = 72;
const TOP = 150;
const PAGE_W = 1100;
const PAGE_H = 1700;

interface Column {
  text: string;
  /** centre x of the column */
  x: number;
  /** px the "detector" overshoots the ink at the line's END (its usual slack) */
  slack?: number;
}
/** One OCR block per entry: the columns of a paragraph share a block. */
const BLOCKS: Column[][] = [
  [
    { text: '山のむこうから風がふいてきて木の葉をゆらした', x: 1000 },
    { text: '「きょうは早くかえろう」と兄がいったので、', x: 900, slack: 14 },
    { text: 'みんなでうなずいた。', x: 800 }
  ],
  [{ text: '「そんなことは知らないよ」', x: 660 }],
  [{ text: '「嫌だ」', x: 540 }],
  [{ text: 'ーそれから一年がすぎた。', x: 420 }],
  [{ text: 'あの店のラーメンは世界一', x: 300 }]
];
const BODY = BLOCKS[0][0];
const SHORT = BLOCKS[2][0];

type Quad = [number, number][];
interface FilePage {
  version: string;
  img_width: number;
  img_height: number;
  img_path: string;
  blocks: {
    box: number[];
    vertical: boolean;
    font_size: number;
    lines: string[];
    lines_coords: Quad[];
  }[];
}

/** Draws the page, measures the ink, seeds the volume. Returns the file page. */
async function seedVolume(page: Page): Promise<FilePage> {
  await page.goto('/');
  await page.waitForTimeout(800);
  return page.evaluate(
    async ({ SERIES, SERIES_UUID, VOLUME_UUID, BLOCKS, PITCH, STRIP, TOP, PAGE_W, PAGE_H }) => {
      const { db } = await import('/src/lib/catalog/db.ts');
      await db.open();
      await Promise.all([
        db.volumes.clear(),
        db.volume_ocr.clear(),
        db.volume_files.clear(),
        db.volume_ocr_layers.clear()
      ]);
      const everything = BLOCKS.flat()
        .map((c) => c.text)
        .join('');
      // The app registers Noto Sans JP by script (web-fonts.ts): until it has,
      // `fonts.load` finds no face and the reference is drawn in the fallback.
      await (await import('/src/lib/util/web-fonts.ts')).loadWebFonts();
      await document.fonts.load(`${PITCH}px 'Noto Sans JP'`, everything).catch(() => undefined);

      const canvas = document.createElement('canvas');
      canvas.width = PAGE_W;
      canvas.height = PAGE_H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, PAGE_W, PAGE_H);
      ctx.fillStyle = '#111';
      ctx.strokeStyle = '#111';
      ctx.lineCap = 'butt';
      ctx.font = `${PITCH}px 'Noto Sans JP', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Vertical forms, in ems from the cell's top-left corner — where print
      // puts them: 。 and 、 top right, 「 the END of its cell, 」 the START.
      const em = PITCH;
      const stroke = (points: number[][], width: number, x0: number, y0: number) => {
        ctx.lineWidth = width * em;
        ctx.beginPath();
        points.forEach(([x, y], k) =>
          k ? ctx.lineTo(x0 + x * em, y0 + y * em) : ctx.moveTo(x0 + x * em, y0 + y * em)
        );
        ctx.stroke();
      };
      const drawn: Record<string, (x0: number, y0: number) => void> = {
        '。': (x0, y0) => {
          ctx.lineWidth = 0.05 * em;
          ctx.beginPath();
          ctx.arc(x0 + 0.74 * em, y0 + 0.2 * em, 0.11 * em, 0, 2 * Math.PI);
          ctx.stroke();
        },
        '、': (x0, y0) =>
          stroke(
            [
              [0.62, 0.08],
              [0.8, 0.3]
            ],
            0.07,
            x0,
            y0
          ),
        '「': (x0, y0) =>
          stroke(
            [
              [0.25, 0.68],
              [0.85, 0.68],
              [0.85, 0.97]
            ],
            0.05,
            x0,
            y0
          ),
        '」': (x0, y0) =>
          stroke(
            [
              [0.15, 0.03],
              [0.15, 0.34],
              [0.75, 0.34]
            ],
            0.05,
            x0,
            y0
          ),
        ー: (x0, y0) =>
          stroke(
            [
              [0.5, 0.06],
              [0.5, 0.95]
            ],
            0.06,
            x0,
            y0
          )
      };

      const blocks = BLOCKS.map((columns) => {
        const quads = columns.map((column) => {
          [...column.text].forEach((glyph, k) => {
            const x0 = column.x - em / 2;
            const y0 = TOP + k * PITCH;
            if (drawn[glyph]) drawn[glyph](x0, y0);
            else ctx.fillText(glyph, column.x, y0 + em / 2);
          });
          // the "detector": first to last inked row of the column's strip
          const left = column.x - STRIP / 2;
          const data = ctx.getImageData(left, 0, STRIP, PAGE_H).data;
          let first = -1;
          let last = -1;
          for (let y = 0; y < PAGE_H; y++) {
            let inked = false;
            for (let x = 0; x < STRIP && !inked; x++) inked = data[(y * STRIP + x) * 4] < 140;
            if (!inked) continue;
            if (first < 0) first = y;
            last = y;
          }
          const bottom = last + 1 + (column.slack ?? 0);
          return [
            [left, first],
            [left + STRIP, first],
            [left + STRIP, bottom],
            [left, bottom]
          ] as [number, number][];
        });
        const xs = quads.flat().map((p) => p[0]);
        const ys = quads.flat().map((p) => p[1]);
        return {
          box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          vertical: true,
          font_size: STRIP,
          lines: columns.map((c) => c.text),
          lines_coords: quads
        };
      });
      const filePage = {
        version: '0.3.0b',
        img_width: PAGE_W,
        img_height: PAGE_H,
        img_path: 'novel.png',
        blocks
      };

      const blob: Blob = await new Promise((r) => canvas.toBlob((c) => r(c!), 'image/png'));
      const chars = everything.length;
      await db.volumes.put({
        volume_uuid: VOLUME_UUID,
        series_uuid: SERIES_UUID,
        series_title: SERIES,
        volume_title: 'Vol 1',
        mokuro_version: '0.3.0b',
        page_count: 1,
        character_count: chars,
        page_char_counts: [chars]
      });
      await db.volume_ocr.put({ volume_uuid: VOLUME_UUID, pages: [filePage] });
      await db.volume_files.put({
        volume_uuid: VOLUME_UUID,
        files: { 'novel.png': new File([blob], 'novel.png', { type: 'image/png' }) }
      });
      const { updateSetting } = await import('/src/lib/settings/index.ts');
      updateSetting('continuousScroll', false);
      updateSetting('singlePageView', 'single');
      updateSetting('displayOCR', true);
      updateSetting('alwaysShowOCR', true);
      updateSetting('fontSize', 'auto' as never);
      window.localStorage.removeItem('sidecar-backfill:edited-volumes');
      return filePage;
    },
    { SERIES, SERIES_UUID, VOLUME_UUID, BLOCKS, PITCH, STRIP, TOP, PAGE_W, PAGE_H }
  );
}

async function openReader(page: Page) {
  // Let the catalog settle on the freshly seeded rows before the route
  // changes — a hash set mid-reaction bounces back to the catalog.
  await page.waitForTimeout(800);
  await page.evaluate(
    ({ SERIES_UUID, VOLUME_UUID }) => {
      window.location.hash = `#/reader/${SERIES_UUID}/${VOLUME_UUID}`;
    },
    { SERIES_UUID, VOLUME_UUID }
  );
  await expect(page.locator('[data-page-index="0"]')).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => {
    const lines = document.querySelectorAll<HTMLElement>('[data-page-index="0"] .positionedLine');
    return lines.length > 0 && [...lines].every((l) => l.style.transform !== '');
  });
  await page.evaluate(() => document.fonts.ready);
  // The font-ready re-measure runs on the next frame.
  await page.waitForTimeout(300);
}

interface RenderedGlyph {
  /** centre of the glyph's INK along the column, image px */
  centre: number;
  /** the character's box along the column — what a pointer hit-tests */
  start: number;
  end: number;
  /** caretRangeFromPoint at the DRAWN glyph's centre: offset into the line, or -1 */
  caret: number;
}
interface RenderedLine {
  text: string;
  fontSize: number;
  letterSpacing: number;
  rotated: boolean;
  glyphs: RenderedGlyph[];
}

/** Every line of the page, measured in IMAGE px (zoom is an ancestor transform). */
async function measure(page: Page): Promise<RenderedLine[]> {
  return page.evaluate(
    ({ BLOCKS, PITCH, TOP }) => {
      const pageEl = document.querySelector<HTMLElement>('[data-page-index="0"]')!;
      const origin = pageEl.getBoundingClientRect();
      const scale = origin.width / pageEl.offsetWidth;
      const columns = BLOCKS.flat();
      return [...pageEl.querySelectorAll<HTMLElement>('.ocr-line')].map((line) => {
        const node = [...line.childNodes].find(
          (n) => n.nodeType === Node.TEXT_NODE && n.nodeValue !== ''
        ) as Text;
        const style = getComputedStyle(line);
        const letterSpacing = parseFloat(style.letterSpacing) || 0;
        const column = columns.find((c) => c.text === node.data)!;
        return {
          text: node.data,
          fontSize: parseFloat(style.fontSize),
          letterSpacing,
          rotated: line.style.transform.includes('rotate'),
          // every character here is one UTF-16 unit
          glyphs: [...node.data].map((_, k) => {
            const range = document.createRange();
            range.setStart(node, k);
            range.setEnd(node, k + 1);
            const r = range.getBoundingClientRect();
            const start = (r.top - origin.top) / scale;
            const end = (r.bottom - origin.top) / scale;
            // the browser puts the letter-spacing AFTER the glyph
            const centre = (start + end - letterSpacing) / 2;
            // …and the pointer on the PRINTED glyph k: the centre of its cell
            const px = origin.left + column.x * scale;
            const py = origin.top + (TOP + (k + 0.5) * PITCH) * scale;
            const caret = document.caretRangeFromPoint(px, py);
            return {
              centre,
              start,
              end,
              caret: caret && caret.startContainer === node ? caret.startOffset : -1
            };
          })
        };
      });
    },
    { BLOCKS, PITCH, TOP }
  );
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  // See the print through the overlay: no white ground, translucent text.
  const style = await page.addStyleTag({
    content:
      '.textBox, .textBox p { background: transparent !important; }' +
      '.textBox p { color: rgba(225, 29, 72, 0.8) !important; }'
  });
  await page.locator('[data-page-index="0"]').screenshot({ path: join(SHOTS, `${name}.png`) });
  await style.evaluate((el) => el.remove());
}

test.describe('novel grid — fixed pitch against the print', () => {
  // Denser raster only: CSS px (and so every measurement) are unchanged.
  test.use({ deviceScaleFactor: 2 });

  test('every glyph sits on its printed cell, a short bracketed line is body-sized, and the pointer on a printed glyph is on that character', async ({
    page
  }) => {
    const filePage = await seedVolume(page);
    await openReader(page);
    const lines = await measure(page);
    const columns = BLOCKS.flat();
    expect(lines.map((l) => l.text).sort()).toEqual(columns.map((c) => c.text).sort());

    // The fixture is the defect's: the quads hug the ink, so a line ending in
    // 。 spans well under n cells — what the old `main / n` grid squeezed.
    const quadOf = (text: string) => {
      for (const b of filePage.blocks) {
        const i = b.lines.indexOf(text);
        if (i >= 0) return b.lines_coords[i];
      }
      throw new Error(`no quad for ${text}`);
    };
    const closing = BLOCKS[0][2];
    const closingQuad = quadOf(closing.text);
    const spanned = (closingQuad[2][1] - closingQuad[0][1]) / PITCH;
    expect(closing.text.length - spanned).toBeGreaterThan(0.6);
    // …and 「嫌だ」 is 4 glyphs in under 3 cells of ink: 45px a glyph by main / n
    const shortQuad = quadOf(SHORT.text);
    expect((shortQuad[2][1] - shortQuad[0][1]) / SHORT.text.length).toBeLessThan(0.75 * PITCH);

    const report: string[] = [];
    let probes = 0;
    let onCharacter = 0;
    for (const line of lines) {
      expect(line.rotated, `${line.text}: upright`).toBe(false);
      const drift = line.glyphs.map((g, k) => (g.centre - (TOP + (k + 0.5) * PITCH)) / PITCH);
      const worst = Math.max(...drift.map(Math.abs));
      report.push(
        `"${line.text.slice(0, 4)}…${line.text.slice(-2)}" n=${line.glyphs.length} font ${line.fontSize.toFixed(2)} ` +
          `ls ${line.letterSpacing.toFixed(2)}: drift first ${drift[0].toFixed(3)} last ${drift[drift.length - 1].toFixed(3)} max ${worst.toFixed(3)} glyph`
      );
      // (1) every rendered glyph centre within 0.15 of a glyph of the drawn one
      drift.forEach((d, k) =>
        expect(
          Math.abs(d),
          `${line.text}: glyph ${k} (${line.text[k]}) vs its printed cell`
        ).toBeLessThan(0.15)
      );
      // (3) the pointer on the PRINTED glyph k is inside rendered character k,
      // and the caret there is at character k (before or after it)
      line.glyphs.forEach((g, k) => {
        probes++;
        const printed = TOP + (k + 0.5) * PITCH;
        const inside = printed >= g.start && printed < g.end;
        const caretOn = g.caret === k || g.caret === k + 1;
        if (inside && caretOn) onCharacter++;
        expect(inside, `${line.text}: printed glyph ${k} is inside rendered character ${k}`).toBe(
          true
        );
        expect(caretOn, `${line.text}: caret at printed glyph ${k} → offset ${g.caret}`).toBe(true);
      });
    }
    console.log(`[novel-grid]\n  ${report.join('\n  ')}`);
    console.log(
      `[novel-grid] pointer on a printed glyph is on that character: ${onCharacter}/${probes}`
    );
    expect(onCharacter).toBe(probes);

    // (2) the short bracketed line renders at the body's size
    const body = lines.find((l) => l.text === BODY.text)!;
    const short = lines.find((l) => l.text === SHORT.text)!;
    expect(body.fontSize / PITCH).toBeGreaterThan(0.95);
    expect(body.fontSize / PITCH).toBeLessThan(1.05);
    expect(short.fontSize / body.fontSize).toBeGreaterThan(0.95);
    expect(short.fontSize / body.fontSize).toBeLessThan(1.05);
    // and the columns of the paragraph share one size and one pitch
    for (const column of BLOCKS[0]) {
      const line = lines.find((l) => l.text === column.text)!;
      expect(line.fontSize).toBeCloseTo(body.fontSize, 3);
      expect(line.letterSpacing).toBeCloseTo(body.letterSpacing, 3);
    }

    await shot(page, 'novel-page-overlay');
  });
});
