/** Shared JSON transport for the adapters: the provider's message on failure, 429/5xx retryable. */
import { RetryableError, isRetryableStatus } from '../run-queue';

export interface JsonRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

export async function requestJson(
  f: typeof fetch,
  url: string,
  req: JsonRequest = {}
): Promise<unknown> {
  const res = await f(url, {
    method: req.method ?? (req.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(req.headers ?? {})
    },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: req.signal
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const e = json.error;
    const message = (typeof e === 'string' ? e : e?.message) ?? `request failed (${res.status})`;
    if (isRetryableStatus(res.status)) throw new RetryableError(message, res.status);
    throw new Error(message);
  }
  return json;
}

export function asTestResult(
  run: () => Promise<unknown>
): Promise<{ ok: true } | { ok: false; error: string }> {
  return run().then(
    () => ({ ok: true }) as const,
    (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
}
