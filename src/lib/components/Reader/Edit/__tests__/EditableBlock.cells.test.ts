import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Writable } from 'svelte/store';
import type { Block, Page } from '$lib/types';

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  return { settings: writable({ fontSize: 'auto', boldFont: false }) };
});

import EditableBlock from '../EditableBlock.svelte';
import { settings } from '$lib/settings';
import { EditSession } from '$lib/reader/edit/edit-session.svelte';
import { lineCells, processLine } from '$lib/reader/char-offsets-layout';
import {
  fittedLineFontSize,
  getDefaultMeasurer,
  layoutLines,
  quadExtents
} from '$lib/reader/line-coords-layout';
import fixture from '$lib/reader/__fixtures__/char-offsets-page.json';
import editableBlockSource from '../EditableBlock.svelte?raw';

// The fixture is a real page (see char-offsets-layout.test.ts): block 0 has a
// zero-width と (line 0) and a ．．． run (line 2), block 1 has a null line
// (line 1), block 3 has no char_offsets at all. Everything is vertical.
// Block 0 line 0 is also SQUEEZED (地 in 94px, な ポ ン in 22–26px): auto mode
// declines its cells and renders it as plain fitted text, like the viewer;
// original mode draws them as filed.
const fontMode = settings as unknown as Writable<{ fontSize: string; boldFont: boolean }>;

function fixturePage(): Page {
  return structuredClone(fixture) as unknown as Page;
}

function mount(blockIndex = 0, page: Page = fixturePage()) {
  const session = new EditSession({
    volumeUuid: 'v1',
    getPage: () => page,
    persist: async () => {},
    debounceMs: 100000
  });
  const utils = render(EditableBlock, {
    props: {
      block: page.blocks[blockIndex],
      index: blockIndex,
      pageIndex: 0,
      selected: false,
      session,
      scale: () => 1
    }
  });
  const root = utils.container.querySelector<HTMLElement>('.editBlock')!;
  return { ...utils, session, page, root };
}

function lineEls(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.line')];
}
function cellSizes(line: HTMLElement): string[] {
  return [...line.querySelectorAll<HTMLElement>('.ocr-char')].map((c) => c.style.inlineSize);
}
function expectedSizes(block: Block, i: number, repair: boolean): string[] {
  const main = quadExtents(block.lines_coords![i], true)!.main;
  const cells = lineCells(block.lines[i], block.char_offsets?.[i], main, { repair });
  // no usable placement (the squeezed line, under repair): plain text, no cells
  return cells?.cells.map((c) => `${c.size}px`) ?? [];
}

/** え has no cell and お has two: a zero cell alone, on a line whose other cells
 * are plausible — what auto mode's repair is for. */
const zeroCellBlock = {
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
} as Block;

/** jsdom has no PointerEvent ctor (same helper as EditOverlay.test.ts). */
async function pointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  props: { id?: number; x?: number; y?: number } = {}
) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    pointerId: { value: props.id ?? 1 },
    clientX: { value: props.x ?? 0 },
    clientY: { value: props.y ?? 0 },
    pointerType: { value: 'mouse' },
    button: { value: 0 },
    shiftKey: { value: false }
  });
  el.dispatchEvent(e);
  await tick();
}

beforeEach(() => fontMode.set({ fontSize: 'auto', boldFont: false }));
afterEach(cleanup);

describe('EditableBlock — char_offsets cells', () => {
  it('a celled line renders one .ocr-char per processed code point, sized by its cell, and reads as the processed text', () => {
    const { root, page } = mount(0);
    const block = page.blocks[0];
    const lines = lineEls(root);
    expect(lines).toHaveLength(3);

    // plain line: 7 characters, 7 cells, the producer's advances verbatim
    expect(cellSizes(lines[1])).toEqual(['51px', '43px', '45px', '44px', '43px', '48px', '37px']);
    expect(lines[1].textContent).toBe('継続的な活動が');

    // ．．． collapses to ONE … cell spanning all three raw cells (544 → 585)
    const raw = block.lines[2];
    expect(raw.endsWith('．．．')).toBe(true);
    expect(lines[2].textContent).toBe(processLine(raw));
    expect(lines[2].textContent!.endsWith('…')).toBe(true);
    const sizes = cellSizes(lines[2]);
    expect(sizes).toHaveLength([...raw].length - 2);
    expect(sizes[sizes.length - 1]).toBe('41px');

    // the squeezed line keeps its text and takes no cells
    expect(expectedSizes(block, 0, true)).toEqual([]);
    expect(lines[0].textContent).toBe('地道なポイント稼ぎと、');
    expect(lines[0].children).toHaveLength(0);

    for (let i = 0; i < lines.length; i++) {
      expect(cellSizes(lines[i])).toEqual(expectedSizes(block, i, true));
      if (i === 0) continue;
      // The invariant selection and copy rely on: nothing but the cells, no
      // whitespace text nodes between them, and never out of flow (#254).
      for (const node of lines[i].childNodes) {
        expect((node as HTMLElement).className).toBe('ocr-char');
        expect((node as HTMLElement).style.position).toBe('');
      }
    }
  });

  it('offsets[0] becomes inline-start padding; a line without cells has none', () => {
    const page = fixturePage();
    page.blocks[1].char_offsets![0] = [6, 54, 113, 160, 218, 269, 319];
    const { root } = mount(1, page);
    const lines = lineEls(root);
    expect(lines[0].style.getPropertyValue('padding-inline-start')).toBe('6px');
    expect(cellSizes(lines[0])[0]).toBe('48px');
    expect(lines[1].style.getPropertyValue('padding-inline-start')).toBe('');
    expect(lines[2].style.getPropertyValue('padding-inline-start')).toBe('0px');
  });

  // The viewer's cell, rule for rule (TextBoxes.test.ts says why): flex
  // centring because `text-align: center` start-aligns a glyph wider than its
  // cell, a display value a text scanner still reads as inline, and a space
  // kept out of the flex cell so it survives selection.
  it('centres glyphs like the viewer, and keeps a space in a cell that renders it', () => {
    const rules = [
      ...editableBlockSource.matchAll(/([^{}]*\.ocr-(?:char|space)\)[^{}]*)\{([^}]*)\}/g)
    ];
    const declared = (body: string, property: string) =>
      new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim();
    const rule = (suffix: string) =>
      rules.find(([, selector]) => selector.trim().endsWith(suffix))![2];
    expect(declared(rule(':global(.ocr-char)'), 'display')).toBe('inline-flex');
    expect(declared(rule(':global(.ocr-char)'), 'justify-content')).toBe('center');
    expect(declared(rule(':global(.ocr-space)'), 'display')).toBe('inline-block');
    expect(declared(rule(':global(.ocr-space)'), 'white-space')).toBe('pre');

    const page = fixturePage();
    page.blocks[3] = {
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
    } as Block;
    const [line] = lineEls(mount(3, page).root);
    expect(line.textContent).toBe('NO WAY');
    expect(
      [...line.querySelectorAll('.ocr-char')].map((c) => c.classList.contains('ocr-space'))
    ).toEqual([false, false, true, false, false, false]);
  });

  it("a celled line takes the viewer's size: fitted on the PROCESSED text, capped by the quad's thickness", () => {
    const { root, page } = mount(0);
    const block = page.blocks[0];
    const measure = getDefaultMeasurer();
    const lines = lineEls(root);
    // The oracle is the viewer itself (nothing in this block gets clipped by
    // its neighbours, so these are the sizes `layoutLines` fitted).
    const viewer = layoutLines(block, block.lines.map(processLine), measure)!;
    for (let i = 0; i < lines.length; i++) {
      // Line 0 is the squeezed one: no cells in the viewer either. A plain
      // line is sized the way the editor always sized plain lines (on its own
      // quad, without the viewer's uniform vote), so only the CELLED lines
      // have the viewer as their oracle.
      expect(viewer[i].cells === undefined).toBe(i === 0);
      if (i === 0) continue;
      expect(lines[i].style.fontSize).toBe(`${Math.round(viewer[i].fontSize)}px`);
    }
    // the … line is two characters shorter than its raw text, so it fits larger
    const rawSize = fittedLineFontSize(block.lines_coords![2], block.lines[2], measure);
    expect(parseFloat(lines[2].style.fontSize)).toBeGreaterThan(rawSize);
  });

  it("a celled line shorter than its quad is fitted to its CELLS' extent, like the viewer — not to the quad's", () => {
    // Real data: the placed extent runs down to 83% of the quad's length. The
    // glyphs are drawn in the cells, so the cells are what they have to fit.
    const page = fixturePage();
    page.blocks[3] = {
      box: [0, 0, 300, 60],
      vertical: false,
      font_size: 60,
      lines: ['あいうえおか'],
      lines_coords: [
        [
          [0, 0],
          [300, 0],
          [300, 60],
          [0, 60]
        ]
      ],
      char_offsets: [[10, 50, 90, 130, 170, 210, 260]]
    } as Block;
    const block = page.blocks[3];
    const measure = getDefaultMeasurer();
    const [viewer] = layoutLines(block, block.lines, measure)!;
    expect(viewer.cells).toHaveLength(6);
    const quadFitted = Math.round(
      fittedLineFontSize(block.lines_coords![0], block.lines[0], measure)
    );
    // the case under test: the two fits really differ, and neither is the cap
    expect(Math.round(viewer.fontSize)).toBeLessThan(quadFitted);
    expect(quadFitted).toBeLessThan(60);

    const [line] = lineEls(mount(3, page).root);
    expect(cellSizes(line)).toHaveLength(6);
    expect(line.style.fontSize).toBe(`${Math.round(viewer.fontSize)}px`);
  });

  it('a null line and a block without char_offsets render as plain text, exactly as before', () => {
    const mixed = mount(1);
    const lines = lineEls(mixed.root);
    expect(lines[0].querySelectorAll('.ocr-char')).toHaveLength(6);
    expect(lines[1].querySelectorAll('.ocr-char')).toHaveLength(0);
    expect(lines[1].childNodes).toHaveLength(1);
    expect(lines[1].firstChild!.nodeType).toBe(Node.TEXT_NODE);
    expect(lines[1].textContent).toBe('しばらく活動停止に');
    expect(lines[2].querySelectorAll('.ocr-char')).toHaveLength(7);
    cleanup();

    const bare = mount(3);
    expect(bare.root.querySelectorAll('.ocr-char')).toHaveLength(0);
    const only = lineEls(bare.root)[0];
    expect(only.textContent).toBe(bare.page.blocks[3].lines[0]);
    expect(only.style.fontSize).toBe(
      `${Math.round(
        fittedLineFontSize(
          bare.page.blocks[3].lines_coords![0],
          bare.page.blocks[3].lines[0],
          getDefaultMeasurer()
        )
      )}px`
    );
  });

  describe('a block that mixes orientations', () => {
    // Offsets run along the BLOCK's reading axis: the producer warps every line
    // crop by the block's `vertical` flag and clamps to quad_extents(quad,
    // block vertical) — never the line's own shape. The editor writes each line
    // along its OWN orientation, so it may only draw cells on a line whose
    // element runs along the axis the offsets were measured on.
    const rect = (x0: number, y0: number, x1: number, y1: number) => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1]
    ];
    function mixedPage(sideways: number[]): Page {
      return {
        version: '0.2.1',
        img_width: 800,
        img_height: 800,
        img_path: 'p.png',
        blocks: [
          {
            box: [100, 100, 400, 340],
            vertical: true,
            font_size: 40,
            lines: ['あいうえお', 'かきくけこ'],
            // line 0 is a column like its block; line 1 is a 200×40 row
            lines_coords: [rect(360, 100, 400, 300), rect(100, 300, 300, 340)],
            char_offsets: [[0, 40, 80, 120, 160, 200], sideways]
          }
        ]
      } as Page;
    }
    const viewerCells = (page: Page) =>
      layoutLines(page.blocks[0], page.blocks[0].lines, getDefaultMeasurer())!.map(
        (line) => line.cells?.map((c) => `${c.size}px`) ?? null
      );

    it("validates along the block axis like the viewer, not along the line's own", () => {
      // 200px of offsets fit the row's own length (200) but not the 40px it
      // has along the block's vertical axis: no placement, in either renderer
      const page = mixedPage([0, 40, 80, 120, 160, 200]);
      const viewer = viewerCells(page);
      expect(viewer[0]).toHaveLength(5);
      expect(viewer[1]).toBeNull();

      const lines = lineEls(mount(0, page).root);
      expect(cellSizes(lines[0])).toEqual(viewer[0]);
      expect(cellSizes(lines[1])).toEqual([]);
      expect(lines[1].textContent).toBe('かきくけこ');
    });

    it('never draws cells across the axis they were measured on', () => {
      // valid along the block axis (40px), so the viewer — which writes the
      // whole block vertically — places it. The editor writes this line as a
      // row: 8px cells there would be measurements of the wrong axis.
      const page = mixedPage([0, 8, 16, 24, 32, 40]);
      expect(viewerCells(page)[1]).toEqual(['8px', '8px', '8px', '8px', '8px']);

      const lines = lineEls(mount(0, page).root);
      expect(lines[1].style.writingMode).toBe('horizontal-tb');
      expect(cellSizes(lines[1])).toEqual([]);
      expect(lines[1].textContent).toBe('かきくけこ');
      // the column beside it keeps its cells
      expect(cellSizes(lines[0])).toHaveLength(5);
    });
  });

  it('malformed offsets degrade that LINE to plain text, not the block', () => {
    const page = fixturePage();
    page.blocks[0].char_offsets![1] = [0, 51, 94]; // wrong length
    const { root } = mount(0, page);
    const lines = lineEls(root);
    expect(lines[2].querySelectorAll('.ocr-char').length).toBeGreaterThan(0);
    expect(lines[1].querySelectorAll('.ocr-char')).toHaveLength(0);
    expect(lines[1].textContent).toBe('継続的な活動が');
  });

  it('original font mode renders the file as-is (a zero-width cell at 0px); auto repairs it; the switch is live', async () => {
    const page = fixturePage();
    page.blocks[3] = structuredClone(zeroCellBlock);
    const { root } = mount(3, page);
    const line = lineEls(root)[0];
    expect(line.textContent).toBe('あいうえおか');
    expect(cellSizes(line)).toEqual(new Array(6).fill('40px'));

    fontMode.set({ fontSize: 'original', boldFont: false });
    await tick();
    expect(cellSizes(lineEls(root)[0])).toEqual(['40px', '40px', '40px', '0px', '80px', '40px']);
    expect(lineEls(root)[0].textContent).toBe('あいうえおか');

    // a manual point size is not `original`: the editor still repairs
    fontMode.set({ fontSize: '12', boldFont: false });
    await tick();
    expect(cellSizes(lineEls(root)[0])).toEqual(new Array(6).fill('40px'));
  });

  it('the real squeezed line: plain fitted text in auto, its cells as filed in original; the switch is live', async () => {
    const { root, page } = mount(0);
    const block = page.blocks[0];
    const plain = () => {
      const line = lineEls(root)[0];
      expect(line.textContent).toBe('地道なポイント稼ぎと、');
      expect(cellSizes(line)).toEqual([]);
      expect(line.children).toHaveLength(0);
    };
    plain();

    fontMode.set({ fontSize: 'original', boldFont: false });
    await tick();
    const sizes = cellSizes(lineEls(root)[0]);
    expect(sizes).toEqual(expectedSizes(block, 0, false));
    expect(sizes.slice(0, 4)).toEqual(['94px', '45px', '26px', '25px']);
    expect(sizes.slice(-2)).toEqual(['0px', '86px']);
    expect(lineEls(root)[0].textContent).toBe('地道なポイント稼ぎと、');

    // a manual point size is not `original`: the editor's best rendering again
    fontMode.set({ fontSize: '12', boldFont: false });
    await tick();
    plain();
  });
});

describe('EditableBlock — cells never live inside a contenteditable', () => {
  it('opening the editor turns EVERY line of the block into plain RAW text; closing re-cells', async () => {
    const { root, page } = mount(0);
    const block = page.blocks[0];
    await fireEvent.dblClick(root);
    await tick();
    const editable = [...root.querySelectorAll<HTMLElement>('[contenteditable]')];
    expect(editable).toHaveLength(3);
    expect(root.querySelectorAll('.ocr-char')).toHaveLength(0);
    editable.forEach((el, i) => {
      expect(el.textContent).toBe(block.lines[i]); // RAW: ．．． not …
      expect(el.childNodes).toHaveLength(1);
      expect(el.firstChild!.nodeType).toBe(Node.TEXT_NODE);
      expect(el.style.getPropertyValue('padding-inline-start')).toBe('');
    });

    await fireEvent.keyDown(editable[0], { key: 'Escape' });
    await tick();
    expect(root.querySelectorAll('[contenteditable]')).toHaveLength(0);
    const lines = lineEls(root);
    for (let i = 0; i < lines.length; i++) {
      expect(cellSizes(lines[i])).toEqual(expectedSizes(block, i, true));
    }
    expect(lines[2].textContent).toBe(processLine(block.lines[2]));
  });

  it("a line containing '...' survives open → close without the model changing", async () => {
    const page = fixturePage();
    // ASCII periods this time: 3 code points sharing one 41px cell
    const raw = page.blocks[0].lines[2].replace('．．．', '...');
    page.blocks[0].lines[2] = raw;
    const { root, session } = mount(0, page);
    const setLines = vi.spyOn(session, 'setLines');
    const before = session.pageFor(0);
    expect(lineEls(root)[2].textContent).toBe(raw.replace('...', '…'));

    await fireEvent.dblClick(root);
    await tick();
    const editable = root.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(editable[2].textContent).toBe(raw);
    // an input event that changes nothing still reads the RAW text back
    await fireEvent.input(editable[2]);
    await fireEvent.keyDown(editable[2], { key: 'Escape' });
    await tick();

    expect(setLines).not.toHaveBeenCalled();
    expect(session.pageFor(0)).toBe(before);
    expect(session.canUndo(0)).toBe(false);
    expect(session.pageFor(0).blocks[0].lines[2]).toBe(raw);
    expect(lineEls(root)[2].textContent).toBe(raw.replace('...', '…'));
  });

  it('committing a one-character fix writes RAW lines, then re-cells from whatever offsets the model holds; undo swaps the old cells back', async () => {
    const { root, page, session, rerender } = mount(0);
    const block = page.blocks[0];
    // The reflow is the session's job (another module): pin it out, and hand
    // the component the model a commit would produce.
    const setLines = vi.spyOn(session, 'setLines').mockImplementation(() => {});
    const elements = lineEls(root);

    await fireEvent.dblClick(root);
    await tick();
    const editable = root.querySelectorAll<HTMLElement>('[contenteditable]');
    editable[1].textContent = '継続的な活動は';
    await fireEvent.input(editable[1]);
    await fireEvent.keyDown(editable[1], { key: 'Escape' });
    await tick();
    expect(setLines).toHaveBeenCalledWith(0, 0, [
      block.lines[0],
      '継続的な活動は',
      block.lines[2] // still ．．． — the processed … never reaches the model
    ]);

    const fixed: Block = {
      ...block,
      lines: [block.lines[0], '継続的な活動は', block.lines[2]],
      char_offsets: [
        block.char_offsets![0],
        [0, 51, 94, 139, 183, 226, 270, 311],
        block.char_offsets![2]
      ]
    };
    await rerender({ block: fixed });
    await tick();
    let lines = lineEls(root);
    expect(lines[1].textContent).toBe('継続的な活動は');
    expect(cellSizes(lines[1])).toEqual(['51px', '43px', '45px', '44px', '43px', '44px', '41px']);
    // same line count → same elements, neighbours untouched
    expect(lines[0]).toBe(elements[0]);
    expect(lines[1]).toBe(elements[1]);
    expect(cellSizes(lines[0])).toEqual(expectedSizes(block, 0, true));

    await rerender({ block });
    await tick();
    lines = lineEls(root);
    expect(lines[1].textContent).toBe('継続的な活動が');
    expect(cellSizes(lines[1])).toEqual(['51px', '43px', '45px', '44px', '43px', '48px', '37px']);
  });

  it('offsets vanishing or appearing under a stable element swap plain text ↔ cells', async () => {
    const { root, page, rerender } = mount(0);
    const block = page.blocks[0];
    const el = lineEls(root)[1];
    expect(el.querySelectorAll('.ocr-char')).toHaveLength(7);

    const stripped: Block = { ...block };
    delete stripped.char_offsets;
    await rerender({ block: stripped });
    await tick();
    expect(lineEls(root)[1]).toBe(el);
    expect(el.querySelectorAll('.ocr-char')).toHaveLength(0);
    expect(el.textContent).toBe('継続的な活動が');
    // plain lines show the RAW text, as they always have
    expect(lineEls(root)[2].textContent).toBe(block.lines[2]);

    await rerender({ block });
    await tick();
    expect(el.querySelectorAll('.ocr-char')).toHaveLength(7);
  });

  it('while editing, a model change that leaves a line’s text alone never rewrites that line (caret safety)', async () => {
    const { root, page, rerender } = mount(0);
    const block = page.blocks[0];
    await fireEvent.dblClick(root);
    await tick();
    const editable = root.querySelectorAll<HTMLElement>('[contenteditable]');
    const textNode = editable[0].firstChild;
    expect(textNode!.nodeType).toBe(Node.TEXT_NODE);

    await rerender({
      block: {
        ...block,
        lines: [block.lines[0], 'かきく', block.lines[2]],
        char_offsets: undefined
      }
    });
    await tick();
    expect(editable[0].firstChild).toBe(textNode);
    expect(editable[1].textContent).toBe('かきく');
    expect(root.querySelectorAll('.ocr-char')).toHaveLength(0);
  });

  it('a press that lands on a cell still belongs to the line: click selects it, drag moves its quad', async () => {
    const page = fixturePage();
    const session = new EditSession({
      volumeUuid: 'v1',
      getPage: () => page,
      persist: async () => {},
      debounceMs: 100000
    });
    session.select(0, 0);
    const moveLine = vi.spyOn(session, 'moveLine').mockImplementation(() => {});
    const { container } = render(EditableBlock, {
      props: {
        block: page.blocks[0],
        index: 0,
        pageIndex: 0,
        selected: true,
        session,
        scale: () => 1
      }
    });
    const root = container.querySelector<HTMLElement>('.editBlock')!;
    const line = lineEls(root)[1];
    line.setPointerCapture = vi.fn();
    line.releasePointerCapture = vi.fn();
    const cell = line.querySelectorAll<HTMLElement>('.ocr-char')[3];

    await pointer(cell, 'pointerdown', { id: 5, x: 10, y: 10 });
    expect(line.setPointerCapture).toHaveBeenCalledWith(5);
    await pointer(cell, 'pointerup', { id: 5, x: 10, y: 10 });
    expect(session.selectedLine).toEqual({ pageIndex: 0, blockIndex: 0, lineIndex: 1 });

    const again = lineEls(root)[1].querySelectorAll<HTMLElement>('.ocr-char')[3];
    await pointer(again, 'pointerdown', { id: 6, x: 10, y: 10 });
    await pointer(again, 'pointermove', { id: 6, x: 40, y: 25 });
    await pointer(again, 'pointerup', { id: 6, x: 40, y: 25 });
    // The move bubbles line → block and both forward it (as for a plain
    // line); the op is absolute from the drag start, so that is idempotent.
    expect(moveLine).toHaveBeenCalled();
    for (const call of moveLine.mock.calls) expect(call.slice(0, 5)).toEqual([0, 0, 1, 30, 15]);
  });
});
