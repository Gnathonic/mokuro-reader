/**
 * Credential refresh for worker-driven cloud transfers.
 *
 * A worker whose request carrying a bearer token is answered 401 must not
 * re-issue the token itself: eight parallel downloads would each spend the
 * password on the server's login rate limiter, and each would store a
 * different token. Instead the worker asks the main thread (`auth-refresh`),
 * which runs the provider's ONE single-flight re-issue and answers every
 * waiting worker with the same fresh credentials (`auth-refresh-result`).
 *
 * Dependency-free on purpose: imported by `worker-pool.ts` (main thread), the
 * providers that register a refresher, and the worker itself.
 */

/** Worker -> main: the header that was refused, and whose provider holds it. */
export interface AuthRefreshRequest {
  type: 'auth-refresh';
  requestId: number;
  provider: string;
  staleAuthorization: string;
}

/** Main -> worker: fresh worker credentials, or null (no retry: the 401 stands). */
export interface AuthRefreshResult {
  type: 'auth-refresh-result';
  requestId: number;
  credentials: Record<string, unknown> | null;
}

export type WorkerAuthRefresher = (
  staleAuthorization: string
) => Promise<Record<string, unknown> | null>;

const refreshers = new Map<string, WorkerAuthRefresher>();

/** A provider that can replace a refused credential registers here (main thread). */
export function registerWorkerAuthRefresher(
  provider: string,
  refresher: WorkerAuthRefresher
): void {
  refreshers.set(provider, refresher);
}

export function isAuthRefreshRequest(data: unknown): data is AuthRefreshRequest {
  const d = data as Partial<AuthRefreshRequest> | null;
  return (
    !!d &&
    d.type === 'auth-refresh' &&
    typeof d.requestId === 'number' &&
    typeof d.provider === 'string' &&
    typeof d.staleAuthorization === 'string'
  );
}

export function isAuthRefreshResult(data: unknown): data is AuthRefreshResult {
  const d = data as Partial<AuthRefreshResult> | null;
  return !!d && d.type === 'auth-refresh-result' && typeof d.requestId === 'number';
}

/** Main thread: answer one worker's request. Never rejects. */
export async function answerAuthRefresh(request: AuthRefreshRequest): Promise<AuthRefreshResult> {
  const refresher = refreshers.get(request.provider);
  let credentials: Record<string, unknown> | null = null;
  if (refresher) {
    try {
      credentials = await refresher(request.staleAuthorization);
    } catch {
      credentials = null;
    }
  }
  return { type: 'auth-refresh-result', requestId: request.requestId, credentials };
}

/**
 * Worker side: a refresher that round-trips to the main thread through
 * `post`/`listen` (the worker's `postMessage` / `addEventListener('message')`).
 */
export function createWorkerAuthRefresher(
  provider: string,
  post: (message: AuthRefreshRequest) => void,
  listen: (handler: (data: unknown) => void) => void
): WorkerAuthRefresher {
  let nextId = 1;
  const pending = new Map<number, (credentials: Record<string, unknown> | null) => void>();
  listen((data) => {
    if (!isAuthRefreshResult(data)) return;
    const resolve = pending.get(data.requestId);
    if (!resolve) return;
    pending.delete(data.requestId);
    resolve(data.credentials ?? null);
  });
  return (staleAuthorization) =>
    new Promise((resolve) => {
      const requestId = nextId++;
      pending.set(requestId, resolve);
      post({ type: 'auth-refresh', requestId, provider, staleAuthorization });
    });
}

/** Tests: forget every registered refresher. */
export function resetWorkerAuthRefreshersForTest(): void {
  refreshers.clear();
}
