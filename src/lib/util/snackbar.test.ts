import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { showSnackbar, snackbarStore } from './snackbar';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('showSnackbar actions', () => {
  it('a plain notice carries no action and clears after its time', () => {
    showSnackbar('Saved', 1000);
    expect(get(snackbarStore)).toEqual({ visible: true, message: 'Saved' });
    vi.advanceTimersByTime(1000);
    expect(get(snackbarStore)).toBeUndefined();
  });

  it('pressing the action runs it once, clears the notice, and is not a dismissal', () => {
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    showSnackbar('Marked read', 8000, { label: 'Undo', onClick }, onDismiss);
    get(snackbarStore)!.action!.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(get(snackbarStore)).toBeUndefined();
    vi.advanceTimersByTime(8000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('runs out: dismissed once, and the stale button does nothing', () => {
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    showSnackbar('Marked read', 8000, { label: 'Undo', onClick }, onDismiss);
    const stale = get(snackbarStore)!.action!;
    vi.advanceTimersByTime(8000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    stale.onClick();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('a newer notice replacing it is a dismissal', () => {
    const onDismiss = vi.fn();
    showSnackbar('Marked read', 8000, { label: 'Undo', onClick: () => {} }, onDismiss);
    showSnackbar('Something else');
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(8000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
