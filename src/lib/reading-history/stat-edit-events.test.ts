import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/reading-history/record', () => ({
  recordEvent: vi.fn(() => Promise.resolve(null))
}));

import { recordEvent } from '$lib/reading-history/record';
import { updateVolumeStats } from '$lib/util/volume-editor';
import {
  archiveAndResetVolumes,
  deleteVolume,
  updateProgress,
  volumesWithTrash
} from '$lib/settings/volume-data';

const recorded = vi.mocked(recordEvent);

beforeEach(() => {
  volumesWithTrash.set({});
  recorded.mockClear();
});

describe('stat edits record history events', () => {
  it('volume editor: records the time and chars deltas', () => {
    updateVolumeStats('vol-a', { timeReadInMinutes: 30, chars: 1000 });
    updateVolumeStats('vol-a', { timeReadInMinutes: 45, chars: 900 });
    expect(recorded.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'adjust', volume: 'vol-a', time_delta_ms: 30 * 60000, chars_delta: 1000 },
      { kind: 'adjust', volume: 'vol-a', time_delta_ms: 15 * 60000, chars_delta: -100 }
    ]);
  });

  it('volume editor: records nothing when time and chars are unchanged', () => {
    updateVolumeStats('vol-a', { timeReadInMinutes: 10 });
    recorded.mockClear();
    updateVolumeStats('vol-a', { timeReadInMinutes: 10, volume_title: 'Renamed' });
    expect(recorded).not.toHaveBeenCalled();
  });

  it('restart series: one restart per volume actually archived', () => {
    updateProgress('vol-a', 10, 500);
    updateProgress('vol-b', 0, 0);
    recorded.mockClear();
    archiveAndResetVolumes(['vol-a', 'vol-b', 'vol-missing']);
    expect(recorded.mock.calls.map((c) => c[0])).toEqual([{ kind: 'restart', volume: 'vol-a' }]);
  });

  it('forget stats: records forget with the deletion time', () => {
    updateProgress('vol-a', 3, 100);
    recorded.mockClear();
    const before = Date.now();
    deleteVolume('vol-a');
    expect(recorded).toHaveBeenCalledTimes(1);
    const [payload] = recorded.mock.calls[0];
    expect(payload).toMatchObject({ kind: 'forget', volume: 'vol-a' });
    expect((payload as { before: number }).before).toBeGreaterThanOrEqual(before);
  });

  it('forget stats on an unknown volume records nothing', () => {
    deleteVolume('nope');
    expect(recorded).not.toHaveBeenCalled();
  });
});
