import { describe, expect, it } from 'vitest';
import type { Page } from '$lib/types';
import { editCommandState, type EditSelectionState } from './edit-commands';

function page(): Page {
  return {
    version: '0.2.1',
    img_width: 200,
    img_height: 200,
    img_path: 'p.png',
    blocks: [
      // Two lines, not placed.
      { box: [10, 10, 50, 100], vertical: true, font_size: 20, lines: ['あ', 'い'] },
      // One line.
      { box: [100, 10, 140, 100], vertical: true, font_size: 20, lines: ['う'] },
      // Two lines, each with its quad.
      {
        box: [150, 10, 190, 100],
        vertical: true,
        font_size: 20,
        lines: ['え', 'お'],
        lines_coords: [
          [
            [150, 10],
            [170, 10],
            [170, 100],
            [150, 100]
          ],
          [
            [170, 10],
            [190, 10],
            [190, 100],
            [170, 100]
          ]
        ]
      }
    ]
  };
}

function session(blocks: number[], line: [number, number] | null = null): EditSelectionState {
  const p = page();
  return {
    selection: blocks.map((blockIndex) => ({ pageIndex: 0, blockIndex })),
    selectedLine: line ? { pageIndex: 0, blockIndex: line[0], lineIndex: line[1] } : null,
    pageFor: () => p
  };
}

const enabled = (s: ReturnType<typeof editCommandState>) =>
  (['delete', 'merge', 'split', 'place-lines', 'flip', 'revert-page'] as const).filter(
    (c) => s[c].enabled
  );

describe('editCommandState', () => {
  it('nothing selected: only revert, and every other command says what to select', () => {
    const s = editCommandState(session([]), true);
    expect(enabled(s)).toEqual(['revert-page']);
    expect(s.single).toBeNull();
    expect(s.splitLine).toBeNull();
    expect(s.merge).toEqual({ enabled: false, reason: 'Select two or more boxes to merge' });
    expect(s.delete).toEqual({ enabled: false, reason: 'Select a box to delete' });
    expect(s.flip).toEqual({ enabled: false, reason: 'Select a box to flip its writing mode' });
    expect(s.split).toEqual({ enabled: false, reason: 'Select one box to split' });
    expect(s['place-lines']).toEqual({
      enabled: false,
      reason: 'Select one box to place its lines'
    });
  });

  it('one box: delete, flip and place lines; split needs a line chosen inside it', () => {
    const s = editCommandState(session([0]), false);
    expect(enabled(s)).toEqual(['delete', 'place-lines', 'flip']);
    expect(s.single).toMatchObject({ pageIndex: 0, blockIndex: 0 });
    expect(s.split).toEqual({
      enabled: false,
      reason: 'Click a line inside the box (not its first) to split before it'
    });
    expect(s.merge.enabled).toBe(false);
  });

  it('split: the second line of the selected box, never the first, never another box', () => {
    expect(editCommandState(session([0], [0, 1]), false).split).toEqual({ enabled: true });
    expect(editCommandState(session([0], [0, 1]), false).splitLine).toBe(1);
    // The first line: there is nothing before it to split off.
    const first = editCommandState(session([0], [0, 0]), false);
    expect(first.split.enabled).toBe(false);
    expect(first.splitLine).toBe(0);
    // A line of a box that is not the selected one.
    const other = editCommandState(session([0], [2, 1]), false);
    expect(other.split.enabled).toBe(false);
    expect(other.splitLine).toBeNull();
  });

  it('a one-line box cannot be split, whatever line is chosen', () => {
    expect(editCommandState(session([1], [1, 0]), false).split).toEqual({
      enabled: false,
      reason: 'This box has one line: nothing to split'
    });
  });

  it('place lines is off once every line has its quad', () => {
    expect(editCommandState(session([2]), false)['place-lines']).toEqual({
      enabled: false,
      reason: "This box's lines are already placed"
    });
  });

  it('two boxes: merge, delete and flip; nothing that needs a single box', () => {
    const s = editCommandState(session([0, 1], [0, 1]), false);
    expect(enabled(s)).toEqual(['delete', 'merge', 'flip']);
    expect(s.single).toBeNull();
    expect(s.splitLine).toBeNull();
  });

  it('revert follows the original snapshot alone', () => {
    expect(editCommandState(session([0]), true)['revert-page']).toEqual({ enabled: true });
    expect(editCommandState(session([0]), false)['revert-page']).toEqual({
      enabled: false,
      reason: 'No original to revert to'
    });
  });

  it('a selection that points at a block that is gone is no single box', () => {
    const s = editCommandState(
      { selection: [{ pageIndex: 0, blockIndex: 9 }], selectedLine: null, pageFor: () => page() },
      false
    );
    expect(s.single).toBeNull();
    expect(s.split.enabled).toBe(false);
  });
});
