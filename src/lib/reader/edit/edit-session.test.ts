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
  const persist = vi.fn(async (_uuid: string, _pageIndex: number, _page: Page) => {});
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

describe('EditSession — line ops', () => {
  function quadPage(): Page {
    return {
      version: '0.2.1',
      img_width: 400,
      img_height: 400,
      img_path: 'p.png',
      blocks: [
        {
          box: [100, 10, 200, 210],
          vertical: true,
          font_size: 40,
          lines: ['あ', 'い'],
          lines_coords: [
            [
              [160, 10],
              [200, 10],
              [200, 210],
              [160, 210]
            ],
            [
              [100, 10],
              [140, 10],
              [140, 210],
              [100, 210]
            ]
          ]
        },
        { box: [10, 10, 50, 100], vertical: true, font_size: 20, lines: ['う', 'え'] }
      ]
    };
  }

  it('selects a line, moves it with coalescing, resizes it, and places lines on a bare block', () => {
    const pages = [quadPage()];
    const s = new EditSession({
      volumeUuid: 'v',
      getPage: (i) => pages[i],
      persist: async () => {},
      debounceMs: 1e6
    });
    s.select(0, 0);
    s.selectLine(0, 0, 1);
    expect(s.selectedLine).toEqual({ pageIndex: 0, blockIndex: 0, lineIndex: 1 });
    s.moveLine(0, 0, 1, -50, 0, 'line-drag');
    s.moveLine(0, 0, 1, -10, 0, 'line-drag');
    expect(s.pageFor(0).blocks[0].lines_coords![1][0][0]).toBe(40);
    expect(s.pageFor(0).blocks[0].box[0]).toBe(40);
    s.undo(0);
    expect(s.pageFor(0).blocks[0].lines_coords![1][0][0]).toBe(100);
    s.resizeLine(0, 0, 0, [
      [150, 10],
      [200, 10],
      [200, 210],
      [150, 210]
    ]);
    expect(s.pageFor(0).blocks[0].lines_coords![0][0][0]).toBe(150);
    s.placeLines(0, 1);
    expect(s.pageFor(0).blocks[1].lines_coords).toHaveLength(2);
  });

  it('insertLine / removeLine keep lines and quads parallel', () => {
    const pages = [quadPage()];
    const s = new EditSession({
      volumeUuid: 'v',
      getPage: (i) => pages[i],
      persist: async () => {},
      debounceMs: 1e6
    });
    expect(s.insertLine(0, 0, 0)).toBe(1);
    expect(s.pageFor(0).blocks[0].lines).toEqual(['あ', '', 'い']);
    expect(s.pageFor(0).blocks[0].lines_coords).toHaveLength(3);
    s.removeLine(0, 0, 1);
    expect(s.pageFor(0).blocks[0].lines).toEqual(['あ', 'い']);
    expect(s.pageFor(0).blocks[0].lines_coords).toHaveLength(2);
  });

  it('a selection change clears the selected line', () => {
    const pages = [quadPage()];
    const s = new EditSession({
      volumeUuid: 'v',
      getPage: (i) => pages[i],
      persist: async () => {},
      debounceMs: 1e6
    });
    s.select(0, 0);
    s.selectLine(0, 0, 0);
    s.select(0, 1);
    expect(s.selectedLine).toBeNull();
  });
});

describe('EditSession — active page', () => {
  it('tracks the page of the last selection or commit, so a spread edits the right page', () => {
    const p0 = page();
    const p1 = page();
    const pages = [p0, p1];
    const s = new EditSession({
      volumeUuid: 'v1',
      getPage: (i) => pages[i],
      persist: async () => {},
      debounceMs: 100000
    });
    expect(s.activePageIndex).toBeNull();

    s.select(1, 0);
    expect(s.activePageIndex).toBe(1);

    s.move(1, 0, 5, 5, 'drag');
    expect(s.activePageIndex).toBe(1);
    expect(s.canUndo(1)).toBe(true);
    expect(s.canUndo(0)).toBe(false);

    s.selectLine(0, 0, 1);
    expect(s.activePageIndex).toBe(0);

    s.setLines(1, 1, ['え']);
    expect(s.activePageIndex).toBe(1);
  });
});
