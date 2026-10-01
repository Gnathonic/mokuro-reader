/**
 * mokuro-bunko bearer-token client (bunko >= 0.5.1).
 *
 * `POST <root>/login/api/token` trades the account's password for a bearer
 * token once; the token then stands in for Basic on every request, so the
 * password is not sent (and bcrypt-checked) on each one. A `reader` token lives
 * 90 days, fixed. `DELETE <root>/login/api/token` with the token signs it out.
 *
 * Anything that does not answer exactly like the endpoint — an older bunko, any
 * other WebDAV server — resolves to `unsupported`, and the session keeps using
 * Basic exactly as before.
 *
 * This module must stay dependency-free (no Svelte / $app imports).
 */

export const TOKEN_KIND = 'reader';
/** Re-issue at connect when fewer than this remain (a reader token lives 90 days, fixed). */
export const TOKEN_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 10000;

export type TokenIssueResult =
  /** `expiresAt`: epoch ms, or null when the server did not say. */
  | { kind: 'issued'; token: string; expiresAt: number | null }
  /** The endpoint refused the password (a JSON 401 from the token endpoint itself). */
  | { kind: 'invalid-credentials' }
  /** The login rate limiter is hot (a JSON 429). */
  | { kind: 'rate-limited' }
  /** No token endpoint here: older bunko, or not bunko at all. */
  | { kind: 'unsupported' }
  /** Network error, timeout or 5xx: nothing learned, try again later. */
  | { kind: 'unreachable' };

/**
 * The token endpoint beside the identity endpoint that answered
 * (`.../login/api/me` -> `.../login/api/token`), so a subpath mount is honoured
 * exactly as identity found it. Without one, the subpath candidate of the
 * server URL (identity's first candidate).
 */
export function tokenEndpointFor(identityEndpoint: string | undefined, serverUrl: string): string {
  if (identityEndpoint) {
    try {
      return new URL('token', identityEndpoint).toString();
    } catch {
      // fall through to the server URL
    }
  }
  const base = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
  return new URL('login/api/token', base).toString();
}

/** A short label naming what holds the token, e.g. `mokuro-reader (Firefox)`. */
export function tokenLabel(userAgent?: string): string {
  const ua = userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '';
  return browser ? `mokuro-reader (${browser})` : 'mokuro-reader';
}

/** Should a token expiring at `expiresAt` be replaced now? Unknown expiry: no. */
export function tokenNeedsRenewal(expiresAt: number | null, now = Date.now()): boolean {
  return expiresAt !== null && expiresAt - now < TOKEN_RENEW_BEFORE_MS;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await response.json()) as unknown;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Ask the token endpoint for a `reader` token. Never throws. */
export async function requestBunkoToken(
  endpoint: string,
  username: string,
  password: string,
  label: string = tokenLabel(),
  fetchImpl: typeof fetch = fetch
): Promise<TokenIssueResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password, kind: TOKEN_KIND, label }),
      cache: 'no-store',
      signal: controller.signal
    });
  } catch {
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timeoutId);
  }

  const body = await readJson(response);
  if (response.status === 200) {
    const token = body?.token;
    const type = body?.token_type;
    if (typeof token === 'string' && token && String(type).toLowerCase() === 'bearer') {
      const seconds = body?.expires_at;
      return {
        kind: 'issued',
        token,
        expiresAt: typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null
      };
    }
    return { kind: 'unsupported' };
  }
  // Only the endpoint's own JSON answers mean anything: an older bunko refuses
  // an anonymous POST with a text/plain 401 from its auth layer, which must
  // never read as "wrong password".
  const hasError = typeof body?.error === 'string';
  if (response.status === 401 && hasError) return { kind: 'invalid-credentials' };
  if (response.status === 429 && hasError) return { kind: 'rate-limited' };
  if (response.status >= 500) return { kind: 'unreachable' };
  return { kind: 'unsupported' };
}

/** Sign a token out (`DELETE`). Best effort: never throws, true when the server answered 2xx. */
export async function revokeBunkoToken(
  endpoint: string,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
