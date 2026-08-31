import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/catalog/db', () => ({
  db: { volumes: { get: vi.fn().mockResolvedValue(undefined), bulkGet: vi.fn(async () => []) } }
}));

import { get } from 'svelte/store';
import { VolumeData, clearVolumes, volumesWithTrash } from '$lib/settings/volume-data';
import { backfillCompletedAt } from '../completed-at-backfill';

const KEY = 'volumes.completedAtBackfill.v1';
const ATTEMPTS = 'volumes.completedAtBackfill.attempts';

beforeEach(() => {
  clearVolumes();
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem(ATTEMPTS);
});

describe('backfillCompletedAt', () => {
  it('dates a finished volume from its last progress update', () => {
    volumesWithTrash.set({
      v1: new VolumeData({
        completed: true,
        progress: 180,
        lastProgressUpdate: '2026-01-12T02:47:41.594Z'
      })
    });

    backfillCompletedAt({ v1: 180 });

    expect(get(volumesWithTrash).v1.completedAt).toBe('2026-01-12T02:47:41.594Z');
    expect(window.localStorage.getItem(KEY)).toBeTruthy();
  });

  it('prefers the page turn that actually completed the volume', () => {
    const turn = Date.parse('2025-06-01T00:00:00.000Z');
    volumesWithTrash.set({
      v1: new VolumeData({
        completed: true,
        progress: 180,
        lastProgressUpdate: '2026-08-01T00:00:00.000Z',
        recentPageTurns: [
          [turn - 1000, 90, 900],
          [turn, 180, 1800]
        ]
      })
    });

    backfillCompletedAt({ v1: 180 });

    expect(get(volumesWithTrash).v1.completedAt).toBe(new Date(turn).toISOString());
  });

  it('does NOT record success when there are no records to examine yet', () => {
    // On a device whose progress arrives by sync, the store is legitimately
    // empty for the first moments of a session. A pass that ran then found
    // nothing to stamp and nothing to defer, marked the migration complete, and
    // never ran again — stranding every volume that synced in a second later.
    volumesWithTrash.set({});

    backfillCompletedAt({ v1: 180 });

    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('picks the work up on the next run once the records arrive', () => {
    volumesWithTrash.set({});
    backfillCompletedAt({ v1: 180 });

    volumesWithTrash.set({
      v1: new VolumeData({
        completed: true,
        progress: 180,
        lastProgressUpdate: '2026-01-12T00:00:00.000Z'
      })
    });
    backfillCompletedAt({ v1: 180 });

    expect(get(volumesWithTrash).v1.completedAt).toBe('2026-01-12T00:00:00.000Z');
  });

  it('never guesses a date it has no evidence for', () => {
    volumesWithTrash.set({
      v1: new VolumeData({
        completed: true,
        progress: 180,
        lastProgressUpdate: new Date(0).toISOString()
      })
    });

    backfillCompletedAt({ v1: 180 });

    expect(get(volumesWithTrash).v1.completedAt).toBeUndefined();
  });

  it('leaves an already-dated volume alone', () => {
    volumesWithTrash.set({
      v1: new VolumeData({
        completed: true,
        progress: 180,
        completedAt: '2024-01-01T00:00:00.000Z'
      })
    });

    backfillCompletedAt({ v1: 180 });

    expect(get(volumesWithTrash).v1.completedAt).toBe('2024-01-01T00:00:00.000Z');
  });
});
