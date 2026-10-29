/**
 * Terminating the shared pool must settle every task it still holds: a caller
 * awaits its task through `onComplete`/`onError`, so a task dropped silently
 * leaves that caller (an import, a download) waiting forever.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerPool, type WorkerTask } from './worker-pool';
import { sharedMemoryManager } from './shared-memory-manager';

/** A worker that never answers: every task it is given stays in flight. */
class SilentWorker {
  static instances: SilentWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor() {
    SilentWorker.instances.push(this);
  }
  postMessage(data: unknown) {
    this.posted.push(data);
  }
  terminate() {
    this.terminated = true;
  }
  addEventListener() {}
  removeEventListener() {}
}

function task(id: string, onError: WorkerTask['onError']): WorkerTask {
  return { id, data: { mode: 'noop', fileId: id }, memoryRequirement: 1, onError };
}

afterEach(() => {
  SilentWorker.instances = [];
  sharedMemoryManager.setMemoryLimit(500);
});

describe('WorkerPool.terminate', () => {
  it('rejects the tasks in flight and the tasks still queued', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pool = new WorkerPool(
      'terminate-test',
      SilentWorker as unknown as new () => Worker,
      1,
      500
    );
    const active = vi.fn();
    const queued = vi.fn();
    pool.addTask(task('active', active));
    pool.addTask(task('queued', queued));
    await Promise.resolve();
    expect(pool.activeTaskCount).toBe(1);
    expect(pool.queuedTaskCount).toBe(1);

    pool.terminate();

    expect(SilentWorker.instances.every((w) => w.terminated)).toBe(true);
    expect(active).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', fileId: 'active', error: expect.any(String) })
    );
    expect(queued).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', fileId: 'queued', error: expect.any(String) })
    );
    expect(pool.totalPendingTasks).toBe(0);
    vi.restoreAllMocks();
  });

  it('settles every task even when one error handler throws', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pool = new WorkerPool(
      'terminate-throw-test',
      SilentWorker as unknown as new () => Worker,
      1,
      500
    );
    const second = vi.fn();
    pool.addTask(
      task('first', () => {
        throw new Error('handler broke');
      })
    );
    pool.addTask(task('second', second));

    expect(() => pool.terminate()).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe('a task settles exactly once', () => {
  // The last pool user's own error handler can count the pool down to zero
  // (the backup and download queues do), terminating it from INSIDE onError.
  function poolOfOne(id: string) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pool = new WorkerPool(id, SilentWorker as unknown as new () => Worker, 1, 500);
    const worker = () => SilentWorker.instances.at(-1)!;
    return { pool, worker };
  }

  afterEach(() => vi.restoreAllMocks());

  it('an error handler that terminates the pool runs once, with the real error', async () => {
    const { pool, worker } = poolOfOne('reentrant-error');
    const onError = vi.fn(() => pool.terminate());
    pool.addTask(task('t', onError));
    await Promise.resolve();
    worker().onmessage!({ data: { type: 'error', fileId: 't', error: 'boom' } } as MessageEvent);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error: 'boom' }));
  });

  it('so does one reached through the worker crashing', async () => {
    const { pool, worker } = poolOfOne('reentrant-crash');
    const onError = vi.fn(() => pool.terminate());
    pool.addTask(task('t', onError));
    await Promise.resolve();
    worker().onerror!({ message: 'crashed' } as ErrorEvent);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error: 'crashed' }));
  });

  it('so does one reached through its data failing to prepare', async () => {
    const { pool } = poolOfOne('reentrant-prepare');
    const onError = vi.fn(() => pool.terminate());
    pool.addTask({
      id: 't',
      memoryRequirement: 1,
      prepareData: async () => {
        throw new Error('no data');
      },
      onError
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error: 'no data' }));
  });

  it('a completion handler that terminates the pool is never followed by an error', async () => {
    const { pool, worker } = poolOfOne('reentrant-complete');
    const onError = vi.fn();
    const onComplete = vi.fn((_result: unknown, done: () => void) => {
      pool.terminate();
      done();
    });
    pool.addTask({ ...task('t', onError), onComplete });
    await Promise.resolve();
    worker().onmessage!({ data: { type: 'complete', fileId: 't' } } as MessageEvent);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a completed task still waiting for its caller to release it is not rejected', async () => {
    const { pool, worker } = poolOfOne('complete-then-terminate');
    const onError = vi.fn();
    pool.addTask({ ...task('t', onError), onComplete: () => {} });
    await Promise.resolve();
    worker().onmessage!({ data: { type: 'complete', fileId: 't' } } as MessageEvent);
    pool.terminate();

    expect(onError).not.toHaveBeenCalled();
  });

  it('terminate rejects in-flight and queued tasks exactly once, even twice terminated', async () => {
    const { pool } = poolOfOne('terminate-once');
    const active = vi.fn();
    const queued = vi.fn();
    pool.addTask(task('active', active));
    pool.addTask(task('queued', queued));
    await Promise.resolve();
    pool.terminate();
    pool.terminate();

    expect(active).toHaveBeenCalledTimes(1);
    expect(queued).toHaveBeenCalledTimes(1);
  });
});
