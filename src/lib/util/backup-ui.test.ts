import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { getBackupUiBridge } from './backup-ui';
import { showSnackbar, snackbarStore } from './snackbar';

beforeEach(() => {
  vi.useFakeTimers();
  snackbarStore.set(undefined);
});

afterEach(() => {
  vi.advanceTimersByTime(60_000);
  vi.useRealTimers();
});

describe('backup notices', () => {
  it('a failure is not overwritten by the success notices of the same run', () => {
    const ui = getBackupUiBridge();
    ui.notifyError!('Upload failed: Vol 9 — bad CRC');
    ui.notify('Backed up Vol 10 successfully');
    expect(get(snackbarStore)?.message).toBe('Upload failed: Vol 9 — bad CRC');
    vi.advanceTimersByTime(9_000);
    expect(get(snackbarStore)?.message).toBe('Upload failed: Vol 9 — bad CRC');
    vi.advanceTimersByTime(1_500);
    expect(get(snackbarStore)).toBeUndefined();
    ui.notify('Backed up Vol 11 successfully');
    expect(get(snackbarStore)?.message).toBe('Backed up Vol 11 successfully');
  });
});

describe('showSnackbar', () => {
  it('an older message’s timer never clears a newer message', () => {
    showSnackbar('first'); // 3 s
    vi.advanceTimersByTime(2_000);
    showSnackbar('second', 10_000);
    vi.advanceTimersByTime(1_500); // the first one's timer fires here
    expect(get(snackbarStore)?.message).toBe('second');
    vi.advanceTimersByTime(9_000);
    expect(get(snackbarStore)).toBeUndefined();
  });
});
