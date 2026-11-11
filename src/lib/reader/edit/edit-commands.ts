/**
 * What the edit toolbar's commands can do right now, and why not (#55, spec
 * 17.10). One function for the toolbar's `disabled` flags and for the keys
 * bound to the same commands, so a key can never do what its button would
 * not — and when it cannot run, it says why instead of doing nothing.
 *
 * Structural on purpose (no `EditSession` import): the session's reactive
 * fields are read where this is called, so a `$derived` over it re-runs when
 * the selection or the page changes, and a test passes a plain object.
 */
import type { Block, Page } from '$lib/types';

export interface EditSelectionState {
  readonly selection: readonly { pageIndex: number; blockIndex: number }[];
  readonly selectedLine: { pageIndex: number; blockIndex: number; lineIndex: number } | null;
  pageFor(pageIndex: number): Page;
}

export type EditCommand = 'delete' | 'merge' | 'split' | 'place-lines' | 'flip' | 'revert-page';

/** `reason` says what is missing, in the words a notification shows. */
export type EditCommandAvailability = { enabled: true } | { enabled: false; reason: string };

export interface EditCommandState extends Record<EditCommand, EditCommandAvailability> {
  /** The one selected block, when exactly one is selected. */
  readonly single: { pageIndex: number; blockIndex: number; block: Block } | null;
  /** The line a split happens BEFORE: chosen inside the single selected block. */
  readonly splitLine: number | null;
}

const ok: EditCommandAvailability = { enabled: true };
const no = (reason: string): EditCommandAvailability => ({ enabled: false, reason });

export function editCommandState(
  session: EditSelectionState,
  hasOriginal: boolean
): EditCommandState {
  const selected = session.selection;
  const ref = selected.length === 1 ? selected[0] : null;
  const block = ref ? session.pageFor(ref.pageIndex).blocks[ref.blockIndex] : undefined;
  const single = ref && block ? { ...ref, block } : null;

  // Split happens before the selected line, so it needs a single block with a
  // line chosen inside it that is not the first one.
  const line = session.selectedLine;
  const splitLine =
    single && line && line.pageIndex === single.pageIndex && line.blockIndex === single.blockIndex
      ? line.lineIndex
      : null;

  let split: EditCommandAvailability;
  if (!single) split = no('Select one box to split');
  else if (single.block.lines.length < 2) split = no('This box has one line: nothing to split');
  else if (splitLine === null || splitLine < 1) {
    split = no('Click a line inside the box (not its first) to split before it');
  } else split = ok;

  let placeLines: EditCommandAvailability;
  if (!single) placeLines = no('Select one box to place its lines');
  else if (
    single.block.lines_coords &&
    single.block.lines_coords.length === single.block.lines.length
  ) {
    placeLines = no("This box's lines are already placed");
  } else placeLines = ok;

  return {
    single,
    splitLine,
    delete: selected.length > 0 ? ok : no('Select a box to delete'),
    merge: selected.length >= 2 ? ok : no('Select two or more boxes to merge'),
    split,
    'place-lines': placeLines,
    flip: selected.length > 0 ? ok : no('Select a box to flip its writing mode'),
    'revert-page': hasOriginal ? ok : no('No original to revert to')
  };
}
