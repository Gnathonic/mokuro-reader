import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { editModeActive, editModeRequest, requestEditMode, setEditModeActive } from './edit-mode';

describe('edit-mode store', () => {
  it('requests carry the desired state, an optional focus, and a fresh sequence number', () => {
    const before = get(editModeRequest).seq;
    requestEditMode(true, { pageIndex: 3, blockIndex: 2, lineIndex: 0 });
    const r = get(editModeRequest);
    expect(r.on).toBe(true);
    expect(r.focus).toEqual({ pageIndex: 3, blockIndex: 2, lineIndex: 0 });
    expect(r.seq).toBe(before + 1);
    requestEditMode(false);
    expect(get(editModeRequest)).toMatchObject({ on: false, focus: undefined, seq: before + 2 });
  });

  it('the reader publishes whether edit mode is active', () => {
    setEditModeActive(true);
    expect(get(editModeActive)).toBe(true);
    setEditModeActive(false);
    expect(get(editModeActive)).toBe(false);
  });
});
