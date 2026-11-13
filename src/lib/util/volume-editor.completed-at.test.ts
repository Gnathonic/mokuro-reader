import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/env', () => ({ browser: true }));

import {
  completedAtFromDateInput,
  completionDateInputValue,
  updateVolumeStats
} from './volume-editor';
import { VolumeData, volumesWithTrash } from '#lib/settings/volume-data.js';

const OLD = '2026-01-01T00:00:00.000Z';
const FINISHED = new Date(2026, 9, 11, 21, 30).toISOString();
const record = () => get(volumesWithTrash)['vol-1'];

describe('editing a completion date (#304)', () => {
  beforeEach(() => {
    volumesWithTrash.set({
      'vol-1': new VolumeData({
        progress: 200,
        completed: true,
        completedAt: FINISHED,
        lastProgressUpdate: OLD
      })
    });
  });

  it('moves the date and stamps the record so the edit wins the next merge', () => {
    const before = Date.now();
    const corrected = new Date(2025, 2, 2, 21, 30).toISOString();
    updateVolumeStats('vol-1', { completedAt: corrected });
    expect(record().completedAt).toBe(corrected);
    expect(record().completed).toBe(true);
    expect(Date.parse(record().lastProgressUpdate)).toBeGreaterThanOrEqual(before);
  });

  it('the same date again is no edit', () => {
    updateVolumeStats('vol-1', { completedAt: FINISHED });
    expect(record().lastProgressUpdate).toBe(OLD);
  });

  it('dates nothing that was never finished', () => {
    volumesWithTrash.set({ 'vol-1': new VolumeData({ progress: 10, lastProgressUpdate: OLD }) });
    updateVolumeStats('vol-1', { completedAt: FINISHED });
    expect(record().completedAt).toBeUndefined();
    expect(record().lastProgressUpdate).toBe(OLD);
  });

  it('an explicit un-finish in the same save still clears it', () => {
    updateVolumeStats('vol-1', { completed: false, completedAt: FINISHED });
    expect(record().completedAt).toBeUndefined();
  });
});

describe('the editor date field', () => {
  const now = new Date(2026, 10, 8, 10, 0).getTime();

  it('shows the local day of a stored date, empty for none', () => {
    expect(completionDateInputValue(FINISHED)).toBe('2026-10-11');
    expect(completionDateInputValue(undefined)).toBe('');
    expect(completionDateInputValue('garbage')).toBe('');
  });

  it('keeps the time of day of the date it replaces, midday when there was none', () => {
    expect(completedAtFromDateInput('2025-03-02', FINISHED, now)).toBe(
      new Date(2025, 2, 2, 21, 30).toISOString()
    );
    expect(completedAtFromDateInput('2025-03-02', undefined, now)).toBe(
      new Date(2025, 2, 2, 12, 0).toISOString()
    );
  });

  it('never dates a finish in the future', () => {
    expect(completedAtFromDateInput('2026-11-09', FINISHED, now)).toBeNull();
    // Today at a later hour than now: now.
    expect(completedAtFromDateInput('2026-11-08', FINISHED, now)).toBe(new Date(now).toISOString());
  });

  it('refuses what is not a day', () => {
    expect(completedAtFromDateInput('', FINISHED, now)).toBeNull();
    expect(completedAtFromDateInput('2025-02-30', FINISHED, now)).toBeNull();
    expect(completedAtFromDateInput('yesterday', FINISHED, now)).toBeNull();
  });
});
