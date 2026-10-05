import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
const syncProgress = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('./sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider: vi.fn(() => ({ type: 'webdav' })), syncProgress }
}));

import { ActivityTracker } from './activity-tracker';

let tracker: ActivityTracker;
beforeEach(() => {
  vi.useFakeTimers();
  syncProgress.mockClear();
  tracker = new ActivityTracker();
});
afterEach(() => {
  tracker.destroy();
  vi.useRealTimers();
});

describe('progress sync batching', () => {
  it('reading a page every 30 s for 10 minutes syncs a handful of times, not every page', async () => {
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 30_000) {
      tracker.recordActivity();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(syncProgress.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(syncProgress.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('a pending change still goes up once the interval has passed, with no further activity', async () => {
    tracker.recordActivity();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(syncProgress).toHaveBeenCalledTimes(1);
    tracker.recordActivity();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncProgress).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(syncProgress).toHaveBeenCalledTimes(2);
  });

  it('flush() sends a pending change now, then waits for new activity', async () => {
    tracker.recordActivity();
    await vi.advanceTimersByTimeAsync(6_000);
    tracker.recordActivity();
    tracker.flush();
    expect(syncProgress).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(syncProgress).toHaveBeenCalledTimes(2);
  });

  it('flush() with nothing pending does nothing', () => {
    tracker.flush();
    expect(syncProgress).not.toHaveBeenCalled();
  });
});
