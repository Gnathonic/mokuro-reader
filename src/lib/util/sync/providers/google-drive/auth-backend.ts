/**
 * The client half of the Drive auth backend (`src/routes/api/gdrive/*`).
 *
 * With `VITE_GDRIVE_AUTH_BACKEND=true` in the build, Drive signs in with the
 * authorization-code flow (PKCE, full-page redirect, `prompt=consent`) and
 * the server keeps Google's refresh token sealed in an HttpOnly cookie. Access
 * tokens are then minted silently (`/api/gdrive/refresh`) instead of through
 * an hourly account-chooser popup. Unset, nothing here runs and the implicit
 * Google Identity Services flow works exactly as before.
 *
 * A build with the flag whose server cannot serve the routes (a preview
 * without the secrets: 501; an old deployment: 404/405; an HTML page) falls
 * back to the implicit flow for the rest of the tab's session
 * (`markBackendUnavailable`).
 */
import { GOOGLE_DRIVE_CONFIG } from './constants';
import { ensureDeviceKey, loadDeviceKey, signProof } from './device-key';

/** The sign-in this tab started: `{ state, verifier, returnTo, createdAt }`. */
export const PENDING_KEY = 'gdrive_oauth_pending';
/** What the callback page brought back: `{ code, state, error }` (`static/oauth/google-callback.js`). */
export const CALLBACK_KEY = 'gdrive_oauth_callback';
const UNAVAILABLE_KEY = 'gdrive_auth_backend_unavailable';
const CLOCK_OFFSET_KEY = 'gdrive_pop_clock_offset';

export const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const CALLBACK_PATH = '/oauth/google-callback.html';
/** A started sign-in is good for this long (Google's codes live ~10 minutes). */
const PENDING_MAX_AGE_MS = 15 * 60 * 1000;
/** A hash route of the app, nothing else (the callback page uses the same rule). */
export const RETURN_TO_PATTERN = /^#\/[A-Za-z0-9\-._~!$&'()*+,;=:@/%?]{0,500}$/;
const CLIENT_TIMEOUT_MS = 15_000;

export type BackendRoute = 'session' | 'refresh' | 'logout';

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The build asks for the backend (`VITE_GDRIVE_AUTH_BACKEND=true`). */
export function backendAuthConfigured(): boolean {
  return import.meta.env.VITE_GDRIVE_AUTH_BACKEND === 'true';
}

/** The backend is in use: configured, and this tab has not found it missing. */
export function backendAuthEnabled(): boolean {
  if (!backendAuthConfigured()) return false;
  return session()?.getItem(UNAVAILABLE_KEY) !== '1';
}

/** The server cannot serve the routes: implicit sign-in for the rest of this tab's session. */
export function markBackendUnavailable(): void {
  console.warn('Google Drive auth backend unavailable here; using popup sign-in this session');
  try {
    session()?.setItem(UNAVAILABLE_KEY, '1');
  } catch {
    // Storage blocked: the flag lasts only as long as nothing re-reads it.
  }
}

// ------------------------------------------------------------------ requests

/** What a backend answer means to the client. */
export type BackendOutcome =
  | { kind: 'ok'; accessToken: string; expiresIn: number }
  /** `reauth` or `no_session`: only an interactive sign-in helps. */
  | { kind: 'reauth' }
  | { kind: 'pop_clock'; serverTime: number }
  /**
   * Nothing wrong with the session NOW: Google or our function is down, the
   * server is misconfigured (`server_config` keeps every cookie), a WAF answered
   * (a non-JSON 403/429), or the network failed. Keep a still-valid token.
   * `offline`: the request never left this device (no network). That says
   * nothing about the backend, so it never counts toward offering the popup
   * — which could not work offline either.
   */
  | { kind: 'transient'; offline?: true }
  /** No backend here (404/405/501, or an HTML page): implicit sign-in. */
  | { kind: 'unavailable' }
  /** Refused for a reason retrying will not fix (bad_request, consent_incomplete, …). */
  | { kind: 'refused'; error: string }
  /**
   * `/logout` done: the cookie is cleared. `revoked` only when the server
   * ended the grant at Google; otherwise (Google down, a cookie it could not
   * open, no cookie) an everywhere sign-out revokes the token it holds
   * itself. `invalidated`: copies of the cookie are now useless (for a
   * device sign-out anything but a live unbound session or proofs switched
   * off; for everywhere, a revoke). Absent reads as false.
   */
  | { kind: 'done'; revoked: boolean; invalidated: boolean };

async function classify(response: Response): Promise<BackendOutcome> {
  const contentType = response.headers.get('content-type') ?? '';
  const isJson = /^application\/json\b/i.test(contentType);
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    return { kind: 'unavailable' };
  }
  if (!isJson) {
    // A challenge page or rate limit in front of the function; a 5xx page.
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      return { kind: 'transient' };
    }
    // Anything else that is not our JSON (the app shell for an unknown path).
    return { kind: 'unavailable' };
  }
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return { kind: 'transient' };
  }
  if (response.ok) {
    if (body.ok === true) {
      return {
        kind: 'done',
        revoked: body.revoked === true,
        invalidated: body.invalidated === true
      };
    }
    const accessToken = body.access_token;
    const expiresIn = body.expires_in;
    if (typeof accessToken === 'string' && accessToken && typeof expiresIn === 'number') {
      return { kind: 'ok', accessToken, expiresIn };
    }
    return { kind: 'transient' };
  }
  const error = typeof body.error === 'string' ? body.error : 'unknown';
  switch (error) {
    case 'reauth':
    case 'no_session':
      return { kind: 'reauth' };
    case 'pop_clock':
      return typeof body.serverTime === 'number'
        ? { kind: 'pop_clock', serverTime: body.serverTime }
        : { kind: 'transient' };
    case 'transient':
    case 'server_config':
    case 'internal':
      return { kind: 'transient' };
    case 'not_configured':
    case 'method_not_allowed':
      return { kind: 'unavailable' };
    default:
      return { kind: 'refused', error };
  }
}

/** One POST to a backend route. Never throws. */
export async function callBackend(
  route: BackendRoute,
  body: Record<string, unknown>
): Promise<BackendOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/gdrive/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS)
    });
  } catch (error) {
    // Our own timeout means the backend is slow: that counts. Anything else
    // thrown for a same-origin request is the network (or the browser saying
    // it is offline): nothing about the backend.
    const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return offline || !timedOut ? { kind: 'transient', offline: true } : { kind: 'transient' };
  }
  return classify(response);
}

// ------------------------------------------------------- proof of possession

let clockOffsetMs: number | null = null;

function clockOffset(): number {
  if (clockOffsetMs === null) {
    let stored = NaN;
    try {
      stored = Number(localStorage.getItem(CLOCK_OFFSET_KEY));
    } catch {
      // ignore
    }
    clockOffsetMs = Number.isFinite(stored) ? stored : 0;
  }
  return clockOffsetMs;
}

function adoptServerTime(serverTime: number): void {
  clockOffsetMs = Math.round(serverTime - Date.now());
  try {
    localStorage.setItem(CLOCK_OFFSET_KEY, String(clockOffsetMs));
  } catch {
    // ignore
  }
}

async function proofFor(route: 'session' | 'refresh'): Promise<Record<string, unknown>> {
  const pair = await loadDeviceKey();
  if (!pair) return {};
  try {
    return {
      pop: await signProof(
        pair,
        location.origin,
        `/api/gdrive/${route}`,
        Date.now() + clockOffset()
      )
    };
  } catch (error) {
    console.warn('Drive device key could not sign:', (error as Error)?.name);
    return {};
  }
}

/**
 * POST with a proof from the device key (when this browser has one). A
 * `pop_clock` answer carries the server's time: adopt the offset and sign
 * again, once.
 */
export async function callWithProof(
  route: 'session' | 'refresh',
  body: Record<string, unknown>
): Promise<BackendOutcome> {
  let outcome = await callBackend(route, { ...body, ...(await proofFor(route)) });
  if (outcome.kind === 'pop_clock') {
    adoptServerTime(outcome.serverTime);
    outcome = await callBackend(route, { ...body, ...(await proofFor(route)) });
    // Still off: the clock moved under us, or the server's did. Not the session's fault.
    if (outcome.kind === 'pop_clock') return { kind: 'transient' };
  }
  return outcome;
}

// ------------------------------------------------------------------- sign-in

function randomUrlSafe(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function safeReturnTo(hash: string): string {
  return RETURN_TO_PATTERN.test(hash) ? hash : '';
}

/** Google's authorization URL for one sign-in. */
export function authorizeUrl(params: {
  clientId: string;
  origin: string;
  challenge: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.origin + CALLBACK_PATH,
    response_type: 'code',
    scope: GOOGLE_DRIVE_CONFIG.SCOPES,
    // A refresh token on EVERY sign-in, so a second device or a lost cookie
    // never meets a consent that returns none.
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state
  }).toString();
  return url.toString();
}

/**
 * Start a sign-in: make sure this browser has a device key (the sign-in path
 * is the only one that creates it), remember the PKCE verifier and a random
 * state for this tab, and leave for Google. Called from a user's click only.
 */
export async function startSignIn(
  navigate: (url: string) => void = (url) => location.assign(url)
): Promise<void> {
  await ensureDeviceKey();
  const verifier = randomUrlSafe(32);
  const state = randomUrlSafe(16);
  const store = session();
  if (!store) throw new Error('This browser blocks the storage Google sign-in needs');
  store.setItem(
    PENDING_KEY,
    JSON.stringify({
      state,
      verifier,
      returnTo: safeReturnTo(location.hash),
      createdAt: Date.now()
    })
  );
  navigate(
    authorizeUrl({
      clientId: GOOGLE_DRIVE_CONFIG.CLIENT_ID,
      origin: location.origin,
      challenge: await pkceChallenge(verifier),
      state
    })
  );
}

export type CallbackResult =
  | { kind: 'none' }
  | { kind: 'code'; code: string; verifier: string }
  | { kind: 'denied'; error: string }
  | { kind: 'refused'; reason: 'no_pending' | 'state_mismatch' | 'expired' | 'malformed' };

/**
 * Take the callback page's answer, ONCE: both it and the pending sign-in are
 * removed before anything is checked. A code is only redeemed for the flow
 * this tab started, with the state that flow made.
 */
export function takeCallback(now = Date.now()): CallbackResult {
  const store = session();
  if (!store) return { kind: 'none' };
  const rawAnswer = store.getItem(CALLBACK_KEY);
  if (rawAnswer === null) return { kind: 'none' };
  const rawPending = store.getItem(PENDING_KEY);
  store.removeItem(CALLBACK_KEY);
  store.removeItem(PENDING_KEY);
  // The redirect that brought this answer may sit in Cache Storage; cleared
  // in the background, so the sign-in never waits on it.
  void purgeCachedCallbacks();

  let answer: { code?: unknown; state?: unknown; error?: unknown };
  let pending: { state?: unknown; verifier?: unknown; createdAt?: unknown } | null;
  try {
    answer = JSON.parse(rawAnswer) ?? {};
    pending = rawPending === null ? null : JSON.parse(rawPending);
  } catch {
    return { kind: 'refused', reason: 'malformed' };
  }
  if (!pending || typeof pending.state !== 'string' || typeof pending.verifier !== 'string') {
    return { kind: 'refused', reason: 'no_pending' };
  }
  if (typeof answer.state !== 'string' || answer.state !== pending.state) {
    return { kind: 'refused', reason: 'state_mismatch' };
  }
  if (typeof pending.createdAt !== 'number' || now - pending.createdAt > PENDING_MAX_AGE_MS) {
    return { kind: 'refused', reason: 'expired' };
  }
  if (typeof answer.error === 'string' && answer.error) {
    return { kind: 'denied', error: answer.error };
  }
  if (typeof answer.code !== 'string' || !answer.code) {
    return { kind: 'refused', reason: 'malformed' };
  }
  return { kind: 'code', code: answer.code, verifier: pending.verifier };
}

/**
 * Delete every cached `/oauth/` response, best-effort. This build's service
 * worker never caches them, but one from an earlier build stays in control
 * until the user accepts the update banner, and it caches every same-origin
 * 200 GET by its full URL: the redirect back from Google, `?code=…&state=…`
 * included. The code is single-use and PKCE-bound, but it has no business
 * outliving the sign-in.
 */
async function purgeCachedCallbacks(): Promise<void> {
  try {
    if (typeof caches === 'undefined' || !caches) return;
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (url.origin === location.origin && url.pathname.startsWith('/oauth/')) {
          await cache.delete(request);
        }
      }
    }
  } catch {
    // Cache Storage refused (a private window, blocked site data): nothing to purge.
  }
}

/**
 * The callback page brought an answer back for this tab (backend mode): this
 * boot must load Drive to take it, whatever provider was configured before.
 * The provider key itself is only set once a sign-in completes, so an
 * abandoned sign-in leaves the app as it was.
 */
export function hasPendingCallback(): boolean {
  if (!backendAuthEnabled()) return false;
  try {
    return session()?.getItem(CALLBACK_KEY) != null;
  } catch {
    return false;
  }
}

/** Tests: forget the in-memory clock offset. */
export function resetAuthBackendForTest(): void {
  clockOffsetMs = null;
}
