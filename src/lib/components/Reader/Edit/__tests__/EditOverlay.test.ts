import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Page } from '$lib/types';

vi.mock('$lib/settings', async () => {
  const { writable } = await import('svelte/store');
  return { settings: writable({ fontSize: 'auto', boldFont: false }) };
});

import EditOverlay from '../EditOverlay.svelte';
import { EditSession } from '$lib/reader/edit/edit-session.svelte';

function page(): Page {
  return {
    version: '0.2.1',
    img_width: 400,
    img_height: 400,
    img_path: 'p.png',
    blocks: [
      { box: [10, 10, 50, 100], vertical: true, font_size: 20, lines: ['あ', 'い'] },
      // exact duplicate of block 0 — read mode hides it; edit mode must show it
      { box: [10, 10, 50, 100], vertical: true, font_size: 20, lines: ['あい'] }
    ]
  };
}

/** jsdom has no PointerEvent ctor: build a pointer-shaped Event (same helper
 * as pointer-tracker.test.ts) and dispatch it. */
async function pointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  props: { id?: number; x?: number; y?: number; button?: number; shift?: boolean } = {}
) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    pointerId: { value: props.id ?? 1 },
    clientX: { value: props.x ?? 0 },
    clientY: { value: props.y ?? 0 },
    pointerType: { value: 'mouse' },
    button: { value: props.button ?? 0 },
    shiftKey: { value: props.shift ?? false }
  });
  el.dispatchEvent(e);
  await tick();
}

function mount() {
  const p = page();
  const session = new EditSession({
    volumeUuid: 'v1',
    getPage: () => p,
    persist: async () => {},
    debounceMs: 100000
  });
  const utils = render(EditOverlay, { props: { page: p, pageIndex: 0, session } });
  return { ...utils, session };
}

afterEach(cleanup);

describe('EditOverlay', () => {
  it('renders every raw block as an editBlock, duplicates included', () => {
    const { container } = mount();
    expect(container.querySelectorAll('.editBlock')).toHaveLength(2);
    expect(container.querySelector('.textBox')).toBeNull();
  });

  it('click selects; shift+click adds; handles appear only on selected blocks', async () => {
    const { container, session } = mount();
    const blocks = container.querySelectorAll<HTMLElement>('.editBlock');
    await pointer(blocks[0], 'pointerdown', { id: 1 });
    await pointer(blocks[0], 'pointerup', { id: 1 });
    expect(session.selection).toEqual([{ pageIndex: 0, blockIndex: 0 }]);
    await tick();
    expect(blocks[0].querySelectorAll('[data-edit-handle]')).toHaveLength(8);
    expect(blocks[1].querySelectorAll('[data-edit-handle]')).toHaveLength(0);
    await pointer(blocks[1], 'pointerdown', { id: 2, shift: true });
    await pointer(blocks[1], 'pointerup', { id: 2, shift: true });
    expect(session.selection).toHaveLength(2);
  });

  it('double click opens one contenteditable line per OCR line; Enter adds, Backspace on empty removes', async () => {
    const { container, session } = mount();
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    await fireEvent.dblClick(block);
    await tick();
    let lines = block.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(lines).toHaveLength(2);
    expect(lines[1].textContent).toBe('い');
    lines[1].textContent = 'いい';
    await fireEvent.input(lines[1]);
    await fireEvent.keyDown(lines[1], { key: 'Enter' });
    await tick();
    lines = block.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(lines).toHaveLength(3);
    expect(lines[1].textContent).toBe('いい');
    lines[2].textContent = '';
    await fireEvent.keyDown(lines[2], { key: 'Backspace' });
    await tick();
    lines = block.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(lines).toHaveLength(2);
    await fireEvent.keyDown(lines[1], { key: 'Escape' });
    await tick();
    expect(block.querySelectorAll('[contenteditable]')).toHaveLength(0);
    expect(session.pageFor(0).blocks[0].lines).toEqual(['あ', 'いい']);
  });

  it('a drag on a block body moves it (pointer capture, no bubbling to the page)', async () => {
    const { container, session } = mount();
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    block.setPointerCapture = vi.fn();
    block.releasePointerCapture = vi.fn();
    const stop = vi.fn();
    container.parentElement!.addEventListener('pointerdown', stop);
    await pointer(block, 'pointerdown', { id: 3, x: 100, y: 100 });
    expect(stop).not.toHaveBeenCalled();
    await pointer(block, 'pointermove', { id: 3, x: 130, y: 110 });
    await pointer(block, 'pointerup', { id: 3, x: 130, y: 110 });
    // jsdom has no layout: scale() falls back to 1 → 30px right, 10px down
    expect(session.pageFor(0).blocks[0].box).toEqual([40, 20, 80, 110]);
  });

  it('with the draw tool armed, a drag on the background adds a block', async () => {
    const { container, session } = mount();
    const overlay = container.querySelector<HTMLElement>('[data-edit-overlay]')!;
    overlay.setPointerCapture = vi.fn();
    overlay.releasePointerCapture = vi.fn();
    session.tool = 'draw';
    await pointer(overlay, 'pointerdown', { id: 4, x: 200, y: 200 });
    await pointer(overlay, 'pointermove', { id: 4, x: 260, y: 300 });
    await pointer(overlay, 'pointerup', { id: 4, x: 260, y: 300 });
    expect(session.pageFor(0).blocks).toHaveLength(3);
    expect(session.pageFor(0).blocks[2].box).toEqual([200, 200, 260, 300]);
    expect(session.tool).toBe('select');
  });
});

describe('EditOverlay — line-centric rendering', () => {
  function rect(x: number, y: number, w: number, h: number) {
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h]
    ];
  }
  /** The Chainsaw Man 02 p.9 table-of-contents block: 13 lines, mixed quads. */
  function tocPage(): Page {
    const quads = [
      rect(800, 1710, 541, 99),
      rect(1500, 1820, 44, 252),
      rect(1440, 1820, 44, 300),
      rect(1380, 1820, 44, 280),
      rect(1320, 1820, 44, 260),
      rect(1260, 1820, 44, 400),
      rect(1000, 1720, 38, 908),
      rect(1010, 1750, 40, 500),
      rect(940, 1820, 44, 300),
      rect(880, 1820, 44, 300),
      rect(820, 1820, 44, 300),
      rect(800, 2500, 500, 90),
      rect(800, 2560, 300, 80)
    ];
    return {
      version: '0.2.1',
      img_width: 1746,
      img_height: 2800,
      img_path: '009.jpg',
      blocks: [
        {
          box: [760, 1704, 1561, 2655],
          vertical: false,
          font_size: 295,
          // 8 fullwidth chars per line (heuristic measurer: 1em each)
          lines: Array.from({ length: 13 }, () => 'あいうえおかきく'),
          lines_coords: quads
        },
        { box: [10, 10, 60, 200], vertical: true, font_size: 20, lines: ['a', 'b', 'c'] }
      ]
    };
  }
  function mountToc() {
    const p = tocPage();
    const session = new EditSession({
      volumeUuid: 'v1',
      getPage: () => p,
      persist: async () => {},
      debounceMs: 100000
    });
    const utils = render(EditOverlay, { props: { page: p, pageIndex: 0, session } });
    return { ...utils, session, p };
  }

  it('renders every line at its quad with per-line orientation and font size, whatever the font setting', () => {
    const { container } = mountToc();
    const block = container.querySelectorAll<HTMLElement>('.editBlock')[0];
    const lines = block.querySelectorAll<HTMLElement>('.line.positioned');
    expect(lines).toHaveLength(13);
    // horizontal quad 0: 541 long, 8 chars → fitted 68px, not the 99px thickness
    expect(lines[0].style.writingMode).toBe('horizontal-tb');
    expect(lines[0].style.fontSize).toBe('68px');
    expect(lines[0].style.left).toBe('40px'); // 800 - box left 760
    expect(lines[0].style.top).toBe('6px');
    // vertical quad 1: 252 long, 8 chars → fitted 32px, not the 44px thickness
    expect(lines[1].style.writingMode).toBe('vertical-rl');
    expect(lines[1].style.fontSize).toBe('32px');
    // a fat mis-detected quad (7: 40×500) never explodes: 500/8 → 63 capped at 40
    expect(lines[7].style.fontSize).toBe('40px');
    // nothing clips: the container and the block let lines overflow
    expect(getComputedStyle(block).overflow).not.toBe('hidden');
  });

  it('in editing state all 13 lines are contenteditable, positioned, and focusable', async () => {
    const { container } = mountToc();
    const block = container.querySelectorAll<HTMLElement>('.editBlock')[0];
    await fireEvent.dblClick(block);
    await tick();
    const lines = block.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(lines).toHaveLength(13);
    for (const line of lines) {
      expect(line.classList.contains('positioned')).toBe(true);
      expect(line.style.left).not.toBe('');
      line.focus();
      expect(document.activeElement).toBe(line);
    }
    expect(lines[6].style.writingMode).toBe('vertical-rl');
    expect(lines[12].style.writingMode).toBe('horizontal-tb');
  });

  it('a block without quads renders its lines in flow with a font size that fits them all', () => {
    const { container } = mountToc();
    const bare = container.querySelectorAll<HTMLElement>('.editBlock')[1];
    const lines = bare.querySelectorAll<HTMLElement>('.line');
    expect(lines).toHaveLength(3);
    expect(lines[0].classList.contains('positioned')).toBe(false);
    // 50px wide vertical box, 3 columns → 16px, below the block's 20px
    expect(bare.style.fontSize).toBe('16px');
  });

  it('clicking a line inside the selected block selects that line; Enter/Backspace keep quads parallel', async () => {
    const { container, session } = mountToc();
    const block = container.querySelectorAll<HTMLElement>('.editBlock')[0];
    block.setPointerCapture = vi.fn();
    block.releasePointerCapture = vi.fn();
    await pointer(block, 'pointerdown', { id: 1 });
    await pointer(block, 'pointerup', { id: 1 });
    expect(session.selection).toEqual([{ pageIndex: 0, blockIndex: 0 }]);
    await tick();
    const line3 = block.querySelectorAll<HTMLElement>('.line.positioned')[3];
    line3.setPointerCapture = vi.fn();
    line3.releasePointerCapture = vi.fn();
    await pointer(line3, 'pointerdown', { id: 2, x: 10, y: 10 });
    await pointer(line3, 'pointerup', { id: 2, x: 10, y: 10 });
    expect(session.selectedLine).toEqual({ pageIndex: 0, blockIndex: 0, lineIndex: 3 });
    expect(
      line3.querySelectorAll('[data-line-handle]').length +
        block.querySelectorAll('[data-line-handle]').length
    ).toBeGreaterThan(0);

    await fireEvent.dblClick(block);
    await tick();
    let editable = block.querySelectorAll<HTMLElement>('[contenteditable]');
    await fireEvent.keyDown(editable[1], { key: 'Enter' });
    await tick();
    editable = block.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(editable).toHaveLength(14);
    expect(session.pageFor(0).blocks[0].lines).toHaveLength(14);
    expect(session.pageFor(0).blocks[0].lines_coords).toHaveLength(14);
    await fireEvent.keyDown(editable[2], { key: 'Backspace' });
    await tick();
    expect(session.pageFor(0).blocks[0].lines).toHaveLength(13);
    expect(session.pageFor(0).blocks[0].lines_coords).toHaveLength(13);
  });
});

describe('EditOverlay — text follows the model', () => {
  function lineTexts(container: HTMLElement): string[] {
    return [...container.querySelectorAll('.editBlock')[0].querySelectorAll('.line')].map(
      (el) => el.textContent
    );
  }

  it('undo and redo of a text edit re-render the line text (same line count)', async () => {
    const { container, session } = mount();
    expect(lineTexts(container)).toEqual(['あ', 'い']);

    session.setLines(0, 0, ['か', 'い']);
    await tick();
    expect(lineTexts(container)).toEqual(['か', 'い']);

    session.undo(0);
    await tick();
    expect(lineTexts(container)).toEqual(['あ', 'い']);

    session.redo(0);
    await tick();
    expect(lineTexts(container)).toEqual(['か', 'い']);
  });

  it('revert page re-renders the original text', async () => {
    const p = page();
    const original = page();
    const session = new EditSession({
      volumeUuid: 'v1',
      getPage: () => p,
      persist: async () => {},
      loadOriginal: async () => original,
      debounceMs: 100000
    });
    const { container } = render(EditOverlay, { props: { page: p, pageIndex: 0, session } });

    session.setLines(0, 0, ['edited', 'い']);
    await tick();
    expect(lineTexts(container)).toEqual(['edited', 'い']);

    await session.revertPage(0);
    await tick();
    expect(lineTexts(container)).toEqual(['あ', 'い']);
  });
});
