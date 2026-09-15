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
