import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { get, writable, type Writable } from 'svelte/store';
import TextBoxes from '../TextBoxes.svelte';
import { settings } from '$lib/settings';
import type { Page } from '$lib/types';
import fixturePage from '$lib/reader/__fixtures__/char-offsets-page.json';
import { codePoints } from '$lib/reader/char-offsets';
import { processLine } from '$lib/reader/char-offsets-layout';
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

  it('original mode renders the raw block font_size without per-line layout', () => {
    settingsStore.update((s) => ({ ...s, fontSize: 'original' }));
    try {
      const { container } = render(TextBoxes, {
        page: makePage([blockWithCoords]),
        volumeUuid: 'test-uuid'
      });
      expect(container.querySelectorAll('.ocr-line.positionedLine')).toHaveLength(0);
      expect(container.querySelectorAll('.ocr-line')).toHaveLength(3);
      const box = container.querySelector<HTMLElement>('.textBox');
      expect(box?.style.fontSize).toBe('46px');
      // faithful original mode: unsized, overflow-visible box
      expect(box?.style.width).toBe('');
    } finally {
      settingsStore.update((s) => ({ ...s, fontSize: 'auto' }));
      expect(get(settingsStore)).toBeTruthy();
    }
  });
});

// One-Punch Man 20 p64 (see the README line in char-offsets-layout.test.ts):
// blocks 0–2 carry char_offsets — a zero-width と in b0 l0, a ．．． run in
// b0 l2, a null line in b1 — and block 3 has none.
const fixtureBlocks = fixturePage.blocks as unknown as Page['blocks'];

// Written by the component as it stood before char_offsets was wired in: a
// block without placement must keep rendering exactly this — plus, in auto
// mode, what the uniform grid adds to a line whose text does not already fill
// its quad: a `letter-spacing` style and a `data-inset` (line-grid.ts). The
// targets, sizes and text are untouched.
describe('TextBoxes without char_offsets renders as it always has', () => {
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

  it('original mode', () => {
    withFontSize('original', () => {
      const { container } = render(TextBoxes, {
        page: makePage([fixtureBlocks[3], blockWithCoords]),
        volumeUuid: 'test-uuid'
      });
      expect(markup(container)).toMatchSnapshot();
    });
  });

  it('a manual size ignores OCR geometry, char_offsets included', () => {
    withFontSize(24, () => {
      const { container } = render(TextBoxes, {
        page: makePage(fixtureBlocks),
        volumeUuid: 'test-uuid'
      });
      expect(markup(container)).toMatchSnapshot();
    });
  });
});

// char_offsets render in ORIGINAL mode only — the diagnostic view of what the
// producer wrote. Auto mode ignores the field and places every line on the
// fixed-pitch grid (see 'TextBoxes auto mode: the fixed-pitch grid' below).
describe('TextBoxes with char_offsets', () => {
  const renderBlock = (block: unknown) =>
    render(TextBoxes, { page: makePage([block]), volumeUuid: 'test-uuid' }).container;
  const lineSpans = (container: HTMLElement) => [
    ...container.querySelectorAll<HTMLElement>('.ocr-line')
  ];
  const charSpans = (line: HTMLElement) => [...line.querySelectorAll<HTMLElement>('.ocr-char')];
  /** Child nodes a text scanner sees. Svelte's block anchors — comments and
   * EMPTY text nodes — are no text; a whitespace text node would be. */
  const contentNodes = (el: HTMLElement) =>
    [...el.childNodes].filter(
      (node) =>
        node.nodeType !== Node.COMMENT_NODE &&
        !(node.nodeType === Node.TEXT_NODE && node.nodeValue === '')
    );
  /** The advance a cell was given. jsdom keeps it on the style attribute. */
  const inlineSize = (char: HTMLElement) =>
    /(?:^|;)\s*inline-size:\s*([^;]+)/.exec(char.getAttribute('style') ?? '')?.[1].trim();

  it.each([
    ['auto', 0],
    ['original', 7]
  ] as const)(
    'renders one .ocr-line per line, holding one .ocr-char per code point of the rendered text (%s)',
    (mode, expectedCelled) => withFontSize(mode, () => celledLinesInvariant(mode, expectedCelled))
  );

  function celledLinesInvariant(mode: 'auto' | 'original', expectedCelled: number) {
    let celledLines = 0;
    for (const block of fixtureBlocks) {
      const container = renderBlock(block);
      const spans = lineSpans(container);
      expect(spans).toHaveLength(block.lines.length);
      block.lines.forEach((raw, i) => {
        const processed = processLine(raw);
        // THE invariant: selection, copy and Yomitan read the line span
        expect(spans[i].textContent, raw).toBe(processed);
        const chars = charSpans(spans[i]);
        if (mode === 'original' && block.char_offsets?.[i]) {
          celledLines++;
          expect(chars, raw).toHaveLength(codePoints(processed).length);
          expect(chars.map((char) => char.textContent)).toEqual(codePoints(processed));
          // nothing but the cells: a whitespace text node between two of them
          // would be a character the file never had
          expect(contentNodes(spans[i])).toEqual(chars);
          // …and nothing but the character inside each
          for (const char of chars) {
            expect(contentNodes(char)).toHaveLength(1);
            expect(char.children).toHaveLength(0);
          }
        } else {
          expect(chars, raw).toHaveLength(0);
          expect(spans[i].children).toHaveLength(0);
        }
      });
      // the block still reads as one continuous run, line after line
      expect(container.querySelector('p')!.textContent).toBe(block.lines.map(processLine).join(''));
      cleanup();
    }
    expect(celledLines).toBe(expectedCelled);
  }

  it('gives every cell its advance as inline-size, the collapsed ellipsis run as ONE cell', () => {
    // b0 l2 ends ．．． at [544, 558, 572, 585]: one … cell of 41px
    const spans = lineSpans(withFontSize('original', () => renderBlock(fixtureBlocks[0])));
    const chars = charSpans(spans[2]);
    expect(spans[2].textContent).toBe('フブキ組の強みだったのに…');
    expect(chars).toHaveLength(13);
    expect(chars.map(inlineSize)).toEqual(
      [53, 40, 45, 48, 40, 49, 42, 52, 33, 53, 43, 46, 41].map((size) => `${size}px`)
    );
  });

  it('renders the null line of a mixed block as bare text on the same per-line path', () => {
    const spans = lineSpans(withFontSize('original', () => renderBlock(fixtureBlocks[1])));
    expect(fixtureBlocks[1].char_offsets?.[1]).toBeNull();
    expect(spans[1].classList.contains('positionedLine')).toBe(true);
    expect(contentNodes(spans[1])).toHaveLength(1);
    expect(contentNodes(spans[1])[0].nodeType).toBe(Node.TEXT_NODE);
    expect(charSpans(spans[0])).toHaveLength(6);
    expect(charSpans(spans[2])).toHaveLength(7);
  });

  // #254, per glyph: an out-of-flow character is a paragraph break to a DOM
  // text scanner, so one between every glyph would leave no word to scan.
  it('never takes a character out of flow', () => {
    // original mode: every line of the block on its cells, the squeezed one too
    const container = withFontSize('original', () => renderBlock(fixtureBlocks[0]));
    const chars = [...container.querySelectorAll<HTMLElement>('.ocr-char')];
    expect(chars.length).toBeGreaterThan(30);
    for (const char of chars) {
      expect(char.style.position).toBe('');
      expect(char.style.left).toBe('');
      expect(char.style.top).toBe('');
      expect(['absolute', 'fixed', 'sticky']).not.toContain(getComputedStyle(char).position);
    }
    // jsdom may not apply the scoped stylesheet, so read the rules themselves
    const rules = [...textBoxesSource.matchAll(/[^{}]*\.ocr-char[^{}]*\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, body] of rules) expect(body).not.toMatch(/position\s*:/);
  });

  // Real layout is the e2e's job (e2e/char-offsets.spec.ts measures the glyph
  // against its cell); what can be held here is the rule that makes it true.
  // `text-align: center` START-aligns content wider than its inline-block, so
  // every glyph in a tight or zero-width cell sat half its overflow late.
  // Flex centring overflows both sides equally. The display value has to stay
  // one a DOM text scanner reads as inline: Yomitan cuts it at the first '-',
  // so inline-flex and inline-block pass, flex / block / grid are a line break.
  const cellRules = () =>
    [...textBoxesSource.matchAll(/([^{}]*\.ocr-char[^{}]*)\{([^}]*)\}/g)].map(
      ([, selector, body]) => ({ selector: selector.replace(/\/\*[\s\S]*?\*\//g, '').trim(), body })
    );
  const declared = (body: string, property: string) =>
    new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim();

  it('centres a glyph on its cell even when the glyph is the wider one', () => {
    const cell = cellRules().find(({ selector }) => selector.endsWith('.ocr-char'))!;
    expect(declared(cell.body, 'display')).toBe('inline-flex');
    expect(declared(cell.body, 'justify-content')).toBe('center');
    for (const { body } of cellRules()) {
      const display = declared(body, 'display');
      if (display) expect(['inline-flex', 'inline-block']).toContain(display);
    }
  });

  // A flex container does not render a text run that is only white space, so
  // a space in a flex cell drops out of selection and copy ("NO WAY" →
  // "NOWAY"). A space has nothing to centre: it keeps the inline-block cell,
  // with `pre` so it is not collapsed away there either.
  it('a space keeps a cell that renders it', () => {
    const block = {
      box: [0, 0, 300, 50],
      vertical: false,
      font_size: 50,
      lines: ['NO WAY'],
      lines_coords: [
        [
          [0, 0],
          [300, 0],
          [300, 50],
          [0, 50]
        ]
      ],
      char_offsets: [[0, 50, 120, 120, 190, 245, 300]]
    };
    const [line] = lineSpans(withFontSize('original', () => renderBlock(block)));
    expect(line.textContent).toBe('NO WAY');
    const cells = charSpans(line);
    expect(cells.map((cell) => cell.classList.contains('ocr-space'))).toEqual([
      false,
      false,
      true,
      false,
      false,
      false
    ]);
    expect(inlineSize(cells[2])).toBe('0px');
    const space = cellRules().find(({ selector }) => selector.endsWith('.ocr-space'))!;
    expect(declared(space.body, 'display')).toBe('inline-block');
    expect(declared(space.body, 'white-space')).toBe('pre');
  });

  it('carries the start shift on the line target, not on the cells', () => {
    const block = {
      box: [100, 0, 150, 400],
      vertical: true,
      font_size: 50,
      lines: ['あいうえおかきく'],
      lines_coords: [
        [
          [100, 0],
          [150, 0],
          [150, 400],
          [100, 400]
        ]
      ],
      char_offsets: [[12, 60, 110, 160, 210, 260, 310, 360, 396]]
    };
    const [line] = lineSpans(withFontSize('original', () => renderBlock(block)));
    expect(line.dataset.targetTop).toBe('12');
    expect(line.style.fontSize).toBe('48px');
    expect(line.style.width).toBe('');
    expect(line.style.height).toBe('');
    expect(line.classList.contains('wrappedLine')).toBe(false);
  });

  describe('a zero-width cell on a real character', () => {
    // え has no cell and お has two: the zero cell alone, on a line whose other
    // cells are plausible
    const block = {
      box: [100, 0, 150, 240],
      vertical: true,
      font_size: 40,
      lines: ['あいうえおか'],
      lines_coords: [
        [
          [100, 0],
          [150, 0],
          [150, 240],
          [100, 240]
        ]
      ],
      char_offsets: [[0, 40, 80, 120, 120, 200, 240]]
    };
    const cellSizes = (container: HTMLElement) =>
      charSpans(lineSpans(container)[0]).map(inlineSize);

    it('auto mode never sees it: no cells, the line on the uniform grid of its quad', () => {
      const container = renderBlock(block);
      expect(cellSizes(container)).toEqual([]);
      expect(lineSpans(container)[0].textContent).toBe('あいうえおか');
      expect(lineSpans(container)[0].children).toHaveLength(0);
    });

    it('original mode renders the file as-is: a 0px cell, the character still in the DOM', () => {
      withFontSize('original', () => {
        const container = renderBlock(block);
        expect(cellSizes(container)).toEqual(['40px', '40px', '40px', '0px', '80px', '40px']);
        expect(lineSpans(container)[0].textContent).toBe('あいうえおか');
      });
    });
  });

  describe('the squeezed b0 l0: 地 in 94px, な ポ ン in 22–26px, と[363,363) 、[363,449)', () => {
    it('auto mode draws no cells at all: every line of the block is one text node on its quad', () => {
      const spans = lineSpans(renderBlock(fixtureBlocks[0]));
      expect(spans[0].textContent).toBe('地道なポイント稼ぎと、');
      for (const span of spans) {
        expect(charSpans(span)).toHaveLength(0);
        expect(span.children).toHaveLength(0);
        expect(contentNodes(span)).toHaveLength(1);
        expect(span.classList.contains('positionedLine')).toBe(true);
      }
    });

    it('original mode renders the file as-is: every cell, the 0px one included', () => {
      withFontSize('original', () => {
        const container = renderBlock(fixtureBlocks[0]);
        expect(charSpans(lineSpans(container)[0]).map(inlineSize)).toEqual(
          [94, 45, 26, 25, 45, 36, 29, 22, 41, 0, 86].map((size) => `${size}px`)
        );
        expect(lineSpans(container)[0].textContent).toBe('地道なポイント稼ぎと、');
      });
    });
  });

  describe('original mode', () => {
    it('takes the per-line path for a block with placement, its null lines included', () => {
      withFontSize('original', () => {
        const container = renderBlock(fixtureBlocks[1]);
        const box = container.querySelector<HTMLElement>('.textBox')!;
        expect(box.classList.contains('perLine')).toBe(true);
        const spans = lineSpans(container);
        expect(spans.every((span) => span.classList.contains('positionedLine'))).toBe(true);
        expect(charSpans(spans[0])).toHaveLength(6);
        expect(charSpans(spans[1])).toHaveLength(0);
        fixtureBlocks[1].lines.forEach((raw, i) =>
          expect(spans[i].textContent).toBe(processLine(raw))
        );
      });
    });

    it('keeps the whole-block rendering when no line yields cells', () => {
      withFontSize('original', () => {
        // parallel, but every entry fails validation (wrong length)
        const junk = { ...fixtureBlocks[0], char_offsets: [[0, 10], null, [0, 10]] };
        const container = renderBlock(junk);
        const bare = { ...fixtureBlocks[0] } as Record<string, unknown>;
        delete bare.char_offsets;
        const expected = markup(container);
        cleanup();
        expect(expected).toBe(markup(renderBlock(bare)));
        expect(expected).not.toContain('positionedLine');
      });
    });
  });

  it('a manual font size renders no cells at all', () => {
    withFontSize(24, () => {
      const { container } = render(TextBoxes, {
        page: makePage(fixtureBlocks),
        volumeUuid: 'test-uuid'
      });
      expect(container.querySelectorAll('.ocr-line')).toHaveLength(9);
      expect(container.querySelectorAll('.ocr-char')).toHaveLength(0);
      expect(container.querySelectorAll('.positionedLine')).toHaveLength(0);
    });
  });
});

describe('TextBoxes auto mode: the fixed-pitch grid and rotation', () => {
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

  it('renders NO .ocr-char for a block with char_offsets; original mode still does', () => {
    const container = renderBlocks(fixtureBlocks);
    expect(fixtureBlocks.some((block) => block.char_offsets)).toBe(true);
    expect(container.querySelectorAll('.ocr-char')).toHaveLength(0);
    // every line is its processed text, in ONE text node
    const expected = [...fixtureBlocks].flatMap((block) => block.lines.map(processLine)).sort();
    expect(
      lineSpans(container)
        .map((span) => span.textContent)
        .sort()
    ).toEqual(expected);
    for (const span of lineSpans(container)) expect(span.children).toHaveLength(0);
    cleanup();
    const original = withFontSize('original', () => renderBlocks(fixtureBlocks));
    expect(original.querySelectorAll('.ocr-char').length).toBeGreaterThan(50);
    expect(
      lineSpans(original)
        .map((span) => span.textContent)
        .sort()
    ).toEqual(expected);
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
});
