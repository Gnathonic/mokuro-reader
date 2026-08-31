import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));

import { get } from 'svelte/store';
import {
  deadlinesWithTrash,
  pruneDeadlinesForDeletedVolumes,
  removeVolumeDeadline,
  setVolumeDeadline,
  setVolumeDeadlineEntries,
  volumeDeadlines
} from '../goal-settings';

beforeEach(() => {
  setVolumeDeadlineEntries({});
});

describe('setVolumeDeadline', () => {
  it('accepts a real calendar date and rejects anything else', () => {
    setVolumeDeadline('v1', '2026-09-15');
    expect(get(volumeDeadlines).v1).toBe('2026-09-15');

    setVolumeDeadline('v2', '2026-02-31');
    setVolumeDeadline('v3', 'soon');
    expect(get(volumeDeadlines).v2).toBeUndefined();
    expect(get(volumeDeadlines).v3).toBeUndefined();
  });

  it('tombstones on removal instead of deleting, so the removal propagates', () => {
    setVolumeDeadline('v1', '2026-09-15');
    removeVolumeDeadline('v1');

    expect(get(volumeDeadlines).v1).toBeUndefined();
    expect(get(deadlinesWithTrash).v1.deletedOn).toBeTruthy();
  });
});

describe('pruneDeadlinesForDeletedVolumes', () => {
  it('tombstones the deadline of a volume the user deleted', () => {
    setVolumeDeadline('gone', '2026-09-15');
    pruneDeadlinesForDeletedVolumes({ gone: { deletedOn: '2026-08-01T00:00:00.000Z' } });

    expect(get(deadlinesWithTrash).gone.deletedOn).toBeTruthy();
    expect(get(volumeDeadlines).gone).toBeUndefined();
  });

  it('NEVER prunes a volume merely missing from the catalog', () => {
    // `volumesWithPlaceholders` is defined the moment the local Dexie read
    // resolves — before the cloud listing fills it in — so every cloud-only
    // volume looks missing for a window on every boot. Pruning on absence
    // there would tombstone live deadlines and sync the deletion to every
    // device the user owns.
    setVolumeDeadline('cloud-only', '2026-09-15');

    // Not in the reading records at all, and not in any catalog.
    pruneDeadlinesForDeletedVolumes({});
    expect(get(volumeDeadlines)['cloud-only']).toBe('2026-09-15');

    // Present with progress, no tombstone.
    pruneDeadlinesForDeletedVolumes({ 'cloud-only': {} });
    expect(get(volumeDeadlines)['cloud-only']).toBe('2026-09-15');
  });

  it('leaves an already-tombstoned deadline alone rather than re-stamping it', () => {
    setVolumeDeadline('gone', '2026-09-15');
    pruneDeadlinesForDeletedVolumes({ gone: { deletedOn: '2026-08-01T00:00:00.000Z' } });
    const first = get(deadlinesWithTrash).gone.deletedOn;

    pruneDeadlinesForDeletedVolumes({ gone: { deletedOn: '2026-08-01T00:00:00.000Z' } });
    expect(get(deadlinesWithTrash).gone.deletedOn).toBe(first);
  });
});
