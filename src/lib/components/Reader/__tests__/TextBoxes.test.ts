import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { get, writable, type Writable } from 'svelte/store';
import TextBoxes from '../TextBoxes.svelte';
import { settings } from '$lib/settings';
import type { Page } from '$lib/types';
import fixturePage from '$lib/reader/__fixtures__/ocr-page.json';
import { processLine } from '$lib/reader/line-coords-layout';
import textBoxesSource from '../TextBoxes.svelte?raw';

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  return {
    settings: writable({
      fontSize: 'auto',
      boldFont: false,
      displayOCR: true,
      alwaysShowOCR: true,
      textBoxBorders: false,
      ankiConnectSettings: { triggerMethod: 'doubleTap', tags: [], cardMode: 'single' }
    }),
    volumes: writable({})
  };
});

vi.mock('$lib/catalog/db', () => ({
  db: { volumes: { get: vi.fn() } }
}));

vi.mock('$lib/anki-connect', () => ({
  showCropper: vi.fn(),
  openCreateModal: vi.fn(),
  openUpdateModal: vi.fn(),
  expandTextBoxBounds: vi.fn(),
  sendQuickCapture: vi.fn(),
  getLastCardInfo: vi.fn(),
  getCardAgeInMin: vi.fn(),
  extractFieldValues: vi.fn(),
  getModelConfig: vi.fn(),
  blobToBase64: vi.fn()
}));

const settingsStore = settings as unknown as Writable<Record<string, unknown>>;

// Real block from Jujutsukaisen 24 p57: font_size 46 is furigana-inflated;
// true glyphs are ~20-30px
const blockWithCoords = {
  box: [653, 123, 801, 358],
  vertical: true,
  font_size: 46,
  lines_coords: [
    [
      [733, 123],
      [793, 123],
      [793, 298],
      [733, 298]
    ],
    [
      [697, 125],
      [736, 125],
      [741, 358],
      [703, 358]
    ],
    [
      [653, 128],
      [692, 128],
      [692, 325],
      [653, 325]
    ]
  ],
  lines: ['総則追加で言うのは', '結界の出入りを', '可能にしても']
};

function makePage(blocks: unknown[]): Page {
  return {
    version: '0.2.2',
    img_width: 1500,
    img_height: 2200,
    img_path: 'page_001.jpg',
    blocks: blocks as Page['blocks']
  };
}

afterEach(cleanup);

/** The block as a volume from before mokuro wrote line quads has it. */
function withoutQuads<T extends object>(block: T): Omit<T, 'lines_coords'> {
  const { lines_coords: _dropped, ...legacy } = block as T & { lines_coords?: unknown };
  return legacy as Omit<T, 'lines_coords'>;
}

/** Render under another font-size setting, restoring auto afterwards. */
function withFontSize<T>(fontSize: string | number, run: () => T): T {
  settingsStore.update((s) => ({ ...s, fontSize }));
  try {
    return run();
  } finally {
    settingsStore.update((s) => ({ ...s, fontSize: 'auto' }));
  }
}

/**
 * The rendered markup minus what Svelte owns: the scoped-class hash moves with
 * every CSS edit and the comment anchors with every template edit, and neither
 * is markup a DOM text scanner or a stylesheet can see.
 */
function markup(container: HTMLElement): string {
  return container.innerHTML.replace(/<!--.*?-->/g, '').replace(/\s*svelte-[a-z0-9]+/g, '');
}

describe('TextBoxes never renders contenteditable', () => {
  it('edit mode is the overlay, not a setting — no contenteditable attribute', () => {
    const { container } = render(TextBoxes, {
      page: makePage([blockWithCoords]),
      volumeUuid: 'test-uuid'
    });
    expect(container.querySelector('.textBox')!.getAttribute('contenteditable')).toBeNull();
  });
});

describe('TextBoxes auto mode with lines_coords', () => {
  it('renders each line as a positioned span sized from its quad', () => {
    const { container } = render(TextBoxes, {
      page: makePage([blockWithCoords]),
      volumeUuid: 'test-uuid'
    });

    const spans = container.querySelectorAll<HTMLElement>('.ocr-line.positionedLine');
    expect(spans).toHaveLength(3);

    // first line: its quad captured a neighbor's ruby ink (60px wide for
    // ~19px glyphs) → wraps at the reference size inside its quad bbox,
    // clipped off the neighboring column's rendered edge (the no-overlap
    // invariant trims the first ~2.7px). The quad origin is carried on
    // data-target-* (not style.left/top) and applied as a transform by
    // positionPerLine after layout — see the continuity guard test below.
    expect(spans[0].classList.contains('wrappedLine')).toBe(true);
    expect(parseFloat(spans[0].dataset.targetLeft!)).toBeCloseTo(83, 0);
    expect(spans[0].dataset.targetTop).toBe('0');
    expect(parseFloat(spans[0].style.width)).toBeCloseTo(57, 0);
    expect(spans[0].style.height).toBe('175px');
    expect(parseFloat(spans[0].style.fontSize)).toBeCloseTo(28.5, 1);

    // remaining lines: clean columns, no wrapping container
    expect(spans[1].classList.contains('wrappedLine')).toBe(false);
    expect(spans[1].style.width).toBe('');

    for (const span of spans) {
      const size = parseFloat(span.style.fontSize);
      // fitted sizes stay below the inflated block font_size
      expect(size).toBeGreaterThan(10);
      expect(size).toBeLessThan(46);
    }

    // the box keeps its OCR dimensions as the hover/tap target
    const box = container.querySelector<HTMLElement>('.textBox');
    expect(box?.style.width).toBe('148px');
    expect(box?.style.height).toBe('235px');
  });

  // Regression guard for #254: per-line spans must stay in normal flow so DOM
  // text scanners (Yomitan/Migaku) read the block as one continuous run. A
  // per-line `position: absolute` (or inline left/top) re-introduces the hard
  // line break that splits words and truncates the mined sentence. The exact
  // on-quad placement is a transform applied after layout and is verified in
  // the browser, not jsdom (offsetParent is null here, so the action no-ops).
  it('keeps per-line spans in flow with no absolute positioning (#254)', () => {
    const { container } = render(TextBoxes, {
      page: makePage([blockWithCoords]),
      volumeUuid: 'test-uuid'
    });

    const spans = container.querySelectorAll<HTMLElement>('.ocr-line.positionedLine');
    expect(spans.length).toBeGreaterThan(0);

    for (const span of spans) {
      // no inline absolute-positioning styles
      expect(span.style.position).toBe('');
      expect(span.style.left).toBe('');
      expect(span.style.top).toBe('');
      // placement data is carried for the post-layout transform instead
      expect(span.dataset.targetLeft).toBeDefined();
      expect(span.dataset.targetTop).toBeDefined();
    }
  });

  it('falls back to legacy hover-fit auto when lines_coords is absent', () => {
    const { lines_coords: _dropped, ...legacyBlock } = blockWithCoords;
    const { container } = render(TextBoxes, {
      page: makePage([legacyBlock]),
      volumeUuid: 'test-uuid'
    });

    expect(container.querySelectorAll('.ocr-line.positionedLine')).toHaveLength(0);
    expect(container.querySelectorAll('.ocr-line')).toHaveLength(3);

    const box = container.querySelector<HTMLElement>('.textBox');
    expect(box?.style.fontSize).toBe('46px');
    expect(box?.classList.contains('perLine')).toBe(false);
    // legacy auto expands the box 10% and fixes its dimensions as fit target
    expect(parseFloat(box!.style.width)).toBeCloseTo(148 * 1.1, 1);
  });

  // Was: 'original mode renders the raw block font_size without per-line
  // layout'. Ignoring the line quads was a bug — a file with rotated quads
  // rendered as one upright paragraph — and so was the raw font_size where the
  // file's own quads contradict it: this block says 46px around ~34px print,
  // and at 46px on its real pitch the glyphs draw on top of each other. The
  // block's size is the file's, capped by what its lines can carry.
  it('original mode places each line on its quad, at the block font_size its quads can carry', () => {
    withFontSize('original', () => {
      const { container } = render(TextBoxes, {
        page: makePage([blockWithCoords]),
        volumeUuid: 'test-uuid'
      });
      const spans = container.querySelectorAll<HTMLElement>('.ocr-line.positionedLine');
      expect(spans).toHaveLength(3);
      for (const span of spans) {
        const size = parseFloat(span.style.fontSize);
        expect(size).toBeLessThan(46);
        expect(size).toBeGreaterThan(20);
        // closed up by 5% of a glyph at the very most
        expect(parseFloat(span.style.letterSpacing) / size).toBeGreaterThanOrEqual(-0.05 - 1e-9);
        // the file is not second-guessed beyond that: auto wraps line 0 into
        // its quad, original never does
        expect(span.classList.contains('wrappedLine')).toBe(false);
        expect(span.style.width).toBe('');
      }
      // the two clean columns in ONE size; the merged-columns line 0 (twice
      // the glyphs its length holds at that size) alone goes lower
      expect(spans[1].style.fontSize).toBe(spans[2].style.fontSize);
      expect(parseFloat(spans[0].style.fontSize)).toBeLessThan(parseFloat(spans[1].style.fontSize));
      const box = container.querySelector<HTMLElement>('.textBox')!;
      expect(box.style.fontSize).toBe('46px');
      expect(box.classList.contains('originalMode')).toBe(true);
      // per-line boxes keep the OCR dimensions as the hover/tap target
      expect(box.style.width).toBe('148px');
      expect(box.style.height).toBe('235px');
    });
  });
});

// One-Punch Man 20 p64, a real mokuro page: three vertical balloons and an SFX.
const fixtureBlocks = fixturePage.blocks as unknown as Page['blocks'];

// The markup the component has always written — plus, in auto mode, what the
// uniform grid adds to a line whose text does not already fill its quad: a
// `letter-spacing` style and a `data-inset` (line-grid.ts). The targets, sizes
// and text are untouched.
describe('TextBoxes renders as it always has', () => {
  it('auto mode', () => {
    const { container } = render(TextBoxes, {
      page: makePage([fixtureBlocks[3]]),
      volumeUuid: 'test-uuid'
    });
    expect(markup(container)).toMatchSnapshot();
  });

  it('auto mode, a multi-line block', () => {
    const { container } = render(TextBoxes, {
      page: makePage([blockWithCoords]),
      volumeUuid: 'test-uuid'
    });
    expect(markup(container)).toMatchSnapshot();
  });

  // The recorded markup is the one from before original mode read the line
  // quads, byte for byte: a block WITHOUT lines_coords (every volume imported
  // before mokuro wrote them) has nothing to be placed on and keeps the
  // whole-block paragraph at the file's size. The two blocks are the ones the
  // snapshot was recorded with, minus their quads — the legacy markup never
  // read them.
  it('original mode, blocks without lines_coords', () => {
    withFontSize('original', () => {
      const { container } = render(TextBoxes, {
        page: makePage([fixtureBlocks[3], blockWithCoords].map(withoutQuads)),
        volumeUuid: 'test-uuid'
      });
      expect(container.querySelectorAll('.positionedLine')).toHaveLength(0);
      expect(markup(container)).toMatchSnapshot();
    });
  });

  it('a manual size ignores OCR geometry', () => {
    withFontSize(24, () => {
      const { container } = render(TextBoxes, {
        page: makePage(fixtureBlocks),
        volumeUuid: 'test-uuid'
      });
      expect(markup(container)).toMatchSnapshot();
    });
  });
});

describe('TextBoxes: the fixed-pitch grid and rotation', () => {
  const renderBlocks = (blocks: unknown[]) =>
    render(TextBoxes, { page: makePage(blocks), volumeUuid: 'test-uuid' }).container;
  const lineSpans = (container: HTMLElement) => [
    ...container.querySelectorAll<HTMLElement>('.ocr-line')
  ];
  /** w × h upright rectangle about (cx, cy), turned like CSS rotate(deg). */
  const tilted = (cx: number, cy: number, w: number, h: number, deg: number) => {
    const t = (deg * Math.PI) / 180;
    return [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2]
    ].map(([dx, dy]) => [
      cx + dx * Math.cos(t) - dy * Math.sin(t),
      cy + dx * Math.sin(t) + dy * Math.cos(t)
    ]);
  };
  const sfxQuad = tilted(500, 400, 50, 360, 20);
  const sfx = {
    box: [409, 222, 591, 578],
    vertical: true,
    font_size: 50,
    lines: ['ドドドドドド'],
    lines_coords: [sfxQuad]
  };
  // Quads hug the INK (hiragana leave 0.11 / 0.10 of their end cells empty).
  // Line 0: 8 glyphs set solid at 40px, cells from y = 0 — ink from 4.4 to 316.
  // Line 1: 4 glyphs of the same size tracked out to a 56px step — ink from
  // 4.4 to 3 × 56 + 36 = 204.
  const loose = {
    box: [100, 0, 190, 320],
    vertical: true,
    font_size: 40,
    lines: ['あいうえおかきく', 'さしすせ'],
    lines_coords: [
      [
        [150, 4.4],
        [190, 4.4],
        [190, 316],
        [150, 316]
      ],
      [
        [100, 4.4],
        [140, 4.4],
        [140, 204],
        [100, 204]
      ]
    ]
  };

  it('renders every line as ONE text node, in auto and in original mode', () => {
    const expected = [...fixtureBlocks].flatMap((block) => block.lines.map(processLine)).sort();
    for (const mode of ['auto', 'original'] as const) {
      const container = withFontSize(mode, () => renderBlocks(fixtureBlocks));
      expect(
        lineSpans(container)
          .map((span) => span.textContent)
          .sort()
      ).toEqual(expected);
      // no element inside a line: no per-character span, #254 per glyph
      for (const span of lineSpans(container)) expect(span.children).toHaveLength(0);
      cleanup();
    }
  });

  it('carries the grid as letter-spacing on the line and the start inset as data', () => {
    const [full, short] = lineSpans(renderBlocks([loose]));
    // text set solid at its own size: no spacing — only the inset that puts
    // the first CELL, not the first ink, 0.11em before the quad's start
    expect(full.style.letterSpacing).toBe('');
    expect(Number(full.dataset.inset)).toBeCloseTo(-4.4, 6);
    expect(full.dataset.rotation).toBeUndefined();
    // a 56px step at 40px glyphs
    expect(parseFloat(short.style.letterSpacing)).toBeCloseTo(16, 6);
    expect(Number(short.dataset.inset)).toBeCloseTo(-4.4, 6);
    // the target stays the quad's start: the inset is applied by the action
    expect(short.dataset.targetTop).toBe('4.4');
    expect(short.textContent).toBe('さしすせ');
  });

  it('carries a tilted quad as its own-frame box and angle', () => {
    const [line] = lineSpans(renderBlocks([sfx]));
    expect(Number(line.dataset.rotation)).toBeCloseTo(20, 6);
    expect(Number(line.dataset.boxWidth)).toBeCloseTo(50, 6);
    expect(Number(line.dataset.boxHeight)).toBeCloseTo(360, 6);
    // box centre = quad centre, relative to the block box
    expect(Number(line.dataset.targetLeft) + 25).toBeCloseTo(500 - sfx.box[0], 6);
    expect(Number(line.dataset.targetTop) + 180).toBeCloseTo(400 - sfx.box[1], 6);
    // six katakana 50px thick in 360px of ink: flush with both ends
    expect(parseFloat(line.style.letterSpacing)).toBeCloseTo((360 - 50 * 0.78) / 5 - 50, 6);
    expect(Number(line.dataset.inset)).toBeCloseTo(-0.12 * 50, 6);
    // still one in-flow text node: no position, no wrap container
    expect(line.style.position).toBe('');
    expect(line.style.width).toBe('');
    expect(line.children).toHaveLength(0);
    expect(line.textContent).toBe('ドドドドドド');
  });

  // jsdom lays nothing out (offsetParent is null, so the action no-ops). Give
  // it just enough of a layout to run: every span naturally at (0,0), 0×0. The
  // real geometry is measured in Chromium (e2e/line-grid.spec.ts).
  it('positionPerLine writes translate + rotate about the own-frame box centre', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) {
        return this.parentElement;
      }
    });
    try {
      const container = renderBlocks([sfx, loose]);
      const [tiltedLine] = lineSpans(container.querySelectorAll<HTMLElement>('.textBox')[0]);
      const [full, short] = lineSpans(container.querySelectorAll<HTMLElement>('.textBox')[1]);
      await vi.waitFor(() => expect(short.style.transform).not.toBe(''));

      // upright: the plain translate, the inset added along the reading axis
      // (quad start 4.4, first cell 4.4 before it)
      const translate = (el: HTMLElement) =>
        /^translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\)$/
          .exec(el.style.transform)!
          .slice(1)
          .map(Number);
      expect(translate(full)[0]).toBe(50);
      expect(translate(full)[1]).toBeCloseTo(0, 6);
      expect(translate(short)[0]).toBe(0);
      expect(translate(short)[1]).toBeCloseTo(0, 6);
      expect(short.style.transformOrigin).toBe('');

      const match = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) rotate\(([\d.]+)deg\)$/.exec(
        tiltedLine.style.transform
      );
      expect(match, tiltedLine.style.transform).not.toBeNull();
      const [x, y, deg] = match!.slice(1).map(Number);
      expect(deg).toBeCloseTo(20, 6);
      // a 0×0 span: centred across the box (left + 25), its first cell 6px
      // (0.12 × 50) before the box's start edge
      expect(x).toBeCloseTo(500 - sfx.box[0], 6);
      expect(y).toBeCloseTo(400 - sfx.box[1] - 180 - 6, 6);
      // the origin is the box centre seen from the span: (0, 180 + 6)
      const [ox, oy] = tiltedLine.style.transformOrigin.split(' ').map(parseFloat);
      expect(ox).toBeCloseTo(0, 6);
      expect(oy).toBeCloseTo(186, 6);
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetParent', descriptor);
    }
  });

  // ORIGINAL mode is the file as it is: the placement the file gives (line
  // quads → frame, pitch grid, ink insets, rotation — all of the above) at the
  // size the file gives (the block's font_size), where auto fits one. A block
  // with no quads has nothing to be placed on ('…renders as it always has').
  describe("original mode: the same placement, at the file's font size", () => {
    // the file says 44px around 50px print, and 42px around 40px print — 5%
    // over the step, as a consistent mokuro file does
    const sfx44 = { ...sfx, font_size: 44 };
    const loose42 = { ...loose, font_size: 42 };
    /** jsdom lays nothing out: give the action a layout to run on, every span
     * naturally at (0,0) and 0×0. Real geometry: e2e/line-grid.spec.ts. */
    async function withOffsetParent(run: () => Promise<void>) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get(this: HTMLElement) {
          return this.parentElement;
        }
      });
      try {
        await run();
      } finally {
        if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetParent', descriptor);
        settingsStore.update((s) => ({ ...s, fontSize: 'auto' }));
      }
    }

    it('a tilted quad: one in-flow text node, turned, at font_size', () => {
      const [line] = lineSpans(withFontSize('original', () => renderBlocks([sfx44])));
      expect(line.classList.contains('positionedLine')).toBe(true);
      expect(line.style.fontSize).toBe('44px');
      // the very box and angle auto gives the line
      expect(Number(line.dataset.rotation)).toBeCloseTo(20, 6);
      expect(Number(line.dataset.boxWidth)).toBeCloseTo(50, 6);
      expect(Number(line.dataset.boxHeight)).toBeCloseTo(360, 6);
      expect(Number(line.dataset.targetLeft) + 25).toBeCloseTo(500 - sfx.box[0], 6);
      expect(Number(line.dataset.targetTop) + 180).toBeCloseTo(400 - sfx.box[1], 6);
      // the print's 64.2px step less the file's 44px; the first glyph centred
      // on the print's 50px one: 3px later than its cell, which starts 6px early
      const step = 50 + (360 - 50 * (6 - 0.12 - 0.1)) / 5;
      expect(parseFloat(line.style.letterSpacing)).toBeCloseTo(step - 44, 6);
      expect(Number(line.dataset.inset)).toBeCloseTo(3 - 6, 6);
      expect(line.style.position).toBe('');
      expect(line.style.width).toBe('');
      expect(line.children).toHaveLength(0);
      expect(line.textContent).toBe('ドドドドドド');
      const box = line.closest<HTMLElement>('.textBox')!;
      expect(box.classList.contains('perLine')).toBe(true);
      expect(box.classList.contains('originalMode')).toBe(true);
    });

    it('upright lines: letter-spacing is the pitch less the file size, closing up when the file overstates', () => {
      const [full, short] = lineSpans(withFontSize('original', () => renderBlocks([loose42])));
      expect(full.style.fontSize).toBe('42px');
      expect(short.style.fontSize).toBe('42px');
      expect(parseFloat(full.style.letterSpacing)).toBeCloseTo(40 - 42, 6);
      expect(parseFloat(short.style.letterSpacing)).toBeCloseTo(56 - 42, 6);
      expect(Number(full.dataset.inset)).toBeCloseTo(-1 - 4.4, 6);
      expect(short.dataset.targetTop).toBe('4.4');
      expect(full.dataset.rotation).toBeUndefined();
    });

    it('a font_size the quads contradict is capped: glyphs never close up by more than 0.05em, one size per block', () => {
      // mokuro's p95: twice the print. 80px glyphs on a 40px step used to
      // fall off the grid (an unspaced 640px run down a 320px column, 80px
      // wide on 40px columns 50px apart).
      const [full, short] = lineSpans(
        withFontSize('original', () => renderBlocks([{ ...loose, font_size: 80 }]))
      );
      expect(parseFloat(full.style.fontSize)).toBeCloseTo(40 / 0.95, 6);
      expect(short.style.fontSize).toBe(full.style.fontSize);
      expect(parseFloat(full.style.letterSpacing)).toBeCloseTo(40 - 40 / 0.95, 6);
      expect(parseFloat(short.style.letterSpacing)).toBeCloseTo(56 - 40 / 0.95, 6);
      // the block's own font-size stays the file's: only the lines are capped
      expect(full.closest<HTMLElement>('.textBox')!.style.fontSize).toBe('80px');
    });

    it('a manual size is untouched by any of it: no per-line spans, no rotation', () => {
      const container = withFontSize(24, () => renderBlocks([sfx44, loose42]));
      expect(container.querySelectorAll('.positionedLine')).toHaveLength(0);
      expect(container.querySelectorAll('[data-rotation]')).toHaveLength(0);
      for (const box of container.querySelectorAll<HTMLElement>('.textBox')) {
        expect(box.style.fontSize).toBe('24pt');
        expect(box.classList.contains('perLine')).toBe(false);
      }
    });

    it('positionPerLine turns the line in original mode, and re-measures on auto → original → auto', async () => {
      await withOffsetParent(async () => {
        const container = renderBlocks([sfx44]);
        const line = () => lineSpans(container)[0];
        const placed = () => {
          const match = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) rotate\(([\d.]+)deg\)$/.exec(
            line().style.transform
          );
          expect(match, line().style.transform).not.toBeNull();
          const [x, y, deg] = match!.slice(1).map(Number);
          return { x, y, deg, origin: line().style.transformOrigin.split(' ').map(parseFloat) };
        };
        // a 0×0 span: centred across the box, the run starting `inset` before
        // the box's start edge — 6px in auto (50px glyphs), 3px at the file's 44
        const startEdge = 400 - sfx.box[1] - 180;
        const expectPlaced = async (fontSize: number, inset: number) => {
          await vi.waitFor(() => {
            expect(parseFloat(line().style.fontSize)).toBeCloseTo(fontSize, 6);
            expect(placed().y).toBeCloseTo(startEdge + inset, 6);
          });
          expect(placed().x).toBeCloseTo(500 - sfx.box[0], 6);
          expect(placed().deg).toBeCloseTo(20, 6);
          expect(placed().origin[0]).toBeCloseTo(0, 6);
          expect(placed().origin[1]).toBeCloseTo(180 - inset, 6);
        };
        await expectPlaced(50, -6);
        settingsStore.update((s) => ({ ...s, fontSize: 'original' }));
        await expectPlaced(44, -3);
        settingsStore.update((s) => ({ ...s, fontSize: 'auto' }));
        await expectPlaced(50, -6);
      });
    });
  });
});
