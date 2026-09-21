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
import {
  blockLineGeometries,
  lineGeometry,
  lineGrid,
  lineHandlePoints
} from '$lib/reader/edit/block-geometry';
import { lineFrame } from '$lib/reader/line-grid';

// The editor draws a line the way the viewer does (line-grid.ts): ONE text
// node on the block's fixed-pitch grid, turned when the quad is tilted. Cells are
// the original font mode's alone (EditableBlock.cells.test.ts).
const fontMode = settings as unknown as Writable<{ fontSize: string; boldFont: boolean }>;

/** An upright w × h rectangle centred on (cx, cy), turned clockwise by `deg`. */
function tilted(cx: number, cy: number, w: number, h: number, deg: number): number[][] {
  const t = (deg * Math.PI) / 180;
  const corner = (dx: number, dy: number) => [
    cx + dx * Math.cos(t) - dy * Math.sin(t),
    cy + dx * Math.sin(t) + dy * Math.cos(t)
  ];
  return [
    corner(-w / 2, -h / 2),
    corner(w / 2, -h / 2),
    corner(w / 2, h / 2),
    corner(-w / 2, h / 2)
  ];
}
const rect = (x: number, y: number, w: number, h: number) => tilted(x + w / 2, y + h / 2, w, h, 0);

// jsdom has no canvas, so the measurer is the heuristic one: 1em per fullwidth
// character, 0.55 per ASCII one. Quads hug the INK (glyph-insets.ts): line 0
// is six hiragana set solid at 40px (ink 0.11em into the first cell to 0.10em
// short of the last); lines 1–3 are 40px glyphs TRACKED to a 50px step — an
// upright column, a column leaning 20°, a row leaning -15° — each as long as
// its ink at that step.
const SOLID = 40 * (6 - 0.11 - 0.1);
const LOOSE = 5 * 50 + 40 * (1 - 0.11 - 0.1);
const LOOSE_KATAKANA = 5 * 50 + 40 * (1 - 0.12 - 0.1);
// ざわざわ... — 5.65em of glyphs, six 10px gaps between its seven characters,
// ends ざ (0.11) and an ASCII period (0.04)
const LOOSE_ROW = 5.65 * 40 + 6 * 10 - (0.11 + 0.04) * 40;
function gridPage(): Page {
  return {
    version: '0.2.1',
    img_width: 1000,
    img_height: 1000,
    img_path: 'g.png',
    blocks: [
      {
        box: [100, 100, 700, 700],
        vertical: true,
        font_size: 40,
        lines: ['あいうえおか', 'かきくけこさ', 'ゴゴゴゴゴゴ', 'ざわざわ...'],
        lines_coords: [
          rect(600, 124.4, 40, SOLID),
          rect(540, 124.4, 40, LOOSE),
          tilted(400, 400, 40, LOOSE_KATAKANA, 20),
          tilted(300, 620, LOOSE_ROW, 40, -15)
        ],
        // present and valid: auto mode must not draw it
        char_offsets: [
          [0, 40, 80, 120, 160, 200, 240],
          [0, 50, 100, 150, 200, 250, 300],
          null,
          null
        ]
      }
    ]
  } as Page;
}

function mount(page: Page = gridPage(), selected = false) {
  const session = new EditSession({
    volumeUuid: 'v1',
    getPage: () => page,
    persist: async () => {},
    debounceMs: 100000
  });
  if (selected) session.select(0, 0);
  const utils = render(EditableBlock, {
    props: { block: page.blocks[0], index: 0, pageIndex: 0, selected, session, scale: () => 1 }
  });
  const root = utils.container.querySelector<HTMLElement>('.editBlock')!;
  return { ...utils, session, page, root };
}
const lineEls = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.line')];
const px = (value: string) => parseFloat(value);

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

describe('EditableBlock — the fixed-pitch grid', () => {
  it('auto mode draws no cells, whatever char_offsets the file carries: every line is one RAW text node', () => {
    const { root, page } = mount();
    expect(root.querySelectorAll('.ocr-char')).toHaveLength(0);
    lineEls(root).forEach((line, i) => {
      expect(line.childNodes).toHaveLength(1);
      expect(line.firstChild!.nodeType).toBe(Node.TEXT_NODE);
      expect(line.textContent).toBe(page.blocks[0].lines[i]); // RAW: ... not …
      expect(line.style.getPropertyValue('padding-inline-start')).toBe('');
    });
  });

  it('a line set solid at its own size has no spacing — only its first cell starts before its ink', () => {
    const [exact] = lineEls(mount().root);
    expect(exact.style.fontSize).toBe('40px');
    expect(exact.style.letterSpacing).toBe('');
    expect(px(exact.style.textIndent)).toBeCloseTo(-4.4, 6);
    expect(exact.style.transform).toBe('');
    expect(exact.style.left).toBe('500px');
    expect(px(exact.style.top)).toBeCloseTo(24.4, 6);
  });

  it('a tracked line steps at the block’s pitch: spacing after each glyph, the first cell a lead-inset early', () => {
    const { root, page } = mount();
    const loose = lineEls(root)[1];
    // 40px glyphs on the 50px step lines 1–3 agree on
    expect(loose.style.fontSize).toBe('40px');
    expect(px(loose.style.letterSpacing)).toBeCloseTo(10, 6);
    expect(px(loose.style.textIndent)).toBeCloseTo(-4.4, 6);
    // ...which is the shared helper's answer, for every line
    const block = page.blocks[0];
    const geoms = blockLineGeometries(block.lines_coords!, block.lines);
    lineEls(root).forEach((line, i) => {
      const grid = lineGrid(geoms[i], block.lines[i]);
      expect(px(line.style.letterSpacing || '0')).toBeCloseTo(grid.letterSpacing, 6);
      expect(px(line.style.textIndent || '0')).toBeCloseTo(grid.inset, 6);
    });
  });

  it('the grid is measured on the text the line SHOWS (raw), and follows a model change', async () => {
    const { root, page, rerender } = mount();
    const block = page.blocks[0];
    const row = lineEls(root)[3];
    expect(row.textContent).toBe('ざわざわ...');
    const before = px(row.style.letterSpacing);
    expect(before).toBeGreaterThan(0);

    await rerender({ block: { ...block, lines: [...block.lines.slice(0, 3), 'ざわざわざわ'] } });
    await tick();
    expect(lineEls(root)[3]).toBe(row);
    expect(px(row.style.letterSpacing || '0')).not.toBeCloseTo(before, 3);
  });

  it('a manual font size is not `original`: still the grid, still no cells', async () => {
    const { root } = mount();
    fontMode.set({ fontSize: '12', boldFont: false });
    await tick();
    expect(root.querySelectorAll('.ocr-char')).toHaveLength(0);
    expect(px(lineEls(root)[1].style.letterSpacing)).toBeCloseTo(10, 6);
  });

  it('original mode draws the file’s cells instead — no spacing on a celled line', async () => {
    const { root } = mount();
    fontMode.set({ fontSize: 'original', boldFont: false });
    await tick();
    const lines = lineEls(root);
    expect(lines[1].querySelectorAll('.ocr-char')).toHaveLength(6);
    expect(lines[1].style.letterSpacing).toBe('');
    expect(lines[1].style.textIndent).toBe('');
    // a line the file does not place is on the grid in original mode too
    expect(lines[2].querySelectorAll('.ocr-char')).toHaveLength(0);
  });

  // The viewer's original mode now places lines on their quads too (grid and
  // tilt, at the FILE's font_size). The editor already did, and keeps the
  // quad's size in every mode: there the quad IS the size (the side handle),
  // and font_size is re-derived from the quads on every quad edit.
  it('original mode changes nothing about a line the file does not place: same box, turn, size and grid as auto', async () => {
    const page = gridPage();
    // a file size unlike the print's: the editor must not pick it up
    (page.blocks[0] as Block).font_size = 64;
    const { root } = mount(page);
    const shape = () =>
      lineEls(root)
        .slice(2)
        .map((el) => ({
          text: el.textContent,
          cells: el.querySelectorAll('.ocr-char').length,
          style: el.getAttribute('style')
        }));
    const auto = shape();
    expect(auto).toHaveLength(2);
    const column = lineEls(root)[2];
    expect(parseFloat(/rotate\((-?[\d.]+)deg\)/.exec(column.style.transform)![1])).toBeCloseTo(
      20,
      6
    );
    expect(column.style.fontSize).toBe('40px');
    expect(px(column.style.letterSpacing)).toBeCloseTo(10, 6);
    fontMode.set({ fontSize: 'original', boldFont: false });
    await tick();
    // lines 0–1 switched to cells, so the mode really is in effect
    expect(lineEls(root)[1].querySelectorAll('.ocr-char')).toHaveLength(6);
    expect(shape()).toEqual(auto);
  });
});

describe('EditableBlock — a tilted quad shows the line turned', () => {
  it('the element is the quad’s own-frame box about its centre, with rotate(θ)', () => {
    const { root, page } = mount();
    const block = page.blocks[0];
    const column = lineEls(root)[2];
    // 40 × LOOSE_KATAKANA centred on (400, 400), block origin (100, 100)
    expect(px(column.style.left)).toBeCloseTo(400 - 20 - 100, 6);
    expect(px(column.style.top)).toBeCloseTo(400 - LOOSE_KATAKANA / 2 - 100, 6);
    expect(px(column.style.width)).toBeCloseTo(40, 6);
    expect(px(column.style.minHeight)).toBeCloseTo(LOOSE_KATAKANA, 6);
    expect(column.style.writingMode).toBe('vertical-rl');
    const turn = /^rotate\((-?[\d.]+)deg\)$/.exec(column.style.transform);
    expect(turn).not.toBeNull();
    expect(parseFloat(turn![1])).toBeCloseTo(20, 6);
    // about the BOX centre, in px: the element grows as text is typed, and a
    // percentage origin would wander with it
    const [ox, oy] = column.style.transformOrigin.split(' ').map(px);
    expect(ox).toBeCloseTo(20, 6);
    expect(oy).toBeCloseTo(LOOSE_KATAKANA / 2, 6);
    // sized by the quad's own thickness, on the step its own length gives
    expect(column.style.fontSize).toBe('40px');
    expect(px(column.style.letterSpacing)).toBeCloseTo(10, 6);

    const row = lineEls(root)[3];
    expect(row.style.writingMode).toBe('horizontal-tb');
    expect(parseFloat(/rotate\((-?[\d.]+)deg\)/.exec(row.style.transform)![1])).toBeCloseTo(-15, 6);
    expect(px(row.style.minWidth)).toBeCloseTo(LOOSE_ROW, 6);
    expect(px(row.style.height)).toBeCloseTo(40, 6);
    expect(lineFrame(block.lines_coords![3], false)!.angle).toBeCloseTo(-15, 6);

    // upright lines are not transformed at all
    expect(lineEls(root)[0].style.transform).toBe('');
    expect(lineEls(root)[1].style.transform).toBe('');
  });

  it('stays turned — and stays one plain RAW text node — while its editor is open', async () => {
    const { root, page } = mount();
    const before = lineEls(root)[2].style.transform;
    await fireEvent.dblClick(root);
    await tick();
    const editable = [...root.querySelectorAll<HTMLElement>('[contenteditable]')];
    expect(editable).toHaveLength(4);
    expect(editable[2].style.transform).toBe(before);
    expect(editable[2].style.transformOrigin).not.toBe('');
    editable.forEach((el, i) => {
      expect(el.textContent).toBe(page.blocks[0].lines[i]);
      expect(el.childNodes).toHaveLength(1);
      expect(el.firstChild!.nodeType).toBe(Node.TEXT_NODE);
    });
    // opening the editor must not make the text jump: the grid stays
    expect(px(editable[1].style.letterSpacing)).toBeCloseTo(10, 6);
    expect(root.querySelectorAll('.ocr-char')).toHaveLength(0);
  });

  it('typing in a turned line commits RAW text and leaves its quad — so its tilt — alone', async () => {
    const { root, page, session } = mount();
    const quad = structuredClone(page.blocks[0].lines_coords![2]);
    await fireEvent.dblClick(root);
    await tick();
    const editable = root.querySelectorAll<HTMLElement>('[contenteditable]');
    editable[2].textContent = 'ドドドドドド';
    await fireEvent.input(editable[2]);
    await fireEvent.keyDown(editable[2], { key: 'Escape' });
    await tick();
    const saved = session.pageFor(0).blocks[0];
    expect(saved.lines[2]).toBe('ドドドドドド');
    expect(saved.lines_coords![2]).toEqual(quad);
  });

  it('a press on the turned text selects the line; a drag moves its quad without straightening it', async () => {
    const { root, session } = mount(gridPage(), true);
    const line = lineEls(root)[2];
    line.setPointerCapture = vi.fn();
    line.releasePointerCapture = vi.fn();

    await pointer(line, 'pointerdown', { id: 5, x: 10, y: 10 });
    expect(line.setPointerCapture).toHaveBeenCalledWith(5);
    await pointer(line, 'pointerup', { id: 5, x: 10, y: 10 });
    expect(session.selectedLine).toEqual({ pageIndex: 0, blockIndex: 0, lineIndex: 2 });

    const before = structuredClone(session.pageFor(0).blocks[0].lines_coords![2]);
    await pointer(line, 'pointerdown', { id: 6, x: 10, y: 10 });
    await pointer(line, 'pointermove', { id: 6, x: 40, y: 25 });
    await pointer(line, 'pointerup', { id: 6, x: 40, y: 25 });
    const after = session.pageFor(0).blocks[0].lines_coords![2];
    after.forEach(([x, y], k) => {
      expect(x).toBeCloseTo(before[k][0] + 30, 6);
      expect(y).toBeCloseTo(before[k][1] + 15, 6);
    });
    expect(lineFrame(after, true)!.angle).toBeCloseTo(20, 6);
  });

  it('its handles sit on the turned quad’s own edges, and a resize keeps the angle', async () => {
    const { root, session, rerender } = mount(gridPage(), true);
    session.selectLine(0, 0, 2);
    await tick();
    const block = session.pageFor(0).blocks[0];
    const at = lineHandlePoints(lineGeometry(block.lines_coords![2]));
    const end = root.querySelector<HTMLElement>('[data-line-handle="end"]')!;
    const side = root.querySelector<HTMLElement>('[data-line-handle="side"]')!;
    expect(px(end.style.left)).toBeCloseTo(at.end.x - 100 - 5, 6);
    expect(px(end.style.top)).toBeCloseTo(at.end.y - 100 - 5, 6);
    expect(px(side.style.left)).toBeCloseTo(at.side.x - 100 - 5, 6);
    expect(px(side.style.top)).toBeCloseTo(at.side.y - 100 - 5, 6);

    end.setPointerCapture = vi.fn();
    end.releasePointerCapture = vi.fn();
    // 60px straight down the screen: only its part along the line's axis counts
    await pointer(end, 'pointerdown', { id: 7, x: 0, y: 0 });
    await pointer(end, 'pointermove', { id: 7, x: 0, y: 60 });
    await pointer(end, 'pointerup', { id: 7, x: 0, y: 60 });
    const resized = session.pageFor(0).blocks[0];
    const frame = lineFrame(resized.lines_coords![2], true)!;
    expect(frame.angle).toBeCloseTo(20, 6);
    expect(frame.main).toBeCloseTo(LOOSE_KATAKANA + 60 * Math.cos((20 * Math.PI) / 180), 6);
    expect(frame.cross).toBeCloseTo(40, 6);

    await rerender({ block: resized });
    await tick();
    const shown = /^rotate\((-?[\d.]+)deg\)$/.exec(lineEls(root)[2].style.transform);
    expect(parseFloat(shown![1])).toBeCloseTo(20, 6);
  });

  it('original mode turns a CELLED tilted line too, its cells starting where the file says', async () => {
    const page = gridPage();
    (page.blocks[0] as Block).char_offsets = [null, null, [6, 50, 100, 150, 200, 250, 300], null];
    fontMode.set({ fontSize: 'original', boldFont: false });
    const { root } = mount(page);
    const column = lineEls(root)[2];
    expect(column.querySelectorAll('.ocr-char')).toHaveLength(6);
    expect(column.style.getPropertyValue('padding-inline-start')).toBe('6px');
    expect(column.style.transform).toContain('rotate(');
    expect(column.style.letterSpacing).toBe('');
  });
});
