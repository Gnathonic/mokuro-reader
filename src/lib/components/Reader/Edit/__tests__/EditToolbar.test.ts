import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Page } from '$lib/types';
import EditToolbar from '../EditToolbar.svelte';
import { EditSession } from '$lib/reader/edit/edit-session.svelte';

afterEach(cleanup);

function page(): Page {
  return {
    version: '0.2.1',
    img_width: 200,
    img_height: 200,
    img_path: 'p.png',
    blocks: [
      { box: [10, 10, 50, 100], vertical: true, font_size: 20, lines: ['あ', 'い'] },
      { box: [100, 10, 140, 100], vertical: true, font_size: 20, lines: ['う'] }
    ]
  };
}

function mount(hasOriginal = true, extra: Record<string, unknown> = {}) {
  const p = page();
  const session = new EditSession({
    volumeUuid: 'v',
    getPage: () => p,
    persist: async () => {},
    debounceMs: 1e6
  });
  const onExit = vi.fn();
  const onRevert = vi.fn();
  const utils = render(EditToolbar, {
    props: { session, pageIndex: 0, hasOriginal, onExit, onRevert, ...extra }
  });
  const btn = (label: string) => utils.getByLabelText(label) as HTMLButtonElement;
  return { ...utils, session, onExit, onRevert, btn };
}

const layers = [
  { layer_id: 'original', name: 'Original', kind: 'original' as const, updated_at: 'x' },
  { layer_id: 'fix', name: 'Fix', kind: 'edit' as const, updated_at: 'x' }
];

describe('EditToolbar — layer strip and dock', () => {
  it('shows the displayed layer and swaps with previous/next through the L-key cycle', async () => {
    const onSelectLayer = vi.fn();
    const { btn, container, rerender } = mount(true, {
      layers,
      currentLayer: null,
      primaryName: 'mokuro 0.2.1',
      onSelectLayer
    });
    expect(container.querySelector('[data-edit-toolbar-layer]')?.textContent).toBe('mokuro 0.2.1');
    await fireEvent.click(btn('Next layer'));
    expect(onSelectLayer).toHaveBeenLastCalledWith('original');
    await fireEvent.click(btn('Previous layer'));
    expect(onSelectLayer).toHaveBeenLastCalledWith('fix');
    await rerender({ currentLayer: 'fix' } as never);
    expect(container.querySelector('[data-edit-toolbar-layer]')?.textContent).toBe('Fix');
    await fireEvent.click(btn('Next layer'));
    expect(onSelectLayer).toHaveBeenLastCalledWith(null);
  });

  it('disables the swap buttons without layers, and hides the strip without a handler', () => {
    const { btn } = mount(true, { layers: [], currentLayer: null, onSelectLayer: vi.fn() });
    expect(btn('Previous layer').disabled).toBe(true);
    expect(btn('Next layer').disabled).toBe(true);
    cleanup();
    const { queryByLabelText } = mount(true);
    expect(queryByLabelText('Next layer')).toBeNull();
  });

  it('docks to the edge given and its button cycles top → right → bottom → left', async () => {
    const onDockChange = vi.fn();
    const { btn, container, rerender } = mount(true, { dock: 'top', onDockChange });
    const bar = () => container.querySelector('[data-edit-toolbar]') as HTMLElement;
    expect(bar().dataset.dock).toBe('top');
    expect(bar().className).toContain('flex-row');
    await fireEvent.click(btn('Move toolbar'));
    expect(onDockChange).toHaveBeenLastCalledWith('right');
    await rerender({ dock: 'right' } as never);
    expect(bar().className).toContain('flex-col');
    expect(bar().className).toContain('right-3');
    await fireEvent.click(btn('Move toolbar'));
    expect(onDockChange).toHaveBeenLastCalledWith('bottom');
    await rerender({ dock: 'left' } as never);
    await fireEvent.click(btn('Move toolbar'));
    expect(onDockChange).toHaveBeenLastCalledWith('top');
  });
});

describe('EditToolbar', () => {
  it('disables ops whose preconditions do not hold', async () => {
    const { btn, session, queryByLabelText } = mount(false);
    expect(btn('Delete').disabled).toBe(true);
    expect(btn('Merge').disabled).toBe(true);
    expect(btn('Split').disabled).toBe(true);
    expect(btn('Undo').disabled).toBe(true);
    expect(btn('Redo').disabled).toBe(true);
    expect(btn('Revert page').disabled).toBe(true);
    session.select(0, 0);
    await tick();
    expect(btn('Delete').disabled).toBe(false);
    // Split needs a chosen line INSIDE the block (never line 0 — nothing
    // would be split off before it); the old unlabeled dropdown is gone.
    expect(btn('Split').disabled).toBe(true);
    expect(queryByLabelText('Split after line')).toBeNull();
    session.selectLine(0, 0, 0);
    await tick();
    expect(btn('Split').disabled).toBe(true);
    session.selectLine(0, 0, 1);
    await tick();
    expect(btn('Split').disabled).toBe(false);
    expect(btn('Merge').disabled).toBe(true);
    session.select(0, 1, true);
    await tick();
    expect(btn('Merge').disabled).toBe(false);
    expect(btn('Split').disabled).toBe(true);
  });

  it('offers Place lines only for a single selected block without quads', async () => {
    const { btn, session } = mount(true);
    expect(btn('Place lines').disabled).toBe(true);
    session.select(0, 0);
    await tick();
    expect(btn('Place lines').disabled).toBe(false);
    await fireEvent.click(btn('Place lines'));
    expect(session.pageFor(0).blocks[0].lines_coords).toHaveLength(2);
    await tick();
    expect(btn('Place lines').disabled).toBe(true);
  });

  it('drives the session', async () => {
    const { btn, session, onExit, onRevert } = mount(true);
    await fireEvent.click(btn('Draw new box'));
    expect(session.tool).toBe('draw');
    // Select the second line of block 0, then Split: the box splits BEFORE
    // that line, so the selected line starts the new block.
    session.selectLine(0, 0, 1);
    await tick();
    await fireEvent.click(btn('Split'));
    expect(session.pageFor(0).blocks).toHaveLength(3);
    await fireEvent.click(btn('Undo'));
    expect(session.pageFor(0).blocks).toHaveLength(2);
    await fireEvent.click(btn('Redo'));
    expect(session.pageFor(0).blocks).toHaveLength(3);
    session.select(0, 0);
    await tick();
    await fireEvent.click(btn('Flip writing mode'));
    expect(session.pageFor(0).blocks[0].vertical).toBe(false);
    await fireEvent.click(btn('Delete'));
    expect(session.pageFor(0).blocks).toHaveLength(2);
    await fireEvent.click(btn('Revert page'));
    expect(onRevert).toHaveBeenCalled();
    await fireEvent.click(btn('Exit edit mode'));
    expect(onExit).toHaveBeenCalled();
  });
});

describe('EditToolbar — engine entry points', () => {
  it('shows OCR / Translate this page only when a handler is given, and calls it', async () => {
    const onOcrPage = vi.fn();
    const p = page();
    const session = new EditSession({
      volumeUuid: 'v',
      getPage: () => p,
      persist: async () => {},
      debounceMs: 1e6
    });
    const utils = render(EditToolbar, {
      props: {
        session,
        pageIndex: 0,
        hasOriginal: false,
        onExit: vi.fn(),
        onRevert: vi.fn(),
        onOcrPage
      }
    });
    await fireEvent.click(utils.getByLabelText('OCR this page'));
    expect(onOcrPage).toHaveBeenCalledTimes(1);
    expect(utils.queryByLabelText('Translate this page')).toBeNull();
  });
});
