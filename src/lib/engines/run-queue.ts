/**
 * The one page/volume run loop both engines share: a bounded worker pool with
 * retry-on-transient (429 / 5xx) and cooperative cancel. Pure of any UI —
 * callers report `onProgress` wherever they like.
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export interface RunQueueOptions {
  concurrency?: number;
  retries?: number;
  backoffMs?: number[];
  signal: AbortSignal;
  onProgress?: (done: number, total: number, failed: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunQueueResult<T> {
  done: number;
  failed: number;
  errors: { item: T; error: unknown }[];
  cancelled: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runQueue<T>(
  items: T[],
  worker: (item: T, signal: AbortSignal) => Promise<void>,
  opts: RunQueueOptions
): Promise<RunQueueResult<T>> {
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? [1000, 2000, 4000];
  const sleep = opts.sleep ?? defaultSleep;
  const result: RunQueueResult<T> = { done: 0, failed: 0, errors: [], cancelled: false };
  let next = 0;

  const report = () => opts.onProgress?.(result.done, items.length, result.failed);

  async function runOne(item: T): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      if (opts.signal.aborted) return;
      try {
        await worker(item, opts.signal);
        result.done++;
        return;
      } catch (error) {
        const retryable = error instanceof RetryableError && attempt < retries;
        if (!retryable || opts.signal.aborted) {
          result.failed++;
          result.errors.push({ item, error });
          return;
        }
        await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
      }
    }
  }

  async function lane(): Promise<void> {
    while (next < items.length && !opts.signal.aborted) {
      const item = items[next++];
      await runOne(item);
      report();
    }
  }

  report();
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  result.cancelled = opts.signal.aborted && result.done + result.failed < items.length;
  return result;
}
