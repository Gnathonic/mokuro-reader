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

/**
 * The session could not renew a refused token RIGHT NOW: the re-issue was
 * rate limited (login limiter hot, cooldown running) or the token endpoint
 * could not be reached. Says nothing about the password, so it must never
 * travel as the original 401: every write path classifies a 401 as "the
 * credentials were rejected" and wipes the stored password
 * (`classifyWriteError`, `markAuthFailed`, the login restore). This error is a
 * retryable, network-class failure instead — its message deliberately matches
 * neither `/\b401\b|Unauthorized/` nor any permission pattern.
 *
 * Only a re-issue the server REFUSED (the token endpoint rejected the
 * password) lets the 401 stand and reach the auth-failed flow.
 */
export class TransientAuthRefreshError extends Error {
  /** Survives a structured clone / a duck-typed check across realms. */
  readonly transientAuthRefresh = true;
  constructor(
    message = 'WebDAV sign-in renewal is temporarily unavailable (network or rate limit) - will retry later'
  ) {
    super(message);
    this.name = 'TransientAuthRefreshError';
  }
}

export function isTransientAuthRefreshError(error: unknown): error is TransientAuthRefreshError {
  return (
    error instanceof TransientAuthRefreshError ||
    (!!error && (error as { transientAuthRefresh?: unknown }).transientAuthRefresh === true)
  );
}

/** Worker -> main: the header that was refused, and whose provider holds it. */
export interface AuthRefreshRequest {
  type: 'auth-refresh';
  requestId: number;
  provider: string;
  staleAuthorization: string;
}

/**
 * Main -> worker: fresh worker credentials, or null (no retry: the 401 stands).
 * `transient`: no credentials NOW, for a reason that is not the password's
 * fault — the worker fails with a `TransientAuthRefreshError`, not the 401.
 */
export interface AuthRefreshResult {
  type: 'auth-refresh-result';
  requestId: number;
  credentials: Record<string, unknown> | null;
  transient?: true;
}

/**
 * Fresh credentials, or null (the 401 stands). Rejects with a
 * `TransientAuthRefreshError` when the session cannot renew right now.
 */
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
  let transient = false;
  if (refresher) {
    try {
      credentials = await refresher(request.staleAuthorization);
    } catch (error) {
      credentials = null;
      transient = isTransientAuthRefreshError(error);
    }
  }
  return {
    type: 'auth-refresh-result',
    requestId: request.requestId,
    credentials,
    ...(transient ? { transient: true as const } : {})
  };
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
  const pending = new Map<number, (result: AuthRefreshResult) => void>();
  listen((data) => {
    if (!isAuthRefreshResult(data)) return;
    const settle = pending.get(data.requestId);
    if (!settle) return;
    pending.delete(data.requestId);
    settle(data);
  });
  return (staleAuthorization) =>
    new Promise((resolve, reject) => {
      const requestId = nextId++;
      pending.set(requestId, (result) => {
        if (result.transient) reject(new TransientAuthRefreshError());
        else resolve(result.credentials ?? null);
      });
      post({ type: 'auth-refresh', requestId, provider, staleAuthorization });
    });
}

/**
 * Credential keys that carry the SECRET a request authenticates with. Fresh
 * credentials name exactly one of them (Bearer: the token, never the password;
 * Basic: the password), so the old secret must go — `webdavAuthorization`
 * prefers a token, and a dead one left behind after a fallback to Basic would
 * keep being sent.
 */
const AUTH_SECRET_KEYS = ['webdavToken', 'webdavPassword'] as const;

/** Write fresh credentials into `credentials`, replacing the auth secret wholesale. */
export function replaceCredentials(
  credentials: Record<string, unknown>,
  fresh: Record<string, unknown>
): void {
  for (const key of AUTH_SECRET_KEYS) {
    if (!(key in fresh)) delete credentials[key];
  }
  Object.assign(credentials, fresh);
}

/**
 * Worker side: a `refreshAuth` for one message's credentials object. Fresh
 * credentials are written back into it (`replaceCredentials`), so the next
 * upload of the same message (sidecars, then the archive) starts with them.
 */
export function refreshInto(
  refresher: WorkerAuthRefresher,
  credentials: Record<string, unknown>
): WorkerAuthRefresher {
  return async (staleAuthorization) => {
    const fresh = await refresher(staleAuthorization);
    if (fresh) replaceCredentials(credentials, fresh);
    return fresh;
  };
}

/** Tests: forget every registered refresher. */
export function resetWorkerAuthRefreshersForTest(): void {
  refreshers.clear();
}
