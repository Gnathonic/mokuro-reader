import { describe, expect, it, vi } from 'vitest';
import { RetryableError, isRetryableStatus, runQueue } from './run-queue';

const noSleep = async () => {};

describe('runQueue', () => {
  it('runs at most `concurrency` workers at once and reports progress', async () => {
    let active = 0;
    let peak = 0;
    const onProgress = vi.fn();
    const r = await runQueue(
      [1, 2, 3, 4, 5],
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((res) => setTimeout(res, 5));
        active--;
      },
      { concurrency: 2, signal: new AbortController().signal, onProgress, sleep: noSleep }
    );
    expect(peak).toBe(2);
    expect(r).toMatchObject({ done: 5, failed: 0, cancelled: false });
    expect(onProgress).toHaveBeenLastCalledWith(5, 5, 0);
  });

  it('retries retryable errors with backoff, then fails the item and continues', async () => {
    const calls: number[] = [];
    const sleeps: number[] = [];
    const r = await runQueue(
      [1, 2],
      async (item) => {
        calls.push(item);
        if (item === 1) throw new RetryableError('rate limited', 429);
      },
      {
        concurrency: 1,
        retries: 2,
        backoffMs: [10, 20],
        signal: new AbortController().signal,
        sleep: async (ms) => {
          sleeps.push(ms);
        }
      }
    );
    expect(calls).toEqual([1, 1, 1, 2]);
    expect(sleeps).toEqual([10, 20]);
    expect(r.done).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.errors[0].item).toBe(1);
  });

  it('does not retry non-retryable errors', async () => {
    const worker = vi.fn(async () => {
      throw new Error('bad key');
    });
    const r = await runQueue([1], worker, { signal: new AbortController().signal, sleep: noSleep });
    expect(worker).toHaveBeenCalledTimes(1);
    expect(r.failed).toBe(1);
  });

  it('stops starting new items once aborted', async () => {
    const ac = new AbortController();
    const started: number[] = [];
    const r = await runQueue(
      [1, 2, 3, 4],
      async (item) => {
        started.push(item);
        if (item === 1) ac.abort();
      },
      { concurrency: 1, signal: ac.signal, sleep: noSleep }
    );
    expect(started).toEqual([1]);
    expect(r.cancelled).toBe(true);
  });

  it('classifies statuses', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });
});
