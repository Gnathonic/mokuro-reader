import { describe, expect, it, vi } from 'vitest';
import { createForegroundSync } from './foreground-sync';

function setup(ready = true, syncing = false, ok = true) {
  const sync = vi.fn(async () => ok);
  const fg = createForegroundSync({ isReady: () => ready, isSyncing: () => syncing, sync });
  return { sync, fg };
}

describe('foreground sync', () => {
  it('pulls when the app comes back or a reader opens', () => {
    const { sync, fg } = setup();
    fg.request(1_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('runs at most once a minute', () => {
    const { sync, fg } = setup();
    fg.request(1_000);
    fg.request(30_000);
    fg.request(60_999);
    expect(sync).toHaveBeenCalledTimes(1);
    fg.request(61_000);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('waits for the cloud listing (and a valid token) without using up the slot', () => {
    let ready = false;
    const sync = vi.fn(async () => true);
    const fg = createForegroundSync({ isReady: () => ready, isSyncing: () => false, sync });
    fg.request(1_000);
    expect(sync).not.toHaveBeenCalled();
    ready = true;
    fg.request(2_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('skips while another sync is running, without using up the slot', () => {
    let syncing = true;
    const sync = vi.fn(async () => true);
    const fg = createForegroundSync({ isReady: () => true, isSyncing: () => syncing, sync });
    fg.request(1_000);
    expect(sync).not.toHaveBeenCalled();
    syncing = false;
    fg.request(2_000);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('a failed sync gives the slot back', async () => {
    const { sync, fg } = setup(true, false, false);
    fg.request(1_000);
    await Promise.resolve();
    await Promise.resolve();
    fg.request(2_000);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a connected provider', () => {
    const { sync, fg } = setup(false);
    fg.request(1_000);
    expect(sync).not.toHaveBeenCalled();
  });

  it('a failed sync is logged, never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fg = createForegroundSync({
      isReady: () => true,
      isSyncing: () => false,
      sync: () => Promise.reject(new Error('offline'))
    });
    expect(() => fg.request(1_000)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('listens for the page becoming visible', () => {
    const { sync, fg } = setup();
    let t = 0;
    const stop = fg.listen(() => (t += 120_000));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sync).toHaveBeenCalledTimes(1);
    stop();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
