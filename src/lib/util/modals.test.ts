import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  seriesEditorModalStore,
  promptSeriesEditor,
  closeSeriesEditor,
  volumeEditorModalStore,
  promptVolumeEditor,
  closeVolumeEditor
} from './modals';

describe('seriesEditorModalStore', () => {
  beforeEach(() => {
    closeSeriesEditor();
    closeVolumeEditor();
  });

  it('promptSeriesEditor opens the store for a series title', () => {
    promptSeriesEditor('One Piece');
    expect(get(seriesEditorModalStore)).toEqual({ open: true, seriesTitle: 'One Piece' });
  });

  it('carries the optional onClose callback', () => {
    const onClose = vi.fn();
    promptSeriesEditor('One Piece', { onClose });
    expect(get(seriesEditorModalStore)?.onClose).toBe(onClose);
  });

  it('closeSeriesEditor clears the store', () => {
    promptSeriesEditor('One Piece');
    closeSeriesEditor();
    expect(get(seriesEditorModalStore)).toBeUndefined();
  });

  it('does not disturb the volume editor store (mirrored pattern, separate state)', () => {
    promptSeriesEditor('One Piece');
    expect(get(volumeEditorModalStore)).toBeUndefined();
    promptVolumeEditor('uuid-1');
    expect(get(seriesEditorModalStore)?.seriesTitle).toBe('One Piece');
  });
});
