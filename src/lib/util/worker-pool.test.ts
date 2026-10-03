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
