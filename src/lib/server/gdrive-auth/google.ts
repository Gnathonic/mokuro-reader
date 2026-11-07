/**
 * The three calls to Google's OAuth endpoints, and what each answer means for
 * the session. Google's `error_description` never leaves this module: callers
 * get a fixed outcome plus Google's short error CODE (for the log line only).
 */
import type { AuthEnv } from './config';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** The scope every session must carry: the app's own Drive files. */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** No Google call may hold a function instance longer than this. */
export const GOOGLE_TIMEOUT_MS = 5000;

/**
 * What one request may spend on Google in total, under the routes'
 * `maxDuration` (10 s) with headroom for the function itself. Only /session
 * makes two calls in a row (redeem the code, then revoke a grant it refuses);
 * the second gets what the first left (`remainingBudget`).
 */
export const GOOGLE_BUDGET_MS = 8000;
/** The least a follow-up call is given, however long the first one took. */
export const MIN_GOOGLE_TIMEOUT_MS = 1000;

/** The timeout for a follow-up Google call started `elapsedMs` into the budget. */
export function remainingBudget(elapsedMs: number): number {
  return Math.min(
    GOOGLE_TIMEOUT_MS,
    Math.max(MIN_GOOGLE_TIMEOUT_MS, GOOGLE_BUDGET_MS - Math.max(0, elapsedMs))
  );
}

/**
 * Test-only: a stand-in for Google's OAuth origin (`GDRIVE_TEST_GOOGLE_ORIGIN`),
 * read only when the server runs in the `test` or `interop` mode. The mode is a
 * compile-time constant, so a production build folds this away together with
 * the variable's name (`scripts/check-no-test-hooks.mjs` proves it): no
 * hosting setting can point a deployed server at another token endpoint.
 */
const GOOGLE_TEST_HOOKS: boolean =
  import.meta.env.MODE === 'test' || import.meta.env.MODE === 'interop';

export interface GoogleEndpoints {
  token: string;
  revoke: string;
}

export function googleEndpoints(env: AuthEnv): GoogleEndpoints {
  if (GOOGLE_TEST_HOOKS) {
    const origin = env.GDRIVE_TEST_GOOGLE_ORIGIN;
    if (origin) return { token: `${origin}/token`, revoke: `${origin}/revoke` };
  }
  return { token: TOKEN_URL, revoke: REVOKE_URL };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Google's error code, if it is one (short snake_case), for a log line; else 'unknown'. */
function errorCode(body: unknown): string {
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'unknown';
}

type Posted = { kind: 'answer'; status: number; body: unknown } | { kind: 'network' };

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  form: Record<string, string>,
  timeoutMs: number = GOOGLE_TIMEOUT_MS
): Promise<Posted> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error'
    });
  } catch {
    // Timeout, DNS, reset: nothing about the session.
    return { kind: 'network' };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { kind: 'answer', status: response.status, body };
}

/** What a token-endpoint answer means. */
export type TokenOutcome =
  | {
      kind: 'ok';
      accessToken: string;
      expiresIn: number;
      refreshToken?: string;
      scope?: string;
    }
  /** The grant is gone (revoked, expired, a used code): sign in again. */
  | { kind: 'invalid_grant'; googleError: string }
  /**
   * Our side is wrong (secret rotated or mistyped, client deleted or
   * disabled, a malformed request): every session is fine and must be KEPT —
   * clearing cookies here would sign out every user at once.
   */
  | { kind: 'server_config'; googleError: string }
  /** Google is down, slow or rate limiting: try again later. */
  | { kind: 'transient'; googleError: string };

const MAX_TOKEN_LENGTH = 4096;

function tokenOutcome(posted: Posted): TokenOutcome {
  if (posted.kind === 'network') return { kind: 'transient', googleError: 'network' };
  const { status, body } = posted;
  if (status >= 200 && status < 300) {
    const b = body as Record<string, unknown> | null;
    const accessToken = b?.access_token;
    const expiresIn = b?.expires_in;
    if (
      typeof accessToken !== 'string' ||
      accessToken.length === 0 ||
      accessToken.length > MAX_TOKEN_LENGTH ||
      typeof expiresIn !== 'number' ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      return { kind: 'transient', googleError: 'malformed_response' };
    }
    const refreshToken =
      typeof b?.refresh_token === 'string' && b.refresh_token.length > 0
        ? b.refresh_token
        : undefined;
    return {
      kind: 'ok',
      accessToken,
      expiresIn: Math.floor(expiresIn),
      ...(refreshToken ? { refreshToken } : {}),
      ...(typeof b?.scope === 'string' ? { scope: b.scope } : {})
    };
  }
  const googleError = errorCode(body);
  if (status >= 500 || status === 429) return { kind: 'transient', googleError };
  // Only this one code means the session itself is dead.
  if (googleError === 'invalid_grant') return { kind: 'invalid_grant', googleError };
  // invalid_client, deleted_client, unauthorized_client, invalid_request,
  // redirect_uri_mismatch, anything new: ours to fix, never the user's.
  return { kind: 'server_config', googleError };
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** Redeem an authorization code (PKCE) at Google's token endpoint. */
export async function exchangeCode(
  fetchImpl: FetchLike,
  endpoints: GoogleEndpoints,
  client: ClientCredentials,
  params: { code: string; codeVerifier: string; redirectUri: string }
): Promise<TokenOutcome> {
  return tokenOutcome(
    await postForm(fetchImpl, endpoints.token, {
      grant_type: 'authorization_code',
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret
    })
  );
}

/** A fresh access token for a refresh token. */
export async function refreshAccessToken(
  fetchImpl: FetchLike,
  endpoints: GoogleEndpoints,
  client: ClientCredentials,
  refreshToken: string
): Promise<TokenOutcome> {
  return tokenOutcome(
    await postForm(fetchImpl, endpoints.token, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret
    })
  );
}

/**
 * Revoke a token at Google (the token in the POST body, never in the URL).
 * Revoking either token of a grant revokes the whole grant. The answer's
 * code, for the log; never throws.
 */
export async function revokeToken(
  fetchImpl: FetchLike,
  endpoints: GoogleEndpoints,
  token: string,
  timeoutMs: number = GOOGLE_TIMEOUT_MS
): Promise<{ revoked: boolean; googleError?: string }> {
  const posted = await postForm(fetchImpl, endpoints.revoke, { token }, timeoutMs);
  if (posted.kind === 'network') return { revoked: false, googleError: 'network' };
  if (posted.status >= 200 && posted.status < 300) return { revoked: true };
  return { revoked: false, googleError: errorCode(posted.body) };
}

/** Does a space-separated scope list include the Drive file scope? */
export function grantsDriveFile(scope: string | undefined): boolean {
  return (scope ?? '').split(/\s+/).includes(DRIVE_FILE_SCOPE);
}
