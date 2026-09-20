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
import { gestureTargetRole } from '$lib/reader/input/gesture-target';
import { PointerGestureTracker } from '$lib/reader/input/pointer-tracker';

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
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  props: {
    id?: number;
    x?: number;
    y?: number;
    button?: number;
    shift?: boolean;
    /** false = a second touch finger (PointerEvent.isPrimary). */
    primary?: boolean;
  } = {}
) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    pointerId: { value: props.id ?? 1 },
    clientX: { value: props.x ?? 0 },
    clientY: { value: props.y ?? 0 },
    pointerType: { value: 'mouse' },
    button: { value: props.button ?? 0 },
    shiftKey: { value: props.shift ?? false },
    isPrimary: { value: props.primary ?? true }
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

  it('Enter mid-IME-composition is left alone: no line inserted, default not prevented', async () => {
    const { container, session } = mount();
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    await fireEvent.dblClick(block);
    await tick();
    let lines = block.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(lines).toHaveLength(2);
    const composingEnter = await fireEvent.keyDown(lines[1], { key: 'Enter', isComposing: true });
    await tick();
    expect(composingEnter).toBe(true); // preventDefault was never called
    lines = block.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(lines).toHaveLength(2);
    expect(session.pageFor(0).blocks[0].lines).toEqual(['あ', 'い']);

    // Control case: the same key, not composing, still inserts as before.
    const plainEnter = await fireEvent.keyDown(lines[1], { key: 'Enter' });
    await tick();
    expect(plainEnter).toBe(false); // preventDefault was called
    lines = block.querySelectorAll<HTMLElement>('[contenteditable]');
    expect(lines).toHaveLength(3);
  });

  it('a drag on a block body moves it (pointer capture)', async () => {
    const { container, session } = mount();
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    block.setPointerCapture = vi.fn();
    block.releasePointerCapture = vi.fn();
    await pointer(block, 'pointerdown', { id: 3, x: 100, y: 100 });
    expect(block.setPointerCapture).toHaveBeenCalledWith(3);
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

/** A page whose first block has quads (positioned lines) and whose second
 * has none (flow lines) — both line variants in one mount. */
function mixedPage(): Page {
  const quad = (x: number, y: number, w: number, h: number) => [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h]
  ];
  return {
    version: '0.2.1',
    img_width: 400,
    img_height: 400,
    img_path: 'p.png',
    blocks: [
      {
        box: [100, 100, 300, 200],
        vertical: false,
        font_size: 20,
        lines: ['あいうえ', 'かきくけ'],
        lines_coords: [quad(100, 100, 200, 40), quad(100, 150, 200, 40)]
      },
      { box: [10, 10, 50, 100], vertical: true, font_size: 20, lines: ['さしすせ'] }
    ]
  };
}
function mountMixed() {
  const p = mixedPage();
  const session = new EditSession({
    volumeUuid: 'v1',
    getPage: () => p,
    persist: async () => {},
    debounceMs: 100000
  });
  const utils = render(EditOverlay, { props: { page: p, pageIndex: 0, session } });
  return { ...utils, session };
}

describe('EditOverlay — pinch always wins (INPUT-CONTRACTS)', () => {
  /** Records the pointer events that reach an ancestor — where the surface's
   * PointerGestureTracker listens. */
  function surfaceSpy(container: HTMLElement) {
    const seen: string[] = [];
    const surface = container.parentElement!;
    const on = (e: Event) => seen.push(`${e.type}:${(e as PointerEvent).pointerId}`);
    for (const t of ['pointerdown', 'pointerup', 'pointercancel']) surface.addEventListener(t, on);
    return seen;
  }

  it('pointerdown AND pointerup on a block bubble to the surface', async () => {
    const { container } = mount();
    const seen = surfaceSpy(container);
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    await pointer(block, 'pointerdown', { id: 1 });
    await pointer(block, 'pointerup', { id: 1 });
    // Both halves: a down without its up would leave a phantom pointer in the
    // tracker's map, misread as a pinch on the next press.
    expect(seen).toEqual(['pointerdown:1', 'pointerup:1']);
  });

  it('presses on a resize handle and on a selected line bubble too', async () => {
    const { container, session } = mountMixed();
    const seen = surfaceSpy(container);
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    session.select(0, 0);
    await tick();
    const handle = block.querySelector<HTMLElement>('[data-edit-handle="se"]')!;
    await pointer(handle, 'pointerdown', { id: 1 });
    await pointer(handle, 'pointerup', { id: 1 });
    const line = block.querySelector<HTMLElement>('.line.positioned')!;
    await pointer(line, 'pointerdown', { id: 2 });
    await pointer(line, 'pointercancel', { id: 2 });
    expect(seen).toEqual(['pointerdown:1', 'pointerup:1', 'pointerdown:2', 'pointercancel:2']);
  });

  it('a second pointer landing mid-drag cancels the drag and commits nothing', async () => {
    const { container, session } = mount();
    const seen = surfaceSpy(container);
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    block.setPointerCapture = vi.fn();
    block.releasePointerCapture = vi.fn();
    const before = session.pageFor(0);
    await pointer(block, 'pointerdown', { id: 1, x: 100, y: 100 });
    await pointer(block, 'pointermove', { id: 1, x: 130, y: 110 });
    expect(session.pageFor(0).blocks[0].box).toEqual([40, 20, 80, 110]);

    // the second finger lands on the page background, outside every block
    await pointer(document.body, 'pointerdown', { id: 2, x: 300, y: 300, primary: false });
    expect(session.pageFor(0)).toBe(before);
    expect(session.canUndo(0)).toBe(false);
    expect(session.selection).toEqual([]);
    expect(block.releasePointerCapture).toHaveBeenCalledWith(1);

    // the first finger keeps moving (it is pinching now) and lifts: no drag,
    // no click-select — but the surface still sees every event
    await pointer(block, 'pointermove', { id: 1, x: 200, y: 200 });
    await pointer(block, 'pointerup', { id: 1, x: 200, y: 200 });
    expect(session.pageFor(0)).toBe(before);
    expect(session.selection).toEqual([]);
    // (the spy's "surface" is document.body, so it sees the second press too)
    expect(seen).toEqual(['pointerdown:1', 'pointerdown:2', 'pointerup:1']);
  });

  it('a drag cancelled by a second pointer is not left on the redo stack, and spares the redo that was there', async () => {
    const { container, session } = mount();
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    session.move(0, 1, 3, 3);
    session.undo(0);
    await tick();
    expect(session.canRedo(0)).toBe(true);
    const before = session.pageFor(0);

    await pointer(block, 'pointerdown', { id: 1, x: 100, y: 100 });
    await pointer(block, 'pointermove', { id: 1, x: 130, y: 110 });
    await pointer(document.body, 'pointerdown', { id: 2, x: 300, y: 300, primary: false });
    expect(session.pageFor(0)).toBe(before);

    // Ctrl+Y replays the step the user undid — not the drag they cancelled.
    session.redo(0);
    expect(session.pageFor(0).blocks[0].box).toEqual(before.blocks[0].box);
    expect(session.pageFor(0).blocks[1].box).not.toEqual(before.blocks[1].box);
    expect(session.canRedo(0)).toBe(false);
  });

  it('a cancelled resize restores the pre-drag box and the selection', async () => {
    const { container, session } = mountMixed();
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    session.select(0, 0);
    await tick();
    const before = session.pageFor(0);
    const handle = block.querySelector<HTMLElement>('[data-edit-handle="se"]')!;
    await pointer(handle, 'pointerdown', { id: 1, x: 300, y: 200 });
    await pointer(handle, 'pointermove', { id: 1, x: 340, y: 230 });
    expect(session.pageFor(0).blocks[0].box).toEqual([100, 100, 340, 230]);
    await pointer(document.body, 'pointerdown', { id: 2, primary: false });
    expect(session.pageFor(0)).toBe(before);
    expect(session.selection).toEqual([{ pageIndex: 0, blockIndex: 0 }]);
  });

  it('the press that cancelled a drag never starts a drag of its own', async () => {
    const { container, session } = mount();
    const blocks = container.querySelectorAll<HTMLElement>('.editBlock');
    const before = session.pageFor(0);
    await pointer(blocks[0], 'pointerdown', { id: 1, x: 100, y: 100 });
    await pointer(blocks[0], 'pointermove', { id: 1, x: 130, y: 110 });
    // second pointer of a DIFFERENT type (mouse while touching): primary, so
    // only the cancellation itself can tell it apart from a fresh press
    await pointer(blocks[1], 'pointerdown', { id: 2, x: 20, y: 20 });
    await pointer(blocks[1], 'pointermove', { id: 2, x: 90, y: 90 });
    await pointer(blocks[1], 'pointerup', { id: 2, x: 90, y: 90 });
    expect(session.pageFor(0)).toBe(before);
    expect(session.selection).toEqual([]);
  });

  it('a non-primary press (the second finger of a pinch) never starts a drag', async () => {
    const { container, session } = mount();
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    const before = session.pageFor(0);
    // first finger is on the page background: no editor drag is in progress
    await pointer(block, 'pointerdown', { id: 2, x: 100, y: 100, primary: false });
    await pointer(block, 'pointermove', { id: 2, x: 160, y: 160, primary: false });
    await pointer(block, 'pointerup', { id: 2, x: 160, y: 160, primary: false });
    expect(session.pageFor(0)).toBe(before);
    expect(session.selection).toEqual([]);
  });

  it('pointercancel ends a drag exactly like pointerup', async () => {
    const { container, session } = mount();
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    await pointer(block, 'pointerdown', { id: 1, x: 100, y: 100 });
    await pointer(block, 'pointermove', { id: 1, x: 130, y: 110 });
    await pointer(block, 'pointercancel', { id: 1, x: 130, y: 110 });
    await pointer(block, 'pointermove', { id: 1, x: 300, y: 300 });
    expect(session.pageFor(0).blocks[0].box).toEqual([40, 20, 80, 110]);
    // …and the drag is over: a later press elsewhere rolls nothing back
    await pointer(document.body, 'pointerdown', { id: 2 });
    expect(session.pageFor(0).blocks[0].box).toEqual([40, 20, 80, 110]);
  });

  it('a release that never reaches the block (window-level) still ends the drag', async () => {
    const { container, session } = mount();
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    await pointer(block, 'pointerdown', { id: 1, x: 100, y: 100 });
    await pointer(block, 'pointermove', { id: 1, x: 130, y: 110 });
    await pointer(document.body, 'pointerup', { id: 1, x: 130, y: 110 });
    // a stale drag would be rolled back by the next press anywhere
    await pointer(document.body, 'pointerdown', { id: 2 });
    expect(session.pageFor(0).blocks[0].box).toEqual([40, 20, 80, 110]);
  });

  it('the real PointerGestureTracker pinches from a block press, and its map drains', async () => {
    const { container, session } = mount();
    const onPinchStart = vi.fn();
    const onPanMove = vi.fn();
    // The paged surface's policy for the editor role (PagedViewport.svelte).
    const tracker = new PointerGestureTracker({
      getElement: () => container.parentElement,
      capturePolicy: 'deferred',
      suppressPan: (e) => gestureTargetRole(e.target) === 'editor',
      onPinchStart,
      onPanMove
    });
    tracker.attach();
    try {
      const block = container.querySelector<HTMLElement>('.editBlock')!;
      const before = session.pageFor(0);
      await pointer(block, 'pointerdown', { id: 1, x: 100, y: 100 });
      expect(tracker.pointerCount).toBe(1);
      await pointer(block, 'pointermove', { id: 1, x: 130, y: 110 });
      expect(onPanMove).not.toHaveBeenCalled(); // the block drags; the page never pans
      await pointer(container, 'pointerdown', { id: 2, x: 300, y: 300, primary: false });
      expect(onPinchStart).toHaveBeenCalledTimes(1);
      expect(onPinchStart.mock.calls[0][0]).toHaveLength(2);
      expect(tracker.isPinching).toBe(true);
      expect(session.pageFor(0)).toBe(before); // the drag yielded, nothing committed
      await pointer(container, 'pointerup', { id: 2 });
      await pointer(block, 'pointerup', { id: 1 });
      expect(tracker.pointerCount).toBe(0); // no phantom pointer left behind

      // a plain click-select leaves the map empty as well
      await pointer(block, 'pointerdown', { id: 3 });
      await pointer(block, 'pointerup', { id: 3 });
      expect(tracker.pointerCount).toBe(0);
      expect(onPinchStart).toHaveBeenCalledTimes(1);
    } finally {
      tracker.detach();
    }
  });

  it('double click still stops at the block (no tap-to-turn, no Anki double-tap)', async () => {
    const { container } = mount();
    const onDbl = vi.fn();
    container.parentElement!.addEventListener('dblclick', onDbl);
    await fireEvent.dblClick(container.querySelector<HTMLElement>('.editBlock')!);
    expect(onDbl).not.toHaveBeenCalled();
    container.parentElement!.removeEventListener('dblclick', onDbl);
  });

  it('with the draw tool armed the background press bubbles, and classifies as the editor’s', async () => {
    const { container, session } = mount();
    const seen = surfaceSpy(container);
    const overlay = container.querySelector<HTMLElement>('[data-edit-overlay]')!;
    // select tool: the background is the page's (pan / tap / pinch)
    expect(gestureTargetRole(overlay)).toBe('page');
    session.tool = 'draw';
    await tick();
    // draw tool: the surface must not pan (and steal capture) under the draw
    expect(gestureTargetRole(overlay)).toBe('editor');
    // …said in the classifier's own terms, not by posing as a resize handle
    expect(overlay.hasAttribute('data-edit-draw')).toBe(true);
    expect(overlay.hasAttribute('data-edit-handle')).toBe(false);
    await pointer(overlay, 'pointerdown', { id: 4, x: 200, y: 200 });
    await pointer(overlay, 'pointermove', { id: 4, x: 260, y: 300 });
    await pointer(overlay, 'pointerup', { id: 4, x: 260, y: 300 });
    expect(seen).toEqual(['pointerdown:4', 'pointerup:4']);
    expect(session.pageFor(0).blocks).toHaveLength(3);
    await tick();
    expect(gestureTargetRole(overlay)).toBe('page');
  });
});

describe('EditOverlay — draw tool vs a second pointer', () => {
  it('a second pointerdown cancels the draft: it never restarts it, and nothing is added', async () => {
    const { container, session } = mount();
    const overlay = container.querySelector<HTMLElement>('[data-edit-overlay]')!;
    overlay.setPointerCapture = vi.fn();
    overlay.releasePointerCapture = vi.fn();
    session.tool = 'draw';
    await pointer(overlay, 'pointerdown', { id: 4, x: 200, y: 200 });
    await pointer(overlay, 'pointermove', { id: 4, x: 260, y: 300 });
    expect(container.querySelector('.draft')).not.toBeNull();

    await pointer(overlay, 'pointerdown', { id: 5, x: 20, y: 20 });
    expect(container.querySelector('.draft')).toBeNull();
    expect(overlay.releasePointerCapture).toHaveBeenCalledWith(4);
    await pointer(overlay, 'pointermove', { id: 5, x: 120, y: 120 });
    expect(container.querySelector('.draft')).toBeNull();
    await pointer(overlay, 'pointerup', { id: 5, x: 120, y: 120 });
    await pointer(overlay, 'pointermove', { id: 4, x: 300, y: 350 });
    await pointer(overlay, 'pointerup', { id: 4, x: 300, y: 350 });
    expect(session.pageFor(0).blocks).toHaveLength(2);
    expect(session.tool).toBe('draw'); // still armed for the next real drag
  });

  it('a second pointer landing on a BLOCK cancels the draft too, and drags nothing', async () => {
    const { container, session } = mount();
    const overlay = container.querySelector<HTMLElement>('[data-edit-overlay]')!;
    const block = container.querySelector<HTMLElement>('.editBlock')!;
    const before = session.pageFor(0);
    session.tool = 'draw';
    await pointer(overlay, 'pointerdown', { id: 4, x: 200, y: 200 });
    await pointer(overlay, 'pointermove', { id: 4, x: 260, y: 300 });
    await pointer(block, 'pointerdown', { id: 5, x: 20, y: 20 });
    await pointer(block, 'pointermove', { id: 5, x: 90, y: 90 });
    expect(container.querySelector('.draft')).toBeNull();
    await pointer(block, 'pointerup', { id: 5, x: 90, y: 90 });
    await pointer(overlay, 'pointerup', { id: 4, x: 260, y: 300 });
    expect(session.pageFor(0)).toBe(before);
  });

  it('pointercancel ends the draw exactly like pointerup (no stale draft)', async () => {
    const { container, session } = mount();
    const overlay = container.querySelector<HTMLElement>('[data-edit-overlay]')!;
    session.tool = 'draw';
    await pointer(overlay, 'pointerdown', { id: 4, x: 200, y: 200 });
    await pointer(overlay, 'pointermove', { id: 4, x: 260, y: 300 });
    await pointer(overlay, 'pointercancel', { id: 4, x: 260, y: 300 });
    expect(container.querySelector('.draft')).toBeNull();
    expect(session.pageFor(0).blocks).toHaveLength(3);
    // the draw is over: a later press anywhere has nothing left to cancel
    await pointer(overlay, 'pointermove', { id: 4, x: 390, y: 390 });
    expect(container.querySelector('.draft')).toBeNull();
  });

  it('a non-primary press never starts a draft', async () => {
    const { container, session } = mount();
    const overlay = container.querySelector<HTMLElement>('[data-edit-overlay]')!;
    session.tool = 'draw';
    await pointer(overlay, 'pointerdown', { id: 5, x: 200, y: 200, primary: false });
    await pointer(overlay, 'pointermove', { id: 5, x: 260, y: 300, primary: false });
    expect(container.querySelector('.draft')).toBeNull();
    await pointer(overlay, 'pointerup', { id: 5, x: 260, y: 300, primary: false });
    expect(session.pageFor(0).blocks).toHaveLength(2);
  });
});

describe('EditOverlay — paste and drop are plain, single-line text', () => {
  function transferEvent(type: 'paste' | 'drop', data: Record<string, string>) {
    const e = new Event(type, { bubbles: true, cancelable: true });
    const transfer = { getData: (t: string) => data[t] ?? '' };
    Object.defineProperty(e, type === 'paste' ? 'clipboardData' : 'dataTransfer', {
      value: transfer
    });
    return e;
  }
  function caretAt(el: HTMLElement, offset: number) {
    const range = document.createRange();
    range.setStart(el.firstChild!, offset);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const RICH = {
    'text/html': '<div><b>bold</b><br><span style="color:red">second</span></div>',
    'text/plain': 'bold\r\nsecond\n\n\tthird\n'
  };

  async function openLine(blockIndex: number, lineIndex: number) {
    const mounted = mountMixed();
    const block = mounted.container.querySelectorAll<HTMLElement>('.editBlock')[blockIndex];
    await fireEvent.dblClick(block);
    await tick();
    const line = block.querySelectorAll<HTMLElement>('[contenteditable]')[lineIndex];
    return { ...mounted, block, line };
  }

  it('positioned line: rich multi-line paste lands as plain text at the caret, newline runs → one space', async () => {
    const { session, line } = await openLine(0, 1);
    expect(line.classList.contains('positioned')).toBe(true);
    line.focus();
    caretAt(line, 2);
    const e = transferEvent('paste', RICH);
    line.dispatchEvent(e);
    await tick();
    expect(e.defaultPrevented).toBe(true);
    expect(line.textContent).toBe('かきbold second thirdくけ');
    expect(line.children).toHaveLength(0); // no nested nodes from the HTML flavour
    // same path as oninput: the draft saw it, so closing commits it
    await fireEvent.keyDown(line, { key: 'Escape' });
    expect(session.pageFor(0).blocks[0].lines).toEqual(['あいうえ', 'かきbold second thirdくけ']);
  });

  it('flow line: same sanitization', async () => {
    const { session, line } = await openLine(1, 0);
    expect(line.classList.contains('positioned')).toBe(false);
    line.focus();
    caretAt(line, 4);
    const e = transferEvent('paste', RICH);
    line.dispatchEvent(e);
    await tick();
    expect(e.defaultPrevented).toBe(true);
    expect(line.textContent).toBe('さしすせbold second third');
    expect(line.children).toHaveLength(0);
    await fireEvent.keyDown(line, { key: 'Escape' });
    expect(session.pageFor(0).blocks[1].lines).toEqual(['さしすせbold second third']);
  });

  it('a paste replaces the selected text', async () => {
    const { line } = await openLine(1, 0);
    line.focus();
    const range = document.createRange();
    range.setStart(line.firstChild!, 1);
    range.setEnd(line.firstChild!, 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    line.dispatchEvent(transferEvent('paste', { 'text/plain': 'X\nY' }));
    await tick();
    expect(line.textContent).toBe('さX Yせ');
  });

  it('prefers execCommand(insertText) — it keeps the browser’s own undo stack', async () => {
    const { line } = await openLine(1, 0);
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    try {
      line.focus();
      caretAt(line, 0);
      line.dispatchEvent(transferEvent('paste', RICH));
      await tick();
      expect(exec).toHaveBeenCalledWith('insertText', false, 'bold second third');
      expect(line.textContent).toBe('さしすせ'); // the (mocked) command owned the insertion
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    }
  });

  it('a drop is sanitized the same way (never the rich flavour)', async () => {
    const { session, line } = await openLine(1, 0);
    line.focus();
    caretAt(line, 0);
    const e = transferEvent('drop', RICH);
    line.dispatchEvent(e);
    await tick();
    expect(e.defaultPrevented).toBe(true);
    expect(line.textContent).toBe('bold second thirdさしすせ');
    expect(line.children).toHaveLength(0);
    await fireEvent.keyDown(line, { key: 'Escape' });
    expect(session.pageFor(0).blocks[1].lines).toEqual(['bold second thirdさしすせ']);
  });
});

describe('EditOverlay — the open editor’s draft survives tab hide and unmount', () => {
  function setHidden(hidden: boolean) {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  }
  afterEach(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
  });

  async function openAndType(text: string) {
    const mounted = mount();
    const setLines = vi.spyOn(mounted.session, 'setLines');
    const flush = vi.spyOn(mounted.session, 'flush');
    const block = mounted.container.querySelector<HTMLElement>('.editBlock')!;
    await fireEvent.dblClick(block);
    await tick();
    const line = block.querySelectorAll<HTMLElement>('[contenteditable]')[1];
    line.focus();
    line.textContent = text;
    await fireEvent.input(line);
    return { ...mounted, setLines, flush, block, line };
  }

  it('visibilitychange → hidden commits the draft and flushes, leaving the editor and its DOM alone', async () => {
    const { setLines, flush, block, line } = await openAndType('いろは');
    expect(setLines).not.toHaveBeenCalled(); // the draft lives only in the component
    const textNode = line.firstChild;
    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await tick();
    expect(setLines).toHaveBeenCalledWith(0, 0, ['あ', 'いろは']);
    expect(flush).toHaveBeenCalled();
    // still editing, same element, same text node: the caret was never touched
    const now = block.querySelectorAll<HTMLElement>('[contenteditable]')[1];
    expect(now).toBe(line);
    expect(now.firstChild).toBe(textNode);
    expect(document.activeElement).toBe(line);
  });

  it('visibilitychange → visible commits nothing', async () => {
    const { setLines } = await openAndType('いろは');
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(setLines).not.toHaveBeenCalled();
  });

  it('pagehide commits the draft', async () => {
    const { setLines } = await openAndType('いろは');
    window.dispatchEvent(new Event('pagehide'));
    expect(setLines).toHaveBeenCalledWith(0, 0, ['あ', 'いろは']);
  });

  it('mid-IME-composition text is not committed on hide; the commit lands on compositionend', async () => {
    const { setLines, line } = await openAndType('い');
    line.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    line.textContent = 'いにほん';
    await fireEvent.input(line);
    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(setLines).not.toHaveBeenCalled();
    line.textContent = 'い日本';
    line.dispatchEvent(new Event('compositionend', { bubbles: true }));
    expect(setLines).toHaveBeenCalledTimes(1);
    expect(setLines).toHaveBeenCalledWith(0, 0, ['あ', 'い日本']);
  });

  it('a composition that ends while visible commits nothing early', async () => {
    const { setLines, line } = await openAndType('い');
    line.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    line.dispatchEvent(new Event('compositionend', { bubbles: true }));
    expect(setLines).not.toHaveBeenCalled();
  });

  it('unmounting with the editor open commits the draft', async () => {
    const { setLines, unmount } = await openAndType('いろは');
    unmount();
    expect(setLines).toHaveBeenCalledWith(0, 0, ['あ', 'いろは']);
  });

  it('unmounting mid-composition commits the confirmed text, not the candidate', async () => {
    const { setLines, line, unmount } = await openAndType('いろ');
    line.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    line.textContent = 'いろにほん';
    await fireEvent.input(line);
    unmount();
    expect(setLines).toHaveBeenCalledWith(0, 0, ['あ', 'いろ']);
  });
});
