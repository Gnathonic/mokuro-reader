import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

import { updateVolumeStats } from './volume-editor';
import { VolumeData, volumesWithTrash } from '$lib/settings/volume-data';

const OLD = '2026-01-01T00:00:00.000Z';

beforeEach(() => {
  volumesWithTrash.set({
    'vol-1': new VolumeData({
      progress: 58,
      chars: 9400,
      timeReadInMinutes: 30,
      lastProgressUpdate: OLD
    })
  });
});

const stamp = () => get(volumesWithTrash)['vol-1'].lastProgressUpdate;

describe('volume editor saves are dated so they win the next merge', () => {
  it.each([
    ['progress', { progress: 60 }],
    ['time read', { timeReadInMinutes: 45 }],
    ['completion', { completed: true }]
  ])('a %s edit moves the stamp', (_label, updates) => {
    const before = Date.now();
    updateVolumeStats('vol-1', updates);
    expect(Date.parse(stamp())).toBeGreaterThanOrEqual(before);
  });

  it('a save that changes no stat keeps the stamp (rename, chars re-estimate)', () => {
    updateVolumeStats('vol-1', {
      progress: 58,
      chars: 8700,
      timeReadInMinutes: 30,
      completed: false,
      volume_title: 'Renamed'
    });
    expect(stamp()).toBe(OLD);
  });
});
