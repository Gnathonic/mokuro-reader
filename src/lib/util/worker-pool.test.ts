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

describe('WorkerPool.cancelTasks', () => {
  // A logout cancels one provider's uploads; the downloads and the other
  // providers' work sharing the pool keep running.
  function poolOf(size: number) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return new WorkerPool('cancel-test', SilentWorker as unknown as new () => Worker, size, 500);
  }
  function providerTask(id: string, provider: string, onError: WorkerTask['onError']): WorkerTask {
    return { ...task(id, onError), provider, providerConcurrencyLimit: 1 };
  }

  afterEach(() => vi.restoreAllMocks());

  it('rejects the matching tasks, in flight and queued, as cancelled and leaves the rest', async () => {
    const pool = poolOf(2);
    const megaActive = vi.fn();
    const megaQueued = vi.fn();
    const download = vi.fn();
    pool.addTask(providerTask('mega-1', 'mega:upload', megaActive));
    pool.addTask(providerTask('mega-2', 'mega:upload', megaQueued));
    pool.addTask(providerTask('dl-1', 'mega:download', download));
    await Promise.resolve();
    expect(pool.activeTaskCount).toBe(2);
    expect(pool.queuedTaskCount).toBe(1);
    const uploadWorker = SilentWorker.instances.find((w) =>
      w.posted.some((data: any) => data.fileId === 'mega-1')
    )!;

    const count = pool.cancelTasks((t) => t.provider === 'mega:upload', 'Logged out');

    expect(count).toBe(2);
    expect(megaActive).toHaveBeenCalledWith({
      type: 'error',
      fileId: 'mega-1',
      error: 'Logged out',
      kind: 'cancelled'
    });
    expect(megaQueued).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'mega-2', kind: 'cancelled' })
    );
    expect(download).not.toHaveBeenCalled();
    // The upload's worker is gone (its request with it); the download's is not.
    expect(uploadWorker.terminated).toBe(true);
    expect(SilentWorker.instances.filter((w) => w.terminated)).toHaveLength(1);
    expect(pool.activeTaskCount).toBe(1);
    expect(pool.queuedTaskCount).toBe(0);
  });

  it('replaces the terminated worker, so the pool keeps its size and its provider slots', async () => {
    const pool = poolOf(1);
    pool.addTask(providerTask('mega-1', 'mega:upload', vi.fn()));
    await Promise.resolve();

    pool.cancelTasks((t) => t.id === 'mega-1');

    // The slot the cancelled upload held is free again: a new upload starts.
    const next = vi.fn();
    pool.addTask(providerTask('mega-3', 'mega:upload', next));
    await Promise.resolve();
    expect(SilentWorker.instances).toHaveLength(2);
    expect(SilentWorker.instances[1].posted).toEqual([{ mode: 'noop', fileId: 'mega-3' }]);
    expect(pool.activeTaskCount).toBe(1);
  });

  it('starts a queued task once a cancellation frees a worker', async () => {
    const pool = poolOf(1);
    pool.addTask(providerTask('mega-1', 'mega:upload', vi.fn()));
    pool.addTask(providerTask('gd-1', 'google-drive:upload', vi.fn()));
    await Promise.resolve();
    expect(pool.queuedTaskCount).toBe(1);

    pool.cancelTasks((t) => t.provider === 'mega:upload');
    await Promise.resolve();

    expect(pool.queuedTaskCount).toBe(0);
    expect(SilentWorker.instances.at(-1)!.posted).toEqual([{ mode: 'noop', fileId: 'gd-1' }]);
  });

  it('never rejects a task whose worker already completed it', async () => {
    const pool = poolOf(1);
    const onError = vi.fn();
    pool.addTask({
      ...providerTask('t', 'mega:upload', onError),
      onComplete: () => {} // still finishing on the main thread
    });
    await Promise.resolve();
    SilentWorker.instances[0].onmessage!({
      data: { type: 'complete', fileId: 't' }
    } as MessageEvent);

    expect(pool.cancelTasks(() => true)).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });
});
