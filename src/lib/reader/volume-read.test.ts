import { beforeEach, describe, expect, it, vi } from 'vitest';

const markVolumeAsComplete = vi.fn();
const markVolumeAsUnread = vi.fn();
vi.mock('$lib/settings/volume-data', () => ({ markVolumeAsComplete, markVolumeAsUnread }));

const { toggleVolumeRead } = await import('./volume-read');

beforeEach(() => {
  markVolumeAsComplete.mockClear();
  markVolumeAsUnread.mockClear();
});

describe('toggleVolumeRead (reader.volume-read)', () => {
  it('marks an unfinished volume read: the last page, with the volume’s characters', () => {
    expect(toggleVolumeRead('vol', 5, 200, 12_345)).toBe('read');
    expect(markVolumeAsComplete).toHaveBeenCalledExactlyOnceWith('vol', 200, 12_345);
    expect(markVolumeAsUnread).not.toHaveBeenCalled();
  });

  it('marks a never-opened volume read', () => {
    expect(toggleVolumeRead('vol', 0, 200)).toBe('read');
    expect(markVolumeAsComplete).toHaveBeenCalledExactlyOnceWith('vol', 200, undefined);
  });

  it('marks a finished volume unread, on the row button’s own test: the last page or the one before', () => {
    expect(toggleVolumeRead('vol', 200, 200, 12_345)).toBe('unread');
    expect(toggleVolumeRead('vol', 199, 200, 12_345)).toBe('unread');
    expect(markVolumeAsUnread).toHaveBeenCalledTimes(2);
    expect(markVolumeAsUnread).toHaveBeenLastCalledWith('vol');
    expect(markVolumeAsComplete).not.toHaveBeenCalled();
  });

  it('does nothing without a page count', () => {
    expect(toggleVolumeRead('vol', 3, 0)).toBeNull();
    expect(markVolumeAsComplete).not.toHaveBeenCalled();
    expect(markVolumeAsUnread).not.toHaveBeenCalled();
  });
});
