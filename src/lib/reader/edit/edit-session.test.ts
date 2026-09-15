import { describe, expect, it, vi } from 'vitest';
import type { Page } from '$lib/types';
import { EditSession } from './edit-session.svelte';

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

function session(overrides: Partial<ConstructorParameters<typeof EditSession>[0]> = {}) {
  const pages = [page()];
  const persist = vi.fn(async () => {});
  const onPersisted = vi.fn();
  const s = new EditSession({
    volumeUuid: 'v1',
    getPage: (i) => pages[i],
    persist,
    onPersisted,
    debounceMs: 0,
    ...overrides
  });
  return { s, persist, onPersisted, pages };
}

describe('EditSession', () => {
  it('seeds a working copy and applies ops without touching the source page', () => {
    const { s, pages } = session();
    s.move(0, 0, 5, 5, 'drag');
    expect(s.pageFor(0).blocks[0].box).toEqual([15, 15, 55, 105]);
    expect(pages[0].blocks[0].box).toEqual([10, 10, 50, 100]);
    expect(s.dirty).toBe(true);
  });

  it('undo/redo per page, and a drag with one coalesce key is one step', () => {
    const { s } = session();
    s.move(0, 0, 1, 0, 'drag:0');
    s.move(0, 0, 1, 0, 'drag:0');
    s.setLines(0, 1, ['え']);
    expect(s.canUndo(0)).toBe(true);
    s.undo(0);
    expect(s.pageFor(0).blocks[1].lines).toEqual(['う']);
    s.undo(0);
    expect(s.pageFor(0).blocks[0].box).toEqual([10, 10, 50, 100]);
    expect(s.canUndo(0)).toBe(false);
    s.redo(0);
    expect(s.pageFor(0).blocks[0].box).toEqual([12, 10, 52, 100]);
  });

  it('persists the page after the debounce and reports it', async () => {
    const { s, persist, onPersisted } = session();
    s.setLines(0, 0, ['か', 'き']);
    await s.flush();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toBe('v1');
    expect(persist.mock.calls[0][1]).toBe(0);
    expect(persist.mock.calls[0][2].blocks[0].lines).toEqual(['か', 'き']);
    expect(onPersisted).toHaveBeenCalledWith(0, expect.objectContaining({ img_path: 'p.png' }));
    expect(s.dirty).toBe(false);
  });

  it('selection-driven ops: delete, merge, split, flip, add', () => {
    const { s } = session();
    s.select(0, 0);
    s.select(0, 1, true);
    expect(s.selection).toHaveLength(2);
    s.mergeSelected();
    expect(s.pageFor(0).blocks).toHaveLength(1);
    expect(s.selection).toEqual([{ pageIndex: 0, blockIndex: 0 }]);
    s.splitSelected(1);
    expect(s.pageFor(0).blocks).toHaveLength(2);
    s.select(0, 0);
    s.flipSelected();
    expect(s.pageFor(0).blocks[0].vertical).toBe(false);
    const idx = s.add(0, [150, 150, 190, 190]);
    expect(idx).toBe(2);
    expect(s.selection).toEqual([{ pageIndex: 0, blockIndex: 2 }]);
    s.deleteSelected();
    expect(s.pageFor(0).blocks).toHaveLength(2);
    expect(s.selection).toEqual([]);
  });

  it('selecting on another page replaces the selection', () => {
    const pages = [page(), page()];
    const { s } = session({ getPage: (i) => pages[i] });
    s.select(0, 0);
    s.select(1, 0, true);
    expect(s.selection).toEqual([{ pageIndex: 1, blockIndex: 0 }]);
  });

  it('revertPage replaces the working page from the original layer', async () => {
    const original = page();
    original.blocks[0].lines = ['元'];
    const { s } = session({ loadOriginal: async () => original });
    s.setLines(0, 0, ['x']);
    expect(await s.revertPage(0)).toBe(true);
    expect(s.pageFor(0).blocks[0].lines).toEqual(['元']);
    s.undo(0);
    expect(s.pageFor(0).blocks[0].lines).toEqual(['x']);
  });

  it('dispose saves whatever is still pending', async () => {
    const { s, persist } = session({ debounceMs: 100000 });
    s.setLines(0, 0, ['z']);
    await s.dispose();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(s.dirty).toBe(false);
  });

  it('revertPage is a no-op without an original layer', async () => {
    const { s } = session({ loadOriginal: async () => null });
    expect(await s.revertPage(0)).toBe(false);
  });
});
