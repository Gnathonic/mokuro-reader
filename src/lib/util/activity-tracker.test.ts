import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
const syncProgress = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('./sync/unified-cloud-manager', () => ({
  unifiedCloudManager: { getActiveProvider: vi.fn(() => ({ type: 'webdav' })), syncProgress }
}));

import { ActivityTracker } from './activity-tracker';
import {
  clearVolumeDataDeferred,
  noteVolumeDataDeferred,
  volumeDataDeferred
} from './sync/reading-session';

let tracker: ActivityTracker;
beforeEach(() => {
  vi.useFakeTimers();
  syncProgress.mockClear();
  tracker = new ActivityTracker();
});
afterEach(() => {
  clearVolumeDataDeferred();
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

  it('flush() ends a session that deferred its volume-data upload: it syncs with no new turn', async () => {
    tracker.recordActivity();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(syncProgress).toHaveBeenCalledTimes(1);
    // That sync was in a reading session and left volume-data.json for the end.
    noteVolumeDataDeferred();
    tracker.flush();
    expect(syncProgress).toHaveBeenCalledTimes(2);
  });

  it('flush() consumes the deferral: offline or read-only, the next hide does not sync again', async () => {
    // The deferring sync's upload never happened (offline, demoted read-only):
    // only a new deferral may owe the next flush a sync.
    noteVolumeDataDeferred();
    tracker.flush();
    expect(syncProgress).toHaveBeenCalledTimes(1);
    expect(volumeDataDeferred()).toBe(false);
    tracker.flush();
    tracker.flush();
    expect(syncProgress).toHaveBeenCalledTimes(1);

    // A later sync deferred again: the next flush owes one sync again.
    noteVolumeDataDeferred();
    tracker.flush();
    expect(syncProgress).toHaveBeenCalledTimes(2);
  });

  it('flush() after the deferred upload went up does nothing', async () => {
    noteVolumeDataDeferred();
    clearVolumeDataDeferred();
    tracker.flush();
    expect(syncProgress).not.toHaveBeenCalled();
  });

  it('activity before a provider is connected does not hold back the first real sync', async () => {
    const { unifiedCloudManager } = await import('./sync/unified-cloud-manager');
    vi.mocked(unifiedCloudManager.getActiveProvider).mockReturnValueOnce(null as never);
    tracker.recordActivity();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(syncProgress).not.toHaveBeenCalled();
    tracker.recordActivity();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(syncProgress).toHaveBeenCalledTimes(1);
  });

  it('a clock set back never pushes the next sync beyond the interval', async () => {
    tracker.recordActivity();
    await vi.advanceTimersByTimeAsync(6_000);
    vi.setSystemTime(Date.now() + 24 * 3600_000); // last sync now looks a day in the future
    vi.setSystemTime(Date.now() - 48 * 3600_000);
    tracker.recordActivity();
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 6_000);
    expect(syncProgress).toHaveBeenCalledTimes(2);
  });
});
